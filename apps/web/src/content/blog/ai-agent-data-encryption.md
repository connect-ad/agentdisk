---
title: "How AgentDisk Encrypts Your AI Agent's Data"
slug: ai-agent-data-encryption
description: "TLS in transit, provider-managed encryption at rest, AES-256-GCM sealed keys and scoped presigned URLs: what AgentDisk encrypts, and what it does not."
date: 2026-10-03
author: "AgentDisk team"
tags: [security, encryption]
keywords: [AI agent data encryption, AES-256 file storage, secure agent storage, encryption at rest]
---

"Is it encrypted?" is usually the first security question about storage, and it is too short to answer honestly with one word. Data is encrypted against particular threats at particular points, and the useful answer says which. This post walks through how AgentDisk handles your agent's data in transit, at rest, and in the secrets that guard it, and it is explicit about where encryption stops.

## In transit: TLS everywhere

Every AgentDisk hostname serves HTTPS only. The minimum protocol version is TLS 1.2, and TLS 1.3 is enabled, so modern clients negotiate 1.3. HTTP Strict Transport Security is set for one year and includes subdomains, which tells browsers never to try a plain HTTP connection to any of our hostnames during that period.

That covers the REST API at {{API_BASE}}, the MCP server at {{MCP_ENDPOINT}}, the dashboard and the marketing site. Every deploy runs a smoke test that fails if a security header goes missing, so a configuration change cannot quietly drop HSTS.

Two related rules keep credentials out of places TLS cannot protect:

- An API key is only accepted in the `Authorization: Bearer` header. A key in a query string is rejected outright. URLs end up in proxy logs, browser history and referrer headers; headers mostly do not.
- Request logs are kept for about 90 days and never contain request bodies with file content or secrets.

## At rest: provider-managed encryption

File bytes live in Cloudflare R2 object storage. File metadata lives in an edge database on Cloudflare. Both are encrypted at rest by Cloudflare, with keys Cloudflare manages.

### What provider-managed encryption protects against

Encryption at rest protects data on the storage layer itself: the disks and the physical infrastructure underneath the service. Someone who obtained raw storage media would not be able to read your files from it.

### What it does not protect against

We want to be direct about this, because "encrypted at rest" is often read as more than it is. **AgentDisk is not end-to-end encrypted.** The service can read a file when a request authorizes it.

That is a consequence of what the service does, not an oversight:

- `read_file` and the REST content endpoint return file contents inline to an authorized agent, up to 1 MB, as text or base64.
- When a client declares a SHA-256 hash on an inline upload, the service verifies it against the bytes it received.
- Share links let a person download a file without holding an API key.

All three require the service to handle plaintext on the request path. A true end-to-end design, where only the client holds keys, would rule them out.

What we can say is what *does* touch your files. No AI processor touches stored files, and they are not used to train anything. Search runs only over names, paths, captions and tags, never file contents.

### If you need the service not to see contents

You can encrypt on the client before upload. AgentDisk stores whatever bytes you send, so a file encrypted with a key held only by your agent stays opaque to us. The trade-offs are the usual ones: you manage the keys, inline reads return ciphertext, and paths, captions, tags and custom metadata are still stored as you send them, so keep sensitive details out of those fields.

## Secrets: how API keys are stored

An API key is the whole credential for an agent, so how we store it matters more than most data in the system.

Keys look like `ask_live_` followed by 32 base62 characters, roughly 190 bits of randomness. Test keys start with `ask_test_`. Each key is stored two ways:

| Stored form | Purpose |
|---|---|
| SHA-256 hash | Fast lookup when a request arrives; the hash alone cannot be turned back into the key |
| AES-256-GCM ciphertext, bound to its row | Lets the signed-in owner reveal the key again |

AES-256-GCM is authenticated encryption: tampering with the ciphertext makes decryption fail rather than produce a wrong value. The ciphertext is bound to the database row it belongs to, so it cannot be copied onto another key's record and decrypted there.

Revealing a key is a deliberate, narrow operation. Only a signed-in owner can do it; an API key can never reveal another key. Every reveal is written to the workspace's Activity log.

When a key is disabled, it stops working on the next request. Re-enabling it issues a new secret, so a key that leaked and was disabled does not come back to life. Disabling an agent stops every key that agent holds, also on the next request.

### Share link passwords

A share link can carry an optional password. We store a PBKDF2 hash of it, never the password itself, and we allow 10 wrong guesses per 15 minutes before refusing further attempts. Share links last at most seven days.

### Webhook signatures

Webhook payloads are signed with HMAC-SHA256 in an `agentdisk-signature` header of the form `t=<unix>,v1=<hex>`, with a 300-second replay window. That is integrity rather than confidentiality: it lets your endpoint prove a delivery came from AgentDisk and was not replayed.

### Secrets that never reach us

Some secrets are safest when we never hold them. Account passwords are handled by Firebase Authentication, which hashes them with scrypt; they never reach AgentDisk. Card numbers go to Stripe Checkout and never reach AgentDisk either.

## Presigned URLs: narrow and short-lived

Files larger than 1 MB move through presigned URLs rather than through the API body. A presigned URL is a credential in its own right, so we keep each one as small as possible.

- **Upload URLs** are valid for 15 minutes and cover exactly one object. The client sends the bytes with a `PUT` and no `Authorization` header, then confirms with `POST /v1/files/:id/complete`.
- **Download URLs** are valid for one hour and cover exactly one object.
- Presigned URLs are never logged in full.

Here is the upload flow for a large file:

```bash
curl -s -X POST {{API_BASE}}/v1/files \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path":"/datasets/survey.parquet","mimeType":"application/octet-stream","sizeBytes":52428800}'
```

The response includes an `upload` object with the method, URL, headers and an `expiresAt` time. After the `PUT`, finish with:

```bash
curl -s -X POST {{API_BASE}}/v1/files/fil_XXXXXXXX/complete \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sizeBytes":52428800}'
```

One honest note on integrity: a SHA-256 declared on an inline upload is verified, but on the presigned path it is recorded, not verified. Separately, the size booked against your quota always comes from storage, never from what the client claims.

## Isolation is the other half

Encryption keeps data unreadable to people outside the system. Isolation keeps one tenant's data unreachable by another tenant's credentials, and in a multi-tenant service that matters at least as much.

The authorization chain binds the workspace from the credential, never from client input. Handlers never receive a raw database or bucket binding; storage methods take a file ID and derive the object key. Isolation tests seed two workspaces and prove every route answers the other tenant's IDs with 404. The API has 1,014 automated tests, and 22 deliberate mutations of security-critical storage code each turned the suite red. Scoped keys narrow access further; see [scoped credentials for AI agents](/blog/scoped-credentials-ai-agents).

## What the provider certifications cover

AgentDisk does not hold its own compliance certification. It runs on infrastructure from providers that hold SOC 2 and ISO 27001, among others:

| Provider | Role | Certifications |
|---|---|---|
| Cloudflare | Compute, storage, database, cache, queues | SOC 2 Type II, ISO 27001, ISO 27701, PCI DSS Level 1 |
| Google (Firebase) | Authentication | SOC 1, SOC 2, SOC 3, ISO 27001, ISO 27017, ISO 27018 |
| Stripe | Payments | PCI DSS Level 1, SOC 2 Type II, ISO 27001 |

Those certifications cover the providers' own controls, including how Cloudflare encrypts storage at rest. They do not certify AgentDisk's application code, and we do not claim they do. The full list of processors is on the [sub-processors page](/sub-processors), and the [security page](/security) and [trust page](/trust) cover the rest of our posture.

## Summary

| Layer | What protects it |
|---|---|
| Network | TLS 1.2 minimum, TLS 1.3 enabled, HSTS one year incl. subdomains |
| Files and metadata at rest | Provider-managed encryption by Cloudflare; not end-to-end |
| API keys | SHA-256 lookup hash plus AES-256-GCM ciphertext bound to its row |
| Share link passwords | PBKDF2 hash, 10 guesses per 15 minutes |
| Large transfers | Presigned URLs, one object, 15 minutes up, 1 hour down |
| Account passwords and cards | Never reach AgentDisk |

To try it, follow the [quickstart](/docs/quickstart), or read [why we built AgentDisk](/blog/why-we-built-agentdisk) for the broader design.

## Frequently asked questions

### Is AgentDisk end-to-end encrypted?

No. Files are encrypted at rest by Cloudflare with provider-managed keys, and the service can read a file when a request authorizes it. If you need the service never to see contents, encrypt files on the client before upload.

### What encryption algorithm protects my API keys?

Each key is stored as a SHA-256 hash for lookup and as AES-256-GCM ciphertext bound to its database row, so the signed-in owner can reveal it. Every reveal is recorded in the Activity log.

### How long do presigned URLs stay valid?

Upload URLs are valid for 15 minutes and download URLs for one hour. Each one covers exactly one object, and presigned URLs are never logged in full.

### Is AgentDisk SOC 2 certified?

AgentDisk does not hold a compliance certification of its own. It runs on infrastructure from providers that hold their own, including SOC 2 and ISO 27001 for Cloudflare, Google and Stripe.

### Are my files used to train AI models?

No. No AI processor touches stored files, and customer files are not used to train anything. Search only looks at names, paths, captions and tags, never file contents.
