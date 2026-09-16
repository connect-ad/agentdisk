# AgentDisk — Guide: Publishing the MCP Server for Public Installation

**Date:** 2026-09-09
**Context:** AgentDisk already runs one real, permanent, publicly-reachable MCP endpoint per environment (dev: `https://api-dev.agentdisk.io/mcp`; production would be the equivalent `https://api.agentdisk.io/mcp`), authenticated with a per-agent bearer key (`ask_live_...`), speaking standard MCP JSON-RPC 2.0 (`tools/list`, `tools/call`) with `read`/`write`/`list`/`delete` scopes and optional path restriction. That is already the shape of a "remote MCP server" — nothing needs to be built to make it reachable. What's missing is: (a) a fix to the path-scope bypass documented in Part 9 of `18-full-ui-audit-and-fix-prompt.md` before this goes in front of strangers, and (b) the actual distribution mechanics covered below.

**Important prerequisite:** before doing any of this publicly, fix the MCP path-scope bypass (Part 9.4, Scenario 2 of doc 18). Right now, any agent's key — no matter how it's scoped — can read/write/list anywhere in its workspace over MCP. Publishing a public "install AgentDisk" button before that's fixed means inviting strangers to connect a tool whose core isolation guarantee doesn't hold for the exact transport they'll be using.

---

## 1. There is no single universal "install" mechanism — each client has its own

Unlike a browser extension or an npm package, there's no one registry that every AI client reads from. As of September 2026, three separate things exist and serve different purposes:

1. **Per-client "add a remote MCP server" flows** — what an end user actually clicks/types to connect. Different syntax per client (Claude Code CLI, claude.ai/Claude Desktop custom connectors, VS Code/GitHub Copilot, Cursor, etc.).
2. **The official MCP Registry** (`registry.modelcontextprotocol.io`) — a metadata index, not an install mechanism. It doesn't host or proxy your server; it just lets clients and marketplaces *discover* that it exists and how to reach it.
3. **Downstream marketplaces/directories** (e.g. Smithery, PulseMCP, and similar) — third-party curated lists that pull from the official registry and/or accept direct submissions, and are often where users actually browse for servers.

A real public launch typically means: publish good copy-paste instructions for the top few clients (§2), submit to the official registry (§3), and optionally submit to a marketplace or two (§4).

---

## 2. Copy-paste install snippets, per client

All of these assume a user has already signed up at AgentDisk, created a workspace, created an agent, and minted a key. Recommend defaulting the example key scope to something narrow (e.g. `read, list` on a specific path) rather than full read/write/delete, since most users copy-pasting a quickstart snippet won't think to narrow it themselves.

### Claude Code (CLI)

```bash
claude mcp add --transport http agentdisk https://api.agentdisk.io/mcp \
  --header "Authorization: Bearer <YOUR_AGENTDISK_KEY>" \
  --scope user
```

`--scope user` makes it available across all of that user's projects (not just the current repo). This is the cleanest client to support first — it takes a raw bearer header natively, no OAuth needed.

### Claude Code / any client via project config (`.mcp.json`)

For teams who want to check a shared config into a repo (using an environment variable rather than a literal key, so the secret itself isn't committed):

```json
{
  "mcpServers": {
    "agentdisk": {
      "type": "http",
      "url": "https://api.agentdisk.io/mcp",
      "headers": {
        "Authorization": "Bearer ${AGENTDISK_KEY}"
      }
    }
  }
}
```

### claude.ai / Claude Desktop (custom connector)

Individual (Pro/Max): **Settings → Connectors → Add custom connector** → paste `https://api.agentdisk.io/mcp` → Advanced Settings.

Team/Enterprise (org owner): **Organization settings → Connectors → Add → Custom → Web** → same URL.

**Caveat worth knowing before promising this path:** claude.ai's custom-connector UI is built primarily around OAuth (Client ID/Secret in Advanced Settings), and there are open reports of it not offering a plain "Authorization: Bearer" header field the way Claude Code and VS Code do. Until confirmed otherwise against the current UI, don't advertise "paste your AgentDisk key into claude.ai" as a supported flow — advertise Claude Code and VS Code/Copilot (both confirmed to take a raw header) as the primary supported clients today, and treat claude.ai/Desktop support as contingent on either (a) confirming the current UI does accept a static bearer header, or (b) adding OAuth (§5).

### VS Code / GitHub Copilot

Add to the workspace or user `mcp.json`:

```json
{
  "servers": {
    "agentdisk": {
      "url": "https://api.agentdisk.io/mcp",
      "requestInit": {
        "headers": {
          "Authorization": "Bearer <YOUR_AGENTDISK_KEY>"
        }
      }
    }
  }
}
```

VS Code also has a built-in MCP server gallery/browse UI; once listed in the official registry (§3) it's a candidate for that gallery too, which is a lower-friction path than asking users to hand-edit `mcp.json`.

### Cursor and other MCP-capable IDEs

Same shape as VS Code — a `mcpServers` (or equivalent) block in that tool's own settings file, `url` + a header carrying the bearer token. Worth a short docs page per client rather than assuming one snippet covers all of them, since the exact JSON key names differ slightly (`servers` vs `mcpServers`, `requestInit.headers` vs `headers`, etc.).

---

## 3. Submitting to the official MCP Registry

The registry (`registry.modelcontextprotocol.io`, currently in preview) is a metadata index other tools and marketplaces read from — it does not require your server to be open source, only that it's **publicly reachable** (which `api.agentdisk.io/mcp` already is).

Steps:

1. **Claim a namespace.** Server names are reverse-DNS-shaped (e.g. `io.github.agentdisk/agentdisk` or, if verifying the `agentdisk.io` domain directly, `io.agentdisk/agentdisk`). Namespace ownership is proved via a GitHub-account check or a DNS/HTTP domain-verification challenge against `agentdisk.io` — so whoever controls that domain's DNS (or a well-known HTTP path on it) needs to run this step.
2. **Write a `server.json`** describing the server per the registry's schema — name, description, and (for a remote server, as opposed to an npm/PyPI-packaged one) the remote endpoint URL and transport type, plus whatever auth metadata the schema supports for a bearer-key-authenticated remote server.
3. **Publish it** via the registry's publish API/CLI (the registry provides a small publishing tool once namespace ownership is verified).
4. **Keep it current.** Downstream marketplaces poll the registry periodically (roughly hourly, per its own docs) — a version bump or URL change in `server.json` propagates outward from there rather than needing separate re-submission everywhere.

The registry explicitly does *not* do security scanning of your server's actual behavior (it delegates that to package registries for packaged servers, and to downstream aggregators for curation) — so listing here doesn't substitute for AgentDisk's own security fixes (the path-scope bypass most of all).

---

## 4. Marketplaces / directories (optional, but where users actually browse)

Once listed in the official registry, submitting the same metadata to a curated MCP marketplace (Smithery, PulseMCP, and similar aggregators mentioned in the registry's own ecosystem docs) is usually a short form pointing back at the same `server.json`/URL. These are worth doing after §2 and §3 are solid, not before — a marketplace listing just drives more traffic to the same install snippets.

---

## 5. Bearer key vs. OAuth — the real tradeoff for a public launch

AgentDisk's current model (a long-lived `ask_live_...` bearer key, copy-pasted into a header) works today for every client that accepts a raw header (Claude Code, VS Code/Copilot, Cursor). It has two real costs at public-launch scale:

- **claude.ai's own custom-connector UI leans OAuth-first** (see the caveat in §2) — without OAuth, that specific on-ramp may not work cleanly.
- **A copy-pasted long-lived key is worse UX and worse security than a real login flow** for a stranger installing your server for the first time — no expiry prompt, no per-install revocation from the *client* side, and a raw secret sitting in a config file.

Recommended path: keep the bearer-key model as-is for the technical/CLI audience (Claude Code, VS Code, Cursor) — it works today and those users are comfortable with it — and treat adding an OAuth 2.1 authorization-code flow (with Dynamic Client Registration and PKCE, the pattern the broader MCP ecosystem has converged on for this) in front of the same `/mcp` endpoint as a medium-term investment specifically to unlock claude.ai's one-click connector flow and any future registry requirement that leans OAuth. The underlying per-agent scoping model (ops + pathPrefix) doesn't need to change — OAuth would just be a second, friendlier way to mint the equivalent of a scoped session on top of the same authorization checks (once the path-scope bug is fixed so those checks are actually trustworthy over MCP).

---

## 6. Suggested order of operations

1. Fix the MCP path-scope bypass (blocking — see doc 18, Part 9.4).
2. Publish the Claude Code and VS Code/Copilot copy-paste snippets (§2) on AgentDisk's own docs site — these work today, no new engineering required.
3. Verify (don't assume) whether claude.ai's custom-connector Advanced Settings currently accepts a static bearer header; document accordingly.
4. Submit to the official MCP Registry (§3) once the domain-verification owner is available to run that step.
5. Treat OAuth (§5) as a follow-up milestone, not a blocker for an initial public listing aimed at developers using Claude Code/VS Code/Cursor.
