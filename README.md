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
