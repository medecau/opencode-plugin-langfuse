# Contributing to @pdbr/opencode-plugin-langfuse

Thank you for your interest in contributing!

## Development Setup

```bash
# Clone the repo
git clone https://github.com/medecau/opencode-plugin-langfuse.git
cd opencode-plugin-langfuse

# Install dependencies
bun install

# Build
bun run build

# Watch mode
bun run dev

# Type check
bun run typecheck

# Lint
bun run lint

# Format
bun run format
```

## Testing Locally

The fastest loop is the in-repo dogfood: `.opencode/opencode.jsonc` already
registers `["../src"]` as a plugin, so running `opencode` from inside this
repo loads the plugin directly from source — no rebuild, no `bun link`.

If you need to exercise the published-package surface instead:

### Option 1: Link in Another Project

```bash
# In plugin directory
bun link

# In your project
cd /path/to/your-opencode-project
bun link @pdbr/opencode-plugin-langfuse
```

Then configure in `.opencode/opencode.json`:

```json
{
  "plugin": ["@pdbr/opencode-plugin-langfuse"]
}
```

### Option 2: Use Relative Path

In your `.opencode/opencode.json`:

```json
{
  "plugin": ["file:../opencode-plugin-langfuse"]
}
```

## Code Style

- TypeScript strict mode
- ESLint + Prettier
- 2 spaces indentation
- Semicolons required
- Single quotes for strings (except in JSON)

## Commit Messages

Write meaningful commit messages that describe the change and (when
non-obvious) the motivation. There is no Conventional Commits enforcement —
commitlint was removed when the release pipeline switched to CalVer.

PR titles feed directly into GitHub's auto-generated release notes, so prefer
clear, user-facing PR titles over commit-by-commit prefixes.

## Pull Request Process

1. Fork the repo
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Run tests: `bun test`
5. Type check: `bun run typecheck`
6. Lint: `bun run lint`
7. Format: `bun run format`
8. Push and open a PR

## Release Process (Maintainers Only)

Releases use **CalVer** (`YYYY.M.MICRO`, no leading zeros) and are triggered
by pushing a Git tag. The `.github/workflows/cd.yml` workflow then runs
typecheck → test → build → `npm publish --provenance` (via OIDC, no
`NPM_TOKEN` required) → `gh release create --generate-notes`.

```bash
# 1. See the latest tag
git tag --sort=-v:refname | head -1

# 2. Compute next:
#    same month  → bump MICRO
#    new month   → reset MICRO to 0
# Example for May 2026:
git tag v2026.5.0
git push origin v2026.5.0
```

The workflow rewrites `package.json:version` in-place at run time, so do not
hand-bump the version in commits.

### One-time setup

Before the first release, configure npm trusted publishing on
[npmjs.com](https://www.npmjs.com) → Settings → Trusted Publishers, with the
GitHub Actions provider pointing at this repo and the `cd.yml` workflow.

## Questions?

Open an issue or discussion on GitHub.
