# Testing AgentDisk

A literal walkthrough for someone with no context. Fifteen minutes end to end.

Everything below is the **development** deployment. Nothing here touches production,
which has never been deployed.

| | |
|---|---|
| Website | **https://app-dev.agentdisk.io** |
| API | `https://api-dev.agentdisk.io` — JSON only; every path returns `{"error":…}` in a browser, which is correct |
| MCP | `https://api-dev.agentdisk.io/mcp` |
| Staff console | `https://admin-dev.agentdisk.io` — internal, Part 8 |

---

## Part 1 — Sign up and look around

**1. Open https://app-dev.agentdisk.io**

You should see the landing page: nav across the top (Docs · Pricing · Sign in ·
Get started), a hero, and pricing further down. Click **Docs**, **Pricing**,
**Terms** and **Privacy** — all four are real pages, not placeholders.

**2. Click "Get started".**

Sign up with **Continue with Google** (fastest), **Continue with GitHub**, or
email and password. All three work. If you use email, you'll get a verification
message — you can carry on without clicking it, but you won't be able to be
*invited* to somebody else's workspace until you do.

**3. You land in a workspace called "My Workspace".**

It was created for you at signup. You should see the dashboard with **Storage
used 0 B**, **Files 0**, **Requests** a small real number, and **Agents —**.

> The em dash on Agents is deliberate. Agent counting has no endpoint yet, and
> showing a plausible number would make you doubt the ones next to it.

**4. Click every item in the left sidebar.** Files, Activity, Agents, API keys,
MCP connection, Webhooks, Usage, Settings. Every screen loads and every list is
genuinely empty — there is no sample data anywhere in this product.

---

## Part 2 — The thing it's actually for

**5. Sidebar → API keys → "Create key".**

- Name: `first key`
- Agent: leave it as **No agent (workspace-level)**
- Permissions: tick **Read**, **List**, **Write**
- Create.

> **You do not need an agent to make a key.** The field is optional and a
> workspace-level key works immediately. Skip it for a first test.
>
> An agent is worth creating once more than one thing is calling the API,
> because it changes attribution: the Activity log will say `research-bot`
> wrote a file rather than naming you, and disabling that one agent stops
> every key it holds at once instead of you working out which of six keys
> belong to it. Step 12 comes back to this.

**6. Copy the key now.** It starts `ask_live_`. This is the only time you will
ever see it — we store a hash, not the key. Click "I've copied my key".

**7. Use it.** In a terminal:

```bash
export AGENTDISK_KEY="ask_live_…"     # what you just copied

curl -s https://api-dev.agentdisk.io/v1/whoami \
  -H "Authorization: Bearer $AGENTDISK_KEY"
```

You should see your workspace name, `"credential": "api_key"`, and the exact
permissions you ticked. `"actor"` says `"user"` — this key has no agent, so it
acts as you. **That is the product working**: a credential scoped to one
workspace and one set of operations, that a human minted and can revoke.

**8. Upload a file with it:**

```bash
curl -s -X POST https://api-dev.agentdisk.io/v1/files \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"path\":\"/reports/hello.txt\",\"mimeType\":\"text/plain\",
       \"content\":\"$(printf 'hello from the API' | base64)\"}"
```

**9. Go back to the browser → Files.** `hello.txt` is there.

**10. Try something the key isn't allowed to do:**

```bash
curl -s -X DELETE https://api-dev.agentdisk.io/v1/files/<id> \
  -H "Authorization: Bearer $AGENTDISK_KEY"
```

`403`. You didn't tick Delete. The key cannot exceed what you granted it, and
nothing about that is enforced in the UI — it's enforced in the API.

**11. Sidebar → Activity.** Every step above is listed. Note that it names
*you* as the actor — the key has no agent, so the trail attributes it to whoever
minted it.

**12. Now create an agent and see the difference.** Sidebar → Agents → "Create
agent", name it `research-bot`. Names take letters, numbers, dots, dashes and
underscores; a slash is refused, because agent names appear in permission paths.

It shows **No credential**, which is correct — an agent without a key is inert.
Mint a second key with **Agent: research-bot**, upload another file with it, and
look at Activity again: this one is attributed to `research-bot`, not to you.
That difference is the whole reason agents exist.

---

## Part 3 — Uploading from the browser

**13. Files → drag a file onto the page**, or use the **Upload** button.

Try one **under 1 MB** and one **over 1 MB**. Both work, by different routes:
small files travel through the API, large ones go straight to storage with a
progress bar. Neither should fail.

**14. Usage** now shows real storage used against your plan's limit.

---

## Part 4 — Working with somebody else

You need a second account. Use a different browser or a private window.

**15. In the second browser, sign up** with another address. Note it down.

**16. Back in the first browser: Settings → Members → "Add member".**

Enter the second address, role **Reader**, add.

- If it says *"has an account but has not verified that address yet"* — go and
  click the verification link in the second account's inbox, then retry. That
  check exists so somebody who typed your colleague's address into a signup form
  can't receive an invitation meant for them.
- If it says *"No AgentDisk account for …"* — they haven't signed up yet.

**17. In the second browser, reload.** They can now see the workspace, the files,
and the activity — and there is no Upload button, no Create key, no Add member.
Reader means read.

**18. Back in the first browser: Members → Remove**, leaving *"Also revoke every
API key they created here"* ticked. They lose access on their next request.

---

## Part 5 — Connect a real MCP client

**19. Add this to your MCP client's config** (Claude Desktop, or any client that
speaks Streamable HTTP):

```json
{
  "mcpServers": {
    "agentdisk": {
      "url": "https://api-dev.agentdisk.io/mcp",
      "headers": { "Authorization": "Bearer ask_live_…" }
    }
  }
}
```

**20. Ask it to list your files.** It should call `list_files` and come back with
`hello.txt`.

**21. Ask it to delete something.** It will tell you it has no tool for that —
because your key has no Delete permission, `delete_file` was never offered to it.
An agent doesn't merely get refused; it never learns the tool exists.

---

## Part 6 — Webhooks

**22. Settings → Webhooks → add an endpoint** pointing at any URL you control.

Upload a file and the endpoint receives a `file.created` POST, signed
`HMAC-SHA256` over `timestamp.body` in a `X-AgentDisk-Signature` header. Deleting
a file sends `file.deleted`. Failed deliveries retry on a queue and then land in
a dead-letter queue rather than disappearing.

> Delivery is built and unit-tested, but I have not watched a payload arrive at a
> real external endpoint — that needs a URL you own, so it is on your side of the
> line. If nothing arrives, that is a finding worth reporting.

---

## Part 7 — Billing

**23. Settings → Billing → "Set up billing".**

You land on Stripe's own hosted portal, in **test mode**. Card `4242 4242 4242
4242`, any future expiry, any CVC.

There is deliberately no card form inside AgentDisk. Everything past "who is this
account" happens on Stripe's page.

---

## Part 8 — The staff console (you, as the operator)

This one is not customer-facing. It lives on its own hostname so a staff session
cookie and a customer session cookie cannot reach each other in a browser.

**24. Open https://admin-dev.agentdisk.io** — it loads, and you cannot log in,
because no staff account exists yet. That is not a bug to work around: `POST
/v1/staff/users` deliberately returns 501, since an endpoint that mints a working
staff credential is an endpoint that can be tricked into minting one.

**25. Create the first one from your machine.** You need
`DATABASE_ENCRYPTION_KEY` — the same value the Worker runs with, from the `dev`
GitHub Environment. Put it in your shell rather than on the command line, where
it would land in history and in the process list:

```bash
cd apps/api
export DATABASE_ENCRYPTION_KEY='...'        # from the dev environment secret
node scripts/provision-staff.mjs --email you@example.com --role super_admin --env dev
```

It prints a generated password, an `otpauth://` URI, and **the code your
authenticator should be showing right now**. Scan the URI, check the code
matches, and only then run the `wrangler d1 execute` command it gives you. If the
codes disagree, fix the enrolment first — applying the SQL anyway creates an
account that cannot log in and cannot be deleted through the API.

Delete the `.sql` file afterwards. It holds a password hash and an encrypted TOTP
secret, neither usable alone, but there is no reason to keep it.

**26. Log in** with the address, the generated password, and a live TOTP code.
All three are required; there is no password-only path.

**27. Look up a workspace** by ID or email. Every read is audited — staff access
is the one deliberate exception to tenant isolation in this system, so unlike
customer reads, *looking* is recorded too, not just changing.

---

## What isn't built

Told plainly so you don't spend time hunting for it:

- **Editable plans and pricing.** The staff console lists plans; it cannot yet
  change them or push a price to Stripe.
- **Multipart upload** — a single file above about 5 GB.
- **Signed permanent links.**
- **Full-text search inside files.** Search covers names, paths, captions and
  tags, and the API says which fields it looked at so an empty result isn't
  mistaken for "no such file".
- **Production.** Everything here is dev. `app.agentdisk.io` does not exist.

---

## If something breaks

Every error response carries a `requestId` like `req_01M1X…`. Send that — it
finds the exact request in the logs. From the browser, open the console (F12);
the same ID appears in any red banner.

---

## How much of this was verified, and how

Being precise about this, because "it should work" and "I watched it work" are
different claims.

**Verified by running it against the live deployment:** every `curl` in Parts 2
and 3 — signup through the identity API, workspace creation, key minting both
with and without an agent, `whoami` for each, agent creation, inline upload, a 2 MB presigned upload
round-tripped and checked byte-for-byte, the `403` on an ungranted permission,
the members flow including the unverified-address refusal, the Stripe portal
session returning a real URL, and the MCP endpoint answering `initialize`.

**Verified against the deployed console:** Part 8's hostname serves the staff
console, stays `noindex`, is built against this stack's own API, and publishes no
`workers.dev` bypass — asserted by `apps/admin/scripts/smoke-test.mjs` on every
deploy, and run by hand against the live origin.

**Verified by test, not by hand:** MCP tool filtering by scope, the webhook
signature rejections and delivery retries, the billing write-block, and that the
values `provision-staff.mjs` writes under Node are the values the Worker's own
verifiers accept. That last one is pinned to literal output rather than
recomputed, because a test that generates its inputs with the code it is checking
asserts nothing.

**Not verified by me — this is what needs your hands:** every step that requires
a browser. I cannot click a Google or GitHub consent screen, drag a file onto a
page, drive an MCP client, or scan an `otpauth://` URI into an authenticator.
Parts 1, 4, 5 and 8 are written from the code and the API behaviour, step 13's
drag-and-drop has never been exercised by a human, and no webhook payload has
been observed arriving at a real external endpoint.

If any of those differ from what's written here, that's the guide being wrong,
not you.
