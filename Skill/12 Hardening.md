# 12 · Hardening

The 30 September 2026 production audit of the `agentdisk.io` zone: what was
found, what was changed in the Cloudflare dashboard, and what is still open.
Read it before touching zone settings, security headers, DNS, robots, the
sitemap, API discovery or anything an AI crawler reads.

The work was done by Claude running in Karim's Chrome against the Cloudflare
dashboard on 30 September and 1 October 2026 (Asia/Shanghai). Every change
was proposed in chat and approved by Karim before it was applied. **None of it
went through Terraform or CI**, which is the one rule on the index page this
page breaks on purpose; section 2 lists each setting so the drift is known
rather than discovered.

The zone is on the **Free** plan, account "Connect@amardrive.com's Account".
Plan limits shaped several decisions below.

---

## 1. What the audit found

### Already right

- Headers: HSTS `max-age=31536000; includeSubDomains`, `X-Frame-Options:
  DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`. CSP carries every main directive;
  `script-src` is `'self'` plus Turnstile, Google APIs and GTM, with no
  `unsafe-inline` or `unsafe-eval`. `'unsafe-inline'` appears only in
  `style-src`, see [5 Hostnames](5%20Hostnames.md).
- SEO basics on the three prerendered pages: own title, canonical, Open
  Graph and Twitter tags, `SoftwareApplication` JSON-LD, alt text on images.
- `/llms.txt` is complete: sandbox flow, secret handling, limits, REST
  examples, MCP config.
- `workers.dev` and preview URLs were already off on both prod Workers.
- Bot settings: Bot Fight Mode off, AI Labyrinth off, Bot Preference Sync on.
  AI bot policy is Search = Allow, Agent = Allow, Training = Disallow.
- DMARC is `p=quarantine`; SPF and DKIM exist for Cloudflare Email Routing.

### Findings

| # | Area | Finding | Status |
|---|---|---|---|
| F1 | SEO, agents | Unknown **file** paths on the site answer the homepage HTML with 200 (soft 404): `/sitemap.xml`, `/favicon.ico`, `/.well-known/security.txt`, `/.well-known/mcp.json`, `/openapi.json`, `/llms-full.txt`, `/site.webmanifest` | **Fixed 3 Oct 2026**, in `worker.js` |
| F2 | SEO | Unknown **page** paths such as `/does-not-exist` redirect to `app.agentdisk.io`, which shows its own 404 | Open, code drafted |
| F3 | SEO | `/privacy`, `/terms`, `/sandbox` and `/docs/quickstart` are not prerendered; they ship the homepage title and `canonical=/`, so Google treats them as duplicates of the homepage | Open |
| F4 | SEO | No sitemap, and `robots.txt` has no `Sitemap:` line | **Fixed 3 Oct 2026**, generated at build |
| F5 | SEO | No real `favicon.ico` or manifest; the social image is the logo with `twitter:card=summary` | Open |
| F6 | SEO | JSON-LD lacks `Organization` (Kernelv5) and `offers`; `/docs` is one page of about 100 KB | Open |
| F7 | Security | Always Use HTTPS was off, with about 1,010 plain-HTTP requests in the previous 24 hours | **Fixed, C1** |
| F8 | Security | Minimum TLS was 1.0 | **Fixed, C2** |
| F9 | Security | DNSSEC was off | **Enabled, pending DS at the registrar, C3** |
| F10 | Security | No `Permissions-Policy` or `Cross-Origin-Opener-Policy` header | **Fixed at the edge, C4** |
| F11 | Security | No `/.well-known/security.txt` | Open, code drafted |
| F12 | Security | HSTS has no `preload` | Open |
| F13 | Security | `api-dev.agentdisk.io` is public and named in `llms.txt` | Open |
| F14 | Security | Anonymous `POST /v1/workspaces` has only app-level limits (10 per hour per IP, 5 open per IP); the audit saw nothing at the edge | Open, see note |
| F15 | Security | No CAA records | Open |
| F16 | Email | SPF is `v=spf1 include:_spf.mx.cloudflare.net ~all` and lacks `include:_spf.firebasemail.com`, though Firebase sends as `agentdisk.io` | Open |
| F17 | Email | The prod zone carries TXT `firebase=agentdisk-dev`, which says the prod email domain is verified to the **dev** Firebase project | Open |
| F18 | Email | DMARC `rua` points at `dmarc_rua@onsecureserver.net`, a third party | Open |
| F19 | Agents | `api.agentdisk.io` has no discovery: `GET /` is a JSON 404; no `openapi.json`, `/.well-known/api-catalog` or OAuth metadata | Open, code drafted |
| F20 | Agents | Cloudflare Agent Readiness: Level 1 **2/5** (missing Sitemap, Content Signals, Markdown negotiation); Level 2 **0/3** (API Catalog, Link headers, Auth.md); Level 3 **0/8** (OAuth Discovery, OAuth Protected Resource, A2A Agent Card, Skills Index, MCP Server Card, Web Bot Auth, WebMCP, DNS-AID) | Open. The isitagentready.com scan of 4 Oct 2026 passes Sitemap, Content Signals, robots AI rules and Link headers; Markdown negotiation **fixed 4 Oct 2026** in `worker.js` (zone-level Markdown for Agents needs Pro; the zone is Free) |
| F21 | Agents | Bot Preference Sync is on, but the Worker serves its own `robots.txt`, so Cloudflare's managed robots rules are never prepended. Robots and Content Signals must come from the Worker | **Fixed 3 Oct 2026**: the generated robots.txt carries Content Signals and the training-crawler group |

**Note on F14.** [4 Infrastructure](4%20Infrastructure.md) records a WAF
rate-limiting rule on `/v1/workspaces` made on 28 September. The audit two
days later reported no edge limit. One of the two is wrong; check Security →
WAF → Rate limiting rules before adding a second rule, because the Free plan
allows exactly one.

---

## 2. Changed in the dashboard, all verified

| # | Setting | Where | Before | After |
|---|---|---|---|---|
| C1 | Always Use HTTPS | SSL/TLS → Edge Certificates | Off | On |
| C2 | Minimum TLS Version | SSL/TLS → Edge Certificates | TLS 1.0 | TLS 1.2 |
| C3 | DNSSEC | DNS → Settings | Off | Enabled, **pending** the DS record at the registrar |
| C4 | Response Header Transform Rule "Security headers (site + app)" | Rules → Overview | none | Active, see below |
| C5 | Certificate Transparency Monitoring | SSL/TLS → Edge Certificates | Off | On, recipient `connect@agentdisk.io` |
| C6 | Crawler Hints (IndexNow) | Caching → Configuration | Off | On; accepts Cloudflare's Supplemental Terms, approved by Karim |

Already correct and left alone: TLS 1.3 on, Automatic HTTPS Rewrites on,
Opportunistic Encryption on.

### C4, the header rule

- Expression: `(http.host in {"agentdisk.io" "www.agentdisk.io" "app.agentdisk.io"})`
- Sets `Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), browsing-topics=()`
- Sets `Cross-Origin-Opener-Policy: same-origin-allow-popups`

The COOP value is the popup-safe one. `scripts/security-headers.js` leaves
COOP out of `dist/_headers` by decision because `same-origin` would break
Firebase's `signInWithPopup`; `same-origin-allow-popups` keeps `window.opener`
reachable. **If Google sign-in on `app.agentdisk.io` ever fails in a popup,
this rule is the first suspect.** It is not applied to `api.agentdisk.io`,
which serves JSON only. It uses one of the ten Transform Rules the Free plan
allows.

These two headers now exist only at the edge, for the two hostnames above,
and nowhere in the build. A smoke test that asserts them against prod passes
only because of the rule.

### Proposed and declined

- A homepage `Link` header rule (`</llms.txt>; rel="describedby"`,
  `</docs>; rel="service-doc"`). Karim preferred it in Worker code; it is in
  the draft in section 3.
- An edge rate limit on `POST api.agentdisk.io/v1/workspaces`. See the F14
  note.

### Rolling back

Each change reverts from the same dashboard location. C1, C2, C5, C6 are
toggles. C4 is disabled or deleted under Rules → Overview. **C3 is the
dangerous one:** if the DS record has already been added at the registrar,
remove it there first and wait for the DS TTL to pass, or the domain stops
resolving.

---

## 3. Code drafted, not deployed

The audit left a file `agentdisk-worker-additions.ts` that type-checks under
TypeScript 5 with `--strict`. **It is not in this repository.** When it
arrives, merge it through the repo and CI, never through the dashboard editor.

| Function | Worker | Does | Fixes |
|---|---|---|---|
| `handleSiteExtras()` | prod-web | Serves `/robots.txt` with `Content-Signal: search=yes, ai-input=yes, ai-train=no` and a `Sitemap:` line, `/sitemap.xml` listing every prerendered page, and `/.well-known/security.txt` (contact `connect@agentdisk.io`, expires 2027-10-01) | F4, F11, F21 |
| `siteNotFound()` | prod-web | A real 404 with `noindex` for unknown paths and for any path that looks like a file, in place of the homepage HTML or a redirect to the app | F1, F2 |
| `withHomepageLinks()` | prod-web | Adds a `Link` header on `/`: `llms.txt` (describedby), `/docs` (service-doc), the API catalog | F20 |
| `handleApiDiscovery()` | prod-api | `GET /` returns a JSON index (docs, llms, openapi, mcp, sandbox endpoint) and `/.well-known/api-catalog` an RFC 9727 linkset. OAuth protected-resource metadata is written but commented out until MCP supports OAuth | F19, F20 |

The draft's `PAGES` and `SPA_ROUTES` constants must match the prerender list
in `scripts/prerender.mjs` and the route table in `src/lib/seo.js`. Note that
the web build today generates `robots.txt` and `_headers` at build time
([5 Hostnames](5%20Hostnames.md)); the draft moves robots into the Worker so
Content Signals can ride with it. Pick one owner for the file before merging.

---

## 4. Open actions, owner Karim

High priority:

1. **Add the DS record at the .io registrar.** The domain is not registered
   at Cloudflare, so DNSSEC stays pending until this exists.
   ```
   agentdisk.io. 3600 IN DS 2371 13 2 75DF48B14E0783834C1B5910F9E55ECE1BBBDDEF6667E5F0E41FEDB4428774D1
   ```
   Key tag 2371, algorithm 13 (ECDSA P-256/SHA-256), digest type 2 (SHA-256),
   flags 257 (KSK).
2. **Test Google sign-in on `app.agentdisk.io` once** to confirm the COOP
   header did not break the popup.
3. **Land the drafted Worker code** (F2, F11, F19). F1, F4, F21 and the
   homepage Link header were built into the existing web build and Worker on
   3 October 2026 instead; see "Built on 3 October" below.
4. **Prerender `/privacy`, `/terms`, `/sandbox` and `/docs/quickstart`**,
   each with its own title, description and canonical (F3).

Medium priority:

5. SPF to `v=spf1 include:_spf.mx.cloudflare.net include:_spf.firebasemail.com ~all` (F16).
6. Resolve the `firebase=agentdisk-dev` TXT on the prod zone (F17); see
   [6 Auth and Firebase](6%20Auth%20and%20Firebase.md) for the two projects.
7. Put `api-dev.agentdisk.io` behind Cloudflare Access, or drop it from
   `llms.txt` (F13).
8. CAA records: `0 issue "letsencrypt.org"`, `0 issue "pki.goog"`,
   `0 issue "ssl.com"`, `0 issue "sectigo.com"`, and
   `0 iodef "mailto:connect@agentdisk.io"` (F15). Once any CAA record exists
   Cloudflare adds the CAs Universal SSL needs; confirm the list in the DNS
   tab afterwards.
9. Point DMARC `rua` at Cloudflare DMARC Management (F18).
10. Publish `api.agentdisk.io/openapi.json` and link it from `llms.txt` (F19).
11. Add `preload` to HSTS in the Worker and submit at hstspreload.org (F12).
    This commits every subdomain to HTTPS permanently and is hard to undo.

SEO and agent improvements:

12. A real `favicon.ico`, apple-touch-icon and web manifest; a 1200×630 OG
    image with `summary_large_image` (F5).
13. JSON-LD `Organization` (Kernelv5, logo, `sameAs`) and `offers` with the
    free tier at price 0 (F6).
14. Split `/docs` into one page per topic (F6).
15. ~~Markdown for docs: `Accept: text/markdown` negotiation (F20).~~ Done
    4 Oct 2026; `/llms-full.txt` remains unbuilt.
16. OAuth metadata for MCP (`/.well-known/oauth-protected-resource` plus
    authorization-server metadata) so the Claude and ChatGPT connectors can
    use OAuth instead of pasted keys (F19, F20).
17. An MCP Server Card, and a listing in the official MCP Registry (F20).
18. Verify the site in Google Search Console and Bing Webmaster Tools, then
    submit the sitemap.
19. Optional: the edge rate limit on `POST /v1/workspaces` (F14).
20. Business decision: the AI Training policy is Disallow. Allowing it lets
    future models learn about AgentDisk; blocking it keeps the content out of
    training data.
21. After deploying, rescan Agent Readiness → Diagnostics. Baseline is
    2/5, 0/3, 0/8.

---

## Built on 3 October 2026

Four items from this page, built into the code that already existed rather
than the separate draft file, and verified first on `dev.agentdisk.io`:

- **robots.txt** (`renderRobotsFile` in `scripts/security-headers.js`). Prod
  now carries `Content-Signal: search=yes, ai-input=yes, ai-train=no`, one
  group refusing training crawlers (GPTBot, ClaudeBot, Google-Extended,
  Applebot-Extended, CCBot, Bytespider, meta-externalagent), and a `Sitemap:`
  line. Assistants and AI search crawlers are deliberately not in that group.
  This is what makes the zone's "Training: disallow" setting reach crawlers.
- **sitemap.xml**, written at build from `PRERENDERED_ROUTES` in
  `src/lib/seo.js`, the same list the prerender renders, so a page whose
  canonical points at `/` can never be listed.
- **Real 404s** for any missing file on the site host: a path with an
  extension, or under `/assets/` or `/.well-known/`. The Worker spots the SPA
  fallback (HTML answering a non-HTML path) and replaces it with a plain 404
  that keeps the security headers. The app host is untouched, because a deep
  link there may end in a file name.
- **A Link header on `/`** naming `/llms.txt` (describedby) and `/docs`
  (service-doc).

The deploy smoke test asserts all four on the site host.



```bash
curl -sI https://agentdisk.io/                       # HSTS, CSP, Permissions-Policy, COOP
curl -s -o /dev/null -w "%{http_code}" https://agentdisk.io/sitemap.xml   # 200 with XML once section 3 lands
curl -s -o /dev/null -w "%{http_code}" https://agentdisk.io/nope.json     # 404 once section 3 lands
dig +dnssec agentdisk.io                             # the ad flag, or use dnsviz.net
```

Email: run the domain through mxtoolbox.com for SPF, DMARC and DKIM. Agent
readiness: Cloudflare → agentdisk.io → Agent Readiness → Diagnostics →
Rescan. Remember the VPN caveats in [4 Infrastructure](4%20Infrastructure.md)
when any of these disagree with the pipeline.
