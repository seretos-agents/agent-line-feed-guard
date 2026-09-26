#!/usr/bin/env node
/**
 * Tests for the release scripts (epic #11 / #7 / #6):
 *   - prev-release-tag.sh   <plugin> <new-version>            (stdin: tag list)
 *   - release-preflight.sh  <repo> <plugin> <version>         (stdin: tag list)
 *   - marketplace-payload.sh                                   (env only)
 *
 * Plain Node.js — no test framework, no external dependencies, same
 * test()/assert() shape as scripts/line-feed-guard-hook.test.mjs.
 * Exit code 0 = all pass, non-zero = at least one failure.
 *
 * The scripts under test are real bash scripts, run through
 * spawnSync(BASH, [script, ...args]) with the tag list piped in on stdin,
 * exactly as release.yml will invoke them (`git tag -l | bash .../foo.sh`).
 * `BASH` is the absolute Git-for-Windows bash on win32 (this suite does not
 * rely on WSL or on bash being first on PATH there) and plain `bash`
 * elsewhere. Windows-runner coverage of release.yml itself is out of scope
 * (see the plan); this suite runs the same real scripts a Linux Actions
 * runner would run, just from a Windows dev machine.
 *
 * ---------------------------------------------------------------------------
 * Fake `gh` contract (release-preflight.sh's only external dependency)
 * ---------------------------------------------------------------------------
 * A single executable `gh` bash stub is written once (GH_STUB_DIR, prepended
 * to PATH for every preflight invocation) that answers only
 * `gh api repos/.../git/ref/tags/<name>`:
 *
 *   - `<name>` listed in the comma-separated env var FAKE_GH_ERROR_REFS
 *       -> exit 1, stderr "gh: Unauthorized (HTTP 401)"   (a real API error,
 *          NOT a 404 — the ref's existence is genuinely unknown)
 *   - `<name>` listed in the comma-separated env var FAKE_GH_REFS
 *       -> exit 0                                          (ref exists)
 *   - otherwise
 *       -> exit 1, stderr "gh: Not Found (HTTP 404)"        (ref absent)
 *
 * release-preflight.sh must tell "absent" (404) apart from "unknown" (any
 * other failure) rather than treating every non-zero `gh api` exit as
 * absence — see plan-critic finding misread::F2. Without that distinction,
 * a transient auth/rate-limit/5xx error on the "does <TAG> already exist?"
 * check would be silently read as "it doesn't", and the run would proceed
 * into the zip/push/orphan steps on a false premise. The "transient gh api
 * failure" test below exercises exactly this.
 *
 * `release-preflight.sh` also reads two env vars that are not gh calls:
 *   - GITHUB_REF     (Actions always sets this; passed straight through)
 *   - DEFAULT_BRANCH (assumed to be an env var the workflow step sets from
 *     `github.event.repository.default_branch`, the same style as
 *     GITHUB_REF — the plan's Approach section names the check
 *     ("Fail unless GITHUB_REF == refs/heads/$DEFAULT_BRANCH") but not
 *     where DEFAULT_BRANCH comes from; plan-critic finding untestable::F1
 *     flags this gap. An env var is the only way this suite can drive the
 *     "not on the default branch" edge case without a gh API round trip, so
 *     that is the contract these tests assume. Flagged in the change report
 *     as an assumption for the orchestrator/planner to confirm.)
 *
 * `release-preflight.sh` reads `git rev-parse HEAD` from its own cwd for
 * main_sha, so every preflight test runs with cwd set to a real `git init`
 * temp repo with one commit (per the plan's suite design).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASH = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

// ---------------------------------------------------------------------------
// Minimal test harness (same shape as scripts/line-feed-guard-hook.test.mjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TMP_ROOTS = [];

function mkTmp(prefix = "rst-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_ROOTS.push(dir);
  return dir;
}

function runScript(name, args, { input = "", cwd, env = {} } = {}) {
  const scriptPath = path.join(SCRIPTS_DIR, name);
  const result = spawnSync(BASH, [scriptPath, ...args], {
    input,
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

/** One generic `gh` stub, reused by every preflight test; see the module doc comment. */
const GH_STUB_SCRIPT = [
  "#!/usr/bin/env bash",
  'if [ "$1" = "api" ]; then',
  '  path="$2"',
  '  name="${path##*tags/}"',
  "  IFS=',' read -ra ERR_REFS <<< \"${FAKE_GH_ERROR_REFS:-}\"",
  '  for r in "${ERR_REFS[@]}"; do',
  '    if [ "$r" = "$name" ]; then',
  '      echo "gh: Unauthorized (HTTP 401)" >&2',
  "      exit 1",
  "    fi",
  "  done",
  "  IFS=',' read -ra REFS <<< \"${FAKE_GH_REFS:-}\"",
  '  for r in "${REFS[@]}"; do',
  '    if [ "$r" = "$name" ]; then',
  "      exit 0",
  "    fi",
  "  done",
  '  echo "gh: Not Found (HTTP 404)" >&2',
  "  exit 1",
  "fi",
  "exit 1",
  "",
].join("\n");

function mkGhStub() {
  const dir = mkTmp("rst-ghstub-");
  const ghPath = path.join(dir, "gh");
  fs.writeFileSync(ghPath, GH_STUB_SCRIPT);
  fs.chmodSync(ghPath, 0o755);
  return dir;
}

const GH_STUB_DIR = mkGhStub();

/** A real `git init` temp repo with one commit, so `main_sha` is real. */
function initGitRepo() {
  const dir = mkTmp("rst-git-");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "x");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  return { dir, sha };
}

function runPreflight(args, { tags = [], githubRef = "refs/heads/main", defaultBranch = "main", ghRefs = [], ghErrorRefs = [], cwd } = {}) {
  return runScript("release-preflight.sh", args, {
    input: tags.length ? tags.join("\n") + "\n" : "",
    cwd,
    env: {
      GITHUB_REF: githubRef,
      DEFAULT_BRANCH: defaultBranch,
      FAKE_GH_REFS: ghRefs.join(","),
      FAKE_GH_ERROR_REFS: ghErrorRefs.join(","),
      PATH: GH_STUB_DIR + path.delimiter + process.env.PATH,
    },
  });
}

function runPayload(env) {
  return runScript("marketplace-payload.sh", [], { env });
}

/** Parses the `key=value` lines release-preflight.sh prints on success. */
function parseKV(output) {
  const map = {};
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

// ---------------------------------------------------------------------------
// R1 — prev-release-tag.sh: prev-tag resolution
// ---------------------------------------------------------------------------

console.log("\nprev-release-tag.sh");

// Per test-critic finding tautology::F1 (round 2): every exclusion fixture
// below previously sat AT OR ABOVE the new version (0.1.0), so the
// "strictly below <new-version>" threshold rule alone removed them — the
// src/, foreign-plugin and malformed-semver filters were never actually
// exercised. Fixed by giving each excluded tag a precedence BELOW the new
// version but ABOVE the true answer (a--v0.9.0-rc.10): an implementation
// missing any one of those three filters would then surface that tag's
// version as a *different*, wrong "previous" tag instead of failing to
// change the result, so the exact-stdout assertion below only passes when
// all three filters are genuinely applied.
test("prev-release-tag: rc.10 beats rc.2, excludes new/src/foreign/malformed", () => {
  const stdin =
    [
      "a--v0.9.0-rc.2",
      "a--v0.9.0-rc.10",
      "a--v0.5.0",
      "a--v1.0.0", // the tag being created — must be excluded
      "src/a--v0.9.5", // src/* marker, precedence ABOVE the true answer but below the new version — must be excluded
      "b--v0.9.7", // foreign plugin, precedence ABOVE the src/ tag but below the new version — must be excluded
      "a--v0.9.8-rc.01", // malformed (leading-zero numeric prerelease id), precedence ABOVE the foreign tag but below the new version — must be excluded
    ].join("\n") + "\n";
  const res = runScript("prev-release-tag.sh", ["a", "1.0.0"], { input: stdin });
  assertEqual(res.status, 0, "exit code");
  assertEqual(res.stdout, "a--v0.9.0-rc.10\n", "stdout");
});

test("prev-release-tag: first release (empty stdin) prints nothing, exit 0", () => {
  const res = runScript("prev-release-tag.sh", ["a", "0.1.0"], { input: "" });
  assertEqual(res.status, 0, "exit code");
  assertEqual(res.stdout, "", "stdout");
});

// Per test-critic finding tautology::F1 (round 2): both fixture tags
// previously sat above the new version (0.1.0), so they were removed by the
// threshold rule regardless of whether the src/ and foreign-plugin filters
// existed. Fixed by putting both below the new version (1.0.0): a missing
// filter would then surface one of them as a non-empty (wrong) answer,
// instead of "nothing" being the only reachable output either way.
test("prev-release-tag: first release (only foreign/src tags) prints nothing, exit 0", () => {
  const stdin = ["src/a--v0.5.0", "b--v0.7.0"].join("\n") + "\n";
  const res = runScript("prev-release-tag.sh", ["a", "1.0.0"], { input: stdin });
  assertEqual(res.status, 0, "exit code");
  assertEqual(res.stdout, "", "stdout");
});

test("prev-release-tag: a release sorts above its own prerelease", () => {
  const stdin = ["a--v0.1.0-rc.1", "a--v0.1.0"].join("\n") + "\n";
  const res = runScript("prev-release-tag.sh", ["a", "0.2.0"], { input: stdin });
  assertEqual(res.status, 0, "exit code");
  assertEqual(res.stdout, "a--v0.1.0\n", "stdout");
});

test("prev-release-tag: 1.10.0 sorts above 1.9.0 (no lexical trap)", () => {
  const stdin = ["a--v1.9.0", "a--v1.10.0"].join("\n") + "\n";
  const res = runScript("prev-release-tag.sh", ["a", "2.0.0"], { input: stdin });
  assertEqual(res.status, 0, "exit code");
  assertEqual(res.stdout, "a--v1.10.0\n", "stdout");
});

// Per test-critic finding tautology::F4: no prior fixture contains a
// same-plugin tag whose SemVer precedence is ABOVE the new version being
// created, so "highest tag strictly below <new-version>" (the plan's exact
// wording) could not be told apart from "highest tag other than the new one".
// This can happen for real with out-of-order manual releases or a hotfix cut
// on an old version line after a newer one already shipped. The plan's own
// Approach text ("the highest ... tag whose precedence is strictly below
// <new-version>") settles this directly: a higher-precedence tag must never
// be treated as "the previous release" relative to a lower new version.
test("prev-release-tag: a higher-precedence tag above the new version is not 'previous'", () => {
  const stdin = ["a--v0.9.0", "a--v2.0.0", "a--v1.0.0"].join("\n") + "\n"; // v1.0.0 is the tag being created
  const res = runScript("prev-release-tag.sh", ["a", "1.0.0"], { input: stdin });
  assertEqual(res.status, 0, "exit code");
  assertEqual(
    res.stdout,
    "a--v0.9.0\n",
    "must resolve to the highest tag strictly below the new version (v0.9.0), not the higher-precedence v2.0.0"
  );
});

test("prev-release-tag: an invalid new version exits 2 with ::error::", () => {
  for (const bad of ["1.0", "01.0.0", "1.0.0-"]) {
    const res = runScript("prev-release-tag.sh", ["a", bad], { input: "" });
    assertEqual(res.status, 2, `exit code for '${bad}'`);
    assert((res.stdout + res.stderr).includes("::error::"), `::error:: present for '${bad}'`);
  }
});

// ---------------------------------------------------------------------------
// R2 — release-preflight.sh: blocks before any side effect
// ---------------------------------------------------------------------------

console.log("\nrelease-preflight.sh");

// pre-flight cannot know the previous release run's historical head_sha — that
// SHA lives only in the Actions run for <PREV_TAG> and is read by a human, per
// the plan's post-merge bootstrap note ("create src/<PREV_TAG> ... from the
// head_sha of that tag's release run"). This test therefore asserts the
// instructional/placeholder wording the plan specifies verbatim, with the
// real <PREV_TAG> name substituted, and explicitly rejects an implementation
// that substitutes the *current* repo's HEAD in place of that placeholder
// (see test-critic finding tautology::F1) — that would silently tell a human
// to bootstrap the marker at the wrong (new-release) commit.
test("preflight: missing src/<PREV> prints the exact bootstrap commands", () => {
  const repo = initGitRepo();
  const res = runPreflight(["owner/repo", "agent-line-feed-guard", "0.0.2"], {
    tags: ["agent-line-feed-guard--v0.0.1"],
    cwd: repo.dir,
    ghRefs: [], // neither the new TAG nor src/PREV exist
  });
  assertEqual(res.status, 1, "exit code");
  const out = res.stdout + res.stderr;
  assert(
    out.includes("read head_sha from the Actions run of `agent-line-feed-guard--v0.0.1`") ||
      out.includes("read head_sha from the Actions run of agent-line-feed-guard--v0.0.1"),
    "instructs a human to read head_sha from the PREV_TAG's own Actions run"
  );
  assert(
    out.includes("git tag src/agent-line-feed-guard--v0.0.1 <head_sha>"),
    "bootstrap 'git tag src/...' command uses the <head_sha> placeholder, not a real SHA"
  );
  assert(
    !out.includes(`git tag src/agent-line-feed-guard--v0.0.1 ${repo.sha}`),
    "must NOT substitute the current repo's HEAD for the historical head_sha placeholder"
  );
  assert(
    out.includes("git push origin src/agent-line-feed-guard--v0.0.1"),
    "bootstrap 'git push origin src/...' command"
  );
});

// Per test-critic finding tautology::F2 (round 2): src/PREV was previously
// left missing here, so check 5 (missing src/<PREV_TAG>) alone produced the
// exit 1 regardless of whether check 4 (src/<TAG> exists) did anything.
// Fixed by also bootstrapping src/PREV in ghRefs, isolating check 4 as the
// only remaining check that can cause the failure — matching how the
// sibling "<TAG> exists" test below was already fixed.
test("preflight: an existing src/<TAG> blocks and names it", () => {
  const repo = initGitRepo();
  const res = runPreflight(["owner/repo", "agent-line-feed-guard", "0.0.2"], {
    tags: ["agent-line-feed-guard--v0.0.1"],
    cwd: repo.dir,
    ghRefs: ["src/agent-line-feed-guard--v0.0.1", "src/agent-line-feed-guard--v0.0.2"],
  });
  assertEqual(res.status, 1, "exit code");
  assert(
    (res.stdout + res.stderr).includes("src/agent-line-feed-guard--v0.0.2"),
    "names the offending src/<TAG>"
  );
});

// src/PREV must be present here so check 5 (missing src/<PREV_TAG>) cannot be
// the thing that forces exit 1 — otherwise this test would pass regardless of
// whether the <TAG>-exists check (check 3) does anything at all (see
// test-critic finding tautology::F2). With src/PREV satisfied and <TAG>
// itself present, only check 3 can be the cause, and the message must name
// the offending <TAG> to prove it, not just any exit 1.
test("preflight: an existing <TAG> blocks", () => {
  const repo = initGitRepo();
  const res = runPreflight(["owner/repo", "agent-line-feed-guard", "0.0.2"], {
    tags: ["agent-line-feed-guard--v0.0.1"],
    cwd: repo.dir,
    ghRefs: ["src/agent-line-feed-guard--v0.0.1", "agent-line-feed-guard--v0.0.2"],
  });
  assertEqual(res.status, 1, "exit code");
  assert(
    (res.stdout + res.stderr).includes("agent-line-feed-guard--v0.0.2"),
    "names the existing <TAG> that caused the block"
  );
});

// src/PREV must be present and <TAG> absent here so that checks 3-5 are all
// satisfied and cannot be what forces exit 1 — otherwise this test would pass
// regardless of whether the default-branch check (check 1) does anything at
// all (see test-critic finding tautology::F3; runPreflight's ghRefs default
// of [] previously left src/PREV missing, so check 5 alone explained the
// exit 1). With every other check satisfied, only the branch check can cause
// the failure, and the message must be about the branch, not a generic
// exit 1 — the plan does not fix exact wording for this message, so this
// asserts on the branch value/keyword actually being present rather than a
// literal string.
test("preflight: GITHUB_REF off the default branch is rejected", () => {
  const repo = initGitRepo();
  const res = runPreflight(["owner/repo", "agent-line-feed-guard", "0.0.2"], {
    tags: ["agent-line-feed-guard--v0.0.1"],
    cwd: repo.dir,
    ghRefs: ["src/agent-line-feed-guard--v0.0.1"], // PREV's marker already bootstrapped; <TAG> absent
    githubRef: "refs/heads/feature-x",
    defaultBranch: "main",
  });
  assertEqual(res.status, 1, "exit code");
  const out = res.stdout + res.stderr;
  assert(
    out.includes("refs/heads/feature-x") || /branch/i.test(out),
    "error message is specific to the branch check (names the actual ref or says 'branch'), not a generic exit 1"
  );
  assert(
    !out.includes("agent-line-feed-guard--v0.0.2"),
    "must not be the <TAG>/src-<TAG> checks firing instead (they are satisfied by this fixture)"
  );
});

test("preflight: first release (no tags) succeeds with an empty prev_tag", () => {
  const repo = initGitRepo();
  const res = runPreflight(["owner/repo", "agent-line-feed-guard", "0.0.1"], {
    tags: [],
    cwd: repo.dir,
    ghRefs: [],
  });
  assertEqual(res.status, 0, "exit code");
  const kv = parseKV(res.stdout);
  assertEqual(kv.tag, "agent-line-feed-guard--v0.0.1", "tag");
  assertEqual(kv.prev_tag, "", "prev_tag must be empty on a first release");
  assertEqual(kv.main_sha, repo.sha, "main_sha");
});

test("preflight: happy path emits tag / prev_tag / main_sha", () => {
  const repo = initGitRepo();
  const res = runPreflight(["owner/repo", "agent-line-feed-guard", "0.0.2"], {
    tags: ["agent-line-feed-guard--v0.0.1"],
    cwd: repo.dir,
    ghRefs: ["src/agent-line-feed-guard--v0.0.1"], // PREV's marker already bootstrapped
  });
  assertEqual(res.status, 0, "exit code");
  const kv = parseKV(res.stdout);
  assertEqual(kv.tag, "agent-line-feed-guard--v0.0.2", "tag");
  assertEqual(kv.prev_tag, "agent-line-feed-guard--v0.0.1", "prev_tag");
  assertEqual(kv.main_sha, repo.sha, "main_sha");
});

// Added per plan-critic finding misread::F2 (see the module doc comment):
// any non-zero `gh api` exit must not be read as "the tag is absent". Only a
// genuine 404 means absent; an auth/rate-limit/5xx error must stop the run
// with a hard failure, not wave it through as "safe to create".
test("preflight: a transient gh api failure (not a 404) is a hard failure, not treated as absent", () => {
  const repo = initGitRepo();
  // src/PREV is made to exist so that, if (and only if) the buggy reading
  // ("any non-zero gh exit means absent") were applied to the <TAG> check
  // below, every remaining check would also read as satisfied and the run
  // would reach the success stanza. That is exactly the false-negative
  // misread::F2 warns about: the test must fail (wrongly go green) under
  // that reading and only pass once <TAG>'s 401 is treated as "unknown",
  // not "absent".
  const res = runPreflight(["owner/repo", "agent-line-feed-guard", "0.0.2"], {
    tags: ["agent-line-feed-guard--v0.0.1"],
    cwd: repo.dir,
    ghRefs: ["src/agent-line-feed-guard--v0.0.1"], // src/PREV already bootstrapped
    ghErrorRefs: ["agent-line-feed-guard--v0.0.2"], // the <TAG> existence check errors, not 404s
  });
  assert(res.status !== 0, "must not succeed on an unresolved existence check");
  const out = res.stdout + res.stderr;
  assert(
    !out.includes("tag=agent-line-feed-guard--v0.0.2"),
    "must not emit the success 'tag=' stanza as if the <TAG> check had cleanly resolved to absent"
  );
});

// ---------------------------------------------------------------------------
// R3 — marketplace-payload.sh
// ---------------------------------------------------------------------------

console.log("\nmarketplace-payload.sh");

test("payload: hostile changelog round-trips byte for byte", () => {
  const hostileChangelog =
    'line one\r\nline two `backtick` "quote" \\backslash $(whoami) ${NAME} : - [ \u65e5\u672c\u8a9e\n';
  const res = runPayload({
    NAME: "agent-line-feed-guard",
    DESC: "desc",
    REPO: "owner/repo",
    VERSION: "0.0.2",
    CHANGELOG: hostileChangelog,
  });
  assertEqual(res.status, 0, "exit code");
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`stdout is not valid JSON.\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
  assertEqual(parsed.client_payload.changelog, hostileChangelog, "changelog byte-for-byte round trip");
  assertEqual(parsed.client_payload.ref, "agent-line-feed-guard--v0.0.2", "ref = <name>--v<version>");
});

test("payload: an empty changelog omits the key entirely", () => {
  const res = runPayload({ NAME: "n", DESC: "d", REPO: "o/r", VERSION: "1.0.0", CHANGELOG: "" });
  assertEqual(res.status, 0, "exit code");
  const parsed = JSON.parse(res.stdout);
  assert(!("changelog" in parsed.client_payload), "changelog key must be absent when CHANGELOG is empty");
});

test("payload: a hostile description is also escaped correctly", () => {
  const hostileDesc = 'desc with "quotes", `backticks`, $(cmd), ${VAR}, back\\slash, and \n a newline';
  const res = runPayload({ NAME: "n", DESC: hostileDesc, REPO: "o/r", VERSION: "1.0.0", CHANGELOG: "" });
  assertEqual(res.status, 0, "exit code");
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.client_payload.description, hostileDesc, "description round trip");
});

test("payload: icon and description_url both use ref = <name>--v<version>", () => {
  const res = runPayload({ NAME: "agent-x", DESC: "d", REPO: "own/rep", VERSION: "2.3.4", CHANGELOG: "" });
  assertEqual(res.status, 0, "exit code");
  const parsed = JSON.parse(res.stdout);
  const ref = "agent-x--v2.3.4";
  assertEqual(parsed.client_payload.ref, ref, "ref");
  assert(parsed.client_payload.icon.includes(`/${ref}/`), "icon URL uses ref");
  assert(parsed.client_payload.description_url.includes(`/${ref}/`), "description_url URL uses ref");
});

// ---------------------------------------------------------------------------
// Teardown + summary
// ---------------------------------------------------------------------------

for (const dir of TMP_ROOTS) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
