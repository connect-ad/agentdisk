---
title: "GDPR Compliance for AI Agent Storage: A Practical Guide"
slug: gdpr-ai-agent-storage
description: "When AI agents store files that contain personal data, GDPR applies. Controller and processor roles, sub-processors, DPAs and what AgentDisk offers today."
date: 2026-10-03
author: "AgentDisk team"
tags: [privacy, gdpr, compliance]
keywords: [GDPR AI agent storage, GDPR compliant file storage]
---

If your AI agents store files, sooner or later some of those files will contain personal data: a customer email pasted into a summary, a CV a recruiting agent was asked to screen, a transcript with names in it, a spreadsheet of leads. At that point the GDPR is part of your storage decision, whether or not you planned for it.

This guide covers how the GDPR applies to agent file storage, how responsibilities split between you and your storage provider, what to look for in sub-processor lists and data processing agreements, and, specifically, what AgentDisk offers today and what it does not yet offer. We are an engineering team, not lawyers.

> This is not legal advice. For decisions about your own obligations, talk to a qualified privacy professional.

## Does GDPR apply when agents store files?

The GDPR applies to the processing of personal data, which Article 4 defines broadly as any information relating to an identified or identifiable natural person. Names, email addresses, identification numbers, location data and online identifiers all count, and so does anything that can be linked back to a person in combination with other data. Processing is defined just as broadly: storing, organising, retrieving, sending and erasing are all processing.

So the question is not whether an agent is involved but what is in the files. If an agent writes a meeting summary that names attendees, stores a support ticket with a customer's email, or saves research notes about a specific person, that file contains personal data, and storing it is processing. The fact that software rather than a person decided to save it does not change anything.

The territorial scope matters too. Broadly, the GDPR applies if you are established in the EU, or if you offer goods or services to people in the EU or monitor their behaviour there. Plenty of teams outside Europe fall within it because their users or their users' customers are in Europe.

Agents add a practical twist: they are good at producing files nobody planned for. A human rarely saves a copy of an inbox to a shared folder by accident; an agent following instructions might. That makes it more important to know where agent output lands and who can reach it.

## Controller versus processor

The GDPR assigns obligations by role.

The **controller** decides why and how personal data is processed. If you build a product that uses agents to process your customers' documents, you are almost certainly the controller for that data. You decide what gets stored, for what purpose and for how long, and you answer to the people the data is about.

The **processor** processes personal data on the controller's behalf and on their instructions. A storage service holding your files is the typical example.

For the files you store in AgentDisk, AgentDisk acts as a processor and you are the controller. That split has practical consequences:

- You choose the lawful basis for processing, and you are responsible for transparency towards the people whose data it is.
- You decide retention: how long agent output is kept, and when it is deleted.
- You handle data subject requests, such as access and erasure, using the tools your processor gives you.
- Your processor stores and serves the data as you direct, protects it, and should not use it for its own purposes.

Article 17, the right to erasure, is where storage design matters most. If someone asks you to delete their data, you need to find every file that contains it and delete it in a way that actually removes it. That is much easier if you decided in advance where personal data is allowed to live, which we come back to below.

## Sub-processors

A processor rarely runs everything itself. It uses other companies for hosting, authentication, payments and email, and those companies are sub-processors. Under Article 28, a processor may only engage sub-processors with the controller's authorisation, and should tell controllers about changes.

When you evaluate any storage provider, read its sub-processor list and check three things: who touches your stored files, who touches account and billing data, and whether anything optional (such as analytics) depends on consent.

AgentDisk's processors are:

| Provider | Used for |
|---|---|
| Cloudflare | Compute, file storage, database, cache, queues, bot verification, outbound email |
| Google LLC | Firebase Authentication, for sign-in |
| Google LLC | Google Analytics, only with consent |
| Stripe | Payments |

Your stored files live with Cloudflare: bytes in Cloudflare R2 object storage, metadata in an edge database. Google handles sign-in, and Stripe handles payment. The current list is on the [sub-processors page](/sub-processors).

## Data processing agreements

Article 28 requires that processing by a processor is governed by a contract that sets out, among other things, the subject matter and duration of processing, the type of data, the processor's obligation to act only on documented instructions, confidentiality, security measures, the rules for engaging sub-processors, assistance with data subject requests, and deletion or return of data at the end of the service. That contract is usually called a data processing agreement, or DPA.

If you transfer personal data outside the EU, there is a further question of which transfer mechanism applies.

AgentDisk's [Data Processing Agreement](/dpa) is published and forms part of the [Terms](/terms), so it applies automatically with nothing to sign. It covers the Article 28 points above, and for transfers out of the EU it incorporates the Standard Contractual Clauses (Module Two, or Module Three where you are yourself a processor), with the UK Addendum and the Swiss adjustments. Kernelv5 Inc., which provides AgentDisk, is a Delaware corporation. If your organisation needs a countersigned copy, write to connect@agentdisk.io.

Two things worth knowing for your own assessment. AgentDisk holds no compliance certification of its own; it runs on infrastructure from providers that hold SOC 2 and ISO 27001 among others. And AgentDisk has no regions, so you cannot choose where data is stored.

## What AgentDisk gives you today

Paperwork is one half of the picture. The other half is whether the service lets you meet your obligations in practice. These are the controls available now.

### Self-service deletion with stated timings

Deletion and download are self-service. You do not need to open a ticket to remove data:

- Deleting a file removes its bytes and its record in the same request. The API response says `"permanent": true`, and there is no restore.
- Deleting a workspace or an account removes the records in the request, and the hourly sweep removes the bytes within seven days. Nothing is recoverable in between.
- Invoices are kept for seven years at Stripe.

Because there is no versioning and no recycle bin, a deleted file does not linger in an older version or a trash folder. For erasure requests that is what you want. The details are in the docs on [deleting data](/docs/deleting-data) and [deleting an account](/docs/deleting-account).

### A known retention list

You should be able to say what a provider keeps and for how long. For AgentDisk:

- Files: until you delete them.
- Activity log: for the life of the workspace. It records actors and source IP addresses, which are themselves personal data, so it goes when the workspace goes.
- Request logs: around 90 days, and never with file content or secrets in them.
- Invoices: seven years, at Stripe.

### Consent-only analytics

Google Analytics runs only if you consent to it, and workspace names, paths and tokens are stripped from URLs before anything is sent. The dashboard does not leak your folder structure into an analytics product.

### No AI processing of your files

No AI processor touches the files you store, and your files are not used to train anything. Search matches file names, paths, captions and tags, never file contents. This keeps the processing narrow: AgentDisk stores and serves bytes, and that is all.

### Encryption and transport

Traffic uses TLS everywhere, with a minimum of TLS 1.2 and HSTS. At rest, data is encrypted by Cloudflare with provider-managed keys. It is not end-to-end encrypted: the service can read a file when an authorized request asks for it. If your threat model needs client-side encryption, encrypt before uploading. The [security page](/security) has the full list.

### Path-scoped keys to keep personal data in known places

This is the control we would point to first. An AgentDisk API key can be limited to a path prefix and to specific operations. Use that to decide where personal data is allowed to live:

1. Pick a prefix for personal data, for example `/pii/`, and keep everything else elsewhere.
2. Give only the agents that need personal data a key bound to that prefix.
3. Give every other agent a key bound to a different prefix, so it cannot read or write under `/pii/` at all.
4. Leave `delete` off agent keys, and keep erasure in code or with a person.

```bash
curl -s -X POST {{API_BASE}}/v1/keys \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"intake-bot","ops":["read","write","list"],"pathPrefix":"/pii/intake"}'
```

When an erasure request comes in, you know which prefixes to search instead of every file in every workspace. `GET /v1/search?q=` matches names, paths, captions and tags, so a consistent naming or tagging convention for records about a person makes them findable. Prefix matching is on whole segments, so `/pii/intake` does not reach `/pii/intake-archive/`. We cover key scoping in more depth in [scoped credentials for AI agents](/blog/scoped-credentials-ai-agents), and per-client separation in [workspace isolation for multi-agent systems](/blog/workspace-isolation-multi-agent).

Separate workspaces give an even harder boundary. If you process data for several of your own customers, a workspace per customer means deleting that customer's data is one workspace deletion.

## Frequently asked questions

### Is AgentDisk GDPR compliant?

We do not describe AgentDisk that way, because compliance depends on how you use a service as well as on the service itself. What AgentDisk provides is a published Data Processing Agreement with the Standard Contractual Clauses, self-service deletion, a stated retention list, consent-only analytics and no AI processing of your files.

### Who is the controller and who is the processor?

For the files you store, you are the controller and AgentDisk acts as a processor. You decide what is stored, why and for how long; AgentDisk stores and serves it as your requests direct.

### Does AgentDisk have a DPA?

Yes. The Data Processing Agreement at /dpa is part of the Terms and applies automatically, with the Standard Contractual Clauses for international transfers. If you need a countersigned copy, email connect@agentdisk.io.

### How fast is data deleted?

A deleted file's bytes and record go in the same request, with no restore. When you delete a workspace or an account, the records go immediately and the bytes are removed within seven days by the hourly sweep, with nothing recoverable in between.

### Does AgentDisk use my files to train AI models?

No. No AI processor touches the files you store, and customer files are not used to train anything. Search runs over names, paths, captions and tags only, never over file contents.
