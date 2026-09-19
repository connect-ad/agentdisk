# 003 · The Google consent screen names the wrong product

**Status:** Not started. One line of config plus a Firebase deploy.
**Priority: MEDIUM** — customer-visible, trivially fixed, and it undermines
trust at the exact moment somebody is deciding whether to sign in.
**Branch:** `dev`
**Found:** 19 September 2026, while swapping the email provider.

---

## The fault

`infra/firebase/firebase.json` declares:

```json
"googleSignIn": {
  "oAuthBrandDisplayName": "AgentDisk",
  "supportEmail": "connect@amardrive.com"
}
```

`connect@amardrive.com` belongs to the **sibling product line**, not to this
product. Almost certainly a copy-paste from that project's config.

Google renders `supportEmail` on the OAuth consent screen — the dialog a person
sees when they choose *Continue with Google*. So a stranger signing up to
AgentDisk is shown a support address at a domain they have never heard of,
beside a brand name that says AgentDisk. That reads either as a phishing page or
as a company that does not know its own address, and it appears at the one
moment the product is asking for trust.

Nothing functional depends on it. The address is a display and contact field,
not an authentication parameter, so sign-in works today and will work after the
change.

## The fix

Change the address to `connect@agentdisk.io` — already verified as the sending
identity for this domain, so it is an address somebody actually reads.

Then deploy the auth config. **Mind the known trap recorded in CLAUDE.md:**
`firebase deploy --only auth` silently resets `passwordRequired`, turning
email-link sign-in off on every run. Re-assert it after deploying, and confirm
email-link sign-in still works before calling this done.

## Verification

Sign out, open `app-dev.agentdisk.io`, choose *Continue with Google*, and read
the address on the consent dialog. It is the only place this value is visible,
so the screen is the test.

## Also worth checking while in there

The same file declares `anonymous: false` and `emailPassword: true` and says
nothing about GitHub, which **is** an enabled provider in the console. Config
that omits a live provider is config nobody can trust as the record of what is
enabled — either complete it or note in the file that the console is
authoritative.
