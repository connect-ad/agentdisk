import React from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '../components/index.js';
import { Nav, Footer } from './Marketing.jsx';

/**
 * Terms of Service — doc 06 PART 17.2.
 *
 * The Privacy Policy used to live beside it here, at /privacy. On the owner's
 * call (26 Sept 2026) the docs page's Privacy section is the one privacy text
 * and this file no longer carries a second copy; /privacy redirects to
 * /docs#privacy so every old link, the cookie notice and the sign-up form
 * still land on it. Two texts describing the same handling drift, and a
 * privacy policy is the one document that must not.
 *
 * Doc 06 states plainly that the Terms are a first draft requiring review by a
 * qualified lawyer before publication. That instruction survives into the page
 * itself rather than being quietly dropped once the words are on a real URL —
 * the banner is the honest thing to show while it is still true, and removing
 * it is a decision for whoever commissions that review.
 */

function LegalShell({ title, updated, children }) {
  return (
    <div className="mk">
      <Nav />
      <main className="mk__wrap" style={{ maxWidth: '72ch', padding: 'var(--s-9) var(--gutter)' }}>
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
        grace-period behaviour described in our <Link to="/docs#privacy">Privacy Policy</Link>.
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
        features you opt into — both disclosed in our <Link to="/docs#privacy">Privacy Policy</Link>. We
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
