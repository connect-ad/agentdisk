---
title: "Hard-Capped Pricing: No Surprise Bills, Ever"
slug: hard-capped-pricing-ai-storage
description: "Metered storage pricing and autonomous agents are a risky mix. How AgentDisk hard caps work, what they cost, and the trade-off you plan for."
date: 2026-10-02
author: "AgentDisk team"
tags: [pricing, agents]
keywords: [AI storage pricing, hard-capped pricing, predictable AI costs]
---

Most cloud storage is billed on usage: so much per gigabyte stored, so much per gigabyte downloaded, sometimes so much per thousand requests. For a web application with a predictable traffic curve that is fair and efficient. For an autonomous agent running unattended, it means the size of your bill is decided by whatever your agent did while you were asleep.

AgentDisk takes the other approach. Every plan has hard caps, and there are no overage charges at all. This post explains why we chose that, exactly how the caps behave, and the trade-off it creates, because there is one and you should plan for it.

## The problem with metered pricing for agents

Metered pricing assumes that usage tracks value. A website that serves more downloads is serving more customers. An agent that writes more files is not necessarily doing more useful work; it may be stuck.

A few ways that goes wrong:

- A retry loop writes the same 20 MB file under a new name every few seconds for eight hours.
- A research agent decides it needs "all the data" and downloads every file in the workspace on every step.
- A scheduled job that was meant to run once a day runs once a minute after a configuration change.
- A leaked key is used by someone else to store or pull large files.

None of these are exotic. Agents act on their own judgement, retry on errors and run without supervision, which is the point of them. Under metered pricing, each of these turns into a line item you discover at the end of the month. Budget alerts help, but an alert is a notification, not a limit: the meter keeps running after the email arrives.

What you want from storage for agents is a ceiling the bill cannot pass. If the agent misbehaves, the worst outcome should be that it stops, not that it spends.

## How the hard caps work

AgentDisk has four plans. Each is a fixed monthly price with fixed limits:

| Plan | Price | Storage | Files | Egress per month | Max file size |
|---|---|---|---|---|---|
| Free | $0 | 1 GB | 10,000 | 10 GB | 100 MB |
| Basic | $9 | 5 GB | 100,000 | 50 GB | 500 MB |
| Pro | $20 | 50 GB | 1,000,000 | 500 GB | 1 GB |
| Team | $80 | 500 GB | 10,000,000 | 5,000 GB | 4.9 GB |

Paying yearly takes 15% off the monthly price, rounded down. Free needs no card. The full comparison, including share links, agents, keys, members and workspaces, is on the [pricing page](/pricing).

### What is enforced

The API enforces total storage, file count, monthly egress, the per-file size cap and the number of share links. When a write would take you past one of them, the API refuses it and names the dimension that was exceeded: HTTP 429 for storage, files and egress, and 413 for a file over the per-file cap, so your code knows exactly what it hit. The plan's counts of workspaces, agents, API keys and members are enforced the same way: creating one more than the plan allows is refused with 403 and the limit named.

Before that point you get warned. When usage reaches 80% and again at 95% of a limit, writes still succeed but carry a warning. An agent, or the code around it, can pick that up and slow down, clean up or tell a person before anything is refused.

The size counted against your quota comes from storage itself, never from what the client says it uploaded. A client cannot under-report a file's size to fit under a limit.

### How the limits are counted

Storage and file count are pooled across your account: all of your workspaces draw from the same allowance. Egress is counted per workspace, per month, so each workspace gets the plan's monthly egress allowance. That means a download-heavy workspace cannot use up the egress of a quiet one. Egress is included in the plan price; there is no separate per-gigabyte download charge to watch.

Reading a file's metadata does not count as egress. If your agent only needs to know a file's size, tags or caption, `GET /v1/files/:id` answers that without touching the egress allowance.

### Requests are unlimited

There is no request quota on any plan and no per-request charge. An agent that lists a folder a thousand times costs the same as one that lists it once. We chose this because request counts are the hardest thing for an agent builder to predict, and because the dimensions that cost real money (bytes stored and bytes sent) are already capped.

### If a payment fails

When a payment fails, writes are blocked and reads keep working, so your agents can still get at what they stored. We announce a seven-day grace period by email before any data is scheduled for removal. There is no scenario where a failed card produces a larger charge.

## Why this matters for agent builders

The practical effect of hard caps is that your maximum monthly cost is the price of your plan. You can give an agent a key, leave it running over a weekend, and know the bill on Monday. You can let a prototype run on the Free plan with no card attached and know it costs nothing, whatever it does.

It also changes how you reason about failures. Under metered pricing, a runaway agent is a financial incident. Under hard caps, it is an operational one: something stops working, you get a clear error naming the limit, and you fix the agent. We think that is the right kind of failure for software that acts on its own.

Caps pair naturally with scoped keys. A cap bounds how much an agent can consume; a scoped key bounds what it can touch. We wrote about the second half in [scoped credentials for AI agents](/blog/scoped-credentials-ai-agents).

## The trade-off: a capped agent stops writing

Hard caps are not free of cost. When you hit one, writes fail. If your agent is in the middle of a task and the account runs out of storage, the next save is refused. Nothing is charged, and nothing already stored is touched, but the work in progress does not get written.

That is the deliberate choice: we would rather your agent stop than your bill grow. It does mean you should design for it.

### Handle 429 explicitly

Treat a 429 from AgentDisk as a capacity signal, not a transient error. Do not retry it in a tight loop; the limit will not have moved. Log the response, which names the dimension, stop writing, and surface it to a person or a fallback path.

```python
import os
import requests

API = "{{API_BASE}}"
HEADERS = {"Authorization": f"Bearer {os.environ['AGENTDISK_KEY']}"}

def save(payload):
    r = requests.post(f"{API}/v1/files", json=payload, headers=HEADERS)
    if r.status_code == 429:
        # A plan limit was reached. The body names the dimension.
        # Retrying will not help; stop and tell someone.
        raise RuntimeError(f"AgentDisk limit reached: {r.text}")
    r.raise_for_status()
    return r.json()["file"]
```

If the agent talks to AgentDisk over MCP, the same refusal comes back through the tool result, because MCP tools call the same REST handlers. Put a line in the agent's instructions telling it that a storage limit error means stop and report, not retry.

### Watch the warnings

The 80% and 95% warnings exist so that a limit is never a surprise. Wire them into whatever your agent already uses to report status. A warning at 80% gives you time to delete stale files, move to a larger plan or split work across workspaces.

### Size the plan to the job

Check what your agents actually produce. If a nightly job writes a few hundred megabytes of reports, Free or Basic is plenty. If agents handle media or large datasets, the per-file cap matters as much as total storage: 100 MB on Free, 500 MB on Basic, 1 GB on Pro and 4.9 GB on Team.

### Use GET /v1/whoami

`GET /v1/whoami` tells a key which workspace it belongs to, what scopes it holds and how much room is left. An agent can call it at the start of a run to decide whether a large job will fit before it begins.

To see the caps in practice without signing up, the [sandbox](/sandbox) creates a workspace with 500 MB and 500 files for three days. Payment runs through Stripe Checkout, so card numbers never reach AgentDisk; the [trust page](/trust) covers the providers involved.

## Frequently asked questions

### Can AgentDisk ever charge more than my plan price?

No. There are no overage charges on any plan. When usage reaches a limit, the API refuses the write with a 429 instead of billing for the excess, so your monthly cost is the price of the plan you chose.

### What happens to my files when I hit a limit?

Nothing happens to files you already stored. Reads keep working within the egress allowance, and the write that would have crossed the limit is refused with a 429 naming the dimension. Delete files you no longer need or move to a larger plan to resume writing.

### Is egress shared across all my workspaces?

No. Egress is counted per workspace per month, so each workspace gets the plan's monthly egress allowance. Storage and file count, by contrast, are pooled across the whole account.

### Are API requests metered or rate limited?

Requests are unlimited on every plan and there is no per-request charge. What is capped is what costs money: storage, files, egress, file size and share links. Traffic that is abusive or degrades the service for others can still be throttled under the [Terms](/terms).

### Can I check how much room is left before a big job?

Yes. GET /v1/whoami returns the workspace a key belongs to, the scopes it holds, and how much storage, file count, egress and share-link allowance is used and left, so an agent can decide whether a large job will fit before it starts.
