---
title: "Workspace Isolation for Multi-Agent Systems"
slug: workspace-isolation-multi-agent
description: "How to keep agents from reading or overwriting each other's files: workspaces, per-agent keys, handoff prefixes, and how AgentDisk enforces tenant isolation."
date: 2026-10-04
author: "AgentDisk team"
tags: [architecture, multi-agent, security]
keywords: [multi-agent workspace, tenant isolation AI]
---

A single agent with a folder of its own is easy to reason about. Add a second agent, then a third, then a set of agents per customer, and the storage question changes. It is no longer "where do files go" but "who can see and change which files", and the answer you get by default from a shared filesystem or a single bucket is "everyone, everything".

This post covers what goes wrong when multiple agents share flat storage, the layout patterns we recommend for keeping them apart, how quotas behave across workspaces, and how AgentDisk enforces the boundaries underneath.

## What goes wrong on a flat shared filesystem

When every agent writes into one shared space with one shared credential, the agents are separated only by convention: by the folder names you told them to use and the instructions you gave them. Conventions hold until a model decides otherwise.

### Agents overwrite each other

Two agents asked to "save the summary" both pick `summary.md`. Two runs of the same agent, started in parallel, both write `output/results.json`. The last write wins, and nobody is told. With agents that pick their own filenames, collisions are not rare; they are the expected outcome of similar instructions.

### Agents read each other's work

An agent that lists the storage root sees every other agent's files. If it is working on customer A and happens to find a file from customer B's run that looks relevant, it may well use it. That is a data leak produced by the model being helpful, not by anyone being malicious.

### One mistake reaches everything

A shared credential means every agent has the union of everyone's permissions. A cleanup agent that misjudges its scope, an injected instruction in a document, or a leaked configuration file each puts the entire store at risk, not the part that agent was meant to handle.

### You cannot tell who did what

If every agent uses the same credential, logs show one actor. When a file disappears, you cannot say which agent deleted it.

## Patterns for isolating agents

AgentDisk gives you three levels of separation: workspaces, keys scoped to path prefixes, and members who can read but not write. The patterns below combine them.

### A workspace per client or project

A workspace is the unit of storage and isolation in AgentDisk. Each one has its own `ws_…` ID, and a key belongs to exactly one workspace; a key cannot be pointed at another workspace by anything in the request.

If your agents work for several of your own customers, give each customer a workspace. If you run separate projects with no reason to share files, give each project a workspace. Then deleting a customer's data is one workspace deletion, and no prompt, filename or bug can make an agent working for one customer reach another customer's files.

Plans include different numbers of workspaces: 1 on Free, 3 on Basic, 10 on Pro and 50 on Team.

### A key per agent, bound to its own prefix

Inside a workspace, give each agent its own API key with a path prefix such as `/agents/<name>`:

```bash
curl -s -X POST {{API_BASE}}/v1/keys \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"researcher","ops":["read","write","list"],"pathPrefix":"/agents/researcher"}'
```

The prefix is matched on whole path segments, so `/agents/researcher` does not reach `/agents/researcher-2/`. Listings and searches made with the key are clipped to the prefix, and any file outside it answers 404. The researcher agent cannot overwrite the writer agent's files because it cannot see them, and it cannot pick a path outside its own tree.

The calling key in that example needs `keys:create`, and it can only mint keys that are a subset of itself. An orchestrator agent can create worker keys at runtime but cannot create one more powerful than its own. Key management is not exposed over MCP, so this is done from your own code over REST.

### An agent per role

It also helps to divide agents by role, not just by name: a collector that gathers source material, an analyst that produces findings, a writer that drafts the output. Each role gets only the operations it needs. Most roles need `read`, `write` and `list`; few need `delete`. Because deletion is permanent and there is no recycle bin, keep `delete` for a dedicated cleanup role with a narrow prefix, if you need it at all.

### A shared prefix for handoff

Agents in a pipeline need to pass work along. Rather than letting the next stage read the previous stage's private tree, define a handoff prefix and give each side the access it needs:

| Key | Operations | Prefix |
|---|---|---|
| collector | `read`, `write`, `list` | `/agents/collector` |
| collector-handoff | `write`, `list` | `/handoff/sources` |
| analyst | `read`, `write`, `list` | `/agents/analyst` |
| analyst-intake | `read`, `list` | `/handoff/sources` |

The collector publishes into `/handoff/sources`; the analyst reads from it but cannot change what it was handed. Each key holds one prefix, so an agent that needs both a private tree and a handoff tree holds two keys. Count those against your plan's key allowance: 2 on Free, 6 on Basic, 20 on Pro and 100 on Team.

If the next stage should start as soon as something arrives, a webhook on `file.created` tells your orchestrator without any agent polling. Webhook deliveries are signed with HMAC-SHA256 so you can verify they came from AgentDisk.

### Readers for humans

People often need to see what agents produced without being able to change it. Invite them into the workspace as members. Members are readers: they can look but cannot write. A reviewer cannot accidentally edit an agent's output, and the agent's files stay exactly as the agent wrote them.

## Quota across workspaces

Separating agents into workspaces does not multiply your storage. Storage and file count are pooled across the account: every workspace draws from the same plan allowance. Egress is counted per workspace per month, so each workspace gets the plan's monthly egress allowance and a download-heavy workspace cannot use up a quiet one's.

| Plan | Storage (pooled) | Files (pooled) | Egress per workspace per month |
|---|---|---|---|
| Free | 1 GB | 10,000 | 10 GB |
| Basic | 5 GB | 100,000 | 50 GB |
| Pro | 50 GB | 1,000,000 | 500 GB |
| Team | 500 GB | 10,000,000 | 5,000 GB |

At 80% and 95% of a limit, writes carry a warning. A write that would exceed a limit is refused with HTTP 429 naming the dimension; nothing is charged as overage, because overage charges do not exist. More on how the caps behave in [hard-capped pricing](/blog/hard-capped-pricing-ai-storage), and the full table is on the [pricing page](/pricing).

An agent can check its own position at the start of a run with `GET /v1/whoami`, which returns the workspace the key belongs to, the scopes it holds and how much room is left.

## How AgentDisk enforces the boundaries

Patterns are only as good as the enforcement under them. Here is what happens on every request, REST or MCP, before any handler runs.

### One authorization chain

There is a single chain for both surfaces: authenticate the key, resolve its scope, bind the workspace, authorize the operation and the path, check quota and billing, and only then run the handler. The MCP tools call the same REST handlers, so an agent cannot get around a rule by switching protocols.

### The workspace comes from the credential

The workspace is bound from the credential, never from client input. There is no workspace parameter an agent could change to aim at a different tenant. A key for workspace A is a key for workspace A, whatever the request body says.

### Handlers never see raw storage

Request handlers never receive a raw database or bucket binding. They get storage objects already bound to the authorized workspace. Storage methods take a file ID and derive the object key themselves, so a handler cannot construct a path into another tenant's data even by mistake.

### Cross-tenant requests answer 404

If a request names a file ID that belongs to another workspace, the answer is 404, the same as a file that does not exist. The response does not confirm that the ID is real.

### Tested, not assumed

Isolation has its own tests. They seed two workspaces and prove that every route answers the other tenant's IDs with 404. Beyond that, we deliberately broke security-critical storage code in 22 different ways, and each mutation turned the test suite red. The API suite has more than 1,000 automated tests.

### Audited

The activity log records file creates and deletes, changes to agents, keys, members, share links and webhooks, and every MCP tool call including denied ones, with the actor, source IP, path and outcome. With one key per agent, every entry names the agent that made the call. Metadata edits, moves and copies over REST are not yet audited.

For the full description of these controls, see the [security page](/security). For how to scope individual keys, see [scoped credentials for AI agents](/blog/scoped-credentials-ai-agents).

## Frequently asked questions

### What is the difference between a workspace and a path prefix?

A workspace is a hard boundary: a key belongs to one workspace and cannot reach another, and requests for another workspace's file IDs answer 404. A path prefix is a boundary inside a workspace, applied to a single key, that clips what the key can list, read and write.

### Can an agent in one workspace read files from another workspace?

No. The workspace is bound from the agent's credential, never from anything in the request, and requests for another workspace's file IDs answer 404. Isolation tests check this for every route.

### Do separate workspaces each get their own storage quota?

No. Storage and file count are pooled across the account, so all workspaces share the plan allowance. Egress is the exception: it is counted per workspace per month.

### How do agents hand work to each other without sharing everything?

Use a handoff prefix. The producing agent gets a key that can write to it, and the consuming agent gets a key with read and list on it. Each keeps a separate key for its own private prefix.

### Can people review agent output without changing it?

Yes. Invite them into the workspace as members. Members are readers and cannot write, so they can see agent output without being able to alter it.
