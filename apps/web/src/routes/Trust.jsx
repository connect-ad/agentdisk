import React from 'react';
import { Link } from 'react-router-dom';
import {
  SitePage, H2, H3, P, List, Table, Note, Faq, LinkCards, slug
} from '../components-local/Prose.jsx';

/**
 * The trust pages: /security, /privacy, /terms, /trust, /sub-processors and /dpa.
 *
 * Moved out of the docs on 4 Oct 2026, where they were four sections behind
 * hash anchors (#data-security, #safety, #privacy, #terms). The text of
 * those sections is carried over as it was; the edits are the links that
 * pointed at neighbouring docs sections, which now point at real addresses,
 * and the test count in "How we know it works", which is 1,014 today.
 *
 * What was added, on /security, is the certifications of the providers this
 * runs on, how the practice maps to the SOC 2 criteria, and an FAQ. The rule
 * for all of it is the docs' rule: nothing that is not true of the running
 * system. AgentDisk holds no certification of its own and says so; the
 * Cloudflare protections listed are the ones this zone actually has (Skill 12
 * records Bot Fight Mode off and a Free-plan zone with one rate-limit rule),
 * and the paid products it does not have are named as absent rather than
 * left out.
 *
 * /dpa joined them on 4 Oct 2026, once the owner settled the governing law
 * (Delaware) and chose a published click-through DPA over one signed per
 * customer. Privacy names the transfer mechanism it brings in.
 */

const TRUST_CRUMB = { to: '/trust', label: 'Trust Center' };

/** The other trust pages, as cards at the foot of each one. */
const TRUST_PAGES = [
  { to: '/security', kicker: 'SECURITY', title: 'Security',
    body: 'Encryption, tenant isolation, credentials, the platform, how it is tested, and the certifications of the providers it runs on.' },
  { to: '/privacy', kicker: 'PRIVACY', title: 'Privacy Policy',
    body: 'What we collect, what we never see, the processors, retention, cookies and your rights.' },
  { to: '/terms', kicker: 'TERMS', title: 'Terms of Service',
    body: 'Acceptable use, agent API use, limits, billing, deletion, liability: all seventeen sections.' },
  { to: '/sub-processors', kicker: 'SUB-PROCESSORS', title: 'Sub-processors',
    body: 'Every third party that processes data for AgentDisk, what it processes and where.' },
  { to: '/dpa', kicker: 'DPA', title: 'Data Processing Agreement',
    body: 'Our commitments as your processor under the GDPR, with the Standard Contractual Clauses for transfers.' },
];

function MoreTrust({ except }) {
  return (
    <section className="doc__section" aria-labelledby="more-trust">
      <H2 id="more-trust">More in the Trust Center</H2>
      <LinkCards label="Trust pages" items={TRUST_PAGES.filter(p => p.to !== except)} />
    </section>
  );
}

/* ═════════════════════════════ SECURITY ═════════════════════════════ */

const SECURITY_FAQ = [
  { q: 'How does AgentDisk encrypt data?',
    a: 'In transit, every connection uses TLS (minimum TLS 1.2, with TLS 1.3 enabled) and the site sends HSTS. At rest, file bytes and the database are encrypted by Cloudflare with AES-256, managed by the provider; this is not end-to-end encryption. API keys are stored as a SHA-256 hash for lookup and as AES-256-GCM ciphertext so the owner can reveal them again.' },
  { q: 'Is AgentDisk SOC 2 compliant?',
    a: 'AgentDisk runs on infrastructure from providers that hold SOC 2 Type II reports: Cloudflare, Google (Firebase) and Stripe. Our own practices align with the SOC 2 Trust Service Criteria, but AgentDisk does not hold its own SOC 2 report or any other certification.' },
  { q: 'How does AgentDisk isolate tenant data?',
    a: 'The authorization chain binds the workspace from the credential before any handler runs, and hands the handler storage and database objects already bound to that workspace. Cross-tenant access is prevented at that layer, and REST and MCP share the one chain. Tests seed two workspaces and prove every route answers the other tenant\'s IDs with 404.' },
  { q: 'Does AgentDisk support GDPR?',
    a: 'The Privacy Policy sets out what we collect, the processors, retention and your rights, and deletion and download are self-service in the product. Our Data Processing Agreement is published at /dpa, applies automatically as part of the Terms, and incorporates the EU Standard Contractual Clauses for international transfers.' },
  { q: 'Where is AgentDisk data stored?',
    a: 'File bytes are in Cloudflare R2 object storage and metadata, keys and the audit log are in Cloudflare\'s edge database, both on Cloudflare\'s global network. There is no region to choose.' },
  { q: 'How are API keys secured?',
    a: 'Keys are 32 random base62 characters, stored as a SHA-256 hash for authentication and as AES-256-GCM ciphertext for reveal, never in plain text. Each key is scoped to operations and a path prefix, belongs to one agent, and can be disabled at once; re-enabling issues a new secret.' },
  { q: 'Does AgentDisk have DDoS protection?',
    a: 'Yes. All traffic passes through Cloudflare\'s network, which mitigates DDoS attacks at layers 3, 4 and 7 automatically. Sandbox creation, the one unauthenticated write, is additionally rate-limited per IP.' },
  { q: 'Can AI agents access other tenants\' data?',
    a: 'No. A key\'s workspace comes from the key itself, never from the request, and is bound before the handler runs. Every authentication failure returns one identical body, and a file outside a key\'s reach answers 404, so the API does not confirm what exists elsewhere.' },
  { q: 'What security certifications does the infrastructure hold?',
    a: 'Cloudflare: SOC 2 Type II, ISO 27001, ISO 27701 and PCI DSS Level 1. Firebase / Google Cloud: SOC 1, SOC 2 and SOC 3, ISO 27001, ISO 27017 and ISO 27018. Stripe: PCI DSS Level 1, SOC 2 Type II and ISO 27001. These are the providers\' certifications, not AgentDisk\'s.' },
  { q: 'How do I report a vulnerability?',
    a: 'Email connect@agentdisk.io with Security in the subject, or use the Support form in the dashboard. Please do not open a public issue.' },
];

const SECURITY_TOC = [
  { id: 'data-security', label: 'Data security' },
  { id: 'safety', label: 'Safety' },
  { id: 'certifications', label: 'Infrastructure certifications' },
  { id: 'soc2', label: 'SOC 2 criteria alignment' },
  { id: 'faq', label: 'FAQ' },
];

export function Security() {
  return (
    <SitePage
      crumbs={[TRUST_CRUMB, { label: 'Security' }]}
      kicker="TRUST"
      title="Security"
      meta="Last reviewed: October 2026"
      lead="How AgentDisk keeps your agents' files: where the data lives, how one tenant is kept from another, how credentials are held, how the platform is protected and tested, and what we do not claim."
      toc={SECURITY_TOC}
    >
      <section id="data-security" className="doc__section">
        <H2 id="data-security-heading">Data security</H2>
        <P>
          How your data is kept while it is with us. The short version: one workspace's bytes
          and rows are reachable only through objects that were bound to that workspace before
          any handler ran, every credential is hashed or sealed, and every URL that touches a
          byte is short-lived and scoped to one object.
        </P>

        <H3 id={slug('Where your data lives')}>Where your data lives</H3>
        <Table
          head={['Data', 'Where', 'Notes']}
          rows={[
            ['File bytes', 'Block-based object storage', 'One object per file, under a per-workspace prefix built from server IDs. Your path is metadata and never part of the object key.'],
            ['Metadata, keys, memberships, audit', 'Edge database', 'Keys are stored as a SHA-256 hash for authentication and as AES-256-GCM ciphertext for reveal.'],
            ['Rate-limit counters, key cache', 'Edge cache', 'Short-lived, no file content.'],
            ['Webhook deliveries', 'Delivery queue', 'Payloads carry ids, paths and sizes only.'],
            ['Identity', 'Managed sign-in provider', 'Passwords, OAuth and session tokens. We receive the verified identifier and email, never a password.'],
            ['Billing', 'Payment processor', 'Card, invoices, subscription. We store the customer and subscription ids and a mirror of the period.'],
          ]}
        />

        <H3 id={slug('Tenant isolation')}>Tenant isolation</H3>
        <P>
          A route handler never receives a raw database or a raw bucket. The authorization
          chain binds the workspace from the credential, never from anything the client sent,
          and hands the handler repositories and a storage object whose constructor already
          holds that workspace. Every storage method takes a file ID and derives the object key
          itself; no method accepts a workspace ID or a raw key, so there is no argument
          through which a handler could name another tenant's object, even by mistake. The
          one cross-workspace operation in the product, the sandbox merge, takes two
          already-bound storage objects and no workspace ID, so a caller can only cross a
          boundary it has legitimately opened both sides of. The isolation tests seed two
          workspaces and prove that every route answers the other tenant's IDs with 404.
        </P>

        <H3 id={slug('Encryption')}>Encryption</H3>
        <List items={[
          <><strong>In transit.</strong> TLS everywhere: browser to dashboard, client to API, presigned upload and download to storage. The dashboard sends HSTS for a year with subdomains included.</>,
          <><strong>At rest.</strong> Object storage and the database are encrypted at rest by our infrastructure provider. This is provider-managed encryption, not end-to-end: our own service can read your files when a request authorizes it to, which is what serving them requires.</>,
          <><strong>Secrets at rest.</strong> API keys are sealed with AES-256-GCM under a key that exists only as a runtime secret, never in infrastructure state or build output, and each ciphertext is bound to its own row so a copied ciphertext opens as nothing. Share-link passwords are PBKDF2 hashes. Claim tokens and API keys are looked up by SHA-256.</>,
        ]} />

        <H3 id={slug('Credentials')}>Credentials</H3>
        <List items={[
          <>Keys are 32 base62 characters of CSPRNG output, about 190 bits, read from the Authorization header and nowhere else. A key in a query string is rejected with a message telling you to rotate it.</>,
          <>Every authentication failure returns one identical body, so the API is never an oracle telling somebody which of their guesses is a real key that merely expired.</>,
          <>Scopes fail closed: an unparseable or unrecognised scope grants nothing.</>,
          <>Human sessions are signed identity tokens verified in our service against the sign-in provider's public keys. A deleted or disabled account is refused from our own record before the provider's, so a token that is still technically valid cannot outlive the account.</>,
          <>An API key can never act as a person: it cannot close the account, delete a workspace, reveal another key, invite a member or end browser sessions.</>,
        ]} />

        <H3 id={slug('Upload and download integrity')}>Upload and download integrity</H3>
        <List items={[
          <>Presigned upload URLs last 15 minutes and are scoped to exactly one object and one HTTP method. Download URLs last one hour. Nothing this product issues may exceed seven days.</>,
          <>The size booked against your quota comes from storage, never from your declaration. A client that declares 1 KB and uploads 1 GB has its bytes deleted, not its quota mis-booked.</>,
          <>A SHA-256 declared with an inline upload is verified by storage on write. On the presigned path it is recorded, not verified.</>,
          <>Presigned URLs are never logged in full: only that one was issued, to whom, and when.</>,
        ]} />

        <H3 id={slug('What we log')}>What we log</H3>
        <P>
          Structured request logs: endpoint, method, status, latency, request ID and the
          identity that called. Never request or response bodies that hold file content or
          secrets. Infrastructure logs are kept around 90 days; your workspace's Activity log is
          kept for the life of the workspace.
        </P>
      </section>

      <section id="safety" className="doc__section">
        <H2 id="safety-heading">Safety</H2>
        <P>
          How the infrastructure itself is protected. This section describes what is built and
          deployed, and closes with what we do not claim.
        </P>

        <H3 id={slug('The platform')}>The platform</H3>
        <List items={[
          <><strong>Serverless at the edge.</strong> No servers, no SSH, no patching window. The API with its MCP server, the dashboard and the admin console are three edge services; the data is in block-based object storage, an edge database, a cache and a queue in the same account.</>,
          <><strong>Custom domains only.</strong> The provider's default public hostname is switched off for every service, so there is no second entry point that bypasses the named domains.</>,
          <><strong>Infrastructure as code.</strong> Everything is declared, one configuration per environment, with a guard that refuses to run in any other. Only one pipeline may apply changes; the others read outputs and cannot write.</>,
          <><strong>Resource IDs are never typed by hand.</strong> The deploy injects them from the infrastructure outputs and asserts every name against the environment before deploying, so a stale selection fails loudly instead of applying one environment's intent to another's resources.</>,
          <><strong>Secrets that decrypt data never enter infrastructure state or build artifacts.</strong> The database encryption key and the session signing key live only as runtime secrets.</>,
        ]} />

        <H3 id={slug('The request path')}>The request path</H3>
        <List items={[
          <><strong>One authorization chain</strong> for REST and MCP: authenticate, resolve scope, bind the workspace from the credential, authorize the operation and the path, check quota and billing, then run the handler with only workspace-bound access. A handler cannot write an unscoped query because it never holds anything that could run one.</>,
          <><strong>Identical failures.</strong> Every authentication failure returns one body, and so does every refusal on a public share link other than the password prompt itself. Reasons go to the log.</>,
          <><strong>Prefixes match whole segments</strong>, listings are clipped to the prefix, and a file outside it answers 404 rather than confirming it exists.</>,
          <><strong>Moves and copies check both ends</strong>, so write on a source never buys write on a destination.</>,
          <><strong>Sizes come from storage</strong>, and a lie about size costs the bytes, not the quota.</>,
        ]} />

        <H3 id={slug('The edges')}>The edges</H3>
        <List items={[
          <><strong>The dashboard</strong> ships a Content-Security-Policy that names only the API it was built against, the sign-in provider, the bot check, the font host and the upload host; plus HSTS, <code>X-Frame-Options: DENY</code>, <code>nosniff</code> and a strict referrer policy. A CORS allow-list names the dashboard and console origins and nothing else.</>,
          <><strong>The one unauthenticated write</strong>, sandbox creation, sits behind two per-IP limits: ten creations an hour, and five unclaimed sandboxes held at once. A browser's bot check is still verified server-side when one is sent, but an agent needs none, because what makes a flood of sandboxes harmless is what a sandbox cannot do: it has no share links, holds 500 MB, and is deleted after three days unless a person claims it.</>,
          <><strong>Share-link passwords</strong> are limited to ten wrong guesses per fifteen minutes per link, and share tokens are 32 random characters looked up by hash.</>,
          <><strong>Webhook deliveries</strong> are signed with a timestamp inside the signed material and a five-minute replay window.</>,
        ]} />

        <H3 id={slug('The operators')}>The operators</H3>
        <List items={[
          <><strong>A separate console on a separate origin.</strong> Support engineers use an internal admin console with its own hostname and its own look, so an operator always knows which surface they are in.</>,
          <><strong>Being an operator is a row in a table</strong>, read fresh on every request, never a claim baked into a token. Removing the row takes effect immediately.</>,
          <><strong>Every operator action is audited</strong>, including refusals, by a base class no admin area can bypass. Deleting a customer's workspace or account from the console is a two-step act: suspend first, which is instant and reversible, then delete, which sets a 30-day timestamp and stops; the actual removal is a separate job that defaults to reporting rather than deleting.</>,
          <><strong>Operators never see card numbers</strong>, and the console renders nothing it cannot source.</>,
        ]} />

        <H3 id={slug('How we know it works')}>How we know it works</H3>
        <List items={[
          <>The API has 1,014 automated tests, including repository and route tests that seed two workspaces and prove each answers the other's IDs with nothing, and a sweep across every authenticated route that proves a missing credential is answered like an invalid one.</>,
          <>Every security-critical behaviour in the storage core was mutation-tested: 22 deliberate breaks, each confirmed to turn the suite red.</>,
          <>Branch protection requires the application and infrastructure checks to pass before anything merges; the deployment pipeline ends with a smoke test against the live hostnames that fails the run if a security header goes missing.</>,
          <>Destructive background jobs, the sandbox sweep, the admin purge and the billing ladder, each default to reporting and need an explicit flag per environment to delete anything.</>,
        ]} />

        <H3 id={slug('What we do not claim')}>What we do not claim</H3>
        <List items={[
          <>Not end-to-end encrypted. Our service can read your files when a request authorizes it; encryption at rest is the infrastructure provider's.</>,
          <>No compliance certification is claimed.</>,
          <>Log out everywhere invalidates every issued session token but cannot revoke the sign-in provider's underlying refresh token; a stolen device should also change its password.</>,
          <>No per-key rate limit on the authenticated surface yet. Quotas are the throttle there; the rate limits that exist guard sandbox creation and share-link passwords, and are coarse and eventually consistent.</>,
        ]} />

        <H3 id={slug('Reporting a vulnerability')}>Reporting a vulnerability</H3>
        <P>
          Email <code>connect@agentdisk.io</code> with "Security" in the subject, or use the
          Support form in the dashboard. Please do not open a public issue. If you have pasted
          a key somewhere it should not be, disable it under API keys first; re-enabling
          issues a new secret.
        </P>
      </section>

      <section id="certifications" className="doc__section">
        <H2 id="certifications-heading">Infrastructure certifications</H2>
        <P>
          AgentDisk runs on three providers, and each holds its own certifications. They cover
          the provider's infrastructure and operations; they are not certifications of
          AgentDisk, which holds none of its own.
        </P>

        <H3 id="cloudflare">Cloudflare (compute, storage, network)</H3>
        <List items={[
          'SOC 2 Type II',
          'ISO 27001',
          'ISO 27701',
          'PCI DSS Level 1',
        ]} />
        <P>Protections this deployment inherits from Cloudflare's network:</P>
        <List items={[
          <><strong>DDoS mitigation</strong> at layers 3, 4 and 7, automatic and always on.</>,
          <><strong>TLS 1.3</strong> enabled, TLS 1.2 the minimum, and HTTPS enforced.</>,
          <><strong>Isolated execution.</strong> The API, the MCP server and the dashboard run as Workers in V8 isolates, separated from other code on the platform.</>,
          <><strong>A rate-limiting rule</strong> in front of sandbox creation, the one unauthenticated write.</>,
        ]} />
        <Note tone="warn" label="Not enabled">
          Cloudflare's managed WAF rulesets, bot management and AI firewall products are paid
          features that are not switched on for this zone, and we do not claim their
          protection.
        </Note>

        <H3 id="firebase">Firebase / Google Cloud (authentication)</H3>
        <List items={[
          'SOC 1, SOC 2 and SOC 3',
          'ISO 27001, ISO 27017 and ISO 27018',
          'Audited by Ernst & Young LLP and Coalfire',
          <>Passwords are hashed by Firebase with scrypt and never reach AgentDisk. AgentDisk does not currently offer multi-factor sign-in.</>,
        ]} />

        <H3 id="stripe">Stripe (payments)</H3>
        <List items={[
          'PCI DSS Level 1',
          'SOC 2 Type II and ISO 27001',
          'Payment card data never touches AgentDisk servers: checkout and the billing portal are Stripe\'s pages.',
        ]} />
        <P>
          The full list of third parties, with what each processes, is on{' '}
          <Link to="/sub-processors">Sub-processors</Link>.
        </P>
      </section>

      <section id="soc2" className="doc__section">
        <H2 id="soc2-heading">SOC 2 Trust Service Criteria alignment</H2>
        <P>
          AgentDisk does not hold its own SOC 2 certification. However, our security practices
          align with the SOC 2 Trust Service Criteria. This is our description of what is
          built, not an auditor's opinion.
        </P>
        <Table
          head={['Criterion', 'Our practice']}
          rows={[
            ['Security', 'Cloudflare DDoS mitigation, API keys scoped to operations and a path prefix, sign-in through Firebase Authentication, one authorization chain for REST and MCP, Workers in V8 isolates.'],
            ['Availability', 'Serverless on Cloudflare\'s global network: no servers to patch or fail over, and capacity that scales with requests.'],
            ['Processing integrity', '1,014 automated API tests, mutation testing of the storage core, a post-deploy smoke test that fails on a missing security header, sizes read from storage rather than declared, SHA-256 verified on inline upload.'],
            ['Confidentiality', 'Workspace isolation bound before any handler runs, encryption at rest by the provider, AES-256-GCM sealed keys, per-agent scoped credentials, presigned URLs for one object that expire in 15 minutes (upload) or one hour (download).'],
            ['Privacy', 'No AI processor touches customer files and no customer data is used for training; analytics only with consent; file bytes removed within seven days of a workspace or account deletion.'],
          ]}
        />
      </section>

      <Faq items={SECURITY_FAQ} />
      <MoreTrust except="/security" />
    </SitePage>
  );
}

/* ═════════════════════════════ PRIVACY ═════════════════════════════ */

const PRIVACY_TOC = ['What we collect', 'What we never see', 'Processors', 'Retention', 'Cookies',
  'International transfers', 'Children', 'Your rights', 'Changes and contact']
  .map(label => ({ id: slug(label), label }));

export function Privacy() {
  return (
    <SitePage
      crumbs={[TRUST_CRUMB, { label: 'Privacy Policy' }]}
      kicker="TRUST"
      title="Privacy Policy"
      meta="Last updated: 4 October 2026"
      toc={PRIVACY_TOC}
    >
      <section id="privacy" className="doc__section">
        <P>
          This is AgentDisk's privacy policy. AgentDisk is provided by Kernelv5 Inc.
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;), and this policy explains how we collect, use and share information when you
          use the website, the dashboard, the API and the MCP server. It applies to human
          account holders and to information generated by AI agents acting under an account
          holder's authorisation. Files an agent creates are treated exactly as files a
          person uploads; nothing here differs by who acted.
        </P>

        <H3 id={slug('What we collect')}>What we collect</H3>
        <List items={[
          <><strong>Account information:</strong> the identifier our sign-in provider issues for you, your email address, and which sign-in method you used.</>,
          <><strong>Your content:</strong> the files you and your agents store, with the metadata you attach.</>,
          <><strong>Request logs:</strong> endpoint, method, status, latency, request ID and the calling identity, for security, quota enforcement and debugging. IP addresses, for rate limiting and abuse prevention, on the same schedule.</>,
          <><strong>Support requests:</strong> what you send through the Support form, from the address you signed in with.</>,
          <><strong>Usage analytics, only if you allow them:</strong> which pages of this site are visited, through Google Analytics. Workspace names, file paths and link tokens are removed from the address before it is sent. Nothing about your files, and nothing from the API or MCP.</>,
        ]} />

        <H3 id={slug('What we never see')}>What we never see</H3>
        <List items={[
          <><strong>Your password.</strong> Sign-up, reset and change all go to the sign-in provider. This backend never receives, hashes or stores one, and the password policy is enforced there.</>,
          <><strong>Your card number.</strong> Checkout and the portal are the payment processor's pages. We hold its customer and subscription identifiers and nothing about the card.</>,
          <><strong>Your file contents, in the ordinary course.</strong> We compute a checksum, sign a URL and measure a size. We do not open, view or process contents except to investigate abuse, a security incident or a valid legal request, and we do not claim the architecture makes that impossible, because it does not.</>,
          <><strong>Advertising data.</strong> Google Analytics runs with ad storage, ad personalisation and Google signals switched off, and there are no marketing cookies.</>,
        ]} />

        <H3 id={slug('Processors')}>Processors</H3>
        <Table
          head={['Processor', 'For']}
          rows={[
            ['Cloudflare, Inc.', 'Compute, object storage, database, cache, queues, bot verification, and outbound email'],
            ['Google LLC (Firebase Authentication)', 'Sign-in and session tokens'],
            ['Google LLC (Google Analytics)', 'Page-visit analytics on this site, only with your consent'],
            ['Stripe, Inc.', 'Payments, invoices, the customer portal'],
          ]}
        />
        <P>
          No AI processor touches your files. Optional per-workspace AI features are not
          enabled in this release, and the policy will name the processor before that changes,
          because it is the one case where content would leave the storage boundary.
        </P>

        <H3 id={slug('Retention')}>Retention</H3>
        <List items={[
          <>Account and file data: while the account and workspace exist.</>,
          <>A deleted file: gone in the request.</>,
          <>A deleted workspace or account: records gone in the request, bytes within seven days, the email address and sign-in released on day seven with one confirmation message.</>,
          <>Request logs: around 90 days. Your workspace's Activity log: the life of the workspace.</>,
          <>Invoices: seven years, at the payment processor.</>,
          <>We may hold data longer where an active dispute or a legal obligation demands it.</>,
        ]} />

        <H3 id={slug('Cookies')}>Cookies</H3>
        <P>
          Session and security storage is strictly necessary and always on. Google
          Analytics is optional: it loads only after you allow it in the cookie notice,
          sets Google's <code>_ga</code> cookies, and switching it off removes them. There
          are no marketing cookies. Your theme choice is kept in your browser and never
          sent to us.
        </P>

        <H3 id={slug('International transfers')}>International transfers</H3>
        <P>
          Our infrastructure, sign-in and analytics providers operate global networks, so your
          data may be processed outside your home country; Google Analytics data, when you allow
          it, is processed by Google in the United States. Kernelv5 Inc. is established in the
          United States. For files and metadata you store with us, transfers from the EU, the UK and
          Switzerland are covered by the Standard Contractual Clauses in our{' '}
          <Link to="/dpa">Data Processing Agreement</Link>.
        </P>

        <H3 id={slug('Children')}>Children</H3>
        <P>
          The service is not directed to anyone under 16, and we do not knowingly collect
          their information. If we learn that we have, we delete it.
        </P>

        <H3 id={slug('Your rights')}>Your rights</H3>
        <P>
          Depending on where you live you may have rights to access, correct, delete, export
          or object to the processing of your data. Deleting your data and downloading your files
          are in your own hands in the product, see <Link to="/docs/deleting-data">Deleting your data</Link> and{' '}
          <Link to="/docs/deleting-account">Deleting your account</Link>. For anything else, contact
          us.
        </P>

        <H3 id={slug('Changes and contact')}>Changes and contact</H3>
        <P>
          Material changes are posted here with an updated date, and account owners are
          notified by email for significant ones. Questions about this policy go to{' '}
          <code>connect@agentdisk.io</code> or the Support form in the dashboard.
        </P>
        <Note label="See also">
          How this data is protected is on <Link to="/security">Security</Link>; every third
          party that processes it is on <Link to="/sub-processors">Sub-processors</Link>.
        </Note>
      </section>
      <MoreTrust except="/privacy" />
    </SitePage>
  );
}

/* ═════════════════════════════ TERMS ═════════════════════════════ */

const TERMS_TOC = ['Acceptance', 'Acceptable use', 'Your responsibility for content', 'Prohibited content',
  'API and automated agent use', 'Limits and fair use', 'Storage limits', 'Account suspension',
  'Your right to delete', 'Billing', 'Intellectual property', 'Third-party services', 'Warranties',
  'Limitation of liability', 'Termination', 'Changes to these Terms', 'Governing law']
  .map((label, i) => ({ id: slug(label), label: `${i + 1}. ${label}` }));

export function Terms() {
  return (
    <SitePage
      crumbs={[TRUST_CRUMB, { label: 'Terms of Service' }]}
      kicker="TRUST"
      title="Terms of Service"
      meta="Last updated: 4 October 2026"
      toc={TERMS_TOC}
    >
      <section id="terms" className="doc__section">
        <P>
          These are the terms under which Kernelv5 Inc. (&ldquo;we&rdquo;, &ldquo;us&rdquo;) provides
          AgentDisk (the &ldquo;Service&rdquo;). They apply to you and to
          any agent acting under credentials you control. The <Link to="/privacy">Privacy
          Policy</Link> and the <Link to="/dpa">Data Processing Agreement</Link> are part of them.
        </P>

        <H3 id={slug('Acceptance')}>1. Acceptance</H3>
        <P>
          By creating an account or using the Service, including through an API key, a
          sandbox workspace or an MCP connection, you agree to these Terms.
        </P>

        <H3 id={slug('Acceptable use')}>2. Acceptable use</H3>
        <P>
          You may not use the Service to store, transmit or process content that is illegal
          in your jurisdiction; malware or anything designed to attack systems, including
          ours; content that infringes another party's intellectual property; content
          involving the sexual exploitation of minors, which we report to the appropriate
          authorities without exception; or content intended to harass, threaten or
          facilitate violence against real people.
        </P>

        <H3 id={slug('Your responsibility for content')}>3. Your responsibility for content</H3>
        <P>
          You, and any agent acting under your account, are solely responsible for the files
          and data you store. We do not pre-screen content, but may review, remove or
          restrict access to content that violates these Terms or the law, and may suspend
          accounts for repeated or severe violations.
        </P>

        <H3 id={slug('Prohibited content')}>4. Prohibited content</H3>
        <P>
          You may not upload content you do not have the right to store or share. You may
          not use the Service as a public content-distribution network: share links exist
          so a person can hand a file to another person, not to serve the public. You may
          not circumvent storage limits or the sandbox allowance through automated account
          or workspace creation.
        </P>

        <H3 id={slug('API and automated agent use')}>5. API and automated agent use</H3>
        <P>
          The API and the MCP server are meant to be used by AI agents and automated systems
          acting on your behalf under credentials you control. <strong>You are responsible for
          what your agents do with your API keys, exactly as you would be for your own
          actions.</strong> Scope keys to what an agent needs. Do not share keys across
          unrelated parties or resell access without our written agreement.
        </P>

        <H3 id={slug('Limits and fair use')}>6. Limits and fair use</H3>
        <P>
          We enforce the quotas of your plan, and rate limits where they apply, to keep the
          Service reliable for everyone. We may throttle or temporarily suspend access we
          reasonably believe is abusive, is degrading reliability for others, or is
          circumventing those limits.
        </P>

        <H3 id={slug('Storage limits')}>7. Storage limits</H3>
        <P>
          Your plan defines storage, file count, egress and per-file limits, see{' '}
          <Link to="/pricing">Pricing</Link> and the <Link to="/docs/features">plan table</Link>.
          Responses warn you as an account approaches its storage allowance; a write that
          would exceed a limit is refused until you upgrade, free space or, for egress, the
          workspace's period resets.
        </P>

        <H3 id={slug('Account suspension')}>8. Account suspension</H3>
        <P>
          We may suspend or terminate accounts that violate these Terms, pose a security risk,
          or where required by law. Suspension comes first and is reversible; where practical
          we will give notice and an opportunity to download your data before anything is
          deleted, except where immediate action is required.
        </P>

        <H3 id={slug('Your right to delete')}>9. Your right to delete</H3>
        <P>
          You may delete your files, workspaces or account at any time, from the dashboard or
          the API. Deletion is permanent, with no recovery, as described under{' '}
          <Link to="/docs/deleting-data">Deleting your data</Link> and{' '}
          <Link to="/docs/deleting-account">Deleting your account</Link>.
        </P>

        <H3 id={slug('Billing')}>10. Billing</H3>
        <P>
          Paid plans are billed in advance, monthly or yearly, and renew automatically until
          you cancel. Cancelling stops renewal at the end of the paid period and you keep the
          plan until then. Fees are non-refundable except as required by law or as we state at
          the time of purchase. An upgrade takes effect immediately and is prorated; a
          downgrade takes effect at the end of the paid period, and if your usage is then over
          the new plan's limits, new writes are refused until it is back within them. If a
          payment fails, writes are blocked while the account is past due, reads continue, and
          you are notified by email before any data is scheduled for removal. Payments are
          taken by Stripe and appear on your card statement as Kernelv5 Inc., the company
          that provides AgentDisk.
        </P>

        <H3 id={slug('Intellectual property')}>11. Intellectual property</H3>
        <P>
          You keep all rights to the content you store. You grant us only the limited rights
          needed to store, process, transmit and display that content back to you and the
          people and agents you authorise. We keep all rights to the Service itself.
        </P>

        <H3 id={slug('Third-party services')}>12. Third-party services</H3>
        <P>
          The Service relies on the third-party infrastructure, sign-in, payment and analytics
          providers named in the Privacy Policy. No third-party AI processor handles your files today;
          if an optional feature ever sends content to one, the Privacy Policy will name it
          before that happens. We are not responsible for the availability or acts of services
          outside our control, though we select and monitor them as part of running the
          Service responsibly.
        </P>

        <H3 id={slug('Warranties')}>13. Warranties</H3>
        <P>
          The Service is provided "as is" without warranties of any kind, express or implied,
          including merchantability, fitness for a particular purpose and non-infringement,
          except as expressly stated here or required by law.
        </P>

        <H3 id={slug('Limitation of liability')}>14. Limitation of liability</H3>
        <P>
          To the maximum extent permitted by law, we are not liable for indirect, incidental,
          special or consequential damages, or for lost data, profits or revenue, arising from
          your use of the Service.
        </P>

        <H3 id={slug('Termination')}>15. Termination</H3>
        <P>
          You may stop using the Service and delete your account at any time. We may terminate
          or suspend access for breach of these Terms. Sections 11, 13 and 14 survive
          termination.
        </P>

        <H3 id={slug('Changes to these Terms')}>16. Changes to these Terms</H3>
        <P>
          We may update these Terms. For material changes we will notify account owners by
          email before the change takes effect, and the date above will move.
        </P>

        <H3 id={slug('Governing law')}>17. Governing law</H3>
        <P>
          These Terms are governed by the laws of the State of Delaware, USA, without regard to
          its conflict-of-laws rules. Any dispute arising from them or from the Service is
          subject to the jurisdiction of the state and federal courts located in Delaware,
          except where the law of your country gives you a right to bring it elsewhere.
        </P>
      </section>
      <MoreTrust except="/terms" />
    </SitePage>
  );
}

/* ═════════════════════════════ DPA ═════════════════════════════ */

/**
 * The data processing agreement, published 4 Oct 2026 at the owner's
 * instruction from the standard GDPR Article 28 structure, with the EU
 * Standard Contractual Clauses incorporated by reference for transfers.
 *
 * The rule is the rest of this file's: every commitment is something the
 * running system or the existing policies already do. Deletion timings are
 * the ones on /docs/deleting-data and depend on PENDING_DELETION_ENABLED being
 * "true" in the environment; breach notice is the statutory "without undue
 * delay", not an hour count nobody has drilled. Customer Data is the files,
 * their metadata and the Activity log; account, billing and analytics data are
 * Kernelv5's own as controller and stay under the Privacy Policy.
 */
const DPA_TOC = ['Scope', 'Roles', 'Instructions', 'Confidentiality', 'Security', 'Sub-processors',
  'International transfers', 'Data subject requests', 'Personal data breaches', 'Deletion and return',
  'Audits and information', 'Liability and precedence', 'Governing law', 'Annex: details of processing']
  .map((label, i) => ({ id: slug(label), label: i < 13 ? `${i + 1}. ${label}` : label }));

export function Dpa() {
  return (
    <SitePage
      crumbs={[TRUST_CRUMB, { label: 'Data Processing Agreement' }]}
      kicker="TRUST"
      title="Data Processing Agreement"
      meta="Last updated: 4 October 2026"
      toc={DPA_TOC}
    >
      <section id="dpa" className="doc__section">
        <P>
          This Data Processing Agreement (the &ldquo;DPA&rdquo;) is between Kernelv5 Inc., a Delaware
          corporation that provides AgentDisk (&ldquo;we&rdquo;, &ldquo;us&rdquo;), and the account holder
          (&ldquo;you&rdquo;). It forms part of the <Link to="/terms">Terms of Service</Link> and needs no
          signature: it applies automatically whenever we process personal data on your behalf that
          is protected by the GDPR, the UK GDPR or the Swiss Federal Act on Data Protection. If your
          organisation needs a countersigned copy, write to <code>connect@agentdisk.io</code>.
        </P>

        <H3 id={slug('Scope')}>1. Scope</H3>
        <P>
          &ldquo;Customer Data&rdquo; means the files you and your agents store in AgentDisk, the
          metadata attached to them (paths, captions, tags and custom key-values) and your
          workspaces' Activity log. This DPA covers the personal data within Customer Data. Your
          account, billing and website-analytics information is ours to handle as a controller and
          is covered by the <Link to="/privacy">Privacy Policy</Link> instead. A sandbox workspace
          that nobody has claimed has no account holder; this DPA applies to it from the moment it
          is claimed.
        </P>

        <H3 id={slug('Roles')}>2. Roles</H3>
        <P>
          For Customer Data you are the controller, or a processor acting for your own customer,
          and we are your processor, or your sub-processor. You are responsible for having a
          lawful basis for the personal data you store and for what you tell the people it is
          about.
        </P>

        <H3 id={slug('Instructions')}>3. Instructions</H3>
        <P>
          We process Customer Data only to provide the Service, on your documented instructions.
          Your instructions are these Terms and this DPA, and every request you or your agents make
          through the dashboard, the API or the MCP server. We do not use Customer Data for our own
          purposes, do not sell it, and do not use it to train any AI model; no AI processor touches
          it. We will tell you if we believe an instruction breaks data protection law, and we may
          process Customer Data otherwise only where the law requires it, in which case we will tell
          you first unless the law forbids that.
        </P>

        <H3 id={slug('Confidentiality')}>4. Confidentiality</H3>
        <P>
          Only people who need access to run the Service may reach Customer Data, and each of them
          is bound to confidentiality. We do not open file contents in the ordinary course; we do so
          only to investigate abuse or a security incident, or to answer a valid legal request.
          Operator access goes through a separate admin console in which every action is audited.
        </P>

        <H3 id={slug('Security')}>5. Security</H3>
        <P>
          We maintain the technical and organisational measures described on the{' '}
          <Link to="/security">Security</Link> page, which forms Annex II of this DPA. In summary:
          TLS on every connection, encryption at rest by our infrastructure provider, tenant
          isolation bound from the credential before any handler runs, API keys scoped to operations
          and a path prefix, keys stored only as a hash and as authenticated ciphertext, short-lived
          single-object URLs for file transfer, and an audit log of agent and owner actions. We may
          improve these measures over time but will not reduce the overall level of protection.
        </P>

        <H3 id={slug('Sub-processors')}>6. Sub-processors</H3>
        <P>
          You authorise us to use the sub-processors listed on the{' '}
          <Link to="/sub-processors">Sub-processors</Link> page, which forms Annex III of this DPA.
          Each one is bound by a written agreement with data protection obligations no less
          protective than ours here, and we remain responsible to you for its performance. Before
          we add or replace a sub-processor that processes Customer Data, we update that page and
          email account owners at least 14 days in advance. You may object on reasonable data
          protection grounds by writing to us within that period; if we cannot resolve the
          objection, you may stop using the Service and delete your account, which you can do at
          any time without asking us.
        </P>

        <H3 id={slug('International transfers')}>7. International transfers</H3>
        <P>
          We are established in the United States, and Customer Data is stored on Cloudflare's
          global network, where no region can be chosen. Where Customer Data protected by the GDPR is
          transferred to a country without an adequacy decision, the Standard Contractual Clauses
          approved by European Commission Implementing Decision (EU) 2021/914 apply and are
          incorporated into this DPA by reference: Module Two where you are a controller and Module
          Three where you are a processor, with you as data exporter and us as data importer. For
          those Clauses, the optional Clause 7 does not apply; under Clause 9 option 2 applies with
          the notice period in section 6; the optional wording in Clause 11 does not apply; Clauses
          17 and 18 select the law and courts of Ireland; and the Annexes are completed by the
          Annex below, the Security page and the Sub-processors page.
        </P>
        <P>
          For Customer Data protected by the UK GDPR, the International Data Transfer Addendum
          issued by the UK Information Commissioner applies to those Clauses. For Customer Data
          protected by Swiss law, the same Clauses apply with references to the GDPR read as the
          Swiss Federal Act on Data Protection, the Swiss Federal Data Protection and Information
          Commissioner as the competent supervisory authority, and the term &ldquo;member
          state&rdquo; read so that data subjects in Switzerland can enforce their rights there.
        </P>

        <H3 id={slug('Data subject requests')}>8. Data subject requests</H3>
        <P>
          The Service lets you find, download and permanently delete Customer Data yourself, through
          the dashboard, the API or the MCP tools, which is how you answer requests for access,
          erasure and portability. If a person contacts us directly about Customer Data, we will pass
          the request to you and will not answer it ourselves unless you ask us to. Where you need
          more help, such as information for a data protection impact assessment, we will provide
          what we reasonably can.
        </P>

        <H3 id={slug('Personal data breaches')}>9. Personal data breaches</H3>
        <P>
          If we become aware of a personal data breach affecting Customer Data, we will notify the
          account owner's email address without undue delay. The notice will describe what happened,
          the data and people likely affected, the likely consequences and what we are doing about
          it, as far as that is known, and we will send more as we learn it. Notifying you is not an
          admission of fault.
        </P>

        <H3 id={slug('Deletion and return')}>10. Deletion and return</H3>
        <P>
          You can download your files at any time while your account exists, and delete them at any
          time. When you delete a file, its bytes and its record go in the same request. When you
          delete a workspace or your account, its records go in the request and the file bytes are
          removed from storage within seven days, as described in{' '}
          <Link to="/docs/deleting-data">Deleting your data</Link> and{' '}
          <Link to="/docs/deleting-account">Deleting your account</Link>. Deleted database records can
          remain in our infrastructure provider's point-in-time recovery for up to 30 days before they
          expire; we use that only to recover the Service from a failure. Request logs are kept for
          around 90 days. We keep nothing longer unless the law requires it.
        </P>

        <H3 id={slug('Audits and information')}>11. Audits and information</H3>
        <P>
          The Security and Sub-processors pages, and the certifications of our infrastructure
          providers, are the information we make available to show compliance with this DPA. We will
          also answer a reasonable written security questionnaire once a year. Where that is not
          enough to meet a requirement of data protection law or of a supervisory authority, you may
          have an audit carried out by an independent auditor bound to confidentiality, at your cost,
          on at least 30 days' written notice, no more than once in any twelve months, and in a way
          that does not disrupt the Service or expose other customers' data.
        </P>

        <H3 id={slug('Liability and precedence')}>12. Liability and precedence</H3>
        <P>
          Each party's liability under this DPA is subject to the limitation of liability in the
          Terms, except where data protection law or the Standard Contractual Clauses do not allow
          it to be limited. If this DPA conflicts with the Terms, this DPA prevails for Customer Data;
          if it conflicts with the Standard Contractual Clauses, the Clauses prevail. This DPA lasts
          as long as we process Customer Data for you.
        </P>

        <H3 id={slug('Governing law')}>13. Governing law</H3>
        <P>
          This DPA is governed by the laws of the State of Delaware, USA, as the Terms are, except
          that the Standard Contractual Clauses are governed by the law their Clause 17 selects. We
          may update this DPA as the law or the Service changes; a change that reduces your
          protection is announced to account owners by email before it takes effect, and the date
          above moves.
        </P>

        <H3 id={slug('Annex: details of processing')}>Annex: details of processing</H3>
        <Table
          head={['Item', 'Detail']}
          rows={[
            ['Subject matter', 'Storing and serving files for AI agents and the people who run them'],
            ['Duration', 'While your account exists, then until deletion completes as in section 10'],
            ['Nature and purpose', 'Storage, retrieval, listing and search by name, path, caption and tags, transfer, sharing by link, webhook notification and deletion, as you or your agents request'],
            ['Personal data', 'Whatever personal data you choose to store in files and their metadata; IP addresses and identities recorded in the Activity log'],
            ['Data subjects', 'Whoever the stored data is about, as you decide; the people and agents acting in your workspaces'],
            ['Special categories', 'Only if you choose to store them; the Service does not inspect content to detect them'],
            ['Frequency', 'Continuous, for as long as you use the Service'],
            ['Sub-processors', <><Link to="/sub-processors">Sub-processors</Link> page</>],
            ['Security measures', <><Link to="/security">Security</Link> page</>],
            ['Contact', <code>connect@agentdisk.io</code>],
          ]}
        />
      </section>
      <MoreTrust except="/dpa" />
    </SitePage>
  );
}

/* ═════════════════════════════ TRUST CENTER ═════════════════════════════ */

export function TrustCenter() {
  return (
    <SitePage
      kicker="TRUST CENTER"
      title="Trust Center"
      lead="How AgentDisk protects the files your agents store, what we do with your information, the terms the service runs under, and every third party involved. Each page describes the system that is running today, including what it does not do."
    >
      <LinkCards label="Trust pages" items={TRUST_PAGES} />

      <section className="doc__section" aria-labelledby="trust-dpa">
        <H2 id="trust-dpa">Data processing agreement</H2>
        <P>
          Our <Link to="/dpa">Data Processing Agreement</Link> sets out our commitments as your
          processor under the GDPR, the UK GDPR and Swiss law, and incorporates the Standard
          Contractual Clauses for international transfers. It is part of the Terms and applies
          automatically, with nothing to sign; if your organisation needs a countersigned copy,
          write to <code>connect@agentdisk.io</code>.
        </P>
      </section>

      <section className="doc__section" aria-labelledby="trust-deletion">
        <H2 id="trust-deletion">Deleting your data</H2>
        <P>
          Deletion is self-service and permanent. How each kind of object is deleted, and when
          the bytes go, is in the documentation: <Link to="/docs/deleting-data">Deleting your
          data</Link> and <Link to="/docs/deleting-account">Deleting your account</Link>.
        </P>
      </section>

      <section className="doc__section" aria-labelledby="trust-contact">
        <H2 id="trust-contact">Questions and vulnerability reports</H2>
        <P>
          Email <code>connect@agentdisk.io</code>, with "Security" in the subject for a
          vulnerability. AgentDisk is a product by Kernelv5 Inc.
        </P>
      </section>

      <p className="doc__meta">Last reviewed: October 2026</p>
    </SitePage>
  );
}

/* ═════════════════════════════ SUB-PROCESSORS ═════════════════════════════ */

/**
 * The same four processors the Privacy Policy names, with what each sees.
 * Analytics is described as what it is — consent-only, with workspace names,
 * paths and tokens stripped from the address — rather than "anonymised".
 * Sign-in emails are triggered by Firebase but delivered through Cloudflare
 * (Skill 2), so email sits on Cloudflare's row.
 */
export const SUB_PROCESSORS = [
  ['Cloudflare, Inc.', 'Compute, object storage, database, cache, queues, CDN and network security, bot verification, outbound email',
    'File content and metadata, API keys (hashed and sealed), audit log, API requests, email messages', 'Global network', 'SOC 2 Type II, ISO 27001, ISO 27701, PCI DSS Level 1'],
  ['Google LLC (Firebase Authentication)', 'Sign-in and session tokens',
    'Account identifier, email address, sign-in method, password hash', 'United States', 'SOC 1/2/3, ISO 27001, ISO 27017, ISO 27018'],
  ['Stripe, Inc.', 'Payments, invoices, the customer portal',
    'Billing name and address, card details, invoices, subscription', 'United States', 'PCI DSS Level 1, SOC 2 Type II, ISO 27001'],
  ['Google LLC (Google Analytics)', 'Page-visit analytics on this site, only with your consent',
    'Pages visited, with workspace names, file paths and link tokens removed; Google\'s analytics cookie identifiers', 'United States', 'SOC 2, ISO 27001'],
];

export function SubProcessors() {
  return (
    <SitePage
      crumbs={[TRUST_CRUMB, { label: 'Sub-processors' }]}
      kicker="TRUST"
      title="Sub-processors"
      meta="Last updated: 4 October 2026"
      lead="Every third party that processes data on AgentDisk's behalf, what it does, what it sees and where. No AI processor touches your files."
    >
      <Table
        head={['Sub-processor', 'Purpose', 'Data processed', 'Location', 'Certifications']}
        rows={SUB_PROCESSORS}
      />
      <P>
        When a processor is added or changes, this page and the Privacy Policy are updated with
        a new date. A new sub-processor for the files and metadata you store is announced by
        email to account owners at least 14 days before it starts, as the{' '}
        <Link to="/dpa">Data Processing Agreement</Link> sets out. How the data is protected is
        on <Link to="/security">Security</Link>.
      </P>
      <MoreTrust except="/sub-processors" />
    </SitePage>
  );
}
