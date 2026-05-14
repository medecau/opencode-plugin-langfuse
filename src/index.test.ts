import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { LangfusePlugin } from "./index";

const mockForceFlush = mock(() => Promise.resolve());
const mockInnerOnStart = mock(() => {});
const mockInnerOnEnd = mock((_span: unknown) => {});
const mockStart = mock(() => {});
const mockShutdown = mock(() => Promise.resolve());

let capturedNodeSDKOptions: Record<string, unknown> = {};

mock.module("@langfuse/otel", () => ({
  LangfuseSpanProcessor: mock(() => ({
    onStart: mockInnerOnStart,
    onEnd: mockInnerOnEnd,
    forceFlush: mockForceFlush,
    shutdown: mockShutdown,
  })),
}));

mock.module("@opentelemetry/sdk-node", () => ({
  NodeSDK: mock((options: Record<string, unknown>) => {
    capturedNodeSDKOptions = options;
    return {
      start: mockStart,
      shutdown: mockShutdown,
    };
  }),
}));

type WrapperLike = {
  onEnd: (span: unknown) => void;
  onStart: (span: unknown, ctx: unknown) => void;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
};

const getWrapper = (): WrapperLike => {
  const processors = capturedNodeSDKOptions.spanProcessors as WrapperLike[];
  return processors[0];
};

type FakeSpan = {
  name: string;
  instrumentationScope: { name: string };
  attributes: Record<string, unknown>;
  spanContext: () => { traceId: string; spanId: string; traceFlags: number };
};

const makeGenSpan = (opts: {
  traceId: string;
  spanId: string;
  sessionId?: string;
  scopeName?: string;
  name?: string;
}): FakeSpan => ({
  name: opts.name ?? "ai.streamText.doStream",
  instrumentationScope: { name: opts.scopeName ?? "ai" },
  attributes:
    opts.sessionId !== undefined
      ? { "ai.telemetry.metadata.sessionId": opts.sessionId }
      : {},
  spanContext: () => ({
    traceId: opts.traceId,
    spanId: opts.spanId,
    traceFlags: 1,
  }),
});

const assistantMsg = (overrides: {
  id?: string;
  sessionID?: string;
  cost?: number | null;
  modelID?: string;
  providerID?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}) =>
  ({
    id: overrides.id ?? "m1",
    sessionID: overrides.sessionID ?? "sess-A",
    role: "assistant" as const,
    cost: overrides.cost,
    modelID: overrides.modelID ?? "model-x",
    providerID: overrides.providerID ?? "provider-y",
    tokens: {
      input: overrides.tokens?.input ?? 0,
      output: overrides.tokens?.output ?? 0,
      reasoning: overrides.tokens?.reasoning ?? 0,
      cache: {
        read: overrides.tokens?.cache?.read ?? 0,
        write: overrides.tokens?.cache?.write ?? 0,
      },
    },
  }) as unknown;

const mockLog = mock(() => {});
const mockProviders = mock(() => Promise.resolve({ data: { providers: [] } }));

const createMockClient = () => ({
  app: {
    log: mockLog,
  },
  config: {
    providers: mockProviders,
  },
});

const mockPluginInput = (clientOverrides = {}) =>
  ({
    client: { ...createMockClient(), ...clientOverrides },
    project: { id: "proj-123", worktree: "/test" },
    directory: "/test/dir",
    worktree: "/test/worktree",
    serverUrl: new URL("http://localhost:3000"),
    $: {},
  }) as any;

const fireMessageUpdated = (
  hooks: Awaited<ReturnType<typeof LangfusePlugin>>,
  info: unknown
) =>
  hooks.event!({
    event: { type: "message.updated", properties: { info } },
  } as any);

const costAttr = (span: FakeSpan): unknown =>
  span.attributes["langfuse.observation.cost_details"];

const costDetails = (span: FakeSpan): Record<string, number> =>
  JSON.parse(span.attributes["langfuse.observation.cost_details"] as string);

describe("LangfusePlugin", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockForceFlush.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
    mockLog.mockClear();
    mockInnerOnStart.mockClear();
    mockInnerOnEnd.mockClear();
    mockProviders.mockClear();
    // Default: no providers known → onMessageUpdated falls into the
    // total-only path, preserving the previous `{ total: dCost }` payload.
    mockProviders.mockImplementation(() =>
      Promise.resolve({ data: { providers: [] } })
    );
    capturedNodeSDKOptions = {};
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const setupEnv = (overrides: Record<string, string> = {}) => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    // Default the hydration timeout high so timer-driven flushes don't fire
    // in tests that don't explicitly exercise the timeout path.
    process.env.LANGFUSE_COST_HYDRATION_TIMEOUT_MS = "60000";
    Object.assign(process.env, overrides);
  };

  describe("credentials", () => {
    it("returns empty hooks when credentials missing", async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;

      const hooks = await LangfusePlugin(mockPluginInput());

      expect(hooks).toEqual({});
      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "warn",
          message:
            "Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY - tracing disabled",
        },
      });
    });

    it("returns hooks when credentials provided via env", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      expect(hooks.config).toBeDefined();
      expect(hooks.event).toBeDefined();
      expect(mockStart).toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "OTEL tracing initialized → https://cloud.langfuse.com",
        },
      });
    });
  });

  describe("config hook", () => {
    it("warns when openTelemetry is disabled in config", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      await hooks.config!({ experimental: { openTelemetry: false } } as any);

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "warn",
          message:
            "OpenTelemetry experimental feature is disabled in Opencode config - tracing disabled",
        },
      });
    });

    it("warns when experimental config is missing", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      await hooks.config!({} as any);

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "warn",
          message:
            "OpenTelemetry experimental feature is disabled in Opencode config - tracing disabled",
        },
      });
    });

    it("does not warn when openTelemetry is enabled", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());
      mockLog.mockClear();

      await hooks.config!({ experimental: { openTelemetry: true } } as any);

      expect(mockLog).not.toHaveBeenCalled();
    });
  });

  describe("event hook", () => {
    it("flushes OTEL spans on session.idle", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      await hooks.event!({
        event: { type: "session.idle", properties: { sessionID: "sess-1" } },
      } as any);

      expect(mockForceFlush).toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "Flushing OTEL spans before idle",
        },
      });
    });

    it("does not flush on other events", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());
      mockForceFlush.mockClear();

      await hooks.event!({
        event: {
          type: "session.created",
          properties: { info: { id: "sess-1" } },
        },
      } as any);

      expect(mockForceFlush).not.toHaveBeenCalled();
    });
  });

  describe("dispose hook", () => {
    it("flushes (not shuts down) on server.instance.disposed", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      await hooks.event!({
        event: { type: "server.instance.disposed", properties: {} },
      } as any);

      expect(mockForceFlush).toHaveBeenCalled();
      expect(mockShutdown).not.toHaveBeenCalled();
    });

    it("respects LANGFUSE_DISPOSE_FLUSH_MS as an upper bound", async () => {
      setupEnv({ LANGFUSE_DISPOSE_FLUSH_MS: "50" });
      mockForceFlush.mockImplementationOnce(() => new Promise<void>(() => {}));

      const hooks = await LangfusePlugin(mockPluginInput());

      const start = Date.now();
      await hooks.event!({
        event: { type: "server.instance.disposed", properties: {} },
      } as any);
      const elapsed = Date.now() - start;

      expect(mockForceFlush).toHaveBeenCalled();
      expect(mockShutdown).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("environment configuration", () => {
    it("uses default baseUrl when not provided", async () => {
      setupEnv();
      delete process.env.LANGFUSE_BASEURL;

      await LangfusePlugin(mockPluginInput());

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "OTEL tracing initialized → https://cloud.langfuse.com",
        },
      });
    });

    it("uses custom baseUrl when provided", async () => {
      setupEnv({ LANGFUSE_BASEURL: "https://custom.langfuse.com" });

      await LangfusePlugin(mockPluginInput());

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "OTEL tracing initialized → https://custom.langfuse.com",
        },
      });
    });
  });

  describe("trace stitching", () => {
    it("passes idGenerator to NodeSDK", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      expect(capturedNodeSDKOptions.idGenerator).toBeDefined();
    });

    it("logs parent trace ID when LANGFUSE_TRACE_ID is set", async () => {
      setupEnv({
        LANGFUSE_TRACE_ID: "abcdef1234567890abcdef1234567890",
      });

      await LangfusePlugin(mockPluginInput());

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message:
            "OTEL tracing initialized → https://cloud.langfuse.com (stitching to parent trace abcdef12…)",
        },
      });
    });

    it("does not log parent trace when LANGFUSE_TRACE_ID is not set", async () => {
      setupEnv();
      delete process.env.LANGFUSE_TRACE_ID;

      await LangfusePlugin(mockPluginInput());

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "OTEL tracing initialized → https://cloud.langfuse.com",
        },
      });
    });

    it("passes contextManager when both trace and parent observation IDs are set", async () => {
      setupEnv({
        LANGFUSE_TRACE_ID: "abcdef1234567890abcdef1234567890",
        LANGFUSE_PARENT_OBSERVATION_ID: "1234567890abcdef",
      });

      await LangfusePlugin(mockPluginInput());

      expect(capturedNodeSDKOptions.contextManager).toBeDefined();
    });
  });

  describe("cost hydration", () => {
    it("buffers a generation span on onEnd (no inner.onEnd yet)", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      getWrapper().onEnd(
        makeGenSpan({ traceId: "t1", spanId: "s1", sessionId: "sess-A" })
      );

      expect(mockInnerOnEnd).not.toHaveBeenCalled();
    });

    it("attaches cost_details and forwards once when positive-delta cost arrives", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(span);

      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "m1", sessionID: "sess-A", cost: 0.001 })
      );

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(1);
      expect(mockInnerOnEnd.mock.calls[0][0]).toBe(span as never);
      expect(costAttr(span)).toBe(JSON.stringify({ total: 0.001 }));
    });

    it("computes delta against previous cost on subsequent updates", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      const s1 = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(s1);
      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "m1", sessionID: "sess-A", cost: 0.001 })
      );

      const s2 = makeGenSpan({
        traceId: "t1",
        spanId: "s2",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(s2);
      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "m1", sessionID: "sess-A", cost: 0.003 })
      );

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(2);
      expect(costAttr(s1)).toBe(JSON.stringify({ total: 0.001 }));
      expect(costAttr(s2)).toBe(JSON.stringify({ total: 0.002 }));
    });

    it("skips when cost is zero — buffered span stays buffered", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(span);

      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "m1", sessionID: "sess-A", cost: 0 })
      );

      expect(mockInnerOnEnd).not.toHaveBeenCalled();
      expect(costAttr(span)).toBeUndefined();
    });

    it("skips when cost is null/undefined/NaN", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      const s1 = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      const s2 = makeGenSpan({
        traceId: "t1",
        spanId: "s2",
        sessionId: "sess-A",
      });
      const s3 = makeGenSpan({
        traceId: "t1",
        spanId: "s3",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(s1);
      getWrapper().onEnd(s2);
      getWrapper().onEnd(s3);

      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "m1", sessionID: "sess-A", cost: null })
      );
      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "m2", sessionID: "sess-A", cost: undefined })
      );
      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "m3", sessionID: "sess-A", cost: NaN })
      );

      expect(mockInnerOnEnd).not.toHaveBeenCalled();
    });

    it("logs when no buffered span matches a positive-delta update", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "m1", sessionID: "sess-Z", cost: 0.5 })
      );

      expect(mockInnerOnEnd).not.toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "no matching generation span for cost update on message m1",
        },
      });
    });

    it("isolates FIFO queues per sessionId across interleaved updates", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      const sA = makeGenSpan({
        traceId: "tA",
        spanId: "sA",
        sessionId: "sess-A",
      });
      const sB = makeGenSpan({
        traceId: "tB",
        spanId: "sB",
        sessionId: "sess-B",
      });
      getWrapper().onEnd(sA);
      getWrapper().onEnd(sB);

      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "mB", sessionID: "sess-B", cost: 0.5 })
      );
      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "mA", sessionID: "sess-A", cost: 0.1 })
      );

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(2);
      expect(mockInnerOnEnd.mock.calls[0][0]).toBe(sB as never);
      expect(mockInnerOnEnd.mock.calls[1][0]).toBe(sA as never);
      expect(costAttr(sB)).toBe(JSON.stringify({ total: 0.5 }));
      expect(costAttr(sA)).toBe(JSON.stringify({ total: 0.1 }));
    });

    it("pops queue in FIFO order within one session", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      const s1 = makeGenSpan({
        traceId: "t",
        spanId: "s1",
        sessionId: "sess-A",
      });
      const s2 = makeGenSpan({
        traceId: "t",
        spanId: "s2",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(s1);
      getWrapper().onEnd(s2);

      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "m1", sessionID: "sess-A", cost: 0.001 })
      );
      await fireMessageUpdated(
        hooks,
        assistantMsg({ id: "m2", sessionID: "sess-A", cost: 0.002 })
      );

      expect(mockInnerOnEnd.mock.calls[0][0]).toBe(s1 as never);
      expect(mockInnerOnEnd.mock.calls[1][0]).toBe(s2 as never);
    });

    it("forwards non-ai-SDK spans immediately, never buffered", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
        scopeName: "@opentelemetry/instrumentation-http",
      });
      getWrapper().onEnd(span);

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(1);
      expect(mockInnerOnEnd.mock.calls[0][0]).toBe(span as never);
    });

    it("forwards outer ai.streamText (non-generation) immediately, never buffered", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      const outer = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
        name: "ai.streamText",
      });
      getWrapper().onEnd(outer);

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(1);
      expect(mockInnerOnEnd.mock.calls[0][0]).toBe(outer as never);
    });

    it("forwards ai.toolCall immediately, never buffered", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      const tool = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        name: "ai.toolCall",
      });
      getWrapper().onEnd(tool);

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(1);
      expect(mockInnerOnEnd.mock.calls[0][0]).toBe(tool as never);
    });

    it("forwards generation span uncosted when sessionId attribute is missing", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({ traceId: "t1", spanId: "s1" });
      getWrapper().onEnd(span);

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(1);
      expect(mockInnerOnEnd.mock.calls[0][0]).toBe(span as never);
      expect(costAttr(span)).toBeUndefined();
    });

    it("flushes buffered span uncosted when hydration timeout elapses", async () => {
      setupEnv({ LANGFUSE_COST_HYDRATION_TIMEOUT_MS: "20" });
      await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(span);

      // Wait past the timeout
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(1);
      expect(mockInnerOnEnd.mock.calls[0][0]).toBe(span as never);
      expect(costAttr(span)).toBeUndefined();
    });

    it("drains all buffered spans on forceFlush (uncosted)", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      const s1 = makeGenSpan({
        traceId: "t",
        spanId: "s1",
        sessionId: "sess-A",
      });
      const s2 = makeGenSpan({
        traceId: "t",
        spanId: "s2",
        sessionId: "sess-B",
      });
      getWrapper().onEnd(s1);
      getWrapper().onEnd(s2);

      expect(mockInnerOnEnd).not.toHaveBeenCalled();

      await getWrapper().forceFlush();

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(2);
      expect(mockForceFlush).toHaveBeenCalledTimes(1);
      expect(costAttr(s1)).toBeUndefined();
      expect(costAttr(s2)).toBeUndefined();
    });

    it("drains buffered spans on shutdown (uncosted)", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(span);

      await getWrapper().shutdown();

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(1);
      expect(mockShutdown).toHaveBeenCalled();
    });

    it("falls back to total-only when rates are missing for (provider,model)", async () => {
      setupEnv();
      // Default mockProviders returns no providers → rates lookup misses.
      const hooks = await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(span);

      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m1",
          sessionID: "sess-A",
          cost: 0.005,
          modelID: "unknown-model",
          providerID: "unknown-provider",
          tokens: { input: 100, output: 50 },
        })
      );

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(1);
      expect(costAttr(span)).toBe(JSON.stringify({ total: 0.005 }));
    });

    it("ignores user messages (non-assistant role)", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      getWrapper().onEnd(
        makeGenSpan({ traceId: "t1", spanId: "s1", sessionId: "sess-A" })
      );

      await hooks.event!({
        event: {
          type: "message.updated",
          properties: {
            info: { id: "u1", sessionID: "sess-A", role: "user" },
          },
        },
      } as any);

      expect(mockInnerOnEnd).not.toHaveBeenCalled();
    });
  });

  describe("cost split via provider rates", () => {
    // Fixture: one provider with one model. Input $1/MTok, output $3/MTok,
    // cache read $0.30/MTok, cache write $3.75/MTok. Numbers chosen so each
    // component is a clean fraction of a dollar.
    const setupRates = () => {
      mockProviders.mockImplementation(() =>
        Promise.resolve({
          data: {
            providers: [
              {
                id: "anthropic",
                models: {
                  "claude-haiku": {
                    id: "claude-haiku",
                    cost: {
                      input: 1,
                      output: 3,
                      cache: { read: 0.3, write: 3.75 },
                    },
                  },
                },
              },
            ],
          },
        })
      );
    };

    it("splits input/output cost when rates are known", async () => {
      setupEnv();
      setupRates();
      const hooks = await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(span);

      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m1",
          sessionID: "sess-A",
          // info.cost is the trigger only — we recompute from tokens.
          cost: 999,
          modelID: "claude-haiku",
          providerID: "anthropic",
          tokens: { input: 1_000_000, output: 500_000 },
        })
      );

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(1);
      const details = costDetails(span);
      // 1M input @ $1/MTok = $1; 500k output @ $3/MTok = $1.50.
      expect(details.input).toBeCloseTo(1.0, 10);
      expect(details.output).toBeCloseTo(1.5, 10);
      expect(details.total).toBeCloseTo(2.5, 10);
    });

    it("drops zero-valued components from costDetails", async () => {
      setupEnv();
      setupRates();
      const hooks = await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(span);

      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m1",
          sessionID: "sess-A",
          cost: 1,
          modelID: "claude-haiku",
          providerID: "anthropic",
          // No cache, no reasoning — only input + output should appear.
          tokens: { input: 1000, output: 1000 },
        })
      );

      const details = costDetails(span);
      expect(Object.keys(details).sort()).toEqual(
        ["input", "output", "total"].sort()
      );
      expect("cache_read" in details).toBe(false);
      expect("cache_write" in details).toBe(false);
      expect("reasoning" in details).toBe(false);
    });

    it("total equals the sum of its non-total components", async () => {
      setupEnv();
      setupRates();
      const hooks = await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(span);

      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m1",
          sessionID: "sess-A",
          cost: 1,
          modelID: "claude-haiku",
          providerID: "anthropic",
          tokens: {
            input: 200_000,
            output: 100_000,
            reasoning: 50_000,
            cache: { read: 1_000_000, write: 400_000 },
          },
        })
      );

      const details = costDetails(span);
      const sum =
        (details.input ?? 0) +
        (details.output ?? 0) +
        (details.cache_read ?? 0) +
        (details.cache_write ?? 0) +
        (details.reasoning ?? 0);
      expect(details.total).toBeCloseTo(sum, 10);
    });

    it("charges reasoning tokens at the output rate", async () => {
      setupEnv();
      setupRates();
      const hooks = await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(span);

      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m1",
          sessionID: "sess-A",
          cost: 1,
          modelID: "claude-haiku",
          providerID: "anthropic",
          // Only reasoning tokens — proves we don't read a separate rate.
          tokens: { reasoning: 1_000_000 },
        })
      );

      const details = costDetails(span);
      // 1M reasoning × output rate ($3/MTok) = $3.
      expect(details.reasoning).toBeCloseTo(3.0, 10);
      expect(details.total).toBeCloseTo(3.0, 10);
    });

    it("does not call client.config.providers() until first message.updated", async () => {
      setupEnv();
      setupRates();
      await LangfusePlugin(mockPluginInput());

      expect(mockProviders).not.toHaveBeenCalled();
    });

    it("calls client.config.providers() only once across many updates", async () => {
      setupEnv();
      setupRates();
      const hooks = await LangfusePlugin(mockPluginInput());

      const s1 = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      const s2 = makeGenSpan({
        traceId: "t1",
        spanId: "s2",
        sessionId: "sess-A",
      });
      const s3 = makeGenSpan({
        traceId: "t1",
        spanId: "s3",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(s1);
      getWrapper().onEnd(s2);
      getWrapper().onEnd(s3);

      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m1",
          sessionID: "sess-A",
          cost: 0.001,
          modelID: "claude-haiku",
          providerID: "anthropic",
          tokens: { input: 1000 },
        })
      );
      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m2",
          sessionID: "sess-A",
          cost: 0.002,
          modelID: "claude-haiku",
          providerID: "anthropic",
          tokens: { input: 2000 },
        })
      );
      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m3",
          sessionID: "sess-A",
          cost: 0.003,
          modelID: "claude-haiku",
          providerID: "anthropic",
          tokens: { input: 3000 },
        })
      );

      expect(mockProviders).toHaveBeenCalledTimes(1);
    });

    it("falls back to total-only when providers() rejects", async () => {
      setupEnv();
      mockProviders.mockImplementationOnce(() =>
        Promise.reject(new Error("network down"))
      );
      const hooks = await LangfusePlugin(mockPluginInput());

      const span = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(span);

      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m1",
          sessionID: "sess-A",
          cost: 0.42,
          modelID: "claude-haiku",
          providerID: "anthropic",
          tokens: { input: 100, output: 50 },
        })
      );

      expect(mockInnerOnEnd).toHaveBeenCalledTimes(1);
      expect(costDetails(span)).toEqual({ total: 0.42 });
      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "warn",
          message:
            "failed to load provider rates: network down (falling back to total-only cost)",
        },
      });
    });

    it("uses per-step token deltas, not cumulative totals", async () => {
      setupEnv();
      setupRates();
      const hooks = await LangfusePlugin(mockPluginInput());

      const s1 = makeGenSpan({
        traceId: "t1",
        spanId: "s1",
        sessionId: "sess-A",
      });
      const s2 = makeGenSpan({
        traceId: "t1",
        spanId: "s2",
        sessionId: "sess-A",
      });
      getWrapper().onEnd(s1);
      getWrapper().onEnd(s2);

      // First step: 1M input.
      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m1",
          sessionID: "sess-A",
          cost: 1,
          modelID: "claude-haiku",
          providerID: "anthropic",
          tokens: { input: 1_000_000 },
        })
      );
      // Second step (same message id): cumulative 1.5M input → delta 500k.
      await fireMessageUpdated(
        hooks,
        assistantMsg({
          id: "m1",
          sessionID: "sess-A",
          cost: 2,
          modelID: "claude-haiku",
          providerID: "anthropic",
          tokens: { input: 1_500_000 },
        })
      );

      expect(costDetails(s1).input).toBeCloseTo(1.0, 10);
      expect(costDetails(s2).input).toBeCloseTo(0.5, 10);
    });
  });
});
