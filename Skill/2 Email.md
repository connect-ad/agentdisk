# 2 · Email

How this product sends mail, how to call it, how to test it, and what to check
when it stops. Everything here was observed on the tree and on dev after the
Mailjet → Cloudflare swap (`e516b93`, 24 Sept 2026), not copied from the
specification.

---

## Two senders, one provider

| Who sends | Through | Configured in | Mail |
|---|---|---|---|
| The API Worker | Cloudflare Email Service, `send_email` binding `EMAIL` | `apps/api/wrangler.toml`, per environment | Admin password reset, console test send, console compose, the renewal ladder, the dashboard's Support form (`POST /v1/support` → `SUPPORT_INBOX`, from `websupport@`, Reply-To the signed-in person) |
| Firebase Auth | Cloudflare Email Service over **SMTP** | Firebase console → Authentication → Templates → SMTP settings | Sign-up verification, self-service password reset, email-link sign-in |

Both use the same Cloudflare account, so they share **one quota**: 3,000 emails
a month included on Workers Paid, then $0.35 per 1,000, plus a conservative
daily cap on a new account that rises with reputation. A burst of sign-ups
spends the allowance the renewal reminders need.

There is no Mailjet anywhere any more: not in code, CI, GitHub secrets or the
Worker's secrets. Its Send API, key pair and "200 with a per-message error"
parsing are history, recoverable from `1e111ac` and earlier.

---

## The domain

`agentdisk.io` is onboarded to Email Sending on the account that owns the
zone. Cloudflare DNS is mandatory for it. Onboarding added MX, SPF and DKIM on
the `cf-bounce.` subdomain and a DMARC record at `_dmarc.agentdisk.io` — a
domain has exactly one DMARC record, so anything else that wants one has to
share it.

```bash
cd apps/api
npx wrangler email sending list        # agentdisk.io should say enabled: yes
```

**Any `from` on `@agentdisk.io` is deliverable; any other domain is refused**
with `E_SENDER_NOT_VERIFIED`. The binding carries no `allowed_sender_addresses`
on purpose — the console's compose screen lets an operator choose the local
part — so the domain check lives in code (`SENDING_DOMAIN` in `lib/email.ts`,
re-checked by the compose route).

---

## Calling it from the Worker

Everything goes through `apps/api/src/lib/email.ts`. Never call `env.EMAIL`
directly from a route.

```ts
import { readEmailConfig, sendEmail } from "../lib/email";

const config = readEmailConfig(env);       // { binding } or null
if (config === null) throw /* a refusal naming the feature */;

const { messageId } = await sendEmail(config, {
  to: "customer@example.com",               // or a list, max 50
  subject: "…",
  text: "…",                                // required — spam scoring, text-only clients
  html: "…",
  fromName: "AgentDisk Billing",            // optional
  fromAddress: "billing@agentdisk.io",      // optional; default connect@agentdisk.io
  replyTo: "support@agentdisk.io",          // optional
  attachments: [{ filename, type, content }], // optional; bytes, not base64
});
```

- **`null` config is a refusal, never a silent skip.** A deployment without the
  binding must say so at the point of use.
- **A resolved promise is the success.** On any failure the binding throws
  with a `code`; `sendEmail` rethrows as `ApiError("INTERNAL_ERROR")` with the
  code in `internalReason`. The client never sees the provider's words.
- **Nothing retries.** Callers that must deliver (the renewal ladder) retry by
  schedule and guard with the `notifications_sent` UNIQUE index — see
  `CLAUDE.md` on state passes versus notification passes.
- Templates live in the same file and always send from `SENDER_EMAIL`
  (`connect@agentdisk.io`). Only the compose route sets `fromAddress`.

### Error codes worth recognising

| Code | Means |
|---|---|
| `E_SENDER_NOT_VERIFIED` | `from` is off an onboarded domain |
| `E_RATE_LIMIT_EXCEEDED` | Daily or burst quota spent — reschedule, do not loop |
| `E_TOO_MANY_RECIPIENTS` | More than 50 across to/cc/bcc |
| `E_CONTENT_TOO_LARGE` | Over 5 MiB including attachments |
| `E_VALIDATION_ERROR` | Malformed message — a bug on our side |

---

## Limits

| | Limit |
|---|---|
| Recipients per message | 50, across to/cc/bcc |
| Message size | 5 MiB including attachments |
| Custom headers | 20, 16 KB total |
| Subject | 998 characters |

The compose route checks recipients, size and blocked extensions
(`.exe .bat .cmd .scr .vbs .js .com .msi .ps1`) itself, so a breach is a 400
naming the field rather than a 500 from the provider.

---

## The console

`securepanel-dev.agentdisk.io` → Email settings.

- **Status** — provider, template sender, whether `EMAIL` is bound.
- **Send a test message** — to the signed-in operator's own address only; no
  recipient field, by design.
- **Compose** — sender (defaults to `noreply@agentdisk.io`, editable within the
  domain), To (comma-separated), subject, plain-text message, attachments.
  `POST /v1/admin/settings/email/compose`. The HTML part is the text escaped,
  so nothing typed becomes markup. Every send, refused ones included, writes a
  `settings.email.composed` fleet row with sender, recipients, subject and
  attachment names — **never the body**.

The test send and compose are the way to prove delivery after any change here.
Acceptance by Cloudflare is not delivery; open the inbox and check the headers
for `dkim=pass` with `d=agentdisk.io`.

---

## Testing

The vitest pool runs the real Workers runtime, and Miniflare simulates the
`send_email` binding from `wrangler.toml` — nothing is sent, and no config
entry is needed in `vitest.config.ts`.

**Through a route (`SELF.fetch`)** — spy on the binding; the Worker sees the
same object:

```ts
import { env } from "cloudflare:test";

vi.spyOn(env.EMAIL!, "send").mockImplementation(async (message) => {
  sent.push(message);                       // { from: { email, name }, to, subject, text, html, attachments? }
  return { messageId: "msg-test" };
});
afterEach(() => vi.restoreAllMocks());
```

To test a rejection, throw `Object.assign(new Error("…"), { code: "E_SENDER_NOT_VERIFIED" })`.

**A job called directly** — pass a fake binding:

```ts
email: { binding: { send: async (m) => { … } } as unknown as SendEmail }
```

Never stub `fetch` for email; nothing calls it.

**Local `wrangler dev`** also simulates: the message is logged and written to a
temp file. `remote = true` on the binding sends real mail — use addresses you
own, because bounces cost sender reputation.

---

## Deploy

The binding needs no secret and nothing in CI pushes one; `wrangler deploy`
declares it from `wrangler.toml`, and the deploy log lists
`env.EMAIL … Send Email`. The CI deploy token needed no extra permission for
it. Prod carries the same block and has never been applied.

---

## When it breaks

| Symptom | Look at |
|---|---|
| Console says not configured | The deployed Worker lacks `EMAIL` — check the deploy log's binding table |
| Every send fails `E_SENDER_NOT_VERIFIED` | `wrangler email sending list`; DNS records on `cf-bounce.` still present |
| Sends succeed, nothing arrives | Recipient's spam folder, then the suppression list and bounce status in the Cloudflare dashboard |
| Firebase mail stopped, Worker mail fine | The SMTP token in the Firebase console — host `smtp.mx.cloudflare.net`, port 465, SSL, user `api_token`, password a token with Email Sending: Edit |
| Everything stopped mid-month | Quota — Worker and Firebase mail share it |
