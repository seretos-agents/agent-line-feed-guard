# agent-line-feed-guard

Repairs CRLF line endings in the files Claude Code parses, so a subagent, skill, or command never silently fails to load.

## The failure it prevents

Claude Code **silently ignores** a `.claude/agents/*.md` whose line endings are CRLF. No error, no warning, no log entry — the subagent simply does not exist. The same applies to `.claude/skills/**` and `.claude/commands/**`.

Measured, with a clean negative control: a repository had 13 files in `.claude/agents/`; the harness served 11. The 2 missing were exactly the 2 whose working-tree bytes were CRLF throughout. Both had valid frontmatter. Converting only the line endings to LF and restarting made the harness announce exactly those two as newly available.

The severity is in the silence. In an orchestration setup, a role that quietly does not exist means a dispatch either errors late or falls back to a general-purpose agent — and nothing turns red.

### Why nothing else catches it

- **Git cannot see it.** Under `text=auto` the committed blob is already LF, so `git status` is silent and `git diff HEAD` is empty. The CRLF lives only in the working tree — precisely what Claude Code reads.
- **A pre-commit hook is the wrong lever.** It inspects staged content, which is LF by construction, so it would never fire.
- **A written-down rule is the weakest lever.** "Don't write repo files through PowerShell" is what a human puts in a project instruction file and hopes an agent remembers.

### Where the CRLF comes from

| Write path | Result |
|---|---|
| Claude Code `Write` tool | LF |
| Claude Code `Edit` tool | preserves existing endings |
| Bash heredoc / `printf` | LF |
| PowerShell `Set-Content -Value @("a","b")` | **CRLF** |
| PowerShell `Add-Content` / `Out-File` / `>` | **CRLF** (and `Out-File`/`>` default to UTF-16LE on PS 5.1) |
| `git checkout` with `core.autocrlf=true` and no `eol=lf` | **CRLF, for the whole tree at once** |

PowerShell cmdlets join lines with `[Environment]::NewLine`. There is no global "always emit LF" switch, so the source cannot be fixed at its origin.

## What the plugin does

| Event | Behaviour |
|---|---|
| `PostToolUse` on `Write`/`Edit`/`MultiEdit`/`NotebookEdit` | checks the one file the tool named |
| `PostToolUse` on `Bash`/`PowerShell` | scans the whole scope — the command string never names the files it wrote |
| `SessionStart` | scans everything, and reports which subagents were unreadable at startup |
| `FileChanged` | checks files written outside any tool call — an external editor, `git checkout`, another terminal |

On a find it converts CRLF to LF in place and tells the agent what it repaired and why, so the agent stops producing the problem. A repair under `.claude/agents/` is also surfaced to you, because agent definitions are read once at startup and a restart is needed to load them.

### Scope

The project's Claude configuration tree, plus the root marker files:

- `<project>/.claude/**` — every file, not just `agents`/`skills`/`commands`/`hooks` (this is what catches `.claude/scripts/`, `.claude/output-styles/`, etc.)
  - except `PROJECT_EXCLUDED_TOP_DIRS` (`projects`, `file-history`, `shell-snapshots`, `todos`, `statsig`, `plugins` — Claude-Code-internal churn dirs) and `VENDOR_DIRS` (`node_modules`, `.git`, `.venv`, `venv`, `__pycache__` — skipped at any depth)
- `<project>/.claude/*.json` — including the gitignored `settings.local.json`, though that's now just one instance of the `.claude/**` rule above
- `<project>/CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md`, `.mcp.json`
- `~/.claude/{agents,skills,commands}/**`, `~/.claude/*.json`, `~/.claude/CLAUDE.md` — the user config dir stays deliberately narrow (see below)

Never anything else. `.bat`, `.cmd` and `.reg` are excluded (CRLF is legitimate there), as are binary files and UTF-16 files — the latter are reported rather than transcoded. Because the scan descends only into `.claude/`, a Unity `Library/` or a `node_modules/` tree is unreachable by construction, and `node_modules/`, `.git/`, `.venv/`, `venv/`, `__pycache__/` are skipped at any depth inside `.claude/` too.

## Install

```
/plugin marketplace add seretos-agents/modular-software-factory
/plugin install agent-line-feed-guard@modular-software-factory
```

## On-demand scan

Ask for a sweep in natural language ("check the line endings", "why is my subagent missing?") to trigger the `scan` skill, or run it directly:

```
node "<plugin-root>/scripts/line-feed-guard-hook.mjs" --scan [project-root]
```

## Configuration

| Variable | Effect |
|---|---|
| `LINE_FEED_GUARD_DISABLE=1` | kill switch — the hook exits immediately and writes nothing |
| `LINE_FEED_GUARD_DRY_RUN=1` | detect and report, never write |
| `LINE_FEED_GUARD_EXTRA_ROOTS` | `PATH`-separated absolute directories to treat as additional project roots |
| `LINE_FEED_GUARD_STATE_DIR` | override the directory holding per-session anti-nag markers |

## Complementary fix

The hook repairs after the fact. To stop CRLF arriving at checkout in the first place, pin line endings in your repository's `.gitattributes` — `* text=auto` alone is **not** enough:

```gitattributes
.claude/** text eol=lf
*.md       text eol=lf
```

## Development

```
node scripts/line-feed-guard-hook.test.mjs
```

Plain Node, no test framework, no dependencies.
