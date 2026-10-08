---
title: "Three Agent Automations You Can Build on a Shared Disk"
slug: three-agent-automations
description: "Agent memory that survives the session, a two-agent handoff over webhooks, and a nightly report run — three automations, with the calls for each."
date: 2026-10-07
author: "AgentDisk team"
tags: [tutorial, automation, mcp, webhooks]
keywords: [AI agent automation, agent memory persistence, multi-agent handoff, agent file storage, scheduled agent reports, MCP file storage]
---

An AI agent can reason, call tools and write code. What it usually cannot do is remember. The session ends and the working notes, the half-finished task list and the file it produced go with it. Give two agents a job between them and it gets worse: there is nowhere for the first to leave its output where the second can reliably find it, so you end up passing text through a prompt and hoping.

Almost every interesting agent automation turns out to need the same missing piece — a disk the agent can reach, that outlives the run, that you can see into, and that does not hand one agent the keys to everything. We have written before about [why agents need file storage at all](/blog/why-ai-agents-need-file-storage); this post is the practical half.

This post builds three of them. You need a terminal with `curl`, and for the first one an MCP client such as Claude Code or Cursor. Nothing here assumes you have used AgentDisk before, and the first step gives you a working key without an account.

## What AgentDisk is, in one paragraph

AgentDisk is file storage designed to be used by agents rather than by people. It is a REST API at `{{API_BASE}}` and an MCP server at `{{MCP_ENDPOINT}}`, and the MCP tools are thin wrappers over the same REST handlers, so the two surfaces cannot disagree. A workspace is the unit of isolation: files, folders, agent identities, API keys and an audit log of every call. A key carries a scope — some combination of `read`, `write`, `delete` and `list`, plus a path prefix it may not leave — and the prefix is matched a whole segment at a time, so a key for `/agents/bot` is refused at `/agents/bot-evil/secrets.txt` — the reasoning behind that is in [scoped credentials for agents](/blog/scoped-credentials-ai-agents). Storage is on Cloudflare R2 behind a Worker, and every plan has a hard cap rather than usage billing, so an agent in a loop costs you a `403` and not an invoice.

Three facts matter for what follows. **Writes are attributable** — every call lands in an activity log against an agent identity, and you can label a run with an `X-AgentDisk-Session` header. **Metadata is searchable** — a file carries a caption and tags, and search covers names, paths, captions and tags, which is how an agent finds its own earlier work. **Storage emits events** — `file.created`, `file.updated`, `file.deleted`, `folder.created` and `folder.deleted` can be delivered to a URL you own, which is what turns a disk into a trigger.

## The shape all three share

The three automations below differ only in what starts them. Each one is a trigger, an agent holding a scoped key, a path convention on one workspace, and whoever reads the result next.

```diagram
automation-lanes
```

That is worth saying plainly, because it is the reason these are cheap to build: you are not standing up three systems. You are agreeing on three folder names.

## Step 0: get a key, with no account

`POST /v1/workspaces` with no credential at all provisions a sandbox. This route exists because a headless agent has no browser to sign in with, and it is the fastest way to follow the rest of this post.

```bash
curl -X POST {{API_BASE}}/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name":"automations","agentName":"demo-bot"}'
# → 201 {
#     "workspace": { "id": "ws_…", "plan": "sandbox", "claimed": false, "deleteAfter": "…" },
#     "agent":     { "id": "agt_…", "name": "demo-bot" },
#     "apiKey":    { "id": "key_…", "token": "ask_live_…",
#                    "scopes": { "ops": ["read","write","delete","list"], "pathPrefix": "/*" } },
#     "claim":     { "url": "https://…", "expiresAt": "…" },
#     "nextSteps": [ … ]
#   }
```

Keep the `token` — it is shown once. Keep the `claim.url` too: opening it in a browser attaches the workspace, and everything the agent wrote in the meantime is already there.

A sandbox is deliberately small: 500 MB of storage, 500 MB of egress, no share links, and it is deleted after three days if nobody claims it. Creation is limited to ten per hour per IP address, and five unclaimed sandboxes per IP at a time. Claiming it moves it onto the free plan — 1 GB, 10,000 files, one agent, two keys — which is enough to run all three automations for real.

Export it, and the snippets below work as written:

```bash
export AGENTDISK_KEY=ask_live_…
curl {{API_BASE}}/v1/whoami -H "Authorization: Bearer $AGENTDISK_KEY"
```

## Automation 1: memory that survives the session

**The problem.** Your agent works out how your deployment pipeline is wired, which tests are flaky and what you asked it not to touch. Tomorrow it knows none of it.

**The fix.** A folder the agent reads at the start of a run and writes at the end. Connect the MCP server and the agent can do this with its own tools, no code from you.

In Claude Code, one command registers it. Name the transport — a bare `url` entry in `.mcp.json` is read as a stdio server and fails to start:

```bash
claude mcp add --transport http agentdisk {{MCP_ENDPOINT}} \
  --header "Authorization: Bearer $AGENTDISK_KEY"
```

Cursor, Cline, Zed and the other clients take the same three things in their own config shape: the URL, an `Authorization` header, and HTTP as the transport. The [docs](/docs/quickstart) carry a worked config per client, and [MCP file storage in five minutes](/blog/mcp-file-storage-quickstart) walks the first write end to end.

The agent now has eleven tools. Four of them are this automation:

| Tool | Its job here |
|---|---|
| `list_files` | See what memory already exists under `/memory/` |
| `read_file` | Load it at the start of a run, inline up to 1 MB |
| `create_file` | Write the run's notes at the end |
| `search_files` | Find an older note by caption or tag, not just by name |

Then give it a standing instruction — in `CLAUDE.md`, a Cursor rule, or whatever your client reads at startup:

```text
At the start of a session, list /memory/ on agentdisk and read
/memory/project.md and /memory/tasks.md if they exist.

Before you finish, write what you learned back:
  /memory/project.md   how this codebase is wired, what not to touch
  /memory/tasks.md     what is in flight, what is blocked, what is next
  /memory/decisions/   one file per decision, tagged, so it can be found later

Tag every file you write, and put the date in the caption. Bytes are
immutable — write a new file rather than trying to edit one in place.
```

That last line is the one people trip on. `update_file` changes a caption, tags or custom metadata; it does not rewrite content. Rewriting means a new file, which is the right default for a record you may want to look back through.

**Why the tags matter.** Six weeks in, `/memory/decisions/` has forty files and the agent cannot read all of them into context. `search_files` over captions and tags is how it pulls the three that are relevant. Plain object storage gives you prefix listing and nothing else; this is the difference between an archive and a memory.

**What it costs.** Notes are kilobytes. Forty decisions is well under a megabyte. This automation runs inside the free plan indefinitely.

## Automation 2: two agents, one disk, no orchestrator

**The problem.** A research agent should hand its findings to a writing agent. The usual answers are to run both in one process and pass strings, or to stand up a queue. The first does not survive a crash and gives you no record; the second is a lot of infrastructure for a handoff.

**The fix.** Agent A writes to `/inbox/`. A webhook fires. Agent B reads it and writes to `/done/`. Neither agent knows the other exists, and neither key can reach the other's folder.

Mint the two scoped keys. Each one names its agent identity, its operations, and the single prefix it may touch:

```bash
# Agent A: may write into /inbox, and may not read /done
curl -X POST {{API_BASE}}/v1/keys \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"agent-a","agentId":"agt_…","ops":["write","list"],
       "pathPrefix":"/inbox"}'

# Agent B: may read /inbox, and writes its output to /done
curl -X POST {{API_BASE}}/v1/keys \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"agent-b","agentId":"agt_…","ops":["read","list"],
       "pathPrefix":"/inbox"}'
```

Now point a webhook at the thing that wakes Agent B — a Worker, a Lambda, a function on your own server:

```bash
curl -X POST {{API_BASE}}/v1/webhooks \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/hooks/agentdisk","events":["file.created"]}'
# → 201 { "webhook": { "id": "whk_…", "status": "active", … },
#         "secret": "whsec_…", "secretShownOnce": true }
```

Store that `whsec_…` — it is shown once, and it is how you verify a delivery actually came from AgentDisk rather than from whoever guessed your URL. Your handler checks the signature, ignores anything whose path is not under `/inbox/`, and starts Agent B with Agent B's key.

**What you get that a queue does not give you.** The handoff is also the artifact. The file Agent B consumed is still there, so when the output is wrong you can read the exact input that produced it. The activity log says which agent identity wrote it and when — what is kept, and for how long, is set out on the [security page](/security). And the isolation is enforced by the API rather than by both agents behaving: if Agent A is prompt-injected into reading `/done/`, the call returns `403` and the attempt is logged. That last property is the one that is genuinely hard to assemble yourself — on a plain bucket it is an IAM policy per agent, a queue, and a function to join them.

**One caution.** `file.created` fires for every file, including the ones Agent B writes. Filter by path prefix in your handler, or Agent B will wake itself up in a loop. The hard caps mean a loop costs you a wall rather than a bill, but it is still a loop.

## Automation 3: a nightly run that files its own output

**The problem.** You want a report every morning — competitor prices, open bugs, yesterday's numbers. An agent can produce it. The awkward part is where it goes, and how you find the one from three weeks ago.

**The fix.** A scheduled job that runs the agent and files the output under a dated path, captioned and tagged.

In GitHub Actions, that is a cron and a key in secrets:

```yaml
name: nightly-report
on:
  schedule:
    - cron: '0 6 * * *'
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run the agent and file the result
        env:
          AGENTDISK_KEY: ${{ secrets.AGENTDISK_KEY }}
        run: ./scripts/nightly-report.sh
```

The script's last act is the upload. Inline is one call for anything up to 1 MB — the content is base64, and the path is the convention doing the work:

```bash
DAY=$(date -u +%F)
curl -X POST {{API_BASE}}/v1/files \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -H "X-AgentDisk-Session: nightly-report $DAY" \
  -d '{
    "path": "/reports/'"$DAY"'/summary.md",
    "mimeType": "text/markdown",
    "caption": "Nightly report '"$DAY"'",
    "tags": ["report","nightly"],
    "content": "'"$(base64 -w0 < summary.md)"'"
  }'
```

Two details are carrying their weight there. The `X-AgentDisk-Session` header labels the run in the audit log, so a month of nightly runs reads as a list of named runs rather than anonymous writes. And the caption and tags make the archive searchable — `search_files` with `nightly` finds every one, which an agent can then summarise into a trend.

Above 1 MB — a PDF, a CSV of any size — declare the size instead and you get a presigned `PUT` back. The bytes go straight to storage without passing through the API, and a final `complete` call re-reads the real size from storage rather than trusting what you declared:

```bash
curl -X POST {{API_BASE}}/v1/files \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path":"/reports/'"$DAY"'/data.csv","mimeType":"text/csv","sizeBytes":8421376}'
# → { "file": { "id": "fil_…", "status": "pending" },
#     "upload": { "method": "PUT", "url": "https://…", "expiresAt": "…" } }

curl -X PUT "$UPLOAD_URL" -H "Content-Type: text/csv" --data-binary @data.csv

curl -X POST {{API_BASE}}/v1/files/$FILE_ID/complete \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" -d '{}'
```

**Where the free plan stops.** Reading the report yourself needs nothing extra — it is in the dashboard, and `GET /v1/files?path=/reports` lists it. Sending it to somebody without an account needs a share link, and share links are zero on the free plan. If the report is for a client rather than for you, that is the line where a paid plan starts — see [pricing](/pricing); everything else in this automation runs free.

## What to build first

Start with memory. It takes one config line and one standing instruction, you will feel the difference in the next session, and it is the automation whose value does not depend on anything else you build.

The handoff is the one to reach for the first time you catch yourself passing a large blob of text between two agents through a prompt. The scheduled run is the one to reach for when you want the output to be an archive rather than a notification.

All three run on the same workspace. You can have the first one working in about five minutes, and you already have the key.

## Frequently asked questions

### Do I need an account to try this?

No. `POST /v1/workspaces` with no credential returns a working API key and a claim link. The sandbox holds 500 MB and is deleted after three days if you do not claim it; claiming it keeps everything already written and moves it to the free plan.

### Can one agent read another agent's files?

Only if its key's path prefix allows it. Scopes combine operations — `read`, `write`, `delete`, `list` — with a prefix the key cannot leave, and the prefix is matched a whole segment at a time, so a key scoped to `/agents/bot` is refused at `/agents/bot-evil/`. Refusals are logged.

### What happens if an agent loops and writes forever?

It hits the plan's cap and starts receiving errors. Every plan is hard-capped rather than usage-billed, so a runaway agent costs you a `403` and a line in the audit log instead of a surprise bill. You also get a warning on write responses as you approach the limit.

### Can I edit a file in place?

No. Bytes are immutable; `PATCH /v1/files/:id` changes the caption, tags and custom metadata only. Write a new file to record a change. Deletion is permanent and immediate — there is no restore — so an automation that deletes should be sure.

### Does this work with my agent framework?

If it speaks MCP, connect it to `{{MCP_ENDPOINT}}` with a Bearer key and it gets eleven file tools with no code. If it does not, the REST API is one header on an ordinary HTTPS call, which is every example in automations 2 and 3 above.
