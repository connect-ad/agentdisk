# 6 · Auth and Firebase

How people sign in, how the Worker verifies them, and how the two Firebase
projects are set up. Agents are unaffected by all of it: they hold API keys and
never touch Firebase.

---

## Two projects

| Environment | Firebase project | Auth domain |
|---|---|---|
| dev | `agentdisk-dev` | `agentdisk-dev.firebaseapp.com` |
| prod | `agentdisk` | `agentdisk.firebaseapp.com` |

Each has four providers: Google, GitHub, email with password, and email link.
The Worker verifies ID tokens with cached JWKS and Web Crypto, because the
Admin SDK is Node-only. The build refuses to point one environment's bundle at
the other's project.

### Setting a project up

The prod project was made by hand on 28 September 2026. The steps, in order,
because `firebase deploy --only auth` cannot express most of them:

1. **Email/Password** with **Email link** both on.
2. **Google**, public name `AgentDisk`, support email `connect@agentdisk.io`.
   That address appears on Google's consent screen; dev showed the sibling
   product's address for months.
3. **GitHub** needs an OAuth App per environment on GitHub, callback
   `https://<project>.firebaseapp.com/__/auth/handler`, and its client ID and
   secret pasted into Firebase. No API can do this part.
4. **Authorized domains**: the app host and the console host.
5. **Password policy**, Require enforcement: 8 characters, an uppercase, a
   lowercase, a number and a special character. `forceUpgradeOnSignin` off.
6. **SMTP**: `smtp.mx.cloudflare.net`, port 465, SSL, user `api_token`,
   password a Cloudflare token with Email Sending: Edit, sender
   `noreply@agentdisk.io`. See [2 Email](2%20Email.md).
7. A **web app** registration; its config becomes the `VITE_FIREBASE_*`
   variables on the GitHub environment.
8. A **service-account key**, one per environment, stored whole as the
   `FIREBASE_SERVICE_ACCOUNT_JSON` secret. Upload it from a file with
   `gh secret set … < file`, never through a chat or a clipboard, and delete
   the file. A key for one project must never act on the other. Keep one live
   key per environment; delete superseded ones on the Google Cloud Keys tab.

`infra/firebase/firebase.json` records the Google provider and can be applied
with `npx firebase-tools deploy --only auth --project <project>`. **Two things
that deploy does silently**: it resets `signIn.email.passwordRequired` to true,
turning email-link sign-in off, and on the run that first creates the config it
ignores `authorizedDomains`. Re-assert both through the admin API or the
console after every run, and verify by reading the config back.

## The password policy lives in Firebase

Nothing in this repository ever receives a password, so nothing here can
enforce one. `apps/web/src/lib/password.js` restates the rules so a person is
told them while typing; `checkPassword` runs on sign-up, reset and change.
Change one and you must change the other, in a console CI cannot read. The
SDK's `validatePassword`, which would fetch the live policy, was rejected: a
network round-trip on a field being typed into. Login never gates on the
policy, or it would lock out the accounts `forceUpgradeOnSignin` exists to
spare.

## Verifying in the Worker

- **Every authentication failure returns one identical body.** Unknown,
  revoked, expired, forged and disabled credentials are indistinguishable to
  the caller; the reason goes to the log. **An absent credential is one of
  those failures, not a missing route.** `withAuth` gets this right for every
  route through it; `/v1/workspaces` is hand-routed because `POST` with no
  credential is the public sandbox, and `test/auth.test.ts` sweeps every
  authenticated route. A route added outside `withAuth` belongs in that table.
- **Failed credentials are throttled per address, and only failures count.**
  Thirty refused credentials from one IP in fifteen minutes and that IP gets
  429 before the lookup until the window ends. A valid key is never charged; a
  403 or 400 from an authenticated caller is not a failure; the 401 body stays
  byte-identical. REST and MCP share one counter because they share one
  middleware, and it lives in KV.
- **A deleted account is our own fact, checked before Firebase's.** Disabling
  a Firebase identity does not invalidate an ID token already issued.
  `users.deleted_at` and `users.disabled_at` are refused in
  `resolveVerifiedUser`, beside `session_revoked_after` and before any
  membership lookup, and unlike revocation a later `iat` is not a way back in.
- Any request may carry `X-AgentDisk-Session` naming the session, model or
  run. It is stored on the audit row and shown in Activity. A label a person
  reads, never an identity.

## Administrators

An admin account is an email address in `admin_users`, not a credential.
Admins sign in through the same Firebase project as customers, and one token
reaches both surfaces; **the `admin_users` lookup on every request is the only
boundary**, which is why the role lives in the row and never in a Firebase
custom claim. A claim is minted once and goes stale; a row is read fresh and a
disable takes effect immediately. The first administrator is seeded by
migration 0014; further ones are `POST /v1/admin/accounts`, audited as
`admin.create`. The console's login is one Google button.

The Worker uses the service-account key for exactly three things: minting a
password-reset link for a customer from the console, and disabling or deleting
a customer's Firebase identity when the console deletes them. Without the key
those three refuse and everything else works, which is why dev ran without it
until 30 September.
