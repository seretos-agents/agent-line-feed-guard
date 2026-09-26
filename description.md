# agent-line-feed-guard

Repairs CRLF line endings in the files Claude Code parses, so a subagent, skill, or command never silently fails to load.

Claude Code silently ignores a `.claude/agents/*.md` whose line endings are CRLF — no error, no warning, no log entry. The subagent simply does not exist. Git cannot warn you either: under `text=auto` the committed blob is already LF, so `git status` and `git diff HEAD` stay empty while the working tree still has CRLF. On Windows this happens constantly, because PowerShell cmdlets emit CRLF and a `git checkout` with `core.autocrlf=true` can CRLF an entire tree at once.

This plugin makes the failure state unreachable instead of documenting it.

## Key features

- **Silent-failure detection made loud.** At session start it reports exactly which subagent definitions the harness could not read — the single thing the bug otherwise never tells you.
- **Automatic repair, in place.** CRLF becomes LF byte for byte. UTF-8 BOMs, multibyte characters and lone `\r` are preserved untouched; binary and UTF-16 files are never rewritten.
- **Covers the shell path, which is where the bug actually comes from.** `Bash` and `PowerShell` tool calls only carry a command string, never the files they wrote, so those trigger a full scope scan rather than a guess.
- **Catches writes no tool call made.** A `FileChanged` hook picks up CRLF introduced by an external editor, a `git checkout`, or another terminal.
- **Teaches the agent, once.** The first repair in a session explains the cause and the correct write paths; every later repair is a two-line reminder. No nagging.
- **Bounded by construction.** The scan descends only into `.claude/`, so a Unity `Library/` or a `node_modules/` tree is unreachable — no measurable cost added to any tool call.
- **Project and user level.** `~/.claude/agents/` fails exactly the same way and is easy to overlook; it is covered too.
- **Fail-open.** Any unexpected error exits cleanly without output. The guard never blocks a tool call and never breaks a session.
