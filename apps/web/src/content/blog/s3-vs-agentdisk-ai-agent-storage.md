---
title: "S3 vs AgentDisk for AI Agents: When to Use Which"
slug: s3-vs-agentdisk-ai-agent-storage
description: "An honest comparison of Amazon S3 and AgentDisk for AI agent storage: where each one wins, a side-by-side table, and a pattern for using both."
date: 2026-10-04
author: "AgentDisk team"
tags: [comparison, s3]
keywords: [S3 vs AgentDisk, S3 alternative AI agents, AI agent storage, MCP file storage]
---

Amazon S3 is the default answer to "where do I put files" for a large part of the industry, and for good reason. So when we tell people AgentDisk is file storage for AI agents, the fair follow-up is: why not just use S3? This post answers that honestly, including the cases where S3 is the better choice and the case where you should use both.

## The short answer

Use S3 when you need scale, the AWS ecosystem, or very large files. Use AgentDisk when the client is an AI agent and you want per-agent scope, an MCP server, an audit trail of what the agent tried, and a bill that cannot grow past the plan, without building any of that yourself. Many teams will end up with both, each doing the job it is suited to.

## Where S3 is the better choice

### Scale

S3 is built for effectively unlimited storage. AgentDisk plans top out at 500 GB of storage and 10,000,000 files on the Team plan. If you are measuring your data in terabytes today, or expect to soon, S3 is the right home for it.

### File size

The largest file AgentDisk accepts is 4.9 GB, on the Team plan. Free allows 100 MB, Basic 500 MB and Pro 1 GB. Model checkpoints, raw video, large database dumps and similar artifacts belong in a store designed for them.

### Ecosystem

S3 has a mature ecosystem: SDKs in every language, command-line tools, backup products, analytics engines that query it directly, and countless services that read from and write to it. AgentDisk has its own REST API and an MCP server. It does not implement the S3 API, so tools that expect S3 will not talk to it.

### Existing AWS integration

If your systems already run on AWS, S3 slots into your existing identity, networking, monitoring and billing. Adding a second storage provider has a real cost in accounts, credentials and review, and that cost is not worth paying for workloads S3 already handles well.

### Data lakes and analytics

If the files are inputs to an analytics pipeline, a warehouse, or a training job that reads them in bulk, S3 is the natural fit. AgentDisk search matches names, paths, captions and tags only. It does not search contents, and it is not a query engine.

### Region choice

AgentDisk runs on Cloudflare's edge and does not let you choose a region. If you have a requirement to pin data to a specific region, AgentDisk does not offer that control.

## Where AgentDisk is the better choice

### Native MCP

AgentDisk ships an MCP server at {{MCP_ENDPOINT}} with eleven file tools: list, search, read, get, get metadata, create, update, delete, create folder, move and copy. Claude Code, Cursor, VS Code with Copilot, Windsurf, Zed and other clients connect with a URL and a Bearer header. With S3 you would write and host an MCP wrapper yourself, decide which operations it exposes, and keep it in step with your own access rules. The [MCP quickstart](/blog/mcp-file-storage-quickstart) shows the AgentDisk setup end to end.

### Per-agent scoped keys without policy authoring

In AWS, giving an agent access to one folder of one bucket means an IAM policy. IAM is expressive and powerful, and this is what a minimal prefix-scoped policy looks like:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::my-bucket/agents/research-bot/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-bucket",
      "Condition": { "StringLike": { "s3:prefix": "agents/research-bot/*" } }
    }
  ]
}
```

Then you attach it to a user or role and manage the credentials. That is fine for one agent. It becomes a chore at ten, and in practice many agents end up with a broader credential than they need.

In AgentDisk, the equivalent is one request:

```bash
curl -s -X POST {{API_BASE}}/v1/keys \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"research-bot","ops":["read","write","list"],"pathPrefix":"/agents/research-bot"}'
```

The prefix is matched on whole segments, so `/agents/research-bot` does not reach `/agents/research-bot-old/`. Listings and searches are clipped to the prefix, and files outside it answer 404. A key can mint a narrower key for a sub-agent only if it holds `keys:create`, and never one wider than itself. IAM can express far more than this; AgentDisk covers the specific shape agents need with much less to get wrong.

### An audit log that includes denied calls

AgentDisk's Activity log records every MCP tool call, including denied ones, with the actor, source IP, path and outcome. It also records file creates and deletes, changes to agents, keys, members, share links and webhooks, and every key reveal. It is on by default, read-only, and kept for the life of the workspace. An `X-AgentDisk-Session` header lets you label each agent run. One gap to know: metadata edits, moves and copies over REST are not yet audited.

### Predictable, hard-capped pricing

AgentDisk plans include storage, file count and monthly egress, with hard limits and no overage charges. A write that would exceed a limit is refused with a 429 that names the limit; at 80% and 95% writes carry a warning first. Requests are unlimited on every plan. For an agent in a loop, that turns a potential surprise bill into an error the agent can handle. Prices run from $0 to $80 a month; see [pricing](/pricing) and [hard-capped pricing for AI storage](/blog/hard-capped-pricing-ai-storage).

### Setup time

A single unauthenticated `POST` to `/v1/workspaces` creates a sandbox workspace with a key and a claim link. There is no account, bucket, policy or role to create first. You can be writing files from an MCP client in about five minutes, and claiming the sandbox later keeps the agent's key working.

## Side by side

| | Amazon S3 | AgentDisk |
|---|---|---|
| Scale | Effectively unlimited | Up to 500 GB and 10,000,000 files (Team) |
| Largest file | Very large objects | 4.9 GB (Team), 100 MB (Free) |
| Ecosystem | Mature, very broad | REST API and MCP server |
| S3 API | Yes | No |
| Region choice | Yes | No |
| MCP server | Build your own | Built in, eleven file tools |
| Per-agent scope | IAM policies | Keys with operations and a path prefix |
| Denied-call audit | Configure separately | Activity log, on by default |
| Pricing model | Usage-based | Flat monthly plans with hard caps; egress included |
| Content search | Not built in | Not offered; metadata search only |
| Servers to run | None | None |

For a more detailed page, see [AgentDisk vs S3](/compare/agentdisk-vs-s3). If what you really want is an S3-compatible API at lower raw cost, also read [AgentDisk vs Cloudflare R2](/compare/agentdisk-vs-cloudflare-r2); AgentDisk itself stores file bytes in R2 and adds the agent layer on top.

## The use-both pattern

For many teams the right answer is not either-or. A pattern that works well:

1. **AgentDisk is the agent's working area.** Each agent gets a key scoped to its own folder. It writes notes, checkpoints, drafts and results there over MCP or REST.
2. **S3 is the system of record.** Large datasets, archives and anything feeding analytics live in S3, under your existing AWS controls.
3. **A trusted job moves finished work across.** A small service of yours subscribes to AgentDisk webhooks (`file.created`, `file.updated`, `file.deleted`, `folder.created`, `folder.deleted`), verifies the HMAC-SHA256 signature, and copies finished results into S3.
4. **The agent never holds AWS credentials.** Its blast radius is its AgentDisk prefix, nothing more.

Step 4 is the point. The agent, whose actions are chosen by a model reading untrusted input, holds only a narrow AgentDisk key. The job with S3 write access is ordinary code you wrote and reviewed. If the agent is tricked into misbehaving, the Activity log shows what it tried, and your data lake is out of its reach.

Webhook deliveries carry an `agentdisk-signature` header of the form `t=<unix>,v1=<hex>`, with a 300-second replay window, so your job can reject forged or replayed events.

Going the other way works too. If an agent needs a reference document that lives in S3, a trusted job can copy that one file into the agent's AgentDisk folder rather than granting the agent read access to the bucket.

## How to decide

Ask three questions.

- **Is the client an agent?** If people and services are the only clients, S3 is likely all you need.
- **Will the data outgrow 500 GB, or include files over 4.9 GB?** If yes, that data belongs in S3.
- **Do you want per-agent scope, MCP and a record of refused calls without building them?** If yes, AgentDisk saves you that work.

Whatever you choose, read the [security page](/security) and [trust page](/trust) for exactly what AgentDisk does and does not provide, including that it holds no compliance certification of its own and runs on providers that do.

## Frequently asked questions

### Is AgentDisk an S3 alternative?

For agent working storage, yes. For general-purpose object storage at large scale, no. AgentDisk does not implement the S3 API and is sized for agent workspaces, up to 500 GB on the Team plan.

### Can I point my S3 SDK at AgentDisk?

No. AgentDisk has its own REST API and an MCP server, and does not speak the S3 protocol. Agents usually connect over MCP, and code uses the REST API directly.

### Does AgentDisk charge for egress?

Egress is included in each plan up to a monthly limit, from 10 GB on Free to 5,000 GB on Team, counted per workspace. There are no overage charges; a request beyond a limit is refused instead of billed.

### Where are AgentDisk files stored?

File bytes are stored in Cloudflare R2 object storage and metadata in an edge database, all run serverless on Cloudflare. You cannot choose a region.

### Can I use AgentDisk and S3 together?

Yes, and it is often the best setup. Let agents work in scoped AgentDisk folders, and have a trusted job of your own, triggered by AgentDisk webhooks, copy finished results into S3 so the agent never holds AWS credentials.
