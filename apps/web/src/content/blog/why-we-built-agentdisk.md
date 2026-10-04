---
title: "We Built Serverless File Storage for AI Agents — Here's Why"
slug: why-we-built-agentdisk
description: "Why we built AgentDisk: scoped, audited, hard-capped file storage for AI agents over REST and MCP, and the architecture decisions behind it."
date: 2026-10-01
author: "AgentDisk team"
tags: [announcement, architecture, mcp]
keywords: [AI agent file storage, serverless storage AI, MCP file storage, scoped API keys]
---

AgentDisk went live on 30 September 2026. It is file storage built for AI agents: every agent gets a scoped, persistent workspace of files, folders and metadata, reachable over a plain REST API and an MCP server. This post explains the problem we kept running into, what we built to fix it, and the architecture decisions that shaped it.

## The problem with handing an agent a bucket

If you have built an agent that produces anything worth keeping, you have faced the storage question. The agent writes a report, collects research notes, saves intermediate results, or keeps a task list it needs to pick up tomorrow. Those files have to live somewhere other than the context window.

The usual answers are a cloud bucket or a shared drive. Both work, and both were designed for people and services, not for agents. Three problems show up quickly.

**The agent gets everything.** A bucket credential or a drive token tends to grant access to the whole bucket or the whole drive. Narrowing it is possible, but it means authoring access policies by hand for each agent, and most people do not. So the research bot that only needed to write into one folder can also read your finance exports, overwrite last month's results, or delete the lot. With a model deciding which calls to make, that is a wider blast radius than most teams would accept from a human contractor.

**There is no useful record of what the agent tried.** General-purpose storage logs can tell you which object was read. They rarely tell you, in one place, which agent attempted which operation, from where, during which run, and whether it was refused. The refused calls are the interesting ones. An agent that keeps trying to read outside its folder is telling you something about its prompt, its tools, or an injection in its input.

**The bill is a guess.** Usage-based storage pricing is fine when a person controls the usage. An agent in a loop does not stop to check the meter. A retry storm, a runaway download, or a bug that re-uploads the same file a thousand times turns into an invoice at the end of the month.

We wanted storage where the default answers to those three problems were the safe ones: the agent reaches only what it was given, every call it makes is recorded, and the bill cannot grow past the plan.

## What AgentDisk is

The model is small on purpose.

- An **account** is a person. It signs in with Google, GitHub, email and password, or an email link, and owns one billing plan.
- A **workspace** is the unit of storage and isolation. An account can have many.
- An **agent** is a named identity inside a workspace. Keys belong to agents, and disabling an agent stops every key it holds on the next request.
- An **API key** carries a set of operations (`read`, `write`, `delete`, `list`, `share`, `keys:create`) and an optional path prefix.
- A **member** is a person invited into one workspace as a reader.

Agents talk to it in one of two ways: REST at {{API_BASE}}, or MCP at {{MCP_ENDPOINT}}. The MCP server exposes eleven file tools: `list_files`, `search_files`, `read_file`, `get_file`, `get_metadata`, `create_file`, `update_file`, `delete_file`, `create_folder`, `move_file` and `copy_file`. Both surfaces take the same API key as a Bearer token.

## The decisions behind it

### One authorization chain for REST and MCP

Every request, whether it arrives as a REST call or an MCP tool call, goes through the same chain in the same order: authenticate, resolve the key's scope, bind the workspace, authorize the operation and the path, check quota and billing, and only then run the handler.

Having one chain means one place to get right and one place to test. It also means every authentication failure returns one identical body. A caller probing with guessed keys cannot learn whether a key exists, was disabled, or belongs to a different workspace.

### MCP tools call the REST handlers

The MCP server is not a second implementation. Each MCP tool calls the corresponding REST handler. If we fix a bug or tighten a check in the REST path, the MCP path gets the same fix, because it is the same code. The two surfaces cannot drift.

We also kept the MCP surface deliberately narrow. Workspace, agent and key management are not exposed over MCP. An agent can work with files; it cannot create workspaces, mint itself a broader key, or invite people. More generally, an API key can never act as a person: it cannot close the account, delete a workspace, reveal another key or invite a member.

### The workspace comes from the credential, never the request

In multi-tenant storage, the most dangerous bug is the one where a client can name someone else's tenant. We designed that bug out rather than testing for it after the fact.

The authorization chain binds the workspace from the credential. No request parameter, header or body field can choose it. Handlers never receive a raw database or bucket binding; they get storage methods that take a file ID and derive the object key themselves. Our isolation tests seed two workspaces and prove that every route answers the other tenant's IDs with 404.

### Scoped keys with path prefixes

A key can be limited to a path prefix, and the prefix is matched on whole path segments. A key scoped to `/agents/bot` does not reach `/agents/bot-evil/`. Listings and searches are clipped to the prefix, and a file outside it answers 404, so the key does not even learn that the file exists.

Keys can mint keys, but only if they hold `keys:create`, and only a subset of themselves. A parent agent can hand a sub-agent a narrower key; it cannot hand out more than it has. We wrote more about this in [scoped credentials for AI agents](/blog/scoped-credentials-ai-agents).

### Serverless on Cloudflare

The API, the MCP server and the dashboard all run on Cloudflare Workers. File bytes live in Cloudflare R2 object storage, metadata in an edge database, and webhook deliveries go through a queue. There are no servers for us to patch and none for you to run: no SSH, no Docker, no Kubernetes.

The trade-off is that we do not offer a choice of region, and we do not offer an S3-compatible API. If you need either, AgentDisk is not the right tool, and we would rather say so up front.

### Hard caps instead of overage

Every plan has hard limits on storage, file count, monthly egress and per-file size. There are no overage charges. At 80% and 95% of a limit, writes carry a warning. A write that would exceed a limit is refused with a 429 that names the dimension it hit. Requests are unlimited on every plan, and the Free plan needs no card.

| Plan | Price | Storage | Egress per month | Max file |
|---|---|---|---|---|
| Free | $0 | 1 GB | 10 GB | 100 MB |
| Basic | $9 | 5 GB | 50 GB | 500 MB |
| Pro | $20 | 50 GB | 500 GB | 1 GB |
| Team | $80 | 500 GB | 5,000 GB | 4.9 GB |

A refused write is an error your agent can handle. A surprise invoice is not. The full table, including file counts and share links, is on the [pricing page](/pricing), and the reasoning is in [hard-capped pricing for AI storage](/blog/hard-capped-pricing-ai-storage).

### An audit log that records refusals

The Activity log records every file create and delete, changes to agents, keys, members, share links and webhooks, every key reveal, and every MCP tool call, including the ones that were denied. Each entry carries the actor, source IP, path and outcome. It is read-only and kept for the life of the workspace. An optional `X-AgentDisk-Session` header lets you label a run so you can follow one agent session from start to finish.

One gap we want to be clear about: metadata edits, moves and copies made over REST are not yet audited.

### Sandbox first, account later

We wanted the first contact to take one request. A `POST` to `/v1/workspaces` with no authentication creates a sandbox: a workspace, a key, and a one-time claim link.

```bash
curl -s -X POST {{API_BASE}}/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name":"research","agentName":"research-bot"}'
```

A sandbox holds 500 MB and 500 files for three days and has no share links. If you like it, open the claim link and sign in. Claiming keeps it as a new workspace or merges it into an existing one, and the key is repointed, so the agent's key keeps working without a config change. If you do not claim it, it expires.

## What it deliberately does not do

A short list of things AgentDisk does not have, so nobody has to find out the hard way:

- Search matches name, path, caption and tags. It never searches file contents, and there is no semantic or vector search.
- There is no versioning and no recycle bin. A delete is permanent and the response says so with `"permanent": true`.
- There is no S3 API and no region selection.
- Encryption at rest is provider-managed by Cloudflare. It is not end-to-end; the service can read a file when a request authorizes it.
- There is no per-key rate limit yet.

The full security posture, including what our infrastructure providers certify and what we do not, is on the [security page](/security) and the [trust page](/trust).

## Try it

The fastest path is the [sandbox page](/sandbox) or the curl above. Then follow the [MCP quickstart](/blog/mcp-file-storage-quickstart) to connect Claude Code, Cursor or any MCP client in a few minutes. If you want the reasoning for why an agent needs persistent storage at all, start with [why AI agents need their own file system](/blog/why-ai-agents-need-file-storage).

## Frequently asked questions

### Who makes AgentDisk?

AgentDisk is a product by Kernelv5 Inc. You can reach the team at connect@agentdisk.io.

### Do I need to run any servers to use AgentDisk?

No. The API, MCP server and dashboard run on Cloudflare Workers, with files in Cloudflare R2. There is nothing to deploy, patch or scale on your side.

### Can an agent's key access other workspaces?

No. The workspace is bound from the credential, never from anything the client sends, so a key can only ever reach its own workspace. Requests for another workspace's file IDs answer 404.

### What happens when my agent hits a plan limit?

The write is refused with a 429 that names the limit it would exceed, such as storage or file count. You are never billed for going over, because going over is not possible. Before that, writes at 80% and 95% of a limit carry a warning so the agent or you can act early.

### Is AgentDisk compatible with the S3 API?

No. AgentDisk has its own REST API and an MCP server, and does not implement the S3 API. If your tooling depends on S3 compatibility, a general-purpose object store is a better fit for that part of your stack.
