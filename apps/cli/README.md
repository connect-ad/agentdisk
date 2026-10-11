# agentdisk

**The disk an AI agent keeps between runs.** Persistent, audited file storage
for agents — over a REST API, an MCP server, or this CLI. No dependencies, no
servers to run, and a hard spending cap so a runaway loop cannot run up a bill.

```bash
npx agentdisk ls /
```

## Try it without an account

Open <https://agentdisk.io/sandbox>. It issues a real workspace and a real
key, needs no sign-up and no card, and hands you the two lines to paste below.
It is browser-only on purpose — the endpoint behind it is bot-checked, so
there is no curl for this step.

## Use it

The key is read from the environment and is never accepted as an argument —
an argument would land in your shell history.

```bash
export AGENTDISK_KEY=ask_live_…

agentdisk whoami                       # which workspace and scopes this key holds
agentdisk ls /memory                   # list a folder
agentdisk put notes.md /memory/notes.md
agentdisk cat /memory/notes.md
agentdisk search "deployment runbook"
agentdisk rm /memory/notes.md --yes    # permanent; there is no restore
```

| Option | |
|---|---|
| `--session <label>` | Names this run in the audit log, so an agent's writes are attributable |
| `--json` | Print the API's JSON instead of a summary |
| `--mime <type>` | MIME type for `put` (default: guessed from the extension) |
| `--yes` | Confirm a destructive command |

| Environment | |
|---|---|
| `AGENTDISK_KEY` | The API key. Required. |
| `AGENTDISK_API` | API base URL. Defaults to `https://api.agentdisk.io`. |

## For agents, not just people

Paths resolve by listing, never by guessing — the API addresses files by id,
so `agentdisk cat /memory/tasks.md` lists the parent and matches the exact
path. A typo is `no such file`, never a neighbouring file that shared a
prefix.

If your agent speaks MCP, skip the CLI and point it at the server directly:

```json
{ "mcpServers": { "agentdisk": { "url": "https://mcp.agentdisk.io" } } }
```

## Links

- Docs — <https://agentdisk.io/docs>
- Pricing — <https://agentdisk.io/pricing> (free tier is 1 GB, no card)
- OpenAPI — <https://agentdisk.io/openapi.json>
- MCP server card — <https://agentdisk.io/.well-known/mcp/server-card.json>

MIT. Built by [Kernelv5 Inc.](https://kernelv5.com/)
