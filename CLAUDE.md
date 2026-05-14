# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## Common commands

All scripts are bun-first (`tsc` and `eslint` are invoked through `bun run`).

- `bun install` — install dependencies
- `bun run build` — `tsc` → `dist/`
- `bun run dev` — `tsc --watch`
- `bun run typecheck` — `tsc --noEmit`
- `bun run lint` / `bun run lint:fix` — ESLint over `src/**/*.ts`
- `bun run format` / `bun run format:check` — Prettier
- `bun test` — full suite via `bun:test`
- `bun test src/index.test.ts -t "<name substring>"` — run a single test by name

## Architecture

One source file: `src/index.ts`. The default export is `LangfusePlugin`, typed as `Plugin` from `@opencode-ai/plugin`. OpenCode invokes it once at startup with `{ client, project, directory, worktree, serverUrl, $ }` and expects an object of lifecycle hooks back.

What the factory does, in order:

1. Reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL` (defaults to `https://cloud.langfuse.com`), `LANGFUSE_ENVIRONMENT` (defaults to `development`), `LANGFUSE_DISPOSE_FLUSH_MS` (defaults to `8000`), `LANGFUSE_COST_HYDRATION_TIMEOUT_MS` (defaults to `10000`), `LANGFUSE_TRACE_ID` (32-hex, optional), `LANGFUSE_PARENT_OBSERVATION_ID` (16-hex, optional; requires `LANGFUSE_TRACE_ID`) from `process.env`.
2. If public or secret key is missing, logs a warning and returns `{}` — **no SDK is started.** This is the "tracing disabled" path.
3. Otherwise constructs a `LangfuseSpanProcessor`, wraps it in `CostHydratingSpanProcessor`, and starts a `NodeSDK` imperatively via `sdk.start()` with the wrapping processor. This runs *once* at plugin load — do not move it into a hook.
4. Returns:
   - `config(config)` — warns if `experimental.openTelemetry` is not set in OpenCode's config.
   - `event({ event })`:
     - `message.updated` → if `info.role === "assistant"`, computes `Δcost = info.cost - lastSeenCost`, and on a positive delta calls `costProcessor.attachCost(sessionID, Δcost)` to hydrate the next buffered generation span. Defensive on every failure mode (zero/null/NaN cost, no matching buffered span).
     - `session.idle` → `costProcessor.forceFlush()` (drains buffered spans uncosted, then inner flush).
     - `server.instance.disposed` → bounded `Promise.race([costProcessor.forceFlush(), setTimeout(LANGFUSE_DISPOSE_FLUSH_MS)])` instead of `sdk.shutdown()` to avoid Bun OTLP keep-alive hangs (oven-sh/bun#13184).

### Cost hydration path

OpenCode computes cost locally (per `session/session.ts`) but never attaches it to the OTel span the AI SDK ships. Langfuse Cloud therefore shows `cost = $0` for any model outside its built-in pricing table. The plugin closes this gap by setting Langfuse's documented OTel attribute `langfuse.observation.cost_details` (a JSON string) on the generation span **before it exports**:

1. `CostHydratingSpanProcessor.onEnd` buffers every AI SDK inner generation span — names matching `/^ai\.(generateText|streamText|generateObject|streamObject)\.do(Generate|Stream)$/` with `instrumentationScope.name === "ai"` and a non-empty `ai.telemetry.metadata.sessionId` attribute — into a per-`sessionId` FIFO. Non-generation spans (outer wrappers, tool calls, anything else) are forwarded to the inner processor immediately. Buffered spans are NOT forwarded yet.
2. Each buffered span gets a `setTimeout` for `LANGFUSE_COST_HYDRATION_TIMEOUT_MS` (default 10s). If no `message.updated` arrives in time, the span ships uncosted via `inner.onEnd`. Per-session FIFO is bounded at 64 entries; on overflow the oldest is evicted (forwarded uncosted) to make room.
3. On `message.updated` with `Δcost > 0` (cost is the *trigger*, not the value), the plugin computes per-component cost from token deltas × per-million rates and calls `attachCost(sessionID, costDetails)` which pops the oldest buffered span for that session, mutates `span.attributes['langfuse.observation.cost_details'] = JSON.stringify(costDetails)`, and forwards to `inner.onEnd`. The span ships once, with cost already in place.

`costDetails` shape: `{input?, output?, cache_read?, cache_write?, reasoning?, total}` — zero-valued components are dropped so models without prompt caching don't clutter the payload. `total` is recomputed from the component sum (not from `info.cost`) so the per-trace breakdown and the grand total are internally consistent; sub-cent rounding drift from OpenCode's `Decimal.js` math is expected and accepted. Rates come from `client.config.providers()`, fetched lazily on the first costed `message.updated` and memoised for the plugin's lifetime. Reasoning tokens are charged at the **output** rate, mirroring `session.ts:431-440` (upstream TODO — revisit on opencode dependency bumps).

When `(providerID, modelID)` isn't in the registry (or the fetch fails), the plugin falls back to `{total: Δcost}` from `info.cost` — same payload shape as the pre-split implementation, so no regression.

Correlation is FIFO within a `sessionID` (k-th `message.updated` ↔ k-th buffered generation span), justified by OpenCode running steps strictly serially per session (`session/processor.ts` accumulates cost then yields `updateMessage` per step). State: `bufferedBySession: Map<string, BufferedSpan[]>` (held by the processor) and `stateByMessage: Map<string, {cost: number; tokens: TokenSnapshot}>` (held by the plugin closure).

### Why not `generation-update` via the ingestion API

An earlier design wrote cost via `LangfuseAPIClient.ingestion.batch({type: "generation-update"})` keyed by the OTel span ID. Production behaviour: the synchronous API write reached Langfuse *before* the OTel-batched export (~5s `BatchSpanProcessor` delay), Langfuse created a stub observation with that ID and our `costDetails`, then refused to backfill name/model/parent/tokens when the OTel doStream span arrived later — leaving the observation gutted (only costDetails present). Span-attribute mutation avoids the race entirely: one write, one observation, cost included from the start. Do not reintroduce the ingestion-API path.

## Conventions

- **No `console.*` in `src/`.** ESLint has `no-console: error` for `src/**/*.ts`. Use the local `log(level, message)` helper which calls `client.app.log({ body: { service: "langfuse-otel", level, message } })`. The `service: "langfuse-otel"` tag is how these logs are filtered in OpenCode's log stream — keep it consistent.
- **Strict TypeScript.** `tsconfig.json` sets `strict: true`. `@typescript-eslint/no-explicit-any` is `warn` in `src/` and `off` in `*.test.ts`.
- **No commit-message enforcement.** Commitlint and the husky `commit-msg` hook were removed when the release pipeline switched to CalVer. Write meaningful commit messages; PR titles drive the auto-generated release notes.
- **Releases use CalVer** (`YYYY.M.MICRO`, no leading zeros) and are triggered by pushing a Git tag matching `v*.*.*`. The `.github/workflows/cd.yml` workflow runs typecheck → test → build → rewrites `package.json:version` to match the tag → `bunx npm publish --provenance --access public` via OIDC trusted publishing (no `NPM_TOKEN`) → `gh release create --generate-notes --verify-tag`. The published package name is `@pdbr/opencode-plugin-langfuse`. Do not hand-bump `version` in commits — the workflow does it in-place per run.

## Testing pattern

`bun:test` with `mock.module()` to stub `@langfuse/otel` and `@opentelemetry/sdk-node` **before** importing the module under test (see top of `src/index.test.ts`). To exercise the cost-hydrating wrapper, tests reach into `capturedNodeSDKOptions.spanProcessors[0]` (the live wrapper instance) and call its `onEnd(fakeSpan)` directly — the wrapper class is private to the module. Tests assert on `mockInnerOnEnd` (whether/when the wrapper forwards to the inner LangfuseSpanProcessor) and on the span's `attributes['langfuse.observation.cost_details']` value (whether cost was attached). `process.env` is snapshotted in `originalEnv` and restored in `afterEach`. The default `setupEnv()` pins `LANGFUSE_COST_HYDRATION_TIMEOUT_MS=60000` so timer-driven flushes don't fire in tests that don't explicitly exercise that path. The test file is excluded from the `tsc` build (`tsconfig.json` `exclude`) and from the strict ESLint rules (separate block in `eslint.config.js`).

## Local dogfooding

`.opencode/opencode.jsonc` registers `["../src"]` as a plugin, so running `opencode` from inside this repo loads the plugin directly from source — no rebuild, no `bun link`. `mise.toml` pre-sets `LANGFUSE_DEBUG=true` for that workflow. This is the fastest dev loop; prefer it over the `bun link` flow described in `CONTRIBUTING.md` unless you're specifically testing the published-package surface.

## CI

`.github/workflows/ci.yml` runs `lint`, `format:check`, `typecheck`, and `test` as parallel jobs; `build` runs after they all pass. All jobs use `oven-sh/setup-bun@v2` and `bun install --frozen-lockfile`. **If you change scripts in `package.json`, mirror them in the workflow.**

## Keep this file current

When the repo or its conventions change in ways future Claude sessions need to know about (new scripts, renamed hooks, updated `@opencode-ai/plugin` contract, new env vars, changed release/CI flow, new user preferences), update `CLAUDE.md` in the same change. Same for `README.md` and `CONTRIBUTING.md` when their user-facing surface drifts. This file should describe the repo *as it is*, not as it was.

See `CONTRIBUTING.md` for the contributor-facing version of the dev/test/release flow.
