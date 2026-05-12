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

One source file: `src/index.ts` (~57 lines). The default export is `LangfusePlugin`, typed as `Plugin` from `@opencode-ai/plugin`. OpenCode invokes it once at startup with `{ client, project, directory, worktree, serverUrl, $ }` and expects an object of lifecycle hooks back.

What the factory does, in order:

1. Reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL` (defaults to `https://cloud.langfuse.com`), `LANGFUSE_ENVIRONMENT` (defaults to `development`), `LANGFUSE_DISPOSE_FLUSH_MS` (defaults to `8000`), `LANGFUSE_TRACE_ID` (32-hex, optional), `LANGFUSE_PARENT_OBSERVATION_ID` (16-hex, optional; requires `LANGFUSE_TRACE_ID`) from `process.env`.
2. If public or secret key is missing, logs a warning and returns `{}` — **no SDK is started.** This is the "tracing disabled" path.
3. Otherwise constructs a `LangfuseSpanProcessor` and starts a `NodeSDK` imperatively via `sdk.start()`. This runs *once* at plugin load — do not move it into a hook.
4. Returns:
   - `config(config)` — warns if `experimental.openTelemetry` is not set in OpenCode's config.
   - `event({ event })` — on `session.idle` calls `processor.forceFlush()`; on `server.instance.disposed` runs a bounded `Promise.race([processor.forceFlush(), setTimeout(LANGFUSE_DISPOSE_FLUSH_MS)])` instead of `sdk.shutdown()` to avoid Bun OTLP keep-alive hangs (oven-sh/bun#13184).

## Conventions

- **No `console.*` in `src/`.** ESLint has `no-console: error` for `src/**/*.ts`. Use the local `log(level, message)` helper which calls `client.app.log({ body: { service: "langfuse-otel", level, message } })`. The `service: "langfuse-otel"` tag is how these logs are filtered in OpenCode's log stream — keep it consistent.
- **Strict TypeScript.** `tsconfig.json` sets `strict: true`. `@typescript-eslint/no-explicit-any` is `warn` in `src/` and `off` in `*.test.ts`.
- **No commit-message enforcement.** Commitlint and the husky `commit-msg` hook were removed when the release pipeline switched to CalVer. Write meaningful commit messages; PR titles drive the auto-generated release notes.
- **Releases use CalVer** (`YYYY.M.MICRO`, no leading zeros) and are triggered by pushing a Git tag matching `v*.*.*`. The `.github/workflows/cd.yml` workflow runs typecheck → test → build → rewrites `package.json:version` to match the tag → `bunx npm publish --provenance --access public` via OIDC trusted publishing (no `NPM_TOKEN`) → `gh release create --generate-notes --verify-tag`. The published package name is `@pdbr/opencode-plugin-langfuse`. Do not hand-bump `version` in commits — the workflow does it in-place per run.

## Testing pattern

`bun:test` with `mock.module()` to stub `@langfuse/otel` and `@opentelemetry/sdk-node` **before** importing the module under test (see top of `src/index.test.ts`). `process.env` is snapshotted in `originalEnv` and restored in `afterEach`. The test file is excluded from the `tsc` build (`tsconfig.json` `exclude`) and from the strict ESLint rules (separate block in `eslint.config.js`).

## Local dogfooding

`.opencode/opencode.jsonc` registers `["../src"]` as a plugin, so running `opencode` from inside this repo loads the plugin directly from source — no rebuild, no `bun link`. `mise.toml` pre-sets `LANGFUSE_DEBUG=true` for that workflow. This is the fastest dev loop; prefer it over the `bun link` flow described in `CONTRIBUTING.md` unless you're specifically testing the published-package surface.

## CI

`.github/workflows/ci.yml` runs `lint`, `format:check`, `typecheck`, and `test` as parallel jobs; `build` runs after they all pass. All jobs use `oven-sh/setup-bun@v2` and `bun install --frozen-lockfile`. **If you change scripts in `package.json`, mirror them in the workflow.**

## Keep this file current

When the repo or its conventions change in ways future Claude sessions need to know about (new scripts, renamed hooks, updated `@opencode-ai/plugin` contract, new env vars, changed release/CI flow, new user preferences), update `CLAUDE.md` in the same change. Same for `README.md` and `CONTRIBUTING.md` when their user-facing surface drifts. This file should describe the repo *as it is*, not as it was.

See `CONTRIBUTING.md` for the contributor-facing version of the dev/test/release flow.
