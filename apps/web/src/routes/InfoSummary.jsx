import React from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/index.js';
import { SitePage, H2, P, LinkCards } from '../components-local/Prose.jsx';
import { TRUST_PAGES, TRUST_CRUMB } from './Trust.jsx';

/**
 * /info-summary: the Trust Center on one page, drawn rather than written.
 *
 * Designed 7 Oct 2026 as the "Safety Information" artboard in the Claude
 * Design project (safety-information/Safety Information v2.dc.html). The
 * reader it is for has no time for the five trust pages and wants to see,
 * in a minute, what the infrastructure is certified for, what stands between
 * the internet and their bytes, where the data travels, how it is deleted,
 * and where the detail is. Every section ends in a link to the page that
 * carries the mechanism.
 *
 * The rule is the trust pages' rule: nothing that is not true of the
 * running system. The certifications are the providers', and the page says
 * so beside every seal; the controls, the numbers and the deletion timeline
 * are the Security page and the docs' deletion sections restated, not
 * extended. The four "not" pills are deliberate: the crosses are what make
 * the ticks credible to a reviewer.
 *
 * Nothing here touches a browser global while rendering; the page is
 * prerendered and has a markdown twin (worker.js MARKDOWN_PAGES).
 */

/**
 * The six seals. `providers` are the chips under each; `own` marks
 * AgentDisk's own commitment rather than a provider's certification, and
 * `note` is the one line that says what the standard covers here.
 */
export const SEALS = [
  { big: 'SOC 2', small: 'TYPE II', name: 'SOC 2 Type II', held: 'Held by', providers: ['Cloudflare', 'Google', 'Stripe'], note: 'audited controls, reported annually' },
  { big: '27001', small: 'ISO / IEC', name: 'ISO 27001', held: 'Held by', providers: ['Cloudflare', 'Google', 'Stripe'], note: 'information security management' },
  { big: '27701', small: 'ISO / IEC', name: 'ISO 27701', held: 'Held by', providers: ['Cloudflare'], note: 'privacy information management' },
  { big: '27017', small: '+ 27018', name: 'ISO 27017 / 27018', held: 'Held by', providers: ['Google'], note: 'cloud security and PII in the cloud' },
  { big: 'PCI', small: 'DSS LEVEL 1', name: 'PCI DSS Level 1', held: 'Held by', providers: ['Stripe', 'Cloudflare'], note: 'card data never touches AgentDisk' },
  { big: 'GDPR', small: 'DPA + SCCs', name: 'GDPR DPA + SCCs', held: 'AgentDisk · click-through', providers: ['AgentDisk'], note: 'EU, UK and Swiss transfers · part of the Terms', own: true },
];

/** The four layers a request falls through, outermost first. */
const LAYERS = [
  { name: 'Cloudflare edge', checks: ['DDoS L3 · L4 · L7', 'TLS 1.2+ · HSTS', 'per-IP limits'] },
  { name: 'Authorization chain', checks: ['authenticate', 'resolve scope', 'bind workspace', 'check path', 'quota · billing'] },
  { name: 'The handler', checks: ['workspace-bound storage only'], stop: 'no raw bucket · no raw database' },
  { name: 'Your bytes', checks: ['AES-256 at rest', 'server-side object keys', 'one file per object'] },
];

const NUMBERS = [
  { n: '15 min', what: 'upload URL lifetime, one object' },
  { n: '1 h', what: 'download URL lifetime' },
  { n: '0', what: 'servers to patch or SSH into' },
  { n: '1', what: 'failure body for every auth error' },
  { n: '1,000+', what: 'automated tests, two-tenant proofs' },
  { n: '22', what: 'mutation checks on the storage core' },
];

const NOT_CLAIMED = [
  ['Not end-to-end encrypted', 'our service reads your files when a request authorizes it'],
  ['No certification of our own', 'SOC 2, ISO and PCI belong to the providers above'],
  ['No multi-factor sign-in yet', 'passwords are hashed by Firebase and never reach us'],
  ['No region to choose', "data sits on Cloudflare's global network"],
];

/**
 * The deletion timeline: one row per thing, one column per moment. A cell
 * is an event (`title`, `note`, `tone`) or empty. `tone` is the colour and
 * the key names it: act (a person acts), gone (destroyed), ok (claimed),
 * stay (kept because the law requires it).
 */
const MOMENTS = ['You act', 'Instant', 'Day 3', 'By day 7', 'Stays'];
const DELETION_ROWS = [
  { who: 'A file', how: 'DELETE /v1/files/:id · delete_file tool · the file drawer', cells: [
    { tone: 'act', title: 'Delete', note: 'any of the three surfaces' },
    { tone: 'gone', title: 'Bytes and record gone', note: 'same request · "permanent": true · quota released · file.deleted fires', last: true },
    null, null, null,
  ] },
  { who: 'A workspace', how: 'Settings → Danger zone · DELETE /v1/workspaces/:id', cells: [
    { tone: 'act', title: 'Owner types the exact name', note: 'refuses an API key · refuses your last workspace' },
    { tone: 'gone', title: 'Everything unreachable', note: 'keys, agents, members, webhooks, share links, folders, file records' },
    null,
    { tone: 'gone', title: 'Bytes erased', note: 'hourly sweep · nothing recoverable in between', last: true },
    null,
  ] },
  { who: 'Your account', how: 'Profile → Delete account · DELETE /v1/me · a key is refused', cells: [
    { tone: 'act', title: 'Type your email to confirm', note: 'a button, not a request' },
    { tone: 'gone', title: 'Billing settled, then destroyed', note: 'subscriptions cancelled, card detached (409 if Stripe refuses) · workspaces destroyed · guest seats removed · signed out everywhere' },
    null,
    { tone: 'gone', title: 'Bytes erased, identity released', note: 'one confirmation email first, retried 48 h · email address freed' },
    { tone: 'stay', title: 'Invoices, seven years', note: 'at Stripe, tax law · request logs ~90 days · nothing else', last: true },
  ] },
  { who: 'A sandbox', how: 'created with no account · 500 MB · no share links', cells: [
    { tone: 'act', title: 'Created by an agent or a browser', note: '10 per hour per IP · 5 unclaimed at once' },
    { tone: 'ok', title: 'Claimed with the one-time link', note: 'becomes a normal workspace · slot freed instantly' },
    { tone: 'gone', title: 'Unclaimed: wiped', note: 'scheduled for removal after three days', last: true },
    null, null,
  ] },
];

const DELETION_KEY = [
  ['act', 'a person acts'],
  ['gone', 'destroyed, not recoverable'],
  ['ok', 'becomes a normal workspace'],
  ['stay', 'kept because the law requires it'],
];

function Seal({ s }) {
  return (
    <li className={s.own ? 'sf__sealcard sf__sealcard--own' : 'sf__sealcard'}>
      <span className="sf__seal" aria-hidden="true">
        <span className="sf__sealin"><b>{s.big}</b><i>{s.small}</i></span>
        <span className="sf__sealtick"><Icon name="check" size={13} strokeWidth={3} /></span>
      </span>
      <span className="sf__sealname">{s.name}</span>
      <span className="sf__holder">
        <b>{s.held}</b>
        <span className="sf__provs">
          {s.providers.map(p => <i key={p} className={s.own ? 'sf__prov sf__prov--own' : 'sf__prov'}>{p}</i>)}
        </span>
      </span>
      <span className="sf__sealnote">{s.note}</span>
    </li>
  );
}

/** The nested layers, drawn recursively so each sits inside the one before. */
function Layer({ i }) {
  const l = LAYERS[i];
  return (
    <div className="sf__layer">
      <div className="sf__lhead">
        <span className="sf__lname"><span className="sf__lno" aria-hidden="true">{i + 1}</span>{l.name}</span>
        <span className="sf__lchecks">
          {l.checks.map(c => <span key={c} className="sf__lc">✓ {c}</span>)}
          {l.stop ? <span className="sf__lc sf__lc--stop">{l.stop}</span> : null}
        </span>
      </div>
      {i + 1 < LAYERS.length ? <Layer i={i + 1} /> : null}
    </div>
  );
}

function Event({ c }) {
  if (!c) return null;
  return (
    <div className={`sf__ev sf__ev--${c.tone}`}>
      <b>{c.title}</b>
      <i>{c.note}</i>
    </div>
  );
}

export function InfoSummary() {
  return (
    <SitePage
      crumbs={[TRUST_CRUMB, { label: 'Safety Information' }]}
      kicker="TRUST CENTER"
      title="Safety Information"
      meta="Last reviewed: October 2026"
      lead="The whole picture on one page: the certifications this service runs on, how a request is protected on its way to your bytes, where your data travels, how it is deleted, and the five pages that carry the detail. Every mark here is true of the system running today."
    >
      {/* ── 1. certifications ── */}
      <section id="certifications" className="doc__section sf__sec">
        <div className="sf__sechead">
          <div>
            <H2 id="certifications-heading">Certifications behind the service</H2>
            <P>
              AgentDisk runs on three providers. Each holds its own audited certifications, and
              the service inherits their controls for compute, storage, identity and payments.
            </P>
          </div>
          <Link to="/security#certifications" className="sf__more">/security#certifications →</Link>
        </div>
        <div className="sf__certband">
          <div className="sf__certhead">
            <span><i className="sf__dot sf__dot--ok" aria-hidden="true" />Five held by a provider, covering its infrastructure</span>
            <span><i className="sf__dot sf__dot--own" aria-hidden="true" />One AgentDisk commitment of its own</span>
          </div>
          <ul className="sf__seals" aria-label="Certifications">
            {SEALS.map(s => <Seal key={s.name} s={s} />)}
          </ul>
        </div>
        <P>
          <strong>AgentDisk holds no certification of its own</strong> and says so on every page.
          The controls it builds on top of these providers are drawn below, and sorted by SOC 2
          category on the <Link to="/security#soc2">Security page</Link> for reviewers who work
          from that framework.
        </P>
      </section>

      {/* ── 2. the request path ── */}
      <section id="request-path" className="doc__section sf__sec">
        <div className="sf__sechead">
          <div>
            <H2 id="request-path-heading">What stands between the internet and your bytes</H2>
            <P>
              Every request, REST or MCP, passes the same four layers in the same order. A
              handler at the centre never holds anything that could reach another tenant.
            </P>
          </div>
          <Link to="/security#safety" className="sf__more">/security#safety →</Link>
        </div>
        <div className="sf__two">
          <figure className="sf__panel" aria-label="The four layers a request passes">
            <div className="sf__internet"><b>The internet</b><span className="sf__req">a request<i aria-hidden="true" /></span></div>
            <Layer i={0} />
            <div className="sf__fail">
              <b><span className="sf__x" aria-hidden="true">✕</span>Any failure, any layer</b>
              <span>one identical body · reason to the log · never an oracle</span>
            </div>
          </figure>
          <figure className="sf__panel" aria-label="One key sees one path">
            <figcaption className="sf__h3">One key sees one path</figcaption>
            <span className="sf__keychip"><Icon name="key" size={13} />ad_live_••••••••<em>· agent "reporter"</em></span>
            <div className="sf__scopes">
              <span className="sf__scope">files:read</span>
              <span className="sf__scope">files:write</span>
              <span className="sf__scope">prefix /projectA/tech</span>
            </div>
            <div className="sf__tree">
              <div className="sf__tree--off"><span>/projectA</span><b>listing clipped</b></div>
              <div className="sf__tree--on"><span>&nbsp;&nbsp;├ /projectA/tech</span><b>✓ read · write</b></div>
              <div className="sf__tree--on"><span>&nbsp;&nbsp;│&nbsp;&nbsp;&nbsp;└ spec.md</span><b>✓</b></div>
              <div className="sf__tree--off"><span>&nbsp;&nbsp;└ /projectA/docs</span><b>✕ 404 · logged</b></div>
              <div className="sf__tree--off"><span>/projectB</span><b>✕ 404 · logged</b></div>
              <div className="sf__tree--off"><span>DELETE /v1/me</span><b>✕ a key is never a person</b></div>
            </div>
            <p className="sf__note">
              The key itself is stored twice: a SHA-256 hash to find it, and AES-256-GCM
              ciphertext bound to its own row so the owner can reveal it again. The plaintext
              is shown once.
            </p>
          </figure>
        </div>
        <ul className="sf__nums" aria-label="Six numbers">
          {NUMBERS.map(x => <li key={x.what} className="sf__num"><b>{x.n}</b><i>{x.what}</i></li>)}
        </ul>
        <ul className="sf__nots" aria-label="What we do not claim">
          {NOT_CLAIMED.map(([title, why]) => (
            <li key={title} className="sf__not"><span className="sf__x" aria-hidden="true">✕</span><b>{title}</b><span>· {why}</span></li>
          ))}
        </ul>
      </section>

      {/* ── 3. where your data goes ── */}
      <section id="data-flow" className="doc__section sf__sec">
        <div className="sf__sechead">
          <div>
            <H2 id="data-flow-heading">Where your data goes</H2>
            <P>
              Four parties ever touch your data, and each sees only its slice. File bytes and
              metadata never leave Cloudflare's network; no AI processor touches your files.
            </P>
          </div>
          <Link to="/sub-processors" className="sf__more">/sub-processors →</Link>
        </div>
        <figure className="sf__flow" aria-label="Where your data goes">
          <div className="sf__node">
            <span className="sf__tile"><Icon name="terminal" size={15} /></span>
            <span className="sf__nt"><b>Your agent</b><i>MCP or REST · one API key</i></span>
          </div>
          <div className="sf__arrow"><em>API key · TLS</em><i aria-hidden="true" /><em>one path only</em></div>
          <div className="sf__edge">
            <div className="sf__edgehead"><b>Cloudflare · global network</b><i>serverless · no region to choose</i></div>
            <div className="sf__chips">
              {['SOC 2 Type II', 'ISO 27001', 'ISO 27701', 'PCI DSS L1'].map(c => <span key={c} className="sf__chip">✓ {c}</span>)}
              <span className="sf__chip sf__chip--acc">DDoS L3 · L4 · L7</span>
            </div>
            <div className="sf__inner">
              <div className="sf__cell"><b>API + MCP</b><i>one authorization chain, workspace bound first</i><s>✓ TLS · HSTS · CSP</s></div>
              <div className="sf__cell"><b>Object storage</b><i>file bytes, one object per file, server-side prefix</i><s>✓ AES-256 at rest</s></div>
              <div className="sf__cell"><b>Edge database</b><i>metadata, memberships, audit log; keys sealed</i><s>✓ AES-256 at rest</s></div>
            </div>
            <div className="sf__edgefoot"><span>✓ every call logged</span><span>✓ URLs expire 15 min / 1 h</span><span>✓ outbound email</span></div>
          </div>
          <div className="sf__arrow"><em>ID token verified</em><i aria-hidden="true" /><em>never a password</em></div>
          <div className="sf__node">
            <span className="sf__tile"><Icon name="users" size={15} /></span>
            <span className="sf__nt"><b>Google · Firebase Auth</b><i>sign-in only · United States</i><i>✓ SOC 1/2/3 · ISO 27001 · 27017 · 27018</i></span>
          </div>
          <div className="sf__node">
            <span className="sf__tile sf__tile--person"><Icon name="dashboard" size={15} /></span>
            <span className="sf__nt"><b>You</b><i>dashboard · owns it all</i></span>
          </div>
          <div className="sf__arrow"><em>session token · TLS</em><i aria-hidden="true" /><em>revoked by us first</em></div>
          <div className="sf__arrow sf__arrow--grey"><em>customer id only</em><i aria-hidden="true" /><em>no card data</em></div>
          <div className="sf__node">
            <span className="sf__tile"><Icon name="billing" size={15} /></span>
            <span className="sf__nt"><b>Stripe</b><i>payments · United States</i><i>✓ PCI DSS L1 · SOC 2 · ISO 27001</i></span>
          </div>
        </figure>
        <div className="sf__legend">
          <span><i className="sf__line" aria-hidden="true" />data in transit, TLS, scoped credential</span>
          <span><i className="sf__line sf__line--grey" aria-hidden="true" />identifiers only, no file content</span>
          <span>Analytics on this site runs only with consent and never sees workspace names, paths or link tokens.</span>
        </div>
      </section>

      {/* ── 4. deletion ── */}
      <section id="deletion" className="doc__section sf__sec">
        <div className="sf__sechead">
          <div>
            <H2 id="deletion-heading">How deletion works</H2>
            <P>
              Deletion is self-service and permanent. Nothing in the product has a recycle bin,
              and no screen implies otherwise. Records go in the request; the last bytes follow
              on the hourly sweep.
            </P>
          </div>
          <Link to="/docs/deleting-data" className="sf__more">/docs/deleting-data →</Link>
        </div>
        <div className="sf__tlwrap">
          <table className="sf__tl">
            <caption className="sr-only">What is deleted, and when, for a file, a workspace, your account and a sandbox</caption>
            <thead>
              <tr>
                <th scope="col">What</th>
                {MOMENTS.map(m => <th key={m} scope="col" className={m === 'By day 7' ? 'sf__d7' : undefined}>{m}</th>)}
              </tr>
            </thead>
            <tbody>
              {DELETION_ROWS.map(r => {
                const lastIdx = r.cells.findIndex(c => c?.last);
                return (
                  <tr key={r.who}>
                    <th scope="row"><b>{r.who}</b><i>{r.how}</i></th>
                    {r.cells.map((c, i) => {
                      const cls = ['sf__tlcell'];
                      if (i === 0) cls.push('sf__tlcell--start');
                      if (i === lastIdx) cls.push('sf__tlcell--end');
                      if (i > lastIdx) cls.push('sf__tlcell--none');
                      return (
                        <td key={MOMENTS[i]} className={cls.join(' ')}>
                          {c ? <Event c={c} /> : <span className="sf__pin" aria-hidden="true" />}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="sf__key">
          {DELETION_KEY.map(([tone, word]) => (
            <span key={tone}><i className={`sf__sw sf__sw--${tone}`} aria-hidden="true" />{word}</span>
          ))}
          <span>
            Operator-initiated deletion from the console is different: suspend first, then a
            30-day hold before any removal.
          </span>
        </div>
        <P>
          Closing the account is covered in <Link to="/docs/deleting-account">Deleting your
          account</Link>; the sandbox limits are in the <Link to="/docs">documentation</Link>.
        </P>
      </section>

      {/* ── 5. the detail pages ── */}
      <section id="detail" className="doc__section sf__sec" aria-labelledby="detail-heading">
        <H2 id="detail-heading">The detail, page by page</H2>
        <P>Each page describes the system as it runs today, including what it does not do.</P>
        <LinkCards label="Trust pages" items={TRUST_PAGES.filter(p => p.to !== '/info-summary')} />
        <div className="sf__band">
          <Icon name="shield" size={18} />
          <div>
            <b>Questions and vulnerability reports.</b> Email <code>connect@agentdisk.io</code> with
            "Security" in the subject, or use the Support form in the dashboard. Please do not
            open a public issue. AgentDisk is a product by Kernelv5 Inc.
          </div>
        </div>
      </section>
    </SitePage>
  );
}
