#!/usr/bin/env node
/**
 * Tests for line-feed-guard-hook.mjs
 *
 * Plain Node.js — no test framework, no external dependencies.
 * Uses fs.mkdtempSync for isolated temp directories per test.
 * Exit code 0 = all pass, non-zero = at least one failure.
 *
 * SAFETY: every end-to-end run injects CLAUDE_CONFIG_DIR and
 * LINE_FEED_GUARD_STATE_DIR into a sandbox. Without that the hook would
 * enumerate — and rewrite — the real ~/.claude tree.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  resolveRoots,
  isInScope,
  enumerateScope,
  watchPathsFor,
  walkDir,
  classifyBuffer,
  stripCrlf,
  inspectAndFix,
  scanFiles,
  relDisplay,
  isAgentFile,
  isSkillOrCommandFile,
  buildSessionSystemMessage,
  markerPath,
  sweepStaleMarkers,
  MAX_FILES,
} from "./line-feed-guard-hook.mjs";

const HOOK_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "line-feed-guard-hook.mjs"
);

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

/** Thrown by skip() so test() can distinguish "not applicable here" from a pass. */
class SkipSignal extends Error {}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    if (err instanceof SkipSignal) {
      console.log(`  SKIP  ${name} (${err.message})`);
      skipped++;
      return;
    }
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

/** Abort the current test as not-applicable on this platform or filesystem. */
function skip(why) {
  throw new SkipSignal(why);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TMP_ROOTS = [];

/** Create an isolated temp directory that is cleaned up at exit. */
function mkTmp(prefix = "lfg-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_ROOTS.push(dir);
  return dir;
}

/** Write a file, creating parent directories. Content is written verbatim. */
function writeFile(root, rel, content) {
  const full = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const CRLF_AGENT = Buffer.from("---\r\nname: reviewer\r\ndescription: x\r\n---\r\n\r\nBody\r\n");
const LF_AGENT = Buffer.from("---\nname: planner\ndescription: x\n---\n\nBody\n");

/**
 * A sandboxed project root with a .claude tree, plus its own fake config dir
 * and state dir so nothing escapes into the real ~/.claude.
 */
function mkProject() {
  const root = mkTmp("lfg-proj-");
  const configDir = mkTmp("lfg-cfg-");
  const stateDir = mkTmp("lfg-state-");
  return { root, configDir, stateDir };
}

function sandboxEnv(p, extra = {}) {
  return {
    CLAUDE_CONFIG_DIR: p.configDir,
    LINE_FEED_GUARD_STATE_DIR: p.stateDir,
    LINE_FEED_GUARD_DISABLE: "",
    LINE_FEED_GUARD_DRY_RUN: "",
    LINE_FEED_GUARD_EXTRA_ROOTS: "",
    LINE_FEED_GUARD_ACTIVE: "",
    ...extra,
  };
}

function runHook(inputObj, env = {}) {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(inputObj),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

function runHookRaw(rawStdin, env = {}) {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: rawStdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

function parseOut(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function hasCR(file) {
  return fs.readFileSync(file).includes(0x0d);
}

function projectRoots(dir) {
  return [{ kind: "project", dir: path.resolve(dir) }];
}

// ---------------------------------------------------------------------------
// stripCrlf / classifyBuffer
// ---------------------------------------------------------------------------

console.log("\nstripCrlf / classifyBuffer");

test("converts CRLF to LF and reports the exact count", () => {
  const r = stripCrlf(Buffer.from("a\r\nb\r\nc"));
  assert(r !== null, "expected a result");
  assertEqual(r.buf.toString(), "a\nb\nc", "content");
  assertEqual(r.count, 2, "count");
});

test("leaves a lone \\r untouched", () => {
  assertEqual(stripCrlf(Buffer.from("a\rb")), null, "lone CR");
});

test("mixed CRLF and lone CR: only CRLF is converted", () => {
  const r = stripCrlf(Buffer.from("a\r\nb\rc\n"));
  assertEqual(r.buf.toString(), "a\nb\rc\n", "content");
  assertEqual(r.count, 1, "count");
});

test("a trailing \\r as the final byte is preserved", () => {
  assertEqual(stripCrlf(Buffer.from("abc\r")), null, "trailing CR");
});

test("no CRLF returns null, so the caller never writes", () => {
  assertEqual(stripCrlf(Buffer.from("a\nb\n")), null, "pure LF");
});

test("UTF-8 BOM survives byte for byte", () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb")]);
  const r = stripCrlf(buf);
  assertEqual([...r.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM bytes");
  assertEqual(r.buf.subarray(3).toString(), "a\nb", "content after BOM");
});

test("multibyte UTF-8 survives byte for byte", () => {
  const r = stripCrlf(Buffer.from("Zeilenümbrüche — 日本語\r\nnext\r\n", "utf8"));
  assertEqual(r.buf.toString("utf8"), "Zeilenümbrüche — 日本語\nnext\n", "content");
});

test("classifyBuffer: NUL byte means binary", () => {
  assertEqual(classifyBuffer(Buffer.from([0x61, 0x00, 0x62])), "binary", "kind");
});

test("classifyBuffer: UTF-16 BOM in either order", () => {
  assertEqual(classifyBuffer(Buffer.from([0xff, 0xfe, 0x61, 0x00])), "utf16", "LE");
  assertEqual(classifyBuffer(Buffer.from([0xfe, 0xff, 0x00, 0x61])), "utf16", "BE");
});

test("classifyBuffer: empty and oversized", () => {
  assertEqual(classifyBuffer(Buffer.alloc(0)), "empty", "empty");
  assertEqual(classifyBuffer(Buffer.alloc(5 * 1024 * 1024, 0x61)), "toolarge", "toolarge");
});

test("inspectAndFix never rewrites a UTF-16 file", () => {
  const root = mkTmp();
  const f = writeFile(root, "x.md", Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x0d, 0x00, 0x0a, 0x00]));
  const before = fs.readFileSync(f);
  const r = inspectAndFix(f, false);
  assertEqual(r.status, "utf16", "status");
  assert(before.equals(fs.readFileSync(f)), "file must be untouched");
});

test("inspectAndFix honours dry-run", () => {
  const root = mkTmp();
  const f = writeFile(root, "x.md", CRLF_AGENT);
  const r = inspectAndFix(f, true);
  assertEqual(r.status, "fixed", "status");
  assert(hasCR(f), "file must still have CRLF in dry-run");
});

test("inspectAndFix on a directory is skipped, never reported", () => {
  const root = mkTmp();
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const r = inspectAndFix(dir, false);
  assertEqual(r.status, "skipped", "status");
  assert(typeof r.error === "string" && r.error.length > 0, "must carry an error message");

  const report = scanFiles([dir], false);
  assertEqual(report.fixed, [], "directory never counted as fixed");
  assertEqual(report.unfixed, [], "directory never counted as unfixed");
  assertEqual(report.utf16, [], "directory never counted as utf16");
});

// ---------------------------------------------------------------------------
// isInScope
// ---------------------------------------------------------------------------

console.log("\nisInScope");

test("in scope: agents, skills, commands, settings.local.json, root CLAUDE.md", () => {
  const root = mkTmp();
  const roots = projectRoots(root);
  for (const rel of [
    ".claude/agents/x.md",
    ".claude/skills/s/SKILL.md",
    ".claude/skills/s/references/deep/notes.md",
    ".claude/commands/c.md",
    ".claude/settings.local.json",
    ".claude/settings.json",
    "CLAUDE.md",
    "AGENTS.md",
    ".mcp.json",
  ]) {
    assert(isInScope(path.join(root, ...rel.split("/")), roots), `expected in scope: ${rel}`);
  }
});

test("out of scope: source files, .claude/projects, nested node_modules/.claude", () => {
  const root = mkTmp();
  const roots = projectRoots(root);
  for (const rel of [
    "src/main.ts",
    "docs/CLAUDE.md",
    ".claude/projects/slug/memory/note.md",
    "node_modules/pkg/.claude/agents/x.md",
  ]) {
    assert(!isInScope(path.join(root, ...rel.split("/")), roots), `expected out of scope: ${rel}`);
  }
});

test("out of scope: extensions where CRLF is legitimate", () => {
  const root = mkTmp();
  const roots = projectRoots(root);
  for (const rel of [
    ".claude/hooks/x.bat",
    ".claude/hooks/y.cmd",
    ".claude/agents/z.reg",
    ".claude/scripts/x.bat",
  ]) {
    assert(!isInScope(path.join(root, ...rel.split("/")), roots), `expected out of scope: ${rel}`);
  }
});

test("in scope: any subdir of a project .claude/, not just the four named", () => {
  const root = mkTmp();
  const roots = projectRoots(root);
  for (const rel of [
    ".claude/scripts/build.mjs",
    ".claude/scripts/lib/util.mjs",
    ".claude/output-styles/x.md",
    ".claude/.gitignore",
    ".claude/notes.md",
  ]) {
    assert(isInScope(path.join(root, ...rel.split("/")), roots), `expected in scope: ${rel}`);
  }
});

test("path traversal out of the root is rejected", () => {
  const root = mkTmp();
  const roots = projectRoots(root);
  assert(
    !isInScope(path.join(root, ".claude", "agents", "..", "..", "..", "evil.md"), roots),
    "traversal escaped the scope"
  );
});

test("a path outside every root is rejected", () => {
  const root = mkTmp();
  const other = mkTmp();
  assert(!isInScope(path.join(other, ".claude/agents/x.md"), projectRoots(root)), "foreign root");
});

test("config-kind root treats its own dir as the .claude dir", () => {
  const cfg = mkTmp();
  const roots = [{ kind: "config", dir: cfg }];
  assert(isInScope(path.join(cfg, "agents", "global.md"), roots), "user-level agent");
  assert(isInScope(path.join(cfg, "settings.json"), roots), "user settings");
  assert(isInScope(path.join(cfg, "CLAUDE.md"), roots), "user CLAUDE.md");
  assert(!isInScope(path.join(cfg, "projects", "slug", "memory", "m.md"), roots), "projects/");
  assert(!isInScope(path.join(cfg, "shell-snapshots", "s.sh"), roots), "shell-snapshots/");
});

test("config-kind scope stays narrow after the project widening", () => {
  const cfg = mkTmp();
  writeFile(cfg, "scripts/x.mjs", "x");
  writeFile(cfg, "output-styles/o.md", "x");
  writeFile(cfg, "projects/slug/memory/m.md", "x");
  writeFile(cfg, "file-history/h.json", "{}");
  writeFile(cfg, "shell-snapshots/s.sh", "x");
  writeFile(cfg, "notes.md", "x");
  writeFile(cfg, "agents/global.md", "x");
  writeFile(cfg, "hooks/h.md", "x");
  writeFile(cfg, "settings.json", "{}");
  writeFile(cfg, "CLAUDE.md", "x");

  const roots = [{ kind: "config", dir: cfg }];
  for (const rel of ["scripts/x.mjs", "output-styles/o.md", "projects/slug/memory/m.md", "file-history/h.json", "shell-snapshots/s.sh", "notes.md"]) {
    assert(!isInScope(path.join(cfg, ...rel.split("/")), roots), `expected out of scope: ${rel}`);
  }
  for (const rel of ["agents/global.md", "hooks/h.md", "settings.json", "CLAUDE.md"]) {
    assert(isInScope(path.join(cfg, ...rel.split("/")), roots), `expected in scope: ${rel}`);
  }

  const found = enumerateScope(roots)
    .map((p) => path.relative(cfg, p).split(path.sep).join("/"))
    .sort();
  assertEqual(found, ["CLAUDE.md", "agents/global.md", "hooks/h.md", "settings.json"], "config enumeration stays narrow");
});

test("excluded top dirs under a project .claude/ are never enumerated", () => {
  const root = mkTmp();
  const roots = projectRoots(root);
  for (const sub of ["projects", "file-history", "shell-snapshots", "todos", "statsig", "plugins"]) {
    const rel = `.claude/${sub}/x.md`;
    assert(!isInScope(path.join(root, ...rel.split("/")), roots), `expected out of scope: ${rel}`);
  }
});

test("vendor dirs are skipped at any depth", () => {
  const root = mkTmp();
  const roots = projectRoots(root);
  for (const rel of [
    ".claude/node_modules/pkg/index.js",
    ".claude/scripts/node_modules/pkg/index.js",
    ".claude/scripts/.git/config",
    ".claude/scripts/__pycache__/m.pyc",
  ]) {
    assert(!isInScope(path.join(root, ...rel.split("/")), roots), `expected out of scope: ${rel}`);
  }

  // Direct walkDir assertion for the any-depth vendor skip.
  writeFile(root, ".claude/scripts/node_modules/pkg/index.js", "x");
  writeFile(root, ".claude/scripts/tool.mjs", "x");
  const out = [];
  walkDir(path.join(root, ".claude", "scripts"), 0, out, { count: 0 });
  const names = out.map((p) => path.basename(p)).sort();
  assertEqual(names, ["tool.mjs"], "vendor dir excluded from walkDir");
});

test("excluded-name matching is case-insensitive", () => {
  const root = mkTmp();
  const roots = projectRoots(root);
  assert(
    !isInScope(path.join(root, ".claude", "Projects", "p", "m.md"), roots),
    "Projects/ (mixed case) excluded"
  );
  assert(
    !isInScope(path.join(root, ".claude", "scripts", "Node_Modules", "x.js"), roots),
    "Node_Modules/ (mixed case) excluded"
  );
});

test("LINE_FEED_GUARD_EXTRA_ROOTS adds absolute roots only", () => {
  const a = mkTmp();
  const b = mkTmp();
  const roots = resolveRoots(a, {
    LINE_FEED_GUARD_EXTRA_ROOTS: [b, "relative/path"].join(path.delimiter),
  });
  const dirs = roots.filter((r) => r.kind === "project").map((r) => r.dir);
  assert(dirs.includes(path.resolve(a)), "cwd root present");
  assert(dirs.includes(path.resolve(b)), "extra root present");
  assert(!dirs.some((d) => d.endsWith("relative")), "relative entry must be dropped");
});

// ---------------------------------------------------------------------------
// enumerateScope / walkDir / watchPathsFor
// ---------------------------------------------------------------------------

console.log("\nenumerateScope");

test("returns exactly the in-scope set, ignoring sibling junk", () => {
  const root = mkTmp();
  writeFile(root, ".claude/agents/a.md", "x");
  writeFile(root, ".claude/skills/s/SKILL.md", "x");
  writeFile(root, ".claude/commands/c.md", "x");
  writeFile(root, ".claude/settings.json", "{}");
  writeFile(root, "CLAUDE.md", "x");
  // Junk that must not appear:
  writeFile(root, ".claude/projects/p/memory/m.md", "x");
  writeFile(root, ".claude/agents/skip.bat", "x");
  writeFile(root, "node_modules/pkg/.claude/agents/n.md", "x");
  writeFile(root, "src/main.ts", "x");

  const found = enumerateScope(projectRoots(root))
    .map((p) => path.relative(root, p).split(path.sep).join("/"))
    .sort();
  assertEqual(
    found,
    [".claude/agents/a.md", ".claude/commands/c.md", ".claude/settings.json", ".claude/skills/s/SKILL.md", "CLAUDE.md"],
    "enumerated set"
  );
});

test("no .claude directory yields an empty list without throwing", () => {
  assertEqual(enumerateScope(projectRoots(mkTmp())), [], "empty root");
});

test("enumerateScope walks the whole project .claude/, including .claude/scripts", () => {
  const root = mkTmp();
  writeFile(root, ".claude/agents/a.md", "x");
  writeFile(root, ".claude/skills/s/SKILL.md", "x");
  writeFile(root, ".claude/commands/c.md", "x");
  writeFile(root, ".claude/hooks/h.md", "x");
  writeFile(root, ".claude/scripts/tool.mjs", "x");
  writeFile(root, ".claude/scripts/deep/nested.py", "x");
  writeFile(root, ".claude/output-styles/s.md", "x");
  writeFile(root, ".claude/notes.md", "x");
  writeFile(root, ".claude/scripts/skip.bat", "x");

  const found = enumerateScope(projectRoots(root))
    .map((p) => path.relative(root, p).split(path.sep).join("/"))
    .sort();
  assertEqual(
    found,
    [
      ".claude/agents/a.md",
      ".claude/commands/c.md",
      ".claude/hooks/h.md",
      ".claude/notes.md",
      ".claude/output-styles/s.md",
      ".claude/scripts/deep/nested.py",
      ".claude/scripts/tool.mjs",
      ".claude/skills/s/SKILL.md",
    ],
    "widened enumeration"
  );
});

test("MAX_DEPTH still bounds a deep new subtree", () => {
  const root = mkTmp();
  const deep =
    ".claude/output-styles/" + Array.from({ length: 20 }, (_, i) => `d${i}`).join("/") + "/x.md";
  writeFile(root, deep, "x");
  const found = enumerateScope(projectRoots(root));
  assertEqual(found, [], "file below MAX_DEPTH must not be collected");
});

test("the four named subdirs are enumerated before the rest of .claude/", () => {
  const root = mkTmp();
  writeFile(root, ".claude/agents/a.md", "x");
  writeFile(root, ".claude/zzz-other/x.md", "x");
  const found = enumerateScope(projectRoots(root)).map((p) =>
    path.relative(root, p).split(path.sep).join("/")
  );
  const agentIdx = found.indexOf(".claude/agents/a.md");
  const otherIdx = found.indexOf(".claude/zzz-other/x.md");
  assert(agentIdx !== -1 && otherIdx !== -1, "both files enumerated");
  assert(agentIdx < otherIdx, "phase 1 (named dirs) must precede phase 2 (the rest)");
});

test("walkDir stops once the budget is exhausted", () => {
  const root = mkTmp();
  writeFile(root, ".claude/agents/a.md", "x");
  writeFile(root, ".claude/agents/b.md", "x");
  const out = [];
  walkDir(path.join(root, ".claude", "agents"), 0, out, { count: MAX_FILES });
  assertEqual(out, [], "budget exhausted means nothing collected");
});

test("walkDir respects MAX_DEPTH", () => {
  const root = mkTmp();
  const deep = ".claude/agents/" + Array.from({ length: 20 }, (_, i) => `d${i}`).join("/") + "/x.md";
  writeFile(root, deep, "x");
  const out = [];
  walkDir(path.join(root, ".claude", "agents"), 0, out, { count: 0 });
  assertEqual(out, [], "file below MAX_DEPTH must not be collected");
});

test("walkDir does not recurse into a symlinked directory", () => {
  const root = mkTmp();
  const target = mkTmp();
  writeFile(target, "inside.md", "x");
  writeFile(root, ".claude/agents/real.md", "x");
  try {
    fs.symlinkSync(target, path.join(root, ".claude", "agents", "linked"), "dir");
  } catch {
    skip("symlink creation unprivileged");
  }
  const out = [];
  walkDir(path.join(root, ".claude", "agents"), 0, out, { count: 0 });
  const names = out.map((p) => path.basename(p)).sort();
  assertEqual(names, ["real.md"], "symlinked dir must not be traversed");
});

test("watchPathsFor watches a project .claude but never the whole config dir", () => {
  const root = mkTmp();
  const cfg = mkTmp();
  writeFile(root, ".claude/agents/a.md", "x");
  writeFile(root, "CLAUDE.md", "x");
  fs.mkdirSync(path.join(cfg, "agents"), { recursive: true });
  fs.mkdirSync(path.join(cfg, "projects"), { recursive: true });

  const paths = watchPathsFor([
    { kind: "project", dir: root },
    { kind: "config", dir: cfg },
  ]);
  assert(paths.includes(path.join(root, ".claude")), "project .claude watched");
  assert(paths.includes(path.join(root, "CLAUDE.md")), "root CLAUDE.md watched");
  assert(paths.includes(path.join(cfg, "agents")), "config agents watched");
  assert(!paths.includes(cfg), "config dir itself must NOT be watched");
  assert(!paths.some((p) => p.endsWith("projects")), "config projects/ must NOT be watched");
});

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

console.log("\nreporting helpers");

test("relDisplay renders project paths relative and config paths with ~/.claude", () => {
  const root = mkTmp();
  const cfg = mkTmp();
  const roots = [
    { kind: "project", dir: root },
    { kind: "config", dir: cfg },
  ];
  assertEqual(
    relDisplay(path.join(root, ".claude", "agents", "a.md"), roots),
    ".claude/agents/a.md",
    "project"
  );
  assertEqual(relDisplay(path.join(cfg, "agents", "g.md"), roots), "~/.claude/agents/g.md", "config");
});

test("isAgentFile / isSkillOrCommandFile classify correctly", () => {
  assert(isAgentFile("/x/.claude/agents/rev.md"), "agent");
  assert(!isAgentFile("/x/.claude/skills/s/SKILL.md"), "not an agent");
  assert(isSkillOrCommandFile("/x/.claude/skills/s/SKILL.md"), "skill");
  assert(isSkillOrCommandFile("/x/.claude/commands/c.md"), "command");
  assert(!isSkillOrCommandFile("/x/.claude/agents/rev.md"), "not a skill");
});

test("session message names the subagents and says restart", () => {
  const msg = buildSessionSystemMessage({
    fixed: [
      { path: "/x/.claude/agents/reviewer.md", count: 3 },
      { path: "/x/.claude/settings.json", count: 1 },
    ],
  });
  assert(msg.includes("reviewer"), "names the subagent");
  assert(msg.includes("restart"), "tells the user to restart");
});

test("sweepStaleMarkers drops old markers and keeps fresh ones", () => {
  const dir = mkTmp();
  const prev = process.env.LINE_FEED_GUARD_STATE_DIR;
  process.env.LINE_FEED_GUARD_STATE_DIR = dir;
  try {
    const stale = markerPath("old-session");
    const fresh = markerPath("new-session");
    fs.writeFileSync(stale, "");
    fs.writeFileSync(fresh, "");
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
    fs.utimesSync(stale, old, old);
    sweepStaleMarkers();
    assert(!fs.existsSync(stale), "stale marker must be removed");
    assert(fs.existsSync(fresh), "fresh marker must survive");
  } finally {
    if (prev === undefined) delete process.env.LINE_FEED_GUARD_STATE_DIR;
    else process.env.LINE_FEED_GUARD_STATE_DIR = prev;
  }
});

// ---------------------------------------------------------------------------
// End-to-end: PostToolUse
// ---------------------------------------------------------------------------

console.log("\nend-to-end: PostToolUse");

test("Bash: full scan fixes a CRLF agent file the command never named", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const res = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-bash",
      cwd: p.root,
      tool_name: "Bash",
      tool_input: { command: "pwsh -c ..." },
    },
    sandboxEnv(p)
  );
  assertEqual(res.status, 0, "exit code");
  assert(!hasCR(f), "file must be LF after the hook");
  const out = parseOut(res.stdout);
  assertEqual(out.hookSpecificOutput.hookEventName, "PostToolUse", "event name");
  assert(out.hookSpecificOutput.additionalContext.includes("reviewer.md"), "names the file");
});

test("Bash: full scan repairs a CRLF file under .claude/scripts/", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/scripts/build.mjs", Buffer.from("a\r\nb\r\n"));
  const res = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-scripts-bash",
      cwd: p.root,
      tool_name: "Bash",
      tool_input: { command: "pwsh -c ..." },
    },
    sandboxEnv(p)
  );
  assertEqual(res.status, 0, "exit code");
  assert(!hasCR(f), "file under .claude/scripts/ must be LF after the hook");
  const out = parseOut(res.stdout);
  assert(out.hookSpecificOutput.additionalContext.includes("build.mjs"), "names the file");

  // Idempotence: a second identical run must be silent for the new path too.
  const second = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-scripts-bash",
      cwd: p.root,
      tool_name: "Bash",
      tool_input: { command: "pwsh -c ..." },
    },
    sandboxEnv(p)
  );
  assertEqual(second.stdout.trim(), "", "second run over .claude/scripts/ must be silent");
});

test("Write under .claude/scripts/ is repaired on the single-file path", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/scripts/build.mjs", Buffer.from("a\r\nb\r\n"));
  const res = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-scripts-write",
      cwd: p.root,
      tool_name: "Write",
      tool_input: { file_path: f },
    },
    sandboxEnv(p)
  );
  assert(!hasCR(f), "file must be LF after the single-file path");
  assert(parseOut(res.stdout).hookSpecificOutput.additionalContext.includes("build.mjs"), "named");
});

test("FileChanged repairs a file under .claude/scripts/", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/scripts/build.mjs", Buffer.from("a\r\nb\r\n"));
  const res = runHook(
    {
      hook_event_name: "FileChanged",
      session_id: "s-scripts-fc",
      cwd: p.root,
      file_path: f,
      event: "change",
    },
    sandboxEnv(p)
  );
  assert(!hasCR(f), "file must be LF after FileChanged");
  const out = parseOut(res.stdout);
  assert(typeof out.systemMessage === "string", "systemMessage is the only channel");
  assert(
    out.hookSpecificOutput === undefined,
    "FileChanged output union has no additionalContext — emit nothing there"
  );
});

test("PowerShell is handled on the same full-scan path as Bash", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/agents/planner.md", CRLF_AGENT);
  const res = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-ps",
      cwd: p.root,
      tool_name: "PowerShell",
      tool_input: { command: "Set-Content -Value @('a','b') x" },
    },
    sandboxEnv(p)
  );
  assert(!hasCR(f), "file must be LF");
  assert(parseOut(res.stdout).hookSpecificOutput.additionalContext.includes("planner.md"), "named");
});

test("a second identical run is silent — idempotent and loop-free", () => {
  const p = mkProject();
  writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const event = {
    hook_event_name: "PostToolUse",
    session_id: "s-twice",
    cwd: p.root,
    tool_name: "Bash",
    tool_input: { command: "x" },
  };
  const first = runHook(event, sandboxEnv(p));
  assert(first.stdout.trim() !== "", "first run must report");
  const second = runHook(event, sandboxEnv(p));
  assertEqual(second.stdout.trim(), "", "second run must be completely silent");
  assertEqual(second.status, 0, "exit code");
});

test("Write with an out-of-scope path does not trigger a scan", () => {
  const p = mkProject();
  const untouched = writeFile(p.root, ".claude/agents/other.md", CRLF_AGENT);
  const outside = writeFile(p.root, "src/main.ts", Buffer.from("a\r\nb\r\n"));
  const res = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-oos",
      cwd: p.root,
      tool_name: "Write",
      tool_input: { file_path: outside },
    },
    sandboxEnv(p)
  );
  assertEqual(res.stdout.trim(), "", "no output expected");
  assert(hasCR(outside), "out-of-scope file must be untouched");
  assert(hasCR(untouched), "single-file path must not scan the whole scope");
});

test("Write with an in-scope path fixes only that file", () => {
  const p = mkProject();
  const target = writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const other = writeFile(p.root, ".claude/agents/planner.md", CRLF_AGENT);
  runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-single",
      cwd: p.root,
      tool_name: "Write",
      tool_input: { file_path: target },
    },
    sandboxEnv(p)
  );
  assert(!hasCR(target), "named file fixed");
  assert(hasCR(other), "sibling must be left alone on the single-file path");
});

test("NotebookEdit uses notebook_path", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/skills/s/SKILL.md", CRLF_AGENT);
  runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-nb",
      cwd: p.root,
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: f },
    },
    sandboxEnv(p)
  );
  assert(!hasCR(f), "notebook_path target fixed");
});

test("systemMessage appears for an agent fix but not for a settings fix", () => {
  const pAgent = mkProject();
  writeFile(pAgent.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const withAgent = parseOut(
    runHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "s-sm1",
        cwd: pAgent.root,
        tool_name: "Bash",
        tool_input: { command: "x" },
      },
      sandboxEnv(pAgent)
    ).stdout
  );
  assert(typeof withAgent.systemMessage === "string", "agent fix must surface to the user");

  const pJson = mkProject();
  writeFile(pJson.root, ".claude/settings.json", Buffer.from('{\r\n  "a": 1\r\n}\r\n'));
  const withJson = parseOut(
    runHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "s-sm2",
        cwd: pJson.root,
        tool_name: "Bash",
        tool_input: { command: "x" },
      },
      sandboxEnv(pJson)
    ).stdout
  );
  assert(withJson.systemMessage === undefined, "non-agent fix must stay agent-facing only");
});

test("the anti-nag marker switches the full message to the terse one", () => {
  const p = mkProject();
  writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const ev = (id) => ({
    hook_event_name: "PostToolUse",
    session_id: id,
    cwd: p.root,
    tool_name: "Bash",
    tool_input: { command: "x" },
  });

  const first = parseOut(runHook(ev("s-nag"), sandboxEnv(p)).stdout);
  assert(first.hookSpecificOutput.additionalContext.includes("Why this matters"), "full form first");

  writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const second = parseOut(runHook(ev("s-nag"), sandboxEnv(p)).stdout);
  const ctx = second.hookSpecificOutput.additionalContext;
  assert(!ctx.includes("Why this matters"), "second emission must be terse");
  assert(ctx.includes("again in"), "terse form");

  writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const other = parseOut(runHook(ev("s-nag-other"), sandboxEnv(p)).stdout);
  assert(
    other.hookSpecificOutput.additionalContext.includes("Why this matters"),
    "a different session gets the full form again"
  );
});

test("stdout never carries a permission decision — PostToolUse must not block", () => {
  const p = mkProject();
  writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const res = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-perm",
      cwd: p.root,
      tool_name: "Bash",
      tool_input: { command: "x" },
    },
    sandboxEnv(p)
  );
  assert(!res.stdout.includes("permissionDecision"), "must never emit permissionDecision");
  assert(!res.stdout.includes('"decision"'), "must never emit a decision");
});

// ---------------------------------------------------------------------------
// End-to-end: SessionStart / FileChanged
// ---------------------------------------------------------------------------

console.log("\nend-to-end: SessionStart / FileChanged");

test("SessionStart fixes, returns watchPaths and tells the user to restart", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const res = runHook(
    { hook_event_name: "SessionStart", session_id: "s-start", cwd: p.root, source: "startup" },
    sandboxEnv(p)
  );
  assertEqual(res.status, 0, "exit code");
  assert(!hasCR(f), "file fixed");
  const out = parseOut(res.stdout);
  assertEqual(out.hookSpecificOutput.hookEventName, "SessionStart", "event name");
  assert(out.hookSpecificOutput.watchPaths.length > 0, "watchPaths returned");
  assert(out.systemMessage.includes("restart"), "restart advice");
  assert(
    out.hookSpecificOutput.additionalContext.includes("Do not recreate"),
    "agent must be told not to recreate the definitions"
  );
});

test("SessionStart with nothing to fix still returns watchPaths and nothing else", () => {
  const p = mkProject();
  writeFile(p.root, ".claude/agents/planner.md", LF_AGENT);
  const out = parseOut(
    runHook(
      { hook_event_name: "SessionStart", session_id: "s-clean", cwd: p.root, source: "startup" },
      sandboxEnv(p)
    ).stdout
  );
  assert(out.hookSpecificOutput.watchPaths.length > 0, "watchPaths still returned");
  assert(out.hookSpecificOutput.additionalContext === undefined, "no context when clean");
  assert(out.systemMessage === undefined, "no systemMessage when clean");
});

test("reloadSkills is set for a skill fix but not for an agent-only fix", () => {
  const pSkill = mkProject();
  writeFile(pSkill.root, ".claude/skills/s/SKILL.md", CRLF_AGENT);
  const withSkill = parseOut(
    runHook(
      { hook_event_name: "SessionStart", session_id: "s-rs1", cwd: pSkill.root, source: "startup" },
      sandboxEnv(pSkill)
    ).stdout
  );
  assertEqual(withSkill.hookSpecificOutput.reloadSkills, true, "reloadSkills for a skill fix");

  const pAgent = mkProject();
  writeFile(pAgent.root, ".claude/agents/a.md", CRLF_AGENT);
  const withAgent = parseOut(
    runHook(
      { hook_event_name: "SessionStart", session_id: "s-rs2", cwd: pAgent.root, source: "startup" },
      sandboxEnv(pAgent)
    ).stdout
  );
  assert(!withAgent.hookSpecificOutput.reloadSkills, "no reloadSkills for an agent-only fix");
});

test("SessionStart also repairs user-level agents in the config dir", () => {
  const p = mkProject();
  const f = path.join(p.configDir, "agents", "global.md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, CRLF_AGENT);
  runHook(
    { hook_event_name: "SessionStart", session_id: "s-cfg", cwd: p.root, source: "startup" },
    sandboxEnv(p)
  );
  assert(!hasCR(f), "user-level agent must be repaired too");
});

test("FileChanged repairs an in-scope file and reports via systemMessage only", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const res = runHook(
    {
      hook_event_name: "FileChanged",
      session_id: "s-fc",
      cwd: p.root,
      file_path: f,
      event: "change",
    },
    sandboxEnv(p)
  );
  assert(!hasCR(f), "file fixed");
  const out = parseOut(res.stdout);
  assert(typeof out.systemMessage === "string", "systemMessage is the only channel");
  assert(
    out.hookSpecificOutput === undefined,
    "FileChanged output union has no additionalContext — emit nothing there"
  );
});

test("FileChanged ignores an out-of-scope file", () => {
  const p = mkProject();
  const f = writeFile(p.root, "src/main.ts", Buffer.from("a\r\nb\r\n"));
  const res = runHook(
    { hook_event_name: "FileChanged", session_id: "s-fc2", cwd: p.root, file_path: f, event: "change" },
    sandboxEnv(p)
  );
  assertEqual(res.stdout.trim(), "", "no output");
  assert(hasCR(f), "out-of-scope file untouched");
});

// ---------------------------------------------------------------------------
// End-to-end: fault tolerance and configuration
// ---------------------------------------------------------------------------

console.log("\nend-to-end: fault tolerance and configuration");

test("malformed stdin exits 0 with no output", () => {
  const res = runHookRaw("not json at all");
  assertEqual(res.status, 0, "exit code");
  assertEqual(res.stdout.trim(), "", "no output");
});

test("empty stdin exits 0", () => {
  const res = runHookRaw("");
  assertEqual(res.status, 0, "exit code");
  assertEqual(res.stdout.trim(), "", "no output");
});

test("a nonexistent cwd exits 0 with no output", () => {
  const p = mkProject();
  const res = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-nocwd",
      cwd: path.join(p.root, "does", "not", "exist"),
      tool_name: "Bash",
      tool_input: { command: "x" },
    },
    sandboxEnv(p)
  );
  assertEqual(res.status, 0, "exit code");
  assertEqual(res.stdout.trim(), "", "no output");
});

test("LINE_FEED_GUARD_DISABLE=1 is a hard kill switch", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const res = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-off",
      cwd: p.root,
      tool_name: "Bash",
      tool_input: { command: "x" },
    },
    sandboxEnv(p, { LINE_FEED_GUARD_DISABLE: "1" })
  );
  assertEqual(res.stdout.trim(), "", "no output");
  assert(hasCR(f), "file must keep its CRLF when disabled");
});

test("LINE_FEED_GUARD_DRY_RUN=1 reports without writing", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const res = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-dry",
      cwd: p.root,
      tool_name: "Bash",
      tool_input: { command: "x" },
    },
    sandboxEnv(p, { LINE_FEED_GUARD_DRY_RUN: "1" })
  );
  assert(hasCR(f), "dry-run must not write");
  assert(parseOut(res.stdout).hookSpecificOutput.additionalContext.includes("reviewer.md"), "still reports");
});

test("LINE_FEED_GUARD_EXTRA_ROOTS brings a second project into scope", () => {
  const p = mkProject();
  const extra = mkTmp("lfg-extra-");
  const f = writeFile(extra, ".claude/agents/extra.md", CRLF_AGENT);
  runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-extra",
      cwd: p.root,
      tool_name: "Bash",
      tool_input: { command: "x" },
    },
    sandboxEnv(p, { LINE_FEED_GUARD_EXTRA_ROOTS: extra })
  );
  assert(!hasCR(f), "file in the extra root must be repaired");
});

test("a read-only file is reported as unfixed rather than swallowed", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/agents/locked.md", CRLF_AGENT);
  fs.chmodSync(f, 0o444);
  // Some filesystems ignore the read-only bit; probe before asserting.
  let enforced = true;
  try {
    fs.appendFileSync(f, "");
    fs.writeFileSync(f, fs.readFileSync(f));
    enforced = false;
  } catch {
    enforced = true;
  }
  if (!enforced) {
    fs.chmodSync(f, 0o644);
    skip("filesystem ignores the read-only bit");
  }
  try {
    const res = runHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "s-ro",
        cwd: p.root,
        tool_name: "Bash",
        tool_input: { command: "x" },
      },
      sandboxEnv(p)
    );
    assertEqual(res.status, 0, "exit code");
    const ctx = parseOut(res.stdout).hookSpecificOutput.additionalContext;
    assert(ctx.includes("locked.md"), "names the unfixable file");
    assert(ctx.includes("Could not rewrite"), "explains it is still broken");
  } finally {
    fs.chmodSync(f, 0o644);
  }
});

test("a UTF-16 agent file is reported, never rewritten", () => {
  const p = mkProject();
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("name: x\r\n", "utf16le"),
  ]);
  const f = writeFile(p.root, ".claude/agents/wide.md", utf16);
  const res = runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-u16",
      cwd: p.root,
      tool_name: "Bash",
      tool_input: { command: "x" },
    },
    sandboxEnv(p)
  );
  assert(utf16.equals(fs.readFileSync(f)), "UTF-16 file must be byte-identical");
  const ctx = parseOut(res.stdout).hookSpecificOutput.additionalContext;
  assert(ctx.includes("UTF-16"), "reports the encoding problem");
});

test("a binary file under .claude is left alone", () => {
  const p = mkProject();
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a]);
  const f = writeFile(p.root, ".claude/skills/s/logo.png", bin);
  runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-bin",
      cwd: p.root,
      tool_name: "Bash",
      tool_input: { command: "x" },
    },
    sandboxEnv(p)
  );
  assert(bin.equals(fs.readFileSync(f)), "binary file must be byte-identical");
});

// ---------------------------------------------------------------------------
// CLI mode
// ---------------------------------------------------------------------------

console.log("\nCLI mode");

test("--scan repairs the scope and prints a report", () => {
  const p = mkProject();
  const f = writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const res = spawnSync(process.execPath, [HOOK_SCRIPT, "--scan", p.root], {
    encoding: "utf8",
    env: { ...process.env, ...sandboxEnv(p) },
  });
  assertEqual(res.status, 0, "exit code");
  assert(!hasCR(f), "file fixed");
  assert(res.stdout.includes("reviewer.md"), "report names the file");
  assert(res.stdout.includes("restart"), "report mentions the restart requirement");
});

test("--scan on a clean tree says so", () => {
  const p = mkProject();
  writeFile(p.root, ".claude/agents/planner.md", LF_AGENT);
  const res = spawnSync(process.execPath, [HOOK_SCRIPT, "--scan", p.root], {
    encoding: "utf8",
    env: { ...process.env, ...sandboxEnv(p) },
  });
  assert(res.stdout.includes("no CRLF found"), "clean report");
});

// ---------------------------------------------------------------------------
// Concurrency (async tail)
// ---------------------------------------------------------------------------

function runHookAsync(inputObj, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ stdout, status: code }));
    child.stdin.end(JSON.stringify(inputObj));
  });
}

async function asyncTests() {
  console.log("\nconcurrency");
  const p = mkProject();
  const f = writeFile(p.root, ".claude/agents/reviewer.md", CRLF_AGENT);
  const event = {
    hook_event_name: "PostToolUse",
    session_id: "s-conc",
    cwd: p.root,
    tool_name: "Bash",
    tool_input: { command: "x" },
  };
  try {
    const [a, b] = await Promise.all([
      runHookAsync(event, sandboxEnv(p)),
      runHookAsync(event, sandboxEnv(p)),
    ]);
    assertEqual(a.status, 0, "first exit code");
    assertEqual(b.status, 0, "second exit code");
    assert(!hasCR(f), "file must end up LF regardless of interleaving");
    console.log("  PASS  two concurrent hooks converge on an LF file");
    passed++;
  } catch (err) {
    console.error("  FAIL  two concurrent hooks converge on an LF file");
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Teardown + summary
// ---------------------------------------------------------------------------

asyncTests().then(() => {
  for (const dir of TMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
});
