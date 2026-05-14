# OpenCode Langfuse Plugin

[![npm version](https://badge.fury.io/js/@pdbr%2Fopencode-plugin-langfuse.svg)](https://www.npmjs.com/package/@pdbr/opencode-plugin-langfuse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Automatic LLM observability for OpenCode using Langfuse via OpenTelemetry.**

Zero-config tracing of sessions, messages, tool calls, costs, and performance.

---

## Installation

```bash
bun add @pdbr/opencode-plugin-langfuse
# or
npm install @pdbr/opencode-plugin-langfuse
```

---

## Setup

### 1. Get Langfuse Credentials

Sign up at [cloud.langfuse.com](https://cloud.langfuse.com) and create a project.

Go to **Settings → API Keys** and copy your keys.

### 2. Configure Environment

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASEURL="https://cloud.langfuse.com"  # Optional
```

### 3. Enable Plugin + OTEL

In `.opencode/opencode.json`:

```json
{
  "experimental": {
    "openTelemetry": true
  },
  "plugin": ["@pdbr/opencode-plugin-langfuse"]
}
```

### 4. Run OpenCode

That's it! All traces appear automatically in your Langfuse dashboard.

---

## How It Works

This plugin initializes a `LangfuseSpanProcessor` that captures all OpenTelemetry spans emitted by OpenCode when `experimental.openTelemetry` is enabled.

```
OpenCode (OTEL spans) → LangfuseSpanProcessor → Langfuse Dashboard
```

### Cost hydration from OpenCode

OpenCode's OTel telemetry attaches token counts and the model name to spans
but not cost — cost is computed locally inside OpenCode (using its bundled
pricing tables and your custom-model overrides). For models that aren't in
Langfuse Cloud's built-in pricing table (custom proxies, rotating gateway
models, self-hosted endpoints), generations would otherwise show up with
tokens but `cost = $0`.

The plugin closes that gap by setting Langfuse's documented OTel attribute
`langfuse.observation.cost_details` on the AI SDK generation span **before
it exports**, so the span ships once with cost already in place:

1. The wrapper buffers every inner generation span the AI SDK emits — names
   matching `^ai\.(generateText|streamText|generateObject|streamObject)\.do(Generate|Stream)$`
   with a non-empty `ai.telemetry.metadata.sessionId` attribute — into a
   per-`sessionId` FIFO. Non-generation spans (outer wrappers, tool calls,
   anything else) are forwarded to the inner `LangfuseSpanProcessor`
   immediately.
2. On OpenCode's `message.updated` event, the plugin computes the per-step
   cost delta (`info.cost - lastSeenCost`), pops the oldest buffered span
   for that session, mutates
   `span.attributes['langfuse.observation.cost_details'] = '{"total":Δcost}'`,
   then forwards to the inner processor.
3. If no `message.updated` arrives within `LANGFUSE_COST_HYDRATION_TIMEOUT_MS`
   (default 10s), the buffered span is flushed uncosted — tokens still arrive
   via OTel.

OpenCode runs steps strictly serially per session, so the k-th
`message.updated` after a message starts maps to the k-th buffered
generation span ended after that message started. No extra correlation key
is needed at the plugin layer.

Behaviour is fully defensive:

- `cost === 0`, `null`, `undefined`, or `NaN` → no cost attached; buffered
  span flushes uncosted at the timeout. Local/free models still get their
  tokens via OTel.
- No buffered span matches when `message.updated` fires → silently logged at
  `info` and skipped.
- Missing Langfuse credentials → none of this code runs (plugin returns `{}`
  early, same as before).

Known limitations:

- If OpenCode sub-agents ever share a parent session ID, the FIFO may
  attribute the wrong cost slice to a peer span in the same session. As of
  current OpenCode, sub-agents run in their own sessions, so this is
  theoretical for v1.
- A plugin reload mid-session resets the cost map; the first
  `message.updated` after reload treats the running cost as the delta. Slight
  over-attribution on that single step; subsequent steps are correct.

### Trace stitching

When OpenCode is invoked as a sub-step of a larger AI workflow, you can stitch its spans into the caller's existing Langfuse trace by setting two environment variables before launching `opencode`:

- `LANGFUSE_TRACE_ID` (32-char hex) — reuse this trace ID for all spans the plugin emits.
- `LANGFUSE_PARENT_OBSERVATION_ID` (16-char hex, requires the above) — nest every root span under this parent observation.

```
caller's trace ──┐
                 └── parent observation
                       └── OpenCode session
                             ├── tool: read
                             ├── tool: edit
                             └── llm: generation
```

Design ported from upstream PR `omercnet/opencode-plugin-langfuse#17`.

---

## Environment Variables

| Variable                         | Required | Default                      | Description                                                                                                            |
| -------------------------------- | -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `LANGFUSE_PUBLIC_KEY`            | Yes      | -                            | Langfuse public key                                                                                                    |
| `LANGFUSE_SECRET_KEY`            | Yes      | -                            | Langfuse secret key                                                                                                    |
| `LANGFUSE_BASEURL`               | No       | `https://cloud.langfuse.com` | Self-hosted instance                                                                                                   |
| `LANGFUSE_DISPOSE_FLUSH_MS`      | No       | `8000`                       | Bounded timeout (ms) for the final span flush when the OpenCode server is disposed; prevents Bun OTLP keep-alive hangs |
| `LANGFUSE_COST_HYDRATION_TIMEOUT_MS` | No  | `10000`                      | Max time (ms) a generation span is buffered while waiting for the matching `message.updated`. On timeout it ships uncosted. |
| `LANGFUSE_TRACE_ID`              | No       | -                            | 32-char hex; reuse this trace ID for all spans (caller-set)                                                            |
| `LANGFUSE_PARENT_OBSERVATION_ID` | No       | -                            | 16-char hex; nest spans under this parent observation (caller-set, requires `LANGFUSE_TRACE_ID`)                       |

---

## Self-Hosting

```bash
export LANGFUSE_BASEURL="https://langfuse.yourcompany.com"
```

See [Langfuse self-hosting docs](https://langfuse.com/docs/deployment/self-host).

---

## Troubleshooting

### No traces appearing

1. Verify `experimental.openTelemetry: true` is set
2. Check credentials: `echo $LANGFUSE_PUBLIC_KEY`
3. Check Langfuse health: `curl https://cloud.langfuse.com/api/public/health`

### Plugin not loading

- Ensure `@pdbr/opencode-plugin-langfuse` is in `dependencies` (not `devDependencies`)
- Verify `.opencode/opencode.json` syntax

---

## License

MIT © pdbr

---

## Related

- [OpenCode](https://opencode.ai/)
- [Langfuse](https://langfuse.com/)
- [Langfuse OTEL Integration](https://langfuse.com/docs/integrations/opentelemetry)
