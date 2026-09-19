# 004 · Customer email still leaves from a firebaseapp.com address

**Status:** Not started. Two console visits, no code.
**Priority: LOW** — nothing is broken; this is deliverability and brand.
**Branch:** n/a — the change is in the Firebase console, not this repository.
**Found:** 19 September 2026, while swapping the email provider to Mailjet.

---

## Where this stands

The product sends from **two** identities, and only one of them is ours.

Our own transactional email — today just the staff-initiated password reset —
goes through Mailjet as `connect@agentdisk.io`, on a domain with SPF and DKIM.

Everything a customer actually receives is sent by the **Firebase browser SDK**
from Firebase's own infrastructure, and never touches our code:

| `apps/web/src/lib/auth.jsx` | Sends |
|---|---|
| `sendEmailVerification` (157, 225) | Verify your address, at sign-up and on resend |
| `sendSignInLinkToEmail` (169) | The email-link sign-in message |
| `sendPasswordResetEmail` (208) | Self-service password reset |

Nothing in this repository sets a sender for those, so Firebase uses its
default: `noreply@agentdisk-dev.firebaseapp.com` in dev and
`noreply@agentdisk.firebaseapp.com` in prod. (Unverified — the Firebase console
is authoritative and nothing here records it. Check before acting.)

So the first message most customers ever receive from this product arrives from
a `firebaseapp.com` address with no alignment to `agentdisk.io`. That is worse
for deliverability than a domain we control, and it looks like somebody else's
mail.

## The cheap fix, and the reason it is the recommended one

**Firebase Console → Authentication → Templates → SMTP settings**, pointed at
Mailjet's SMTP relay, once per Firebase project (`agentdisk-dev` and
`agentdisk`).

All customer mail then leaves via Mailjet from `connect@agentdisk.io`, aligned
with the SPF and DKIM already published for the domain. No code, no migration,
no new endpoint.

Note the asymmetry this creates and accept it deliberately: **Firebase would use
Mailjet's SMTP relay while our Worker uses Mailjet's Send API.** Same provider,
same sender, two transports — because a Worker cannot speak SMTP (no `net`, and
no maintained SMTP implementation for workerd). That is not untidiness to fix
later; it is the only shape available.

## The expensive alternative, recorded so it is not re-derived

Move those four sends into the Worker: the browser calls our API, the Worker
mints the link with the Admin SDK — `generatePasswordResetLink`
(`auth/firebase-admin.ts:250`) already does exactly this, and `VERIFY_EMAIL` and
`EMAIL_SIGNIN` are the same `accounts:sendOobCode` call with a different
`requestType` — and sends it through Mailjet itself.

Buys: our own wording instead of Firebase's templates, and delivery telemetry
covering customer mail.

Costs, and they are the reason this is not the recommendation:

- Three new endpoints, two of them unauthenticated and able to send email on
  request. Both need Turnstile **and** per-address/per-IP throttling — Turnstile
  stops a bot farm, it does not stop one person mailbombing one address.
- Both public endpoints must answer **identically** whether or not an identity
  exists, including when throttled. A distinguishable response is an
  account-enumeration oracle.
- It puts the sign-in path behind our delivery channel. Today, if our email
  breaks, a customer can still reset a password and get in.

Only worth it if the wording or the telemetry is wanted for its own sake.

## Verification, either way

Sign up with a fresh address on `app-dev.agentdisk.io` and read the `From` and
the `Received` headers of the verification message. That is the whole test.
