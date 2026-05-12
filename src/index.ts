import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Plugin } from "@opencode-ai/plugin";
import {
  trace,
  ROOT_CONTEXT,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";

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
    spanProcessors: [processor],
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
      if (event.type === "session.idle") {
        log("info", "Flushing OTEL spans before idle");
        await processor.forceFlush();
      }

      if (event.type === "server.instance.disposed") {
        // sdk.shutdown() can hang under Bun when OTLP keep-alive sockets linger
        // (oven-sh/bun#13184). Use a bounded forceFlush instead; no sdk.shutdown.
        const ms = Number(process.env.LANGFUSE_DISPOSE_FLUSH_MS ?? "8000");
        log("info", `Flushing OTEL on server.instance.disposed (max ${ms}ms)`);
        await Promise.race([
          processor.forceFlush(),
          new Promise<void>((resolve) => setTimeout(resolve, ms)),
        ]);
      }
    },
  };
};
