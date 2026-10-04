---
title: "MCP File Storage in 5 Minutes with AgentDisk"
slug: mcp-file-storage-quickstart
description: "Step by step: get an AgentDisk key with one curl, connect Claude Code or Cursor over MCP, write and read your first file, and check the audit log."
date: 2026-10-03
author: "AgentDisk team"
tags: [tutorial, mcp, claude-code]
keywords: [MCP file storage, MCP server setup, Claude Code file storage, Cursor MCP storage]
---

This is a hands-on tutorial. By the end, your agent will have a persistent, scoped workspace it can read and write over the Model Context Protocol, you will have watched it create and read a file, and you will know where to see a record of every call it made. You need a terminal with `curl` and an MCP client. We use Claude Code and Cursor as examples; other clients follow the same shape.

## What you are setting up

AgentDisk exposes an MCP server at {{MCP_ENDPOINT}}. It speaks JSON-RPC 2.0 over streamable HTTP, protocol version 2025-06-18, and authenticates with an API key sent as a Bearer token. There is no browser sign-in step inside the MCP client; the key is the whole credential.

The server offers eleven tools:

| Tool | What it does |
|---|---|
| `list_files` | List files and folders under a path |
| `search_files` | Substring search over name, path, caption and tags |
| `read_file` | Return file contents inline, up to 1 MB, as text or base64 |
| `get_file` | Metadata plus a short-lived download URL |
| `get_metadata` | Metadata only |
| `create_file` | Upload inline up to 1 MB, or get a presigned upload URL above that |
| `update_file` | Change caption, tags or custom metadata; bytes are immutable |
| `delete_file` | Permanent delete |
| `create_folder` | Create a folder |
| `move_file` | Move a file |
| `copy_file` | Copy a file |

Workspace, agent and key management are deliberately not exposed over MCP. The agent works with files; it cannot widen its own access.

## Step 1: Get a key

You have two options.

**Option A: a sandbox, no account.** One unauthenticated request creates a workspace, an agent key and a one-time claim link:

```bash
curl -s -X POST {{API_BASE}}/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name":"research","agentName":"research-bot"}'
```

Copy the key and the claim link from the response. The claim link is one-time, so keep it somewhere safe. A sandbox holds 500 MB and 500 files, lasts three days unless claimed, and cannot create share links. Sandbox creation is limited to 10 per hour per IP, with at most 5 unclaimed sandboxes per IP. You can also do this from the [sandbox page](/sandbox).

**Option B: sign up.** Create an account with Google, GitHub, email and password, or an email link. The Free plan needs no card and includes 1 GB of storage. Create an agent in a workspace and issue a key for it. When you issue a key, you choose its operations and, optionally, a path prefix. For this tutorial, `read`, `write` and `list` are enough.

Either way, put the key in an environment variable:

```bash
export AGENTDISK_KEY=ask_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Check that it works. `whoami` tells you which workspace the key is bound to, what it is allowed to do, and how much room is left:

```bash
curl -s {{API_BASE}}/v1/whoami \
  -H "Authorization: Bearer $AGENTDISK_KEY"
```

The key must go in the `Authorization` header. A key passed in a query string is rejected, so it does not end up in proxy logs or browser history.

## Step 2: Connect Claude Code

One command registers the server:

```bash
claude mcp add --transport http agentdisk {{MCP_ENDPOINT}} \
  --header "Authorization: Bearer $AGENTDISK_KEY"
```

Start a Claude Code session and ask it to list the MCP tools it has. You should see the eleven AgentDisk tools. Claude Code is covered in more depth on the [storage for Claude page](/storage-for-claude).

## Step 3: Connect Cursor

Cursor reads MCP servers from `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "agentdisk": {
      "url": "{{MCP_ENDPOINT}}",
      "headers": { "Authorization": "Bearer ask_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" }
    }
  }
}
```

Replace the placeholder with your key. If the file lives in a repository, keep it out of version control, because the key is a credential. See [storage for Cursor](/storage-for-cursor) for more.

Claude Desktop (through the `mcp-remote` bridge), VS Code with Copilot, Windsurf, Zed, the OpenAI Codex CLI and the Gemini CLI also have documented configurations in the [docs](/docs). The pattern is always the same: the endpoint URL plus an `Authorization: Bearer` header.

## Step 4: Verify with curl

Before blaming a client config, confirm the server answers your key directly. This is a raw JSON-RPC `tools/list` call:

```bash
curl -s -X POST {{MCP_ENDPOINT}} \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response lists the tools and their input schemas. If you get an authentication error instead, check the key. Every authentication failure returns the same body on purpose, whether the key is malformed, unknown or disabled, so the error will not tell you which. Re-copy the key, and if it was disabled and re-enabled, note that re-enabling issues a new secret.

## Step 5: Create and read your first file

Now let the agent do the work. In Claude Code or Cursor, ask something like:

```text
Create a file at /notes/hello.md containing a three-line summary of what
this project does, tagged "notes". Then read it back and show me.
```

The agent will call `create_file`, then `read_file`. Tool results carry JSON both as text and as `structuredContent`, so clients that understand structured output can use it directly.

The same write over REST, for comparison, is one request with base64 content:

```bash
curl -s -X POST {{API_BASE}}/v1/files \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path":"/notes/hello.txt","mimeType":"text/plain","content":"aGVsbG8gZnJvbSBjdXJsCg==","caption":"First note","tags":["notes"]}'
```

That returns `201` with a `file` object whose ID starts with `fil_`. The MCP tools call the same REST handlers, so a file written one way is readable the other way, and both paths go through the same authorization and quota checks.

A few behaviours worth knowing early:

- Inline uploads and inline reads stop at 1 MB. Above that, `create_file` returns a presigned upload URL valid for 15 minutes, and `get_file` returns a download URL valid for one hour.
- `search_files` matches name, path, caption and tags. It does not search inside files.
- `delete_file` is permanent. There is no recycle bin.

## Step 6: Check the Activity log

Open the Activity log for the workspace. You should see the calls you just made, including each MCP tool call with its actor, source IP, path and outcome. Denied calls are recorded too, which is the useful part when you start scoping keys tightly: if the agent tries to read outside its prefix, you see the attempt.

To group a run, send an `X-AgentDisk-Session` header (up to 120 characters) with your requests. The log is read-only and kept for the life of the workspace. One current gap: metadata edits, moves and copies made over REST are not yet audited.

## Step 7: Claim the sandbox

If you started with a sandbox, open the claim link and sign in before the three days are up. You can keep the sandbox as a new workspace or merge it into an existing one. Either way, the key is repointed, so the agent's configuration keeps working without changes.

## Where to go next

- Scope the key. Issue a key with a `pathPrefix` such as `/agents/research-bot`, so the agent cannot see anything outside its own folder. The [features docs](/docs/features) cover prefixes and key minting.
- Read the [REST quickstart](/docs/quickstart) if you want to call the API from code as well.
- Read [REST vs MCP for AI agent storage](/blog/rest-vs-mcp-ai-agent-storage) to decide which surface fits which job.
- Read the [security page](/security) for how keys are stored and how isolation is tested.

If you are curious why the system is shaped this way, [why we built AgentDisk](/blog/why-we-built-agentdisk) explains the decisions.

## Frequently asked questions

### Which MCP clients work with AgentDisk?

Any client that supports MCP over streamable HTTP with a custom Authorization header. Documented configurations exist for Claude Code, Claude Desktop through the mcp-remote bridge, Cursor, VS Code with Copilot, Windsurf, Zed, the OpenAI Codex CLI and the Gemini CLI.

### Can my agent create new keys or workspaces over MCP?

No. Workspace, agent and key management are not exposed over MCP. An API key can mint a narrower key over REST only if it holds the keys:create operation, and never one with more rights than itself.

### How large a file can the agent upload?

Inline uploads go up to 1 MB. Larger files use a presigned upload URL, up to your plan's per-file limit, which ranges from 100 MB on Free to 4.9 GB on Team.

### Why does a wrong key and a disabled key give the same error?

Every authentication failure returns one identical body, so nobody probing the API can learn whether a key exists or what state it is in. Check the key value and, if it was re-enabled, fetch the new secret.

### What happens if I never claim my sandbox?

It expires after three days. Sandboxes are meant for trying the service without an account; claim it if you want to keep the workspace and its files.
