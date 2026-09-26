---
name: line-feed-guard
description: >
  Apply when creating or editing any file under .claude/ — a subagent definition
  in .claude/agents/, a SKILL.md, a slash command, settings.json — or a root
  CLAUDE.md or AGENTS.md, and whenever writing a repo file from PowerShell
  (Set-Content, Add-Content, Out-File, `>`). These files are silently ignored by
  Claude Code if they have CRLF line endings.
---

# Line endings in the files Claude Code parses

## The failure this prevents

A file under `.claude/agents/`, `.claude/skills/` or `.claude/commands/` with
CRLF line endings is **silently ignored** by Claude Code. The subagent, skill or
command simply does not exist. No error, no warning, no log entry — the only
symptom is a role that is quietly absent, which in an orchestration setup means
a dispatch either fails late or falls back to a general-purpose agent while
nothing turns red.

Nothing else catches this:

- **Git cannot.** Under `text=auto` the committed blob is already LF, so
  `git status` is silent and `git diff HEAD` is empty. The CRLF exists only in
  the working tree — precisely what Claude Code reads.
- **A pre-commit hook cannot.** It inspects staged content, which is LF by
  construction, so it would never fire.

## Where CRLF comes from

| Write path | Result |
|---|---|
| `Write` tool | LF |
| `Edit` tool | preserves existing endings |
| Bash heredoc / `printf` | LF |
| PowerShell `Set-Content -Value @("a","b")` | **CRLF** |
| PowerShell `Add-Content`, `Out-File`, `>` | **CRLF** |

PowerShell cmdlets join lines with `[Environment]::NewLine`, which is CRLF on
Windows. There is no global switch that changes this, so it cannot be fixed at
the source.

## The rule

For any file under `.claude/`, plus root `CLAUDE.md` and `AGENTS.md`:

1. **Preferred — the `Write` tool.** It always writes LF.
2. **From Bash** — a heredoc or `printf`:
   ```bash
   cat > .claude/agents/reviewer.md <<'EOF'
   ---
   name: reviewer
   ---
   EOF
   ```
3. **From PowerShell, only if unavoidable** — bypass the cmdlets entirely:
   ```powershell
   [System.IO.File]::WriteAllText($path, ($lines -join "`n"))
   ```
   Never `Set-Content` or `Out-File` with an array of lines.

Also avoid PowerShell 5.1's `Out-File` and `>` for these files for a second
reason: they default to **UTF-16LE**, which Claude Code also cannot read. The
guard reports that case but deliberately does not transcode it.

## When the hook reports a repair

The plugin's hook repairs CRLF automatically and tells you which files it
touched. That message is a **confirmation, not an error**:

- Do **not** rewrite the file it just fixed. It is already correct on disk.
- Do **not** recreate a subagent definition it repaired. The file is valid; the
  harness registry is what is stale, and only a restart refreshes it.
- If it reports `could not rewrite` or `UTF-16`, the file is **still** being
  ignored. Surface that to the user instead of assuming it is handled.
