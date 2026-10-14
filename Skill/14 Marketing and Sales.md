# 14 · Marketing and Sales

How AgentDisk gets its first users and its first revenue. Written 11 October
2026, when the product had been live for eleven days and had **zero
customers**.

This is an operating document, not a strategy deck. It names the channel, the
step, the owner and the state of every item, and it carries the decision rules
that say when to push harder and when to stop. Run the daily check
(`/mcheck`), act on what it says, append to the log at the bottom.

**Karim owns the account and the money. Claude owns the plan, the
measurement, and everything that lives in this repository.**

---

## 1 · The position, in one line

> **AgentDisk is the disk an AI agent keeps between runs.**

Not "cloud storage with an API" — that market has AWS in it. The wedge is the
thing S3 is bad at: an agent needs its own identity, its own scoped key, a
hard spending cap so a runaway loop cannot bankrupt anyone, and an MCP server
it can discover and mount without a human writing glue code. The product
already does all four; the job here is that nobody knows.

**Who, exactly.** A developer building agents on Claude Code, Cursor, Cline or
the OpenAI Agents SDK, who has hit the moment where the agent needs a file to
survive past the end of the run. Indie developers and two-to-five person teams.
Not enterprises — the pricing forbids it, see §2.

The campaign's own search themes already name this audience correctly:
`ai agent workspace`, `claude code file storage`, `llm agent storage`,
`mcp server file storage`.

---

## 2 · The arithmetic that decides everything

This is the single most important section. Read it before proposing any paid
channel, ever.

| | |
|---|---|
| Plans (`apps/web/src/lib/pricing.js`) | Free $0 · Basic **$9** · Pro **$20** (featured) · Team **$80** |
| Realistic ARPU | ~$15–20/month |
| Realistic LTV | **$150–400** |
| Healthy allowable CAC (⅓ of LTV) | **$50–100** |
| US CPC, developer-infrastructure keywords | ~$3–12 |
| Cold visitor → paying customer | 1–3%, optimistically |
| Implied CAC from paid search | **$100–600** |

**Paid acquisition is structurally unprofitable at this price point.** Not
"badly configured" — unprofitable by arithmetic, before anyone touches a
setting. That is the finding that shapes the whole plan.

Two corollaries worth stating plainly, because they are counter-intuitive:

- **Performance Max is the worst possible fit.** It needs roughly 10–20
  conversions a week to leave the learning phase. The campaign runs at
  **SGD 3.00/day** (~US$2.30) and has recorded zero conversions since it
  started on 10 Oct 2026. It cannot learn, and spraying a niche technical
  audience across YouTube, Display, Gmail and Discover wastes what little
  budget there is. Final URL expansion is also on, which sends paid clicks to
  whichever page Google likes rather than the one chosen.
- **This is not a reason to despair.** It is a reason to pick the channels
  that cost nothing and reach this exact audience better than any ad can:
  package registries, the MCP ecosystem, and other developers. See §5.

---

## 3 · The ninety-day goal

**Ten to thirty people who use AgentDisk more than once and will talk to you
about it.** Chosen 11 Oct 2026 over "signup volume" and "first MRR", because
with zero customers the binding question is not *can we acquire* but *does the
product hold anyone*. Volume bought before that answer is known is volume
wasted.

Success is therefore a number **and** a sentence:

- 10–30 users with a second session, and
- a sentence you could not have written on day one about why they stay.

Revenue is a lagging indicator here and is deliberately not the target. If the
retention signal is real, pricing is a solvable problem; if it is not, no
amount of acquisition fixes it.

---

## 4 · Where we actually stand

Verified 11 Oct 2026. Re-verify with `/mcheck`.

**What is genuinely good — do not rebuild any of this:**

| | |
|---|---|
| Machine discovery | All eight documents live and returning 200: `/llms.txt`, `/openapi.json`, `/auth.md`, `/.well-known/api-catalog`, `/.well-known/mcp/server-card.json`, `/.well-known/ai-catalog.json`, plus agent-skills. See `apps/web/scripts/agent-discovery.js`. |
| Content | 36 URLs in the sitemap: 10 blog posts, compare pages, alternatives pages, four `storage-for-*` landing pages. |
| The front door | The no-signup sandbox is already a primary CTA in three places — nav, spotlight, closing band. Nothing to fix. |
| Product surface | REST + MCP + CLI, four plans on live Stripe. |

**What is missing — this is the entire problem:**

| Channel | State on 11 Oct 2026 | Workstream |
|---|---|---|
| **npm** | `agentdisk` → **404, unpublished**. The docs tell people to run `npx agentdisk`; it fails for everyone. The name is also unclaimed, so a stranger can take it. | W1 |
| **Official MCP registry** | **Not listed.** `search=agentdisk` returns zero. For an MCP-first product this is *the* directory. | W2 |
| **GitHub** | Repo is **public** with **0 stars, no description, no homepage link, no topics**. A free storefront, entirely unmerchandised. | W3 |
| **Awesome-lists / directories** | Absent everywhere. | W2 |
| **Activation measurement** | `sign_up`, `login`, `begin_checkout`, `purchase` are tracked. The sandbox — the hero flow, the one anonymous people actually use — was **not measured at all**. | W4 |

The pattern: AgentDisk is excellent at being *found by machines* and invisible
to *people*. Every item above is free to fix.

---

## 5 · The channel plan

Priority order. Do them top to bottom; do not start a lower one while a higher
one is incomplete.

### W1 · Be installable — npm

**Why first.** `npx agentdisk` appears in the docs and in `apps/cli`, and it
currently fails. Every developer who follows the quick start hits a 404. It is
also the cheapest credibility signal a dev tool has, and the name is sitting
unclaimed.

**Two defects were found by dry-running the publish on 11 Oct 2026, and both
are fixed.** They are worth recording because each would have shipped to every
user and neither was visible from inside the repo:

- `DEFAULT_API` read `https://api-dev.agentdisk.io`. Harmless while the
  package was unpublished and every caller was us; the moment a stranger runs
  `npx agentdisk`, it silently points them at **dev**.
- The help text sent people to `https://app-dev.agentdisk.io/sandbox`.
- The tarball had no README, so the npm page — the first thing anyone
  evaluating a dev tool reads — would have been blank. `apps/cli/README.md`
  now leads with what it is, the no-signup sandbox, and the MCP config block.

**Steps**

1. `cd apps/cli && npm login` *(Karim — needs his npm account)*
2. `npm publish --access public`
3. Verify: `npx agentdisk@latest --help` — the sandbox line must read
   `agentdisk.io`, not `app-dev`.
4. Then W2, which is worth far more once this works.

**Owner:** Karim runs the publish; Claude prepared and verified the package.
**State:** package ready and `npm pack --dry-run` clean (4 files, 5.2 kB).
Publish not run — needs Karim's npm credentials.

### W2 · Be listed — registries and directories

**Why.** This audience discovers tools by browsing registries, not by
searching Google. One registry entry outperforms a month of SGD 3/day.

**Steps, in order of value**

1. **Official MCP registry** — submit `mcp.agentdisk.io`. The server card at
   `/.well-known/mcp/server-card.json` already exists and is the input.
2. **`awesome-mcp-servers`** (and its forks) — a pull request adding one line.
3. **MCP directory sites** — mcpservers.org, mcp.so, Smithery, Glama.
4. **AI-tool directories** — only ones a developer would actually read.

**Owner:** Claude prepares each submission (text, URLs, categories); Karim
submits, because each one publishes under his name.
**State:** not done.

### W3 · Be legible — GitHub

**Why.** A developer evaluating infrastructure opens the repo before the
pricing page. Right now it says nothing about what it is.

**Steps**

1. Repo description, homepage URL (`https://agentdisk.io`), topics:
   `mcp`, `ai-agents`, `storage`, `cloudflare-workers`, `claude`, `llm-tools`.
2. A README that **sells before it documents**: what it is in one line, the
   30-second sandbox `curl`, the MCP config block, then the links.

   **This needs Karim's decision, because it collides with a standing rule.**
   `README.md` is a symlink to `CLAUDE.md`, and CLAUDE.md says that file is
   the only index and README is never written directly. The rule exists to
   stop two indexes drifting apart, and it is a good rule. But it means the
   public storefront for this product is an internal build index — skills
   table, deploy rules, test counts — shown to a developer who wanted to know
   what the thing does. The one-line opener is right; everything after it is
   written for us, not for them.

   Two ways out, both fine: break the symlink and keep a short public README
   whose only job is the first screen, with CLAUDE.md unchanged as the
   internal index; **or** keep the symlink and accept that GitHub is a weaker
   channel than it could be. Claude's recommendation is the first — the
   drift risk is small for a page that holds a pitch and two code blocks, and
   the audience for the two documents genuinely differs.

3. Only after 1 and 2: ask the handful of people from §6 to star it.

**Owner:** Claude.
**State:** description, homepage and eight topics set 11 Oct 2026. README
decision open.

### W4 · Measure activation

**Why.** The 90-day goal is *engaged users*, and until 11 Oct 2026 nothing
distinguished an engaged user from a page view. The sandbox is used by people
with no account, so sign-ups undercount the real audience badly.

**Events** (`apps/web/src/lib/analytics.js`, consent-gated like everything else,
and carrying **no** parameters — the module's rule that nothing names a person,
a workspace or a file applies here too):

| Event | Fires | Means |
|---|---|---|
| `sandbox_created` | `components-local/SandboxDialog.jsx`, on a successful `POST /v1/workspaces` | Somebody tried the product |
| `file_stored` | `routes/FileBrowser.jsx`, on a completed upload | Somebody used the product |
| `sign_up` *(existing)* | `lib/auth.jsx` | Somebody committed |
| `purchase` *(existing)* | `App.jsx` | Somebody paid |

Those four are the funnel. Everything in §7 is read off them.

**Owner:** Claude.
**State:** `sandbox_created` and `file_stored` added 11 Oct 2026.

### W5 · The paid account — stop the bleeding

**Steps**

1. **Pause Campaign #1.** It cannot learn at SGD 3/day and the conversion
   action it bids against has never fired.
2. Fix the conversion action anyway, so the funnel is intact when traffic
   arrives: Goals → Conversions → **Sign Up** → Settings → **Event** →
   *Match when* `URL starts with` → **`URL contains`**. The rule currently
   reads `agentdisk.io/signup`, but that URL 302s to `app.agentdisk.io/signup`,
   which does not *start with* it. `contains` matches; the domain prefix is
   locked so nothing else can be edited.
3. Do not restart paid until §7 says so.

**Owner:** Karim. Claude is blocked from writing to the Ads account by the
permission classifier (see the memory note `classifier-blocks-live-writes`);
it can read the account freely.
**State:** conversion rule still broken; campaign still enabled.

#### The spend-matching coupon — recommendation: let it wait, probably let it go

Read from Billing → Promotions on 11 Oct 2026, because the overview card
rounds and mislabels it:

| | |
|---|---|
| Code | `6C7XV-NRWCL-CFRWA` |
| Terms | Spend **SGD 489.53** → receive **SGD 489.54 credit for future ad spend** |
| Spent so far | **SGD 0.00** |
| Expires | **9 December 2026** — 59 days from today |

Two corrections to what the overview card implies. The amounts are **SGD, not
USD** (~US$375, not $490), and the reward is **credit against future spend**,
not cash back. So the real shape is: pay ~US$375 now, and earn the right to
spend another ~US$375 on ads later.

**Why this does not change the verdict in §2.** A matched-credit offer is a
discount, and a discount is only a good deal on something you wanted at half
price. The question is not "should we claim SGD 490 of credit" — it is "do we
want to spend SGD 490 of real cash on ads right now". With zero customers, an
unvalidated product and W1–W3 still undone, the answer is no. The organic
channels cost nothing and are not finished; money spent before them buys
noise.

The arithmetic is also sobering. Qualifying means **SGD 8.30/day for 59 days**
— nearly three times the current budget. All in, both halves together buy
roughly **95–190 clicks** at this niche's CPC, which at a 2–3% signup rate is
a handful of signups and realistically zero to one paying customer. That is
not a channel test. It will not prove paid works.

**What it is genuinely good for.** §7 says paid may only resume when allowable
CAC is *measured* rather than estimated. This coupon is the cheapest way to
buy that measurement — real CPC, real visitor→signup rate — at half price.
That is worth something, but only once there is an organic baseline to compare
it against.

**Decision: revisit around 10 November 2026.** Spend nothing before then. Four
preconditions, all of them, before a cent goes out:

1. The conversion action actually records — otherwise the spend teaches nothing.
2. PMax is gone, replaced by exact-match Search on eight to ten terms.
3. W1–W3 are live and an organic baseline exists to compare against.
4. Karim is content to lose the whole SGD 490 and call it tuition.

If all four hold on 10 Nov: SGD 17/day × 29 days = SGD 493, which qualifies
with a few days' buffer before 9 Dec. If they do not hold, **let it expire**.
An expired coupon costs nothing. A chased one costs SGD 490 and the attention
that should have gone to the registries.

### W6 · One launch moment — *only after W1–W4 are done*

A launch to a product nobody can install is a wasted launch, and you get one.
When npm, the registry listing, the README and the funnel events are all live
and the sandbox has worked for real strangers: Show HN, then the MCP
community channels. Product Hunt is optional and lower value for this
audience.

**State:** blocked on W1–W4.

---

## 6 · The first thirty conversations

The sales motion at this stage is not a funnel. It is thirty conversations.
Written for someone doing this for the first time.

**Where these people are.** The Claude/MCP developer community, the Cursor and
Cline communities, r/LocalLLaMA and r/ClaudeAI, agent-framework Discords, and
the issue trackers of agent projects where people are visibly hand-rolling
file persistence. That last one is the highest-yield: somebody describing the
problem in public is somebody who already has it.

**The opening.** Short, specific, no pitch, and it must be obvious you read
what they wrote:

> Saw you were wiring up file persistence for your agent. I built
> AgentDisk — agents get their own scoped key and an MCP server, and the
> spend is hard-capped so a loop can't run up a bill. There's a sandbox
> that needs no signup: agentdisk.io/sandbox. Would it help? Happy to hear
> if it doesn't.

**What to ask, once they have tried it.** Three questions, in this order:

1. *What were you using before this?* — tells you the real competitor, which
   is usually "a folder on disk" or "nothing", not S3.
2. *Where did it get confusing?* — the only reliable source of the first-five-
   minutes problem.
3. *What would have to be true for you to put something you care about in it?*
   — this is the trust question, and for storage it is the whole sale.

**What not to do.** Do not ask "would you pay for this" — the answer is
unreliable and it ends the conversation. Do not demo. Do not mention price
unless they ask; when they do, say the free tier is 1 GB and real, and that
paid starts at $9.

**Write every answer down.** Ten of these and the positioning in §1 rewrites
itself, in their words rather than yours. That rewrite is the single highest-
value marketing asset this company can produce in ninety days.

---

## 7 · Decision rules

Read these off the daily check. They exist so a bad week produces a decision
rather than anxiety.

| If | Then | Because |
|---|---|---|
| `sandbox_created` < 10/week once W1–W3 are live | Push distribution harder — more directories, more conversations. Do **not** touch the product. | The problem is awareness. |
| `file_stored` ÷ `sandbox_created` < 30% | Stop all marketing. Fix the first five minutes. | People are arriving and bouncing; more arrivals makes it worse, not better. |
| `file_stored` healthy, `sign_up` near zero | Fix the sandbox→account bridge, not the top of funnel. | The free tier is not yet worth an account. |
| `sign_up` healthy, `purchase` zero after 60 days | Pricing and packaging problem. Revisit §2, not the channels. | Acquisition is working; conversion to paid is not. |
| Someone asks for a feature twice, unprompted | Write it in the log. Two unprompted asks is the strongest signal available at this stage. | |
| Any paid channel is proposed | Re-read §2 first. Paid resumes only when allowable CAC is **measured**, never estimated — and never as PMax. Exact-match Search, a handful of terms, a hard daily cap. | |

---

## 8 · What we are deliberately not doing

Named so nobody re-proposes them in a weak moment.

- **Performance Max, at any budget this company can afford.** §2.
- **Paid acquisition before activation data exists.** Optimising blind.
- **More SEO content.** 36 URLs already exist for a category with little search
  volume. Writing the 37th before anyone has used the product is motion, not
  progress. Revisit when conversations say which words people actually use.
- **Enterprise or sales-led motion.** $9–80 per month cannot fund a sales call.
- **Rebuilding the homepage.** The sandbox is already the front door in three
  places. Checked 11 Oct 2026.
- **A newsletter, a Discord, or a community.** These need an audience to work.
  We do not have one yet.

---

## 9 · The daily check

Run `/mcheck`. It takes about two minutes, reads every number in §7 from its
source, compares against the previous entry, and says which decision rule
fired — or that none did, which is the common and correct outcome.

Where each number comes from, and who can read it:

| Number | Source | Readable by Claude? |
|---|---|---|
| npm downloads | `api.npmjs.org/downloads/point/last-week/agentdisk` | Yes |
| GitHub stars, views, clones | `gh repo view`, `gh api repos/.../traffic/views` | Yes |
| MCP registry listing | `registry.modelcontextprotocol.io/v0/servers?search=agentdisk` | Yes |
| `sandbox_created`, `file_stored`, `sign_up`, `purchase` | GA4 property **556215733** | Yes — see the note below |
| Ads impressions, clicks, cost, conversions | Google Ads UI, read-only via Chrome | Yes (read only; writes are blocked) |
| Subscriptions, MRR | Stripe MCP, read | Yes |

**Reading GA4, and the two traps in it.** Sorted 13 Oct 2026 after two checks
ran blind:

- The analytics MCP reads ADC **once, at start-up**. Once credentials expire it
  keeps reporting "Reauthentication is needed" for the rest of the session even
  after they are repaired, which reads exactly like a dead token and is not
  one. `gcloud auth application-default print-access-token` settles it: if it
  prints, the credentials are fine and only the MCP is stale. Restart it with
  `/mcp`, and meanwhile read the Data API directly over `curl` — `/mcheck`
  carries the request.
- Re-authenticating needs the **project's own OAuth client**, not gcloud's
  default, which Google now blocks for `analytics.readonly`. The client is
  `analytics-mcp` in Cloud project `agentdisk` (514497115904). Its secret can
  no longer be downloaded from the console, but the expired
  `application_default_credentials.json` still holds the same `client_id` and
  `client_secret` — rebuild the client file from those rather than adding a new
  secret and leaving one to rotate. The account with access to the property is
  **connect@amardrive.com**, not `kernelv5@`.
- **The credential expires roughly daily, and the repair is interactive.** On
  14 Oct 2026 the refresh token itself came back `invalid_grant /
  invalid_rapt`: Google wants a fresh reauthentication proof, which is what a
  Workspace session-control policy on `connect@amardrive.com` produces. This
  is *not* the stale-MCP trap above — `print-access-token` fails too. A
  browser login fixes it for about a day and then it dies again, so **`/mcheck`
  cannot read GA4 on its own.** The durable fix is a **service account** with
  Viewer on property 556215733: service accounts carry no reauth policy and do
  not expire. It needs Karim — a key created in Cloud project `agentdisk`,
  stored outside this repository, and its address added under GA4 Admin →
  Property access management.

**Do not expect daily movement.** At this stage most days are flat and that is
not failure. The check exists to catch the week where something moves, and to
make sure a broken funnel is noticed in a day rather than a month.

---

## 10 · Log

Newest first. One line per entry: what changed, what moved, what was decided.
`/mcheck` appends here.

| Date | Entry |
|---|---|
| 2026-10-14 | `/mcheck`. **The ad budget was raised from SGD 3.00/day to SGD 10.00/day** — change history names `connect@amardrive.com`, 13 Oct 20:46, Web client (manual). That is 3.3× more money into a Performance Max campaign bidding against a conversion action that has still never fired, while §5 W5 says pause it. Paid since launch: **82 impressions, 2 clicks, SGD 3.10, 0 conversions** (Oct 10–13; it was 20/1/SGD 2.23 through Oct 12, so Oct 13 alone bought 62 impressions and one click). A new **EU political-ads confirmation** dialog now blocks every Ads page and states this account was previously confirmed to run EU political ads — wrong for this product, it costs EU serving, and clearing it is a write only Karim can make. Funnel unreadable: the GA4 refresh token now fails `invalid_rapt`, a reauth-policy expiry rather than the stale-MCP trap, and it will recur daily until a service account replaces it (§9). Distribution unmoved — npm 404, MCP registry zero, 0 stars. Live Stripe still unreadable, test-mode context only. No §7 rule fires on the funnel for want of data; the paid-channel row fires in substance, and its answer is to cut spend, not raise it. |
| 2026-10-13 | **GA4 restored, and the funnel read for the first time.** 7 days: 15 users, 10 first visits, 58 page views — and **zero** `sandbox_created`, `file_stored`, `sign_up` or `purchase`. Not one event past a page view. Sources: 12 users direct (mostly us), 1 organic Google, 1 via `syndicatedsearch.goog` (the paid click, on search partners rather than google.com), 1 unassigned. So real external traffic is **one to three people a week**. This is the §4 diagnosis in numbers: the product is undistributed, not unconvincing — too few people arrive to learn anything about whether it converts. No decision rule fires; the §7 rules gate on W1–W3 being live, and they are not. Fixing the credentials needed the project's own OAuth client, and the MCP needed a restart on top; both traps are now written into §9 and `/mcheck`. |
| 2026-10-13 | `/mcheck`. **The campaign started serving** — 20 impressions, 1 click, SGD 2.23 spent (Oct 10–12), from a standing start of zero. "Ad strength is poor" cleared on its own, leaving two diagnostics. Distribution unmoved: npm still 404, MCP registry still zero, GitHub still 0 stars. GitHub traffic is CI, not people — 1,124 clones from 229 uniques is Actions, and page views show 1 unique. Funnel unreadable: GA4 needs `gcloud auth application-default login`. Live Stripe unreadable: only a test-mode context in this session. No decision rule fired — W1–W3 aren't live, so the rules that gate on them have no standing, and there is no funnel data for the ratios. **Money is now leaving against a conversion action that structurally cannot fire.** |
| 2026-10-11 | Spend-matching coupon `6C7XV-NRWCL-CFRWA` recorded (SGD 489.53 → SGD 489.54 of future ad credit, expires 9 Dec 2026). Decision: spend nothing now, revisit 10 Nov against four preconditions, let it expire if they are not met. See §5 W5. |
| 2026-10-11 | CI's `push` trigger now ignores `Skill/`, `.claude/`, `CLAUDE.md`, `README.md` and `design-system/`. The seven deploy callers already allow-list one app directory each, so prose could never trigger a deployment; this only stops the dev-push build running for nothing. The `pull_request` trigger is deliberately unfiltered — filtering it would leave docs-only PRs waiting for required checks that never report. |
| 2026-10-11 | W1 prepared. Dry-running the npm publish caught two defects that would have shipped to every user: the CLI defaulted to the **dev** API, and its help pointed at the dev sandbox host. Both fixed; a README added so the npm page is not blank. Package verified publish-ready; the publish itself needs Karim's npm login. |
| 2026-10-11 | Plan written. Diagnosis: product well-built, entirely undistributed — npm unpublished, absent from the MCP registry, GitHub repo public but blank. Paid search ruled out on ARPU arithmetic (§2). Goal set: 10–30 engaged users in 90 days. `sandbox_created` and `file_stored` instrumented. GitHub metadata set. Baseline: 0 customers, 0 npm downloads, 0 GitHub stars, 0 ad impressions, 0 conversions ever recorded. |
| 2026-10-11 | CSP fix shipped (`Fixing_feedback_53`) — the Google tag's Ads conversion pings were blocked by `connect-src`. Campaign moved from *Eligible (Misconfigured)* to *Eligible (Limited)*; tag Account and Signals checks went green. |
