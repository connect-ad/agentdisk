import React from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '../components/index.js';
import { Nav, Footer } from './Marketing.jsx';

/**
 * Terms of Service and Privacy Policy — doc 06 PART 17.2 / 17.3.
 *
 * The copy is the drafted text from that document, with two deliberate
 * departures. First, the draft's account-information section described a
 * password we hash ourselves and a GitHub OAuth integration we run; neither is
 * true any more, because Firebase owns authentication and this backend never
 * receives a password (doc 16 PART 30). Publishing a privacy policy that
 * describes handling we do not do would be wrong in the one direction a privacy
 * policy must never be wrong.
 *
 * Second, doc 06 states plainly that both texts are first drafts requiring
 * review by a qualified lawyer before publication. That instruction survives
 * into the page itself rather than being quietly dropped once the words are on
 * a real URL — the banner is the honest thing to show while it is still true,
 * and removing it is a decision for whoever commissions that review.
 */

function LegalShell({ title, updated, children }) {
  return (
    <div className="mk">
      <Nav />
      <main className="mk__wrap" style={{ maxWidth: '72ch', padding: 'var(--s-9) var(--s-6)' }}>
        <h1 className="mk__h1" style={{ marginBottom: 'var(--s-3)' }}>{title}</h1>
        <p className="ad-meta" style={{ marginBottom: 'var(--s-7)' }}>{updated}</p>

        <div style={{ marginBottom: 'var(--s-8)' }}>
          <Alert tone="warn" title="Draft — pending legal review">
            This text is a first draft written alongside the product design. It has not been
            reviewed by a lawyer and is published here so the product can be tested end to end.
            It is not the final agreement.
          </Alert>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
          {children}
        </div>
      </main>
      <Footer />
    </div>
  );
}

function Clause({ n, heading, children }) {
  return (
    <section>
      <h2 className="ad-h3" style={{ marginBottom: 'var(--s-2)' }}>{n}. {heading}</h2>
      <p style={{ color: 'var(--ink-2)', lineHeight: 1.65 }}>{children}</p>
    </section>
  );
}

export function Terms() {
  return (
    <LegalShell title="Terms of Service" updated="Draft · last updated 7 September 2026">
      <Clause n="1" heading="Acceptance">
        By creating an account or using the Service — including through an API key or an MCP
        connection — you agree to these Terms.
      </Clause>
      <Clause n="2" heading="Acceptable use">
        You may not use the Service to store, transmit, or process content that is illegal in your
        jurisdiction; malware or anything designed to attack systems, including ours; content that
        infringes another party's intellectual property; content involving the sexual exploitation
        of minors, which we report to the appropriate authorities without exception; or content
        intended to harass, threaten, or facilitate violence against real people.
      </Clause>
      <Clause n="3" heading="Your responsibility for content">
        You — and any agent acting under your account — are solely responsible for the files and
        data you store. We do not pre-screen content, but may review, remove, or restrict access to
        content that violates these Terms or the law, and may suspend accounts for repeated or
        severe violations.
      </Clause>
      <Clause n="4" heading="Prohibited content">
        You may not upload content you do not have the right to store or share. You may not use the
        Service as a public content-distribution network — this is storage for your own agents and
        team. You may not circumvent storage or rate limits through automated account creation.
      </Clause>
      <Clause n="5" heading="API and automated agent use">
        The API and MCP server are meant to be used by AI agents and automated systems acting on
        your behalf under credentials you control. <strong>You are responsible for what your agents
        do with your API keys, exactly as you would be for your own actions.</strong> Do not share
        keys across unrelated parties or resell access without our written agreement.
      </Clause>
      <Clause n="6" heading="Rate limits and fair use">
        We enforce rate limits and quotas to keep the Service reliable for everyone, and may
        throttle or temporarily suspend access we reasonably believe is abusive, degrading
        reliability for others, or circumventing those limits.
      </Clause>
      <Clause n="7" heading="Storage limits">
        Your plan defines storage, file count, egress, and request limits — see{' '}
        <Link to="/pricing">Pricing</Link>. We notify you as you approach a limit; exceeding a hard
        limit may block further writes until you upgrade, free space, or your usage period resets.
      </Clause>
      <Clause n="8" heading="Account suspension">
        We may suspend or terminate accounts that violate these Terms, pose a security risk, or
        where required by law. Where practical we will give notice and an opportunity to export your
        data first, except where immediate action is required.
      </Clause>
      <Clause n="9" heading="Your right to delete">
        You may delete your files, workspaces, or account at any time, subject to the recovery and
        grace-period behaviour described in our <Link to="/privacy">Privacy Policy</Link>.
      </Clause>
      <Clause n="10" heading="Billing">
        Paid plans are billed in advance on a recurring basis through our payment processor. Fees
        are non-refundable except as required by law or as we state at the time of purchase.
        Downgrading while over a plan's limits may restrict new writes until usage is back within
        them.
      </Clause>
      <Clause n="11" heading="Intellectual property">
        You keep all rights to the content you store. You grant us only the limited rights needed to
        store, process, transmit, and display that content back to you and the people and agents you
        authorise. We keep all rights to the Service itself.
      </Clause>
      <Clause n="12" heading="Third-party services">
        The Service relies on third-party infrastructure, and on third-party AI processors for
        features you opt into — both disclosed in our <Link to="/privacy">Privacy Policy</Link>. We
        are not responsible for the availability or acts of services outside our control, though we
        select and monitor them as part of running the Service responsibly.
      </Clause>
      <Clause n="13" heading="Warranties">
        The Service is provided "as is" without warranties of any kind, express or implied,
        including merchantability, fitness for a particular purpose, and non-infringement, except as
        expressly stated here or required by law.
      </Clause>
      <Clause n="14" heading="Limitation of liability">
        To the maximum extent permitted by law, we are not liable for indirect, incidental, special,
        or consequential damages, or for lost data, profits, or revenue, arising from your use of
        the Service.
      </Clause>
      <Clause n="15" heading="Termination">
        You may stop using the Service and delete your account at any time. We may terminate or
        suspend access for breach of these Terms. Sections 11, 13, and 14 survive termination.
      </Clause>
      <Clause n="16" heading="Changes to these Terms">
        We may update these Terms. For material changes we will notify account owners by email
        before the change takes effect.
      </Clause>
      <Clause n="17" heading="Governing law">
        To be specified once the operating entity is finalised. This clause is one of several
        requiring legal review before these Terms are binding.
      </Clause>
    </LegalShell>
  );
}

export function Privacy() {
  return (
    <LegalShell title="Privacy Policy" updated="Draft · last updated 7 September 2026">
      <Clause n="1" heading="Introduction">
        This policy explains how AgentDisk collects, uses, and shares information when you use our
        website, dashboard, API, and MCP server. It applies to human account holders and to
        information generated by AI agents acting under an account holder's authorisation.
      </Clause>
      <Clause n="2" heading="What we collect">
        Information you provide directly — account details, files you or your agents upload, support
        requests. Information collected automatically — log data, client information, usage metrics.
        And information from a sign-in provider you choose to use, described next.
      </Clause>
      <Clause n="3" heading="Account information and sign-in">
        <strong>We never receive, hash, or store your password.</strong> Sign-in is handled by
        Firebase Authentication (Google LLC), which owns password storage, Google and GitHub
        sign-in, and the session tokens underneath all of them. What reaches us is the identifier
        Firebase issues for your account and the email address associated with it. If you sign in
        with Google or GitHub, that provider tells Firebase who you are; we see the result, not your
        credentials.
      </Clause>
      <Clause n="4" heading="Files and content">
        Files you or your agents upload are stored on your behalf using Cloudflare R2. We do not
        access, view, or process their contents except as strictly necessary to run the Service —
        computing a checksum, generating a presigned URL, measuring size against your quota — or
        where required to investigate abuse, a security incident, or a valid legal request. We do
        not claim our architecture makes it impossible for us to read your files, because it does
        not: R2 storage is not end-to-end encrypted in a way that excludes our own infrastructure.
      </Clause>
      <Clause n="5" heading="API usage">
        We log API and MCP requests — endpoint, method, status, latency, and which identity made the
        call — for security, billing, quota enforcement, and debugging. We do not log request or
        response bodies containing file content or secrets.
      </Clause>
      <Clause n="6" heading="Agent data">
        Information about agents you create is account information under section 3. Files an agent
        creates or modifies are treated exactly as files a human uploads — we do not apply different
        retention or access rules based on whether a human or an agent acted.
      </Clause>
      <Clause n="7" heading="Logs and retention">
        Structured request logs are retained for around 90 days for security and debugging, then
        deleted or aggregated into non-identifying metrics. The audit events shown in your
        workspace's Activity log are kept for the life of the workspace, so your own audit trail
        outlives our raw infrastructure logs.
      </Clause>
      <Clause n="8" heading="IP addresses">
        Collected for rate limiting and abuse prevention, and retained on the same schedule as
        section 7.
      </Clause>
      <Clause n="9" heading="Cookies and analytics">
        We use strictly necessary session and security storage only. We do not currently use
        analytics or marketing cookies, and will update this policy and ask for consent before we
        do.
      </Clause>
      <Clause n="10" heading="Processors we use">
        Cloudflare, Inc. for compute, object storage, database, caching, and queues. Google LLC
        (Firebase Authentication) for sign-in. Stripe, Inc. for payments — we do not store your card
        number. An email delivery provider for verification and notification messages.
      </Clause>
      <Clause n="11" heading="AI processing">
        Optional per-workspace AI features are not enabled in this release. If you opt a workspace
        into them in future, this section will name the specific processor before that happens,
        because it is the one case where file content leaves our storage boundary.
      </Clause>
      <Clause n="12" heading="Data retention">
        Account and file data is retained while your account and workspace are active. Deleted files
        enter a recoverable state before being permanently purged from object storage. Deleted
        workspaces are permanently purged within roughly 30 days, except where a legal obligation or
        active dispute requires holding them longer.
      </Clause>
      <Clause n="13" heading="Deletion and export">
        You can delete individual files, folders, agents, keys, or an entire workspace at any time
        from the dashboard or API, and request an export of your account and workspace data in a
        structured, machine-readable format.
      </Clause>
      <Clause n="14" heading="Security">
        TLS for all traffic, encryption at rest as provided by Cloudflare, API keys stored only as
        hashes, scoped credentials, and tenant isolation enforced in the data layer rather than by
        convention. No system is perfectly secure and we do not claim otherwise.
      </Clause>
      <Clause n="15" heading="International transfers">
        Cloudflare and Google operate global networks, so your data may be processed outside your
        home country. The specific transfer mechanisms require legal review before this policy is
        final.
      </Clause>
      <Clause n="16" heading="Children's privacy">
        The Service is not directed to anyone under 16, and we do not knowingly collect their
        information. If we learn that we have, we delete it.
      </Clause>
      <Clause n="17" heading="Your rights">
        Depending on where you live you may have rights to access, correct, delete, export, or
        object to processing of your data. Sections 13 covers deletion and export in-product; for
        anything else, contact us.
      </Clause>
      <Clause n="18" heading="Changes and contact">
        Material changes will be posted here with an updated date, and account owners notified by
        email for significant ones. Questions about this policy can be sent to the address published
        alongside the final version.
      </Clause>
    </LegalShell>
  );
}
