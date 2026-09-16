# 022 · Finish webhooks

**Status:** Open — found by the 8 Sept 2026 audit ([summary.md](../summary.md) F-09, F-11b)

Delivery itself is built and correct — queued off the request path, HMAC-signed
over `timestamp.body` in Stripe's header shape so a captured delivery cannot be
replayed, each message acked or retried individually. Three gaps remain.

**1. Four of six subscribable events are never emitted.** `WEBHOOK_EVENTS`
(`routes/webhooks.ts:29`) offers `file.created`, `file.updated`, `file.deleted`,
`file.restored`, `folder.created`, `folder.deleted`. Only `file.created` and
`file.deleted` have an `auditAndNotify` call site. A customer subscribes to the
other four and waits forever. Fixing this overlaps
[021](021-audit-trail-gaps.md) — the same handlers are missing both the audit row
and the fan-out.

**2. Signing secrets are stored in plaintext.** `migrations/0002_core_schema.sql:156`
states "secret is stored encrypted at rest (06 PART 16.16a)".
`createWebhook` (`webhooks.ts:125`) sets the raw `whsec_…` value and
`WorkspaceScopedWebhooks.insert` binds it directly. There is no encryption
anywhere; `DATABASE_ENCRYPTION_KEY` is used only for staff TOTP secrets.

Impact is bounded — the secret authenticates *us to the customer*, so disclosure
forges deliveries to that customer's endpoint rather than granting anything here
— but it is a live credential at rest in plaintext, and **the schema comment
asserts otherwise**, so anyone auditing by reading the migration reaches the
wrong conclusion. Either encrypt it or correct the comment.

Handling elsewhere is right: never returned by any read, never logged, shown once.

**3. Delivery follows redirects.** `deliverOnce` (`jobs/webhook-delivery.ts:108`)
uses `fetch` with the default `redirect: "follow"`. HTTPS is correctly enforced at
registration (`webhooks.ts:42`), but a registered endpoint can 302 anywhere,
defeating that check at delivery time and carrying the signed payload and headers
with it. Blast radius in Workers is limited — there is no cloud metadata service
— but `redirect: "manual"` would close it.

Also stale: the file header of `routes/webhooks.ts` still says "Delivery itself is
not built … this is registration only", and `listWebhooks` already returns
`deliveryEnabled: true`.
