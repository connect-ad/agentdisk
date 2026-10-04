---
title: "REST vs MCP: Which API for AI Agent Storage?"
slug: rest-vs-mcp-ai-agent-storage
description: "MCP and REST both reach AgentDisk storage through the same handlers. What MCP is, how it differs from REST, and when to use each, with examples."
date: 2026-10-01
author: "AgentDisk team"
tags: [mcp, api, tutorial]
keywords: [REST vs MCP, MCP protocol file storage]
---

AgentDisk exposes the same file storage two ways: a plain REST API and an MCP server. People reasonably ask which one they should use. The short answer is that it depends on who is making the decisions. If a language model is choosing which storage operation to run, use MCP. If your own code is choosing, use REST. The rest of this post explains why, shows both in practice, and covers what stays identical between them.

## What MCP is

The Model Context Protocol is an open protocol for connecting language model applications to external tools and data. An MCP client, such as Claude Code, Cursor or VS Code with Copilot, connects to an MCP server and asks it what it can do. The server answers with a list of tools, each with a name, a description and a JSON Schema for its inputs. The model reads those descriptions and decides when to call which tool, and the client sends the call to the server.

Under the hood, MCP messages are JSON-RPC 2.0. Two methods matter most for a tool server:

- `tools/list` returns the tools the server offers, with their input schemas.
- `tools/call` runs one tool with a set of arguments and returns the result.

A real client also performs an `initialize` handshake to agree on a protocol version and capabilities before it starts calling tools.

MCP defines transports for carrying those messages. Local servers often run as a subprocess over standard input and output. Remote servers, like AgentDisk's, use the streamable HTTP transport: the client sends JSON-RPC messages as HTTP POST requests to a single endpoint, and the server can answer with plain JSON or stream responses.

AgentDisk's MCP server speaks JSON-RPC 2.0 over streamable HTTP at `/mcp`, implements protocol version 2025-06-18, and authenticates with the same API key as the REST API, sent as a Bearer token.

## How MCP differs from REST

REST is organised around resources and HTTP verbs. A file is a URL; you `POST` to create, `GET` to read, `DELETE` to remove. The caller is expected to know the API: which path, which method, which fields. That suits code, because a developer reads the documentation once and writes the calls.

MCP is organised around tools that describe themselves. Everything goes to one endpoint as `tools/call` with a tool name and arguments. The caller is expected to discover the API at runtime by reading tool descriptions. That suits models, because the model does not have your documentation, but it can read a tool list and a schema in its context and decide what to call.

| | REST | MCP |
|---|---|---|
| Shape | Resources and HTTP verbs | Named tools over JSON-RPC 2.0 |
| Endpoint | Many paths under `/v1` | One endpoint, `/mcp` |
| Discovery | Read the docs | `tools/list` at runtime |
| Typical caller | Your code | An LLM through an MCP client |
| Auth | Bearer API key | The same Bearer API key |

## What each surface offers

The AgentDisk MCP server has eleven tools: `list_files`, `search_files`, `read_file`, `get_file`, `get_metadata`, `create_file`, `update_file`, `delete_file`, `create_folder`, `move_file` and `copy_file`. That is the set of file operations an agent needs while working. `read_file` returns up to 1 MB inline as text or base64; `get_file` returns metadata and a short-lived download URL for anything larger. `create_file` takes base64 content up to 1 MB inline, and returns a presigned upload URL above that. Tool results carry JSON both as text and as `structuredContent`.

The REST API covers the same file operations, plus things the MCP server deliberately does not expose. Workspace, agent and key management are REST only. An agent connected over MCP can work with files but cannot mint a key, change an agent or touch workspace settings through that connection, even if its key would otherwise allow it. That is a design decision: the surface a model drives should not be able to widen its own access.

## When to use MCP

Use MCP when a model is in the loop and should decide which storage operation to make. Typical cases:

- A coding assistant that saves notes, plans or generated files as it works.
- A chat agent that should remember things across sessions by writing and reading files.
- A research agent that decides for itself what to save, search for and read back.

In these cases MCP saves you from writing glue code. You do not define tool schemas, write handlers or parse arguments; the client lists the tools and the model uses them. Connecting Claude Code takes one command:

```bash
export AGENTDISK_KEY=ask_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
claude mcp add --transport http agentdisk {{MCP_ENDPOINT}} \
  --header "Authorization: Bearer $AGENTDISK_KEY"
```

We have documented configurations for Claude Code, Claude Desktop (through the mcp-remote bridge), Cursor, VS Code with Copilot, Windsurf, Zed, OpenAI Codex CLI and Gemini CLI. The [MCP file storage quickstart](/blog/mcp-file-storage-quickstart) walks through setup.

## When to use REST

Use REST when your code, not a model, decides what happens. Typical cases:

- Scripts and scheduled jobs that upload or collect files on a fixed schedule.
- Pipelines that move agent output into other systems.
- Large uploads, where your code streams bytes to a presigned URL.
- Key management: minting a narrow key for each agent, disabling keys, setting up workspaces.

Large files are a good example of the split. Over REST, you `POST /v1/files` with the path, MIME type and size, get back a presigned `PUT` URL that is valid for 15 minutes, upload the bytes directly to it with no Authorization header, then call `POST /v1/files/:id/complete`. That flow is natural for code. A model can be handed the same presigned URL by `create_file`, but moving hundreds of megabytes is a job for code, not for a model's context window.

## The same operation both ways

Here is one small text file created over each surface.

### Over MCP with curl

For a quick test you can talk to the MCP endpoint directly with curl. First, list the tools and their input schemas:

```bash
curl -s -X POST {{MCP_ENDPOINT}} \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Then call `create_file`. The content is base64; `aGVsbG8gZnJvbSBtY3A=` is "hello from mcp". Check the input schema returned by `tools/list` for the exact argument names:

```bash
curl -s -X POST {{MCP_ENDPOINT}} \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_file","arguments":{"path":"/notes/hello.txt","mimeType":"text/plain","content":"aGVsbG8gZnJvbSBtY3A="}}}'
```

In normal use you never write this by hand; the MCP client builds these messages when the model decides to call a tool.

### Over REST with curl

The REST equivalent is a single `POST /v1/files`, which also accepts a caption, tags and custom metadata:

```bash
curl -s -X POST {{API_BASE}}/v1/files \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path":"/notes/hello.txt","mimeType":"text/plain","content":"aGVsbG8gZnJvbSByZXN0","caption":"First note","tags":["notes"],"metadata":{"source":"nightly-run"}}'
```

A successful inline upload, up to 1 MB, returns 201 with the new file, whose ID starts with `fil_`.

### Over REST with Python

From a script, the same thing with `requests`, followed by a listing of the folder:

```python
import base64
import os
import requests

API = "{{API_BASE}}"
HEADERS = {"Authorization": f"Bearer {os.environ['AGENTDISK_KEY']}"}

body = {
    "path": "/reports/daily.txt",
    "mimeType": "text/plain",
    "content": base64.b64encode(b"All checks passed.").decode(),
    "tags": ["daily"],
}
r = requests.post(f"{API}/v1/files", json=body, headers=HEADERS)
r.raise_for_status()
print("created", r.json()["file"]["id"])

listing = requests.get(f"{API}/v1/files", params={"path": "/reports", "limit": 200}, headers=HEADERS)
listing.raise_for_status()
print(listing.json())
```

Listings return 50 entries by default and up to 200 per page.

## Same auth chain, same answers

Whichever surface you choose, the request goes through the same authorization chain: authenticate the key, resolve its scope, bind the workspace from the credential, authorize the operation and the path, check quota and billing, then run the handler. The MCP tools call the REST handlers themselves, so the two surfaces cannot drift apart.

In practice that means:

- A key scoped to `read` and `list` on `/agents/researcher` has exactly that scope over both surfaces.
- A file outside the key's prefix answers as not found, over REST and over MCP alike.
- A write that would exceed a plan limit is refused the same way, naming the dimension.
- Every authentication failure returns one identical body, whichever door it came through.
- The activity log records every MCP tool call, including denied ones.

So the choice between REST and MCP is about ergonomics, not about security or capability for file work. Pick MCP for the model, REST for your code, and use both where it helps: many setups have a script that mints a scoped key over REST and an agent that uses that key over MCP. For key scoping see [scoped credentials for AI agents](/blog/scoped-credentials-ai-agents), for the endpoint reference see the [API docs](/docs/api), and for how the authorization chain is built see the [security page](/security).

## Frequently asked questions

### Do I need separate keys for REST and MCP?

No. The MCP server authenticates with the same API key as the REST API, sent as a Bearer token. A key's operations and path prefix apply identically on both surfaces.

### Why can I not manage keys over MCP?

It is deliberate. Workspace, agent and key management are not exposed over MCP so that the surface a model drives cannot widen its own access. Manage keys over REST from your own code.

### Can MCP handle files larger than 1 MB?

Yes, through a presigned upload URL. The create_file tool takes base64 content up to 1 MB inline and returns a presigned upload URL above that, and get_file returns a short-lived download URL for reading large files. For bulk or very large transfers, REST from your own code is usually simpler.

### Which MCP clients work with AgentDisk?

Any client that supports remote MCP servers over streamable HTTP with a Bearer header. We have documented configurations for Claude Code, Claude Desktop through mcp-remote, Cursor, VS Code with Copilot, Windsurf, Zed, OpenAI Codex CLI and Gemini CLI, and plain curl works too.

### Do REST and MCP return different results for the same request?

The results come from the same handlers, so the data is the same. The envelope differs: MCP wraps results in a JSON-RPC response with JSON as text and as structuredContent, while REST returns JSON with an HTTP status code.
