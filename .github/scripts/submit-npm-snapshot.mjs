// Reads an npm `package-lock.json` (lockfileVersion >= 2) generated in CI and
// POSTs the resolved dependency tree to GitHub's Dependency Submission API.
// Used to teach GitHub's dependency graph about transitives that it would
// otherwise miss because the source-of-truth lockfile is `bun.lock`, which
// GitHub does not parse. See `.github/workflows/dependency-submission.yml`.

import { readFileSync } from "node:fs";

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

const TOKEN = env("GITHUB_TOKEN");
const SHA = env("GITHUB_SHA");
const REF = env("GITHUB_REF");
const REPO = env("GITHUB_REPOSITORY");
const RUN_ID = env("GITHUB_RUN_ID");
const WORKFLOW = env("GITHUB_WORKFLOW");
const SERVER = process.env.GITHUB_SERVER_URL ?? "https://github.com";
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

const lockPath = process.argv[2] ?? "package-lock.json";
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if ((lock.lockfileVersion ?? 0) < 2) {
  throw new Error(
    `Need lockfileVersion >= 2; got ${lock.lockfileVersion} from ${lockPath}`
  );
}

const rootPkg = lock.packages?.[""] ?? {};
const rootDeps = new Set([
  ...Object.keys(rootPkg.dependencies ?? {}),
  ...Object.keys(rootPkg.devDependencies ?? {}),
  ...Object.keys(rootPkg.optionalDependencies ?? {}),
]);

const purlFor = (name, version) => {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    const scope = name.slice(1, slash);
    const bare = name.slice(slash + 1);
    return `pkg:npm/%40${scope}/${bare}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
};

const resolved = {};
for (const [path, info] of Object.entries(lock.packages ?? {})) {
  if (!path || !info.version) continue;
  if (!path.startsWith("node_modules/")) continue;
  const segments = path.slice("node_modules/".length).split("/node_modules/");
  const name = segments[segments.length - 1];
  const isTopLevel = segments.length === 1;
  resolved[path] = {
    package_url: purlFor(name, info.version),
    relationship: isTopLevel && rootDeps.has(name) ? "direct" : "indirect",
    scope: info.dev ? "development" : "runtime",
  };
}

const snapshot = {
  version: 0,
  sha: SHA,
  ref: REF,
  job: {
    id: RUN_ID,
    correlator: WORKFLOW,
    html_url: `${SERVER}/${REPO}/actions/runs/${RUN_ID}`,
  },
  detector: {
    name: "opencode-plugin-langfuse-npm-lockfile",
    version: "1",
    url: `${SERVER}/${REPO}/blob/main/.github/scripts/submit-npm-snapshot.mjs`,
  },
  scanned: new Date().toISOString(),
  manifests: {
    "package-lock.json": {
      name: "package-lock.json",
      file: { source_location: "package-lock.json" },
      resolved,
    },
  },
};

console.log(
  `Submitting snapshot for ${REPO} @ ${SHA.slice(0, 7)} (${Object.keys(resolved).length} packages)`
);

const res = await fetch(`${API}/repos/${REPO}/dependency-graph/snapshots`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "opencode-plugin-langfuse-dep-submission",
  },
  body: JSON.stringify(snapshot),
});
const body = await res.text();
if (!res.ok) {
  throw new Error(`Snapshot submission failed: HTTP ${res.status}\n${body}`);
}
console.log(`Snapshot submitted: ${body}`);
