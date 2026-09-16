# 001 · Import the design system from Claude Design

**Status:** Done — 2026-09-05

The AgentDisk design system was built inside the Claude Design project
`agent-storage-mcp` (`d311bfd0-9751-4a9b-84f4-b33e7a09378e`), not in this repo.
Pulled it down via the claude_design MCP read tools into `design-system/`.

96 of 97 project files imported, **every one byte-identical** to the remote,
verified file-by-file against `list_files` sizes. Not imported: `.thumbnail`
(5584 B binary preview, the only remote entry outside the requested list).

`design-system/` is the upstream mirror. Treat it as read-only: changes belong
in the Claude Design project, then re-import.

Transfer gotchas are recorded in [../.design-sync/NOTES.md](../.design-sync/NOTES.md) —
entity decoding order, literal `\uXXXX` escapes, sed mangling multibyte on this
machine, and the ~8-10 KB Bash heredoc ceiling.
