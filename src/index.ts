import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Plugin } from "@opencode-ai/plugin";
import type { AssistantMessage, Model } from "@opencode-ai/sdk";
import {
  trace,
  ROOT_CONTEXT,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  RandomIdGenerator,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * ID generator that reuses a caller-supplied trace ID from LANGFUSE_TRACE_ID
 * so every root span created by the AI SDK shares that ID — stitching
 * OpenCode's spans into the caller's existing Langfuse trace rather than
 * creating standalone traces. RandomIdGenerator defines generateTraceId as
 * a class-field arrow function, so we reassign the field directly.
 */
class ParentAwareIdGenerator extends RandomIdGenerator {
  constructor() {
    super();
    const raw = process.env.LANGFUSE_TRACE_ID;
    if (raw && /^[0-9a-f]{32}$/i.test(raw)) {
      const parentTraceId = raw.toLowerCase();
      this.generateTraceId = () => parentTraceId;
    }
  }
}

/**
 * Context manager that returns a parent-pinned context when AsyncLocalStorage
 * is empty. The AI SDK creates root spans via `tracer.startSpan()` without an
 * explicit parent; OTEL falls back to `context.active()`. Overriding `.active()`
 * makes every otherwise-root span a child of the caller's remote parent.
 */
class ParentAwareContextManager extends AsyncLocalStorageContextManager {
  private readonly defaultContext: Context;

  constructor(defaultContext: Context) {
    super();
    this.defaultContext = defaultContext;
  }

  active(): Context {
    const current = super.active();
    return current === ROOT_CONTEXT ? this.defaultContext : current;
  }
}

/**
 * Hydrates AI SDK generation spans with cost computed by OpenCode before they
 * ship to Langfuse. An earlier design wrote cost via Langfuse's public
 * ingestion API (`generation-update`) and lost a race against OTel batched
 * export — the API write created/locked a stub observation under the same
 * spanId, and the OTel-emitted doStream span arriving ~5s later was unable to
 * overwrite name/model/parent/tokens, leaving the observation gutted (only
 * costDetails survived).
 *
 * The fix sets `langfuse.observation.cost_details` (Langfuse's documented
 * OTel attribute key for cost) on the span itself, BEFORE it exports. We
 * buffer the inner generation span (`ai.*.do{Generate,Stream}`) in onEnd,
 * wait for the matching `message.updated`, mutate the attribute, then forward
 * to the inner LangfuseSpanProcessor. The span ships once with cost already
 * attached — no API write, no race.
 */
type BufferedSpan = {
  span: Span;
  timer: ReturnType<typeof setTimeout>;
};

// Per-(provider/model) pricing pulled from OpenCode's `client.config.providers()`.
// Values are dollars per million tokens, matching OpenCode's own representation.
type CostRates = Model["cost"];

// Token totals carried by AssistantMessage. We snapshot the previous values per
// message id so each `message.updated` yields per-component deltas, not totals.
type TokenSnapshot = AssistantMessage["tokens"];

const ZERO_SNAPSHOT: TokenSnapshot = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

// Match ONLY the inner generation spans the AI SDK emits — these are the
// observations Langfuse maps to GENERATION (they carry model + token usage).
// The outer `ai.streamText` / `ai.generateText` wrappers are SPAN observations
// and have no `model` attribute, so attaching cost there is meaningless.
const GENERATION_SPAN_RE =
  /^ai\.(generateText|streamText|generateObject|streamObject)\.do(Generate|Stream)$/;

// Per-session FIFO. Bounded to prevent unbounded growth if `message.updated`
// never arrives for some span (e.g. local model with cost === 0). On overflow
// the oldest buffered span is flushed uncosted to make room for newer ones.
const MAX_PENDING_PER_SESSION = 64;

// Langfuse's documented OTel attribute key for per-observation cost details.
const COST_DETAILS_ATTR = "langfuse.observation.cost_details";

function isGenerationSpan(span: ReadableSpan): boolean {
  return (
    span.instrumentationScope?.name === "ai" &&
    GENERATION_SPAN_RE.test(span.name)
  );
}

const isDebug = (): boolean => process.env.LANGFUSE_DEBUG === "true";

type DebugLog = (message: string) => void;

class CostHydratingSpanProcessor implements SpanProcessor {
  private readonly bufferedBySession = new Map<string, BufferedSpan[]>();

  constructor(
    private readonly inner: LangfuseSpanProcessor,
    private readonly flushTimeoutMs: number,
    private readonly debug: DebugLog
  ) {}

  onStart(span: Span, parentContext: Context): void {
    if (isDebug()) {
      this.debug(
        `span.onStart scope=${span.instrumentationScope?.name ?? "<no-scope>"} name=${span.name}`
      );
    }
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (isDebug()) {
      const scope = span.instrumentationScope?.name ?? "<no-scope>";
      const sid = span.attributes["ai.telemetry.metadata.sessionId"];
      this.debug(
        `span.onEnd scope=${scope} name=${span.name} sessionId=${typeof sid === "string" ? sid : "<absent>"}`
      );
    }

    if (!isGenerationSpan(span)) {
      this.inner.onEnd(span);
      return;
    }

    const sessionId = span.attributes["ai.telemetry.metadata.sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      if (isDebug()) {
        this.debug(
          `generation span ${span.name} missing ai.telemetry.metadata.sessionId attribute — forwarding uncosted`
        );
      }
      this.inner.onEnd(span);
      return;
    }

    // ReadableSpan is the underlying mutable Span instance; the readonly type
    // is a view, not an enforcement. Langfuse's own processor mutates
    // attributes in `applyMaskInPlace`, confirming this is supported.
    this.bufferSpan(sessionId, span as Span);
  }

  /**
   * Pop the oldest buffered span for this session, attach the cost-details
   * object as the Langfuse-documented OTel attribute, and forward to the
   * inner processor. The caller composes the full `{input, output, ..., total}`
   * shape so we don't need to know which components are populated.
   */
  attachCost(
    sessionId: string,
    costDetails: Record<string, number>
  ): BufferedSpan | undefined {
    const queue = this.bufferedBySession.get(sessionId);
    const buffered = queue?.shift();
    if (!buffered) return undefined;
    clearTimeout(buffered.timer);
    (buffered.span.attributes as Record<string, unknown>)[COST_DETAILS_ATTR] =
      JSON.stringify(costDetails);
    this.inner.onEnd(buffered.span);
    return buffered;
  }

  private bufferSpan(sessionId: string, span: Span): void {
    const queue = this.bufferedBySession.get(sessionId) ?? [];
    const entry: BufferedSpan = {
      span,
      timer: setTimeout(
        () => this.flushOne(sessionId, span),
        this.flushTimeoutMs
      ),
    };
    queue.push(entry);

    // Overflow protection: if we're past the cap, drop the OLDEST and ship it
    // uncosted. We prefer dropping the head because the tail is more likely
    // to be the one whose cost is still en route.
    while (queue.length > MAX_PENDING_PER_SESSION) {
      const evicted = queue.shift()!;
      clearTimeout(evicted.timer);
      this.inner.onEnd(evicted.span);
      if (isDebug()) {
        this.debug(
          `evicted oldest buffered generation span (queue cap ${MAX_PENDING_PER_SESSION}) session=${sessionId} — forwarded uncosted`
        );
      }
    }

    this.bufferedBySession.set(sessionId, queue);
    if (isDebug()) {
      const ctx = span.spanContext();
      this.debug(
        `buffered generation span traceId=${ctx.traceId} spanId=${ctx.spanId} session=${sessionId} queueDepth=${queue.length}`
      );
    }
  }

  private flushOne(sessionId: string, span: Span): void {
    const queue = this.bufferedBySession.get(sessionId);
    if (!queue) return;
    const idx = queue.findIndex((b) => b.span === span);
    if (idx === -1) return;
    const [entry] = queue.splice(idx, 1);
    clearTimeout(entry.timer);
    this.inner.onEnd(entry.span);
    if (isDebug()) {
      const ctx = span.spanContext();
      this.debug(
        `timed out buffered span traceId=${ctx.traceId} spanId=${ctx.spanId} session=${sessionId} — forwarded uncosted`
      );
    }
  }

  private drainAll(): void {
    for (const queue of this.bufferedBySession.values()) {
      for (const entry of queue) {
        clearTimeout(entry.timer);
        this.inner.onEnd(entry.span);
      }
    }
    this.bufferedBySession.clear();
  }

  forceFlush(): Promise<void> {
    this.drainAll();
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    this.drainAll();
    return this.inner.shutdown();
  }
}

export const LangfusePlugin: Plugin = async ({ client }) => {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASEURL ?? "https://cloud.langfuse.com";
  const environment = process.env.LANGFUSE_ENVIRONMENT ?? "development";

  const log = (level: "info" | "warn" | "error", message: string) => {
    client.app.log({
      body: { service: "langfuse-otel", level, message },
    });
  };

  if (!publicKey || !secretKey) {
    log(
      "warn",
      "Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY - tracing disabled"
    );
    return {};
  }

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment,
  });

  const debug: DebugLog = (message) => log("info", `[debug] ${message}`);

  const rawTimeout = Number(
    process.env.LANGFUSE_COST_HYDRATION_TIMEOUT_MS ?? "10000"
  );
  const costHydrationTimeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 10000;
  const costProcessor = new CostHydratingSpanProcessor(
    processor,
    costHydrationTimeoutMs,
    debug
  );

  // Tracks running cost and token totals per assistant message so each
  // message.updated can be recognised as "progress was made since the last
  // update". cost is the trigger only — the actual value sent to Langfuse is
  // recomputed locally from token deltas × per-million rates so the
  // per-component split is internally consistent.
  type MessageState = { cost: number; tokens: TokenSnapshot };
  const stateByMessage = new Map<string, MessageState>();

  // Lazy provider-rates fetch. The Model registry isn't available
  // synchronously at plugin init — and we don't need it until the first
  // costed message arrives — so we defer the HTTP call and memoise the
  // resulting promise. On failure, the map is empty and the caller falls
  // back to a total-only `costDetails`, matching pre-split behaviour.
  let ratesPromise: Promise<Map<string, CostRates>> | null = null;
  const loadRates = (): Promise<Map<string, CostRates>> => {
    if (ratesPromise) return ratesPromise;
    ratesPromise = (async () => {
      const map = new Map<string, CostRates>();
      try {
        const res = await client.config.providers();
        const providers = res.data?.providers ?? [];
        for (const provider of providers) {
          for (const model of Object.values(provider.models ?? {})) {
            map.set(`${provider.id}/${model.id}`, model.cost);
          }
        }
        if (isDebug()) {
          debug(`loaded cost rates for ${map.size} models`);
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        log(
          "warn",
          `failed to load provider rates: ${m} (falling back to total-only cost)`
        );
      }
      return map;
    })();
    return ratesPromise;
  };

  const onMessageUpdated = async (info: AssistantMessage): Promise<void> => {
    if (isDebug()) {
      debug(
        `message.updated id=${info.id} session=${info.sessionID} role=${info.role} cost=${JSON.stringify(info.cost)}`
      );
    }

    const currCost = typeof info.cost === "number" ? info.cost : 0;
    if (!Number.isFinite(currCost)) return;

    const prev = stateByMessage.get(info.id) ?? {
      cost: 0,
      tokens: ZERO_SNAPSHOT,
    };
    const dCost = currCost - prev.cost;
    if (dCost <= 0) {
      // Advance cost (so future deltas are computed against the latest seen
      // value) but keep the previous token snapshot — tokens only step forward
      // on a positive cost delta, keeping per-component arithmetic aligned.
      stateByMessage.set(info.id, { cost: currCost, tokens: prev.tokens });
      if (isDebug()) {
        debug(
          `skip update id=${info.id} dCost=${dCost} prev=${prev.cost} curr=${currCost}`
        );
      }
      return;
    }

    const curr: TokenSnapshot = {
      input: info.tokens.input,
      output: info.tokens.output,
      reasoning: info.tokens.reasoning,
      cache: {
        read: info.tokens.cache.read,
        write: info.tokens.cache.write,
      },
    };
    stateByMessage.set(info.id, { cost: currCost, tokens: curr });

    const rates = (await loadRates()).get(`${info.providerID}/${info.modelID}`);
    const costDetails: Record<string, number> = {};
    if (rates) {
      // Mirror packages/opencode/src/session/session.ts:431-440. Rates are
      // per million tokens. Reasoning is charged at the output rate
      // (upstream TODO — re-check on opencode bumps).
      const inp = ((curr.input - prev.tokens.input) * rates.input) / 1_000_000;
      const out =
        ((curr.output - prev.tokens.output) * rates.output) / 1_000_000;
      const cr =
        ((curr.cache.read - prev.tokens.cache.read) * rates.cache.read) /
        1_000_000;
      const cw =
        ((curr.cache.write - prev.tokens.cache.write) * rates.cache.write) /
        1_000_000;
      const reas =
        ((curr.reasoning - prev.tokens.reasoning) * rates.output) / 1_000_000;
      if (inp > 0) costDetails.input = inp;
      if (out > 0) costDetails.output = out;
      if (cr > 0) costDetails.cache_read = cr;
      if (cw > 0) costDetails.cache_write = cw;
      if (reas > 0) costDetails.reasoning = reas;
      costDetails.total = inp + out + cr + cw + reas;
    } else {
      // Unknown (providerID/modelID) — fall back to the coarse total from
      // OpenCode's `info.cost`. Same payload shape we shipped pre-split.
      costDetails.total = dCost;
      if (isDebug()) {
        debug(
          `no rates for ${info.providerID}/${info.modelID} — sending total-only ${costDetails.total}`
        );
      }
    }

    const buffered = costProcessor.attachCost(info.sessionID, costDetails);
    if (!buffered) {
      log(
        "info",
        `no matching generation span for cost update on message ${info.id}`
      );
      return;
    }

    if (isDebug()) {
      const ctx = buffered.span.spanContext();
      debug(
        `attached cost message=${info.id} span=${ctx.spanId} trace=${ctx.traceId} costDetails=${JSON.stringify(costDetails)}`
      );
    }
  };

  const idGenerator = new ParentAwareIdGenerator();
  const parentTraceId = process.env.LANGFUSE_TRACE_ID;
  const parentSpanId = process.env.LANGFUSE_PARENT_OBSERVATION_ID;

  let contextManager: AsyncLocalStorageContextManager | undefined;
  let parentNested = false;
  if (
    parentTraceId &&
    /^[0-9a-f]{32}$/i.test(parentTraceId) &&
    parentSpanId &&
    /^[0-9a-f]{16}$/i.test(parentSpanId)
  ) {
    const remoteParent: SpanContext = {
      traceId: parentTraceId.toLowerCase(),
      spanId: parentSpanId.toLowerCase(),
      traceFlags: 1,
      isRemote: true,
    };
    const parentContext = trace.setSpanContext(ROOT_CONTEXT, remoteParent);
    contextManager = new ParentAwareContextManager(parentContext);
    parentNested = true;
  }

  const sdk = new NodeSDK({
    spanProcessors: [costProcessor],
    idGenerator,
    ...(contextManager ? { contextManager } : {}),
  });

  sdk.start();

  if (parentNested) {
    log(
      "info",
      `OTEL tracing initialized → ${baseUrl} (nested under parent ${parentTraceId!.slice(0, 8)}…/${parentSpanId!.slice(0, 8)}…)`
    );
  } else if (parentTraceId) {
    log(
      "info",
      `OTEL tracing initialized → ${baseUrl} (stitching to parent trace ${parentTraceId.slice(0, 8)}…)`
    );
  } else {
    log("info", `OTEL tracing initialized → ${baseUrl}`);
  }

  if (isDebug()) {
    debug("LANGFUSE_DEBUG=true — verbose cost-hydration diagnostics enabled");
  }

  return {
    config: async (config) => {
      if (!config.experimental?.openTelemetry) {
        log(
          "warn",
          "OpenTelemetry experimental feature is disabled in Opencode config - tracing disabled"
        );
      }
    },
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "assistant") {
          await onMessageUpdated(info);
        }
        return;
      }

      if (event.type === "session.idle") {
        log("info", "Flushing OTEL spans before idle");
        await costProcessor.forceFlush();
      }

      if (event.type === "server.instance.disposed") {
        // sdk.shutdown() can hang under Bun when OTLP keep-alive sockets linger
        // (oven-sh/bun#13184). Use a bounded forceFlush instead; no sdk.shutdown.
        const ms = Number(process.env.LANGFUSE_DISPOSE_FLUSH_MS ?? "8000");
        log("info", `Flushing OTEL on server.instance.disposed (max ${ms}ms)`);
        await Promise.race([
          costProcessor.forceFlush(),
          new Promise<void>((resolve) => setTimeout(resolve, ms)),
        ]);
      }
    },
  };
};
