---
name: scan
description: >
  Scan and repair CRLF line endings across every file Claude Code parses
  (the project's whole .claude/ tree, CLAUDE.md, AGENTS.md, and the
  user-level ~/.claude/{agents,skills,commands}) and report which files the
  harness was silently ignoring. Use when a subagent, skill, or command is
  unexpectedly missing or "does not exist", after a clone, checkout, merge or
  rebase, when the user asks about line endings or CRLF, or when a file was
  just written from PowerShell.
---

# scan — on-demand CRLF sweep

## What this is for

Claude Code silently ignores a file under `.claude/agents/`, `.claude/skills/`
or `.claude/commands/` whose line endings are CRLF. There is no error, no
warning, and no log entry — the subagent, skill or command simply does not
exist. This skill runs the repair sweep on demand and tells the user what was
broken.

Reach for it when:

- a subagent or skill the user expects is not in the available list
- the user just cloned, checked out, merged or rebased (a checkout with
  `core.autocrlf=true` and no `eol=lf` in `.gitattributes` writes CRLF into the
  whole working tree at once)
- the user asks about line endings, CRLF, or why a file "isn't being picked up"
- a file under `.claude/` was just written by a PowerShell cmdlet

## How to run it

From the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/line-feed-guard-hook.mjs" --scan
```

Pass a different root as a positional argument if the project is elsewhere:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/line-feed-guard-hook.mjs" --scan /path/to/project
```

To report without writing anything, set `LINE_FEED_GUARD_DRY_RUN=1`.

The scan covers the whole `.claude/` tree — including `.claude/scripts/` and
any other subdirectory you keep there — the root `CLAUDE.md` / `AGENTS.md` /
`.mcp.json`, and the user-level `~/.claude/{agents,skills,commands}` — user
agents fail exactly the same way and are easy to overlook.

## Reading the output

- `no CRLF found` — nothing to do. Say so and stop.
- A list of converted files — report them to the user. **If any of them is under
  `agents/`, tell the user plainly that those subagents were invisible to this
  session and that Claude Code must be restarted to load them.** Agent
  definitions are read once at startup; repairing the file does not make the
  subagent appear mid-session.
- `could not rewrite …` — a permissions problem. The file still has CRLF and is
  still being ignored. Surface it; do not pretend it was fixed.
- `… is UTF-16, not UTF-8` — a different failure with the same symptom, common
  when PowerShell 5.1's `Out-File` or `>` wrote the file. The scan deliberately
  does not transcode. Offer to rewrite the file with the Write tool.

## Do not

- Do not rewrite a file the scan reports as already fixed — it is correct on
  disk, and rewriting it only churns the diff.
- Do not recreate a subagent definition that the scan just repaired. The file
  exists and is valid; it is the *registry* that is stale until restart.
