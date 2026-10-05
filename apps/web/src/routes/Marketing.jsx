import React, { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Button, Icon } from '../components/index.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PLANS, OVERAGES, FREE_SUMMARY, COUNTING_NOTE, YEARLY_NOTE, RENEWAL_NOTE,
  PERIODS, yearlyListPrice, yearlySaving
} from '../lib/pricing.js';
import { WORKS_WITH } from '../lib/clients.js';
import Logo from '../components-local/Logo.jsx';
import Byline from '../components-local/Byline.jsx';
import { COMPANY_LEGAL_NAME, COMPANY_NAME, COMPANY_URL } from '../lib/company.js';
import { SupportDialog } from '../components-local/SupportDialog.jsx';
import ThemeToggle from '../components-local/ThemeToggle.jsx';
import HomeDiagram from '../components-local/HomeDiagram.jsx';

/**
 * 8.1 Landing · 8.2 Pricing.
 *
 * Rebuilt to `AgentDisk Site.dc.html`. The previous version was the same page
 * in new colours: a different headline, a six-card use-cases section the design
 * does not have, and a four-tab code panel where the design draws a terminal
 * transcript. Copy and section order now follow the design.
 *
 * Every price and limit comes from `lib/pricing.js`, which is the one module
 * that changes when pricing goes dynamic.
 */

/* ── landing content, from the design ─────────────────────────────────────── */

/**
 * Corrected 26 Sept 2026. The design's tags read "S3-COMPATIBLE" and
 * "EU + US REGIONS". Neither is true: the product exposes REST and MCP, not an
 * S3 API (presigning uses R2's S3 endpoint internally, which is not the same
 * claim), and there is no region concept anywhere in the stack — the footer
 * dropped its region badge for that reason. What replaces them is what the
 * pricing page already promises.
 */
const HERO_TAGS = ['NO CARD REQUIRED', 'REST + MCP', 'HARD-CAPPED PRICING'];

/**
 * The hero transcript. `tone` colours a line; absent means body text.
 * Modelled as data rather than markup so the panel stays one element and the
 * tones stay tokens.
 *
 * The lines describe what the API does. Files carry a SHA-256 and no version
 * number (the design's "v3" named a field that does not exist); a denied call
 * is `403 FORBIDDEN` (`lib/errors.ts`), not `scope_denied`; and keys begin
 * `ask_live_` (`lib/keys.ts`), not `adk_live_`.
 *
 * Rewritten 27 Sept 2026. The design's transcript showed an 812 MB parquet
 * file and a 504 MB index — a big-data story that sold to a different buyer
 * than the headline above it. What an agent actually persists here is small
 * and read back later: a task list one session writes and the next one reads.
 * That is the story, and `read_file` is the tool that makes it true.
 */
const TRANSCRIPT = [
  { text: '> create_file /memory/tasks.md' },
  { text: '  ✓ 1.2 KB · sha256:c81e0f2d', tone: 'ok' },
  { text: '' },
  { text: '> read_file /memory/tasks.md        # next session' },
  { text: '  # Tasks · nightly-report #42' },
  { text: '  - [x] fetch sources' },
  { text: '  - [ ] draft the summary' },
  { text: '' },
  { text: '> delete_file /memory/tasks.md' },
  { text: '  ✗ 403 FORBIDDEN', tone: 'danger' },
  { text: '  key ask_live_••••4aUgT lacks delete', tone: 'warn' },
];

const FEATURES = [
  {
    kicker: 'SCOPED',
    title: "Keys that can't overreach",
    body: 'Every key carries explicit scopes and an optional path prefix. A denied MCP call is logged with the scope it needed.',
  },
  {
    kicker: 'PERSISTENT',
    title: 'State between runs',
    body: 'Agents pick up where they left off. Notes, task lists and results written in one session are read back in the next.',
  },
  {
    kicker: 'MCP NATIVE',
    title: 'One config block',
    body: 'File tools registered in any MCP client. No SDK, no wrapper service to maintain.',
  },
  {
    kicker: 'AUDITED',
    title: 'Who touched what',
    body: 'Human and agent actions land in the same log, with actor, path, scope and source IP.',
  },
];

/** The sandbox-to-claim flow on the landing page. Numbers, not paragraphs. */
const SPOT_FLOW = [
  { num: '01', title: 'Sandbox', sub: 'workspace + key, no sign-up' },
  { num: '02', title: 'Agent works', sub: 'files land, scoped and logged' },
  { num: '03', title: 'Claim link', sub: 'one click makes it yours', claim: true },
];

const STEPS = [
  {
    n: '1',
    title: 'Create a key',
    body: 'Pick scopes and a prefix in the dashboard, or over the API. View it again whenever you need it.',
    // The design showed `adk keys create …`. There is no CLI; this is the
    // real request (`routes/keys.ts`), and the dashboard's Create-key dialog
    // sends the same fields.
    code: "POST /v1/keys\n{ \"name\": \"research-bot\",\n  \"ops\": [\"read\",\"write\",\"list\"],\n  \"pathPrefix\": \"/projects\" }",
  },
  {
    n: '2',
    title: 'Point your client at it',
    body: 'One entry in your MCP config, or one header for REST. The workspace comes from the key.',
    code: "export AGENTDISK_KEY=ask_live_…\n# Authorization: Bearer $AGENTDISK_KEY",
  },
  {
    n: '3',
    title: 'Let the agent work',
    body: 'Watch the audit log fill in as calls arrive.',
    code: "> create_file /projects/notes.md\n  ✓ 4.2 KB · sha256:c81e0f2d",
  },
];

/* ── shared chrome ────────────────────────────────────────────────────────── */

/**
 * The three page links.
 *
 * The absence of `end` on Docs is load-bearing: it is what keeps Docs marked
 * on a future `/docs/<section>`, and adding one turns that off. `end` on
 * Product is not — react-router 7 matches whole path segments, so `/` already
 * fails to claim `/pricing`. It is stated anyway, because the root link is the
 * one place where that is not obvious to the next reader, and the only place a
 * basename change could make it matter.
 */
const NAV_PAGES = [
  { to: '/', label: 'Product', end: true },
  { to: '/pricing', label: 'Pricing' },
  { to: '/docs', label: 'Docs' },
  { to: '/blog', label: 'Blog' },
];

const navLinkClass = ({ isActive }) =>
  isActive ? 'mk__navlink mk__navlink--on' : 'mk__navlink';

export function Nav() {
  const { user } = useAuth();
  const [supportOpen, setSupportOpen] = useState(false);
  /*
   * The phone treatment. Below 875px the row of links does not fit beside the
   * brand — at 360px it ran to 740px and dragged the whole page sideways — so
   * the links become a panel under the bar, opened by one button. Same links,
   * same order, same components: the panel is a layout of the row, not a
   * second navigation. Nav is remounted per route, so the panel closes on
   * every navigation without a listener; Escape closes it in place.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  React.useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = e => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  return (
    <>
    <nav className={menuOpen ? 'mk__nav is-open' : 'mk__nav'}>
      {/* The lockup: the logo at the left, and beside it two lines, the
          wordmark over the company byline. The byline is a sibling of the
          brand link, not a child: it goes somewhere else (kernelv5.com), and
          an anchor inside an anchor is invalid. The grid puts the logo in
          the first column spanning both rows, so the link's two children and
          the byline lay out as one block (`display:contents` on the link). */}
      <span className="mk__lockup">
        <Link to="/" className="mk__brand">
          <Logo size={34} />
          <span className="mk__wordmark">AgentDisk</span>
        </Link>
        <Byline className="mk__by" />
      </span>
      <button
        type="button"
        className="mk__burger"
        aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={menuOpen}
        aria-controls="mk-navlinks"
        onClick={() => setMenuOpen(o => !o)}
      >
        <Icon name={menuOpen ? 'x' : 'menu'} size={18} />
      </button>
      <span className="mk__navlinks" id="mk-navlinks">
        {/* NavLink marks the current page with `aria-current="page"`, and the
            class carries the visible state -- a bordered pill, see app.css.
            Before this the three rendered identically in the accent, so
            nothing said which page you were on and clicking the one you were
            already reading did nothing visible.

            They are grouped so the pills read as one set of tabs and keep
            their distance from Sign in / Start free, which are actions. */}
        <span className="mk__pages">
          {NAV_PAGES.map(p => (
            <NavLink key={p.to} to={p.to} end={p.end} className={navLinkClass}>
              {p.label}
            </NavLink>
          ))}
        </span>
        {/* Support sits immediately after Docs and outside the pill group, and
            the two facts are one decision: it is the next thing in the row, but
            it is not a page. It opens a dialog, has no route and no
            aria-current, so giving it a tab pill would promise a navigation
            that never happens -- and the group's 2px gap exists to make the
            pills read as one set of pages.

            It is a <button> because it performs an action. An <a> without an
            href is not focusable and not announced as anything; one with href="#"
            puts a fragment in the address bar and breaks the back button. */}
        <button type="button" className="mk__navlink mk__navlink--action"
          onClick={() => setSupportOpen(true)}>
          Support
        </button>
        {/* The same light/dark control the dashboard's top bar carries. The
            marketing pages sit inside the ThemeProvider already (main.jsx), so
            the choice made here is the one the dashboard opens with. */}
        {/* display:contents on desktop, so the row's own gap runs through it
            unchanged; on a phone it is the panel's last row, the theme control
            and the two actions side by side under a rule. */}
        <span className="mk__navactions">
          <span className="mk__theme"><ThemeToggle /></span>
          {user ? (
            <Button size="sm" as={Link} to="/app">Open dashboard</Button>
          ) : (
            <>
              <Link to="/login" className="mk__navlink">Sign in</Link>
              <Button size="sm" as={Link} to="/signup">Start free</Button>
            </>
          )}
        </span>
      </span>
    </nav>
    {/* Outside the <nav>, and this is not cosmetic. .mk__nav is sticky with
        z-index 30, which makes it a stacking context: a scrim rendered inside
        it is ranked *within* that context and cannot paint above anything the
        bar itself sits below, whatever number it carries. That is the trap
        Skill/13 UI Layering.md §1 records against .wsx__menu, and the reason
        FileBrowser.jsx keeps its dialogs as siblings of the drawer rather than
        children. .mk is a static flex column, so out here the scrim's 80
        competes globally as intended. */}
    {supportOpen ? <SupportDialog onClose={() => setSupportOpen(false)} /> : null}
    </>
  );
}

/**
 * The footer's columns. Every destination is a route or a docs section that
 * exists; the support address is the one the Support form delivers to.
 * There is no region badge, for the reason the old footer recorded: the
 * reference drew "EU-CENTRAL-1" and nothing in this system has a region.
 *
 * Reworked 4 Oct 2026 for the trust pages, the blog and the comparisons. The
 * Account column went: Sign in and Start free are in the bar above on every
 * page, and the support address moved under the blurb.
 */
const FOOT_COLUMNS = [
  { head: 'Product', links: [
    { to: '/docs', label: 'Docs' },
    { to: '/pricing', label: 'Pricing' },
    { to: '/sandbox', label: 'Sandbox' },
    { to: '/docs/quickstart', label: 'Quick start' },
  ] },
  { head: 'Use with', links: [
    { to: '/storage-for-claude', label: 'Claude' },
    { to: '/storage-for-openai', label: 'OpenAI' },
    { to: '/storage-for-cursor', label: 'Cursor' },
    { to: '/storage-for-cline', label: 'Cline' },
  ] },
  { head: 'Trust', links: [
    { to: '/security', label: 'Security' },
    { to: '/trust', label: 'Trust Center' },
    { to: '/privacy', label: 'Privacy' },
    { to: '/terms', label: 'Terms' },
    { to: '/sub-processors', label: 'Sub-processors' },
    { to: '/dpa', label: 'DPA' },
  ] },
  { head: 'Blog', links: [
    { to: '/blog', label: 'Latest' },
    { to: '/blog?tag=tutorial', label: 'Tutorials' },
    { to: '/blog?tag=security', label: 'Security guides' },
  ] },
  { head: 'Compare', links: [
    { to: '/compare/agentdisk-vs-fast-io', label: 'vs Fast.io' },
    { to: '/compare/agentdisk-vs-s3', label: 'vs S3' },
    { to: '/compare/agentdisk-vs-diskd-ai', label: 'vs Diskd.ai' },
    { to: '/alternatives', label: 'Alternatives' },
    { to: '/compare', label: 'All comparisons' },
  ] },
];

export function Footer() {
  return (
    <footer className="mk__foot">
      <div className="mk__wrap">
        <div className="mk__footgrid">
          <div className="mk__footabout">
            <span className="mk__footbrand">
              <Logo size={30} alt="" />
              <span className="mk__footmark">AgentDisk</span>
              <Byline className="mk__footby" />
            </span>
            <p className="mk__footblurb">
              A scoped, persistent workspace for every AI agent: files, folders and
              metadata over REST and MCP, with the audit log kept for you.
            </p>
            <p className="mk__footblurb">
              <a href="mailto:connect@agentdisk.io">connect@agentdisk.io</a>
            </p>
            <div className="mk__footfacts" aria-label="In short">
              {HERO_TAGS.map(t => <span key={t} className="mk__footfact">{t}</span>)}
            </div>
          </div>
          {FOOT_COLUMNS.map(col => (
            <div key={col.head} className="mk__footcol">
              <h3 className="mk__foothead">{col.head}</h3>
              <ul className="mk__footlist">
                {col.links.map(l => (
                  <li key={l.label}>
                    {l.href
                      ? <a href={l.href}>{l.label}</a>
                      : <Link to={l.to}>{l.label}</Link>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mk__footbase">
          {/* Owner's wording, 30 Sept 2026. The company is named so that
              somebody who sees "Kernelv5" on a card statement can find the
              word on this site. Since 4 Oct 2026 the copyright carries the
              legal name, as the Terms, the DPA and the statement do. */}
          <span>
            © {new Date().getFullYear()}{' '}
            <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer">{COMPANY_LEGAL_NAME}</a>
            {' '}AgentDisk is a product by {COMPANY_NAME}.
          </span>
          <span>Files your agents can reason about.</span>
        </div>
      </div>
    </footer>
  );
}

/* ── landing pieces. Local because each is used once, inside one map. ─────── */

function TerminalPanel() {
  return (
    <div className="term">
      <div className="term__bar">
        <span className="term__dot term__dot--r" />
        <span className="term__dot term__dot--y" />
        <span className="term__dot term__dot--g" />
        <span className="term__cap">agent session</span>
      </div>
      <pre className="term__body">
        {TRANSCRIPT.map((line, i) => (
          <span key={i} className={line.tone ? `term__ln term__ln--${line.tone}` : 'term__ln'}>
            {line.text}{'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}

export function Landing() {
  return (
    <div className="mk">
      <Nav />
      <div className="mk__wrap">

        <section className="mk__hero">
          <div>
            <span className="mk__badge">
              <span className="mk__badgedot" aria-hidden="true" />
              <span className="mk__badgetext">MCP SERVER · GENERALLY AVAILABLE</span>
            </span>
            <h1 className="mk__h1">Storage your agents can actually reason about.</h1>
            <p className="mk__lead">
              AgentDisk gives every AI agent a scoped, persistent workspace for files,
              folders and metadata — over a REST API and an MCP server. You keep the
              audit log.
            </p>
            <div className="mk__ctas">
              <Button size="lg" as={Link} to="/signup"
                iconRight={<Icon name="chevronRight" size={16} />}>
                Start free
              </Button>
              {/* Straight to the docs' guided quick start, which writes a
                  path for the goal and the tool you pick. Named for what it
                  does, not for how fast it is: a first-time visitor told us
                  "Quick start" did not say there was a tour behind it.
                  "Read the docs" is the third way in, for the person who
                  would rather read the whole thing; a pill with a book mark
                  so it is seen, not a bare link that scrolled past. */}
              <Button size="lg" variant="secondary" as={Link} to="/docs/quickstart"
                className="mk__quick"
                icon={<Icon name="bolt" size={15} />}
                iconRight={<Icon name="chevronRight" size={16} />}>
                Follow the guided tour
              </Button>
              <Link to="/docs" className="mk__docs">
                <span className="mk__docsico" aria-hidden="true"><Icon name="book" size={15} /></span>
                Read the docs
                <span className="mk__docsarrow" aria-hidden="true"><Icon name="chevronRight" size={14} /></span>
              </Link>
            </div>
            <div className="mk__tags">
              {HERO_TAGS.map(t => <span key={t} className="mk__tag">{t}</span>)}
            </div>
          </div>
          <TerminalPanel />
        </section>

        {/* What it is, before how to get one: the picture answers "why not
            Drive, or my disk plus git" on the first scroll, which is the
            question first-time visitors asked us. */}
        <HomeDiagram />

        {/* The sandbox and the claim link, as the attraction they are: a disk
            with no sign-up, then one link to make it yours. Three nodes and a
            mock claim card carry it; the words are kept to what fits on a
            glance, and the docs carry the rest. */}
        <section className="mk__section">
          <div className="mk__spot">
            <div className="mk__spotglow" aria-hidden="true" />
            <div className="mk__spotcol">
              <span className="mk__kicker">NO ACCOUNT · ONE MINUTE</span>
              <h2 className="mk__spoth">A disk for your agent, before you even sign up.</h2>
              <ol className="mk__spotflow" aria-label="From sandbox to your account">
                {SPOT_FLOW.map((n, i) => (
                  <React.Fragment key={n.title}>
                    {i > 0 ? <li className="mk__spotarrow" aria-hidden="true">→</li> : null}
                    <li className={n.claim ? 'mk__spotnode mk__spotnode--claim' : 'mk__spotnode'}>
                      <span className="mk__spotnum">{n.num}</span>
                      <strong>{n.title}</strong>
                      <span className="mk__spotsub">{n.sub}</span>
                    </li>
                  </React.Fragment>
                ))}
              </ol>
              <div className="mk__ctas">
                <Button size="lg" as={Link} to="/sandbox"
                  iconRight={<Icon name="chevronRight" size={16} />}>
                  Open a sandbox
                </Button>
                <Button size="lg" variant="secondary" as={Link} to="/docs/quickstart">
                  How claiming works
                </Button>
              </div>
            </div>
            <div className="mk__spotcard" aria-hidden="true">
              <span className="mk__spotcardkick">CLAIM LINK · SHOWN ONCE</span>
              <span className="mk__spotcardurl">app.agentdisk.io/claim/••••••••</span>
              <div className="mk__spotopts">
                <span className="mk__spotopt mk__spotopt--on">Keep as new workspace</span>
                <span className="mk__spotopt">Merge into mine</span>
              </div>
              <span className="mk__spotcardfoot">
                Your agent's key keeps working · 500 MB · 3 days to claim
              </span>
            </div>
          </div>
        </section>

        <section className="mk__section">
          <div className="mk__grid4">
            {FEATURES.map(f => (
              <div key={f.kicker} className="mk__card">
                <div className="mk__kicker">{f.kicker}</div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mk__section">
          <div className="mk__panel">
            <h2 className="mk__h2">Three steps to a working agent workspace</h2>
            <div className="mk__grid3">
              {STEPS.map(s => (
                <div key={s.n} className="mk__step">
                  <div className="mk__stephead">
                    <span className="mk__stepno">{s.n}</span>
                    <span className="mk__steptitle">{s.title}</span>
                  </div>
                  <p className="mk__stepbody">{s.body}</p>
                  <pre className="mk__stepcode">{s.code}</pre>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mk__section">
          <div className="mk__band">
            <div className="mk__bandtext">
              <h2 className="mk__h2">Give an agent a disk in five minutes.</h2>
              <p className="mk__bandsub">
                The free tier is {FREE_SUMMARY}. No card, no sales call.
              </p>
            </div>
            <Button size="lg" as={Link} to="/signup">Create a workspace</Button>
          </div>
        </section>

      </div>
      <Footer />
    </div>
  );
}

/* ── pricing ──────────────────────────────────────────────────────────────── */

/**
 * One client mark on a plan card. A link into the docs section that sets the
 * client up, named for the screen reader and the hover; the SVG itself is
 * decoration. `fill` is the brand colour or `currentColor` (see clients.js).
 */
function ClientMark({ client }) {
  return (
    <Link
      to={`/docs/${client.docsId}`}
      className="mk__mark"
      title={client.name}
      aria-label={client.name}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
        <path d={client.path} fill={client.color} />
      </svg>
    </Link>
  );
}

export function Pricing() {
  // Monthly first: it is the price Stripe lists and the one a reader can
  // compare across the row without arithmetic. Yearly is one tap away and
  // wears its saving on the switch, so nothing is hidden behind the toggle.
  const [period, setPeriod] = useState('monthly');
  const yearly = period === 'yearly';

  return (
    <div className="mk">
      <Nav />
      <div className="mk__wrap">

        <section className="mk__hero mk__hero--single">
          {/* Headline and lead on the left, the billing switch on the right,
              both on the lead's baseline. The switch used to have a row of its
              own under the lead, which pushed the cards a full row down for
              two words; the space beside the headline was empty. */}
          <div className="mk__pricehead">
            <div className="mk__priceheadtext">
              {/* Requests are unlimited on every plan, so the old headline — "Pay
                  for storage and requests" — named a meter that does not exist. */}
              <h1 className="mk__h1">Pay for storage. Nothing else.</h1>
              <p className="mk__lead">
                Every plan includes the MCP server, webhooks, path-scoped keys and the
                full audit log, with unlimited requests.
              </p>
            </div>

            {/* The billing period, as a two-option switch. `aria-pressed` on
                buttons rather than a radio group: the two are commands that
                redraw the cards, and a pressed button is what the pill looks like. */}
            <div className="mk__period" role="group" aria-label="Billing period">
              {PERIODS.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  className={period === opt.id ? 'mk__periodbtn is-on' : 'mk__periodbtn'}
                  aria-pressed={period === opt.id}
                  onClick={() => setPeriod(opt.id)}
                >
                  {opt.label}
                  {opt.badge ? <span className="mk__periodbadge">{opt.badge}</span> : null}
                </button>
              ))}
            </div>
          </div>

          <div className="mk__prices">
            {PLANS.map(p => {
              const showYearly = yearly && p.yearlyPrice;
              return (
                <div key={p.id} className={p.featured ? 'mk__plan mk__plan--pop' : 'mk__plan'}>
                  <div className="mk__planhead">
                    <span className="mk__kicker">{p.kicker}</span>
                    {p.featured ? <span className="mk__planflag">RECOMMENDED</span> : null}
                  </div>
                  <div>
                    <div className="mk__planprice">
                      {showYearly ? (
                        // Twelve months at the monthly rate, struck through, so
                        // the saving is shown rather than asserted.
                        <s className="mk__pricewas">{yearlyListPrice(p)}</s>
                      ) : null}
                      <span className="mk__price">{showYearly ? p.yearlyPrice : p.price}</span>
                      <span className="mk__planunit">{showYearly ? p.yearlyUnit : p.unit}</span>
                    </div>
                    {/* One line under the price in every state, so the cards
                        stay the same height when the switch flips. */}
                    {showYearly ? (
                      <p className="mk__plansave">Save {yearlySaving(p)} · billed yearly</p>
                    ) : p.yearlyPrice ? (
                      <p className="mk__planyear">Billed monthly · or {p.yearlyPrice} {p.yearlyUnit}</p>
                    ) : (
                      <p className="mk__planyear">No card required</p>
                    )}
                  </div>
                  <div className="mk__feats">
                    {p.lines.map(l => (
                      <span key={l} className="mk__feat">
                        <Icon name="check" size={15} />
                        <span>{l}</span>
                      </span>
                    ))}
                  </div>
                  <Button
                    full
                    as={Link}
                    to={p.ctaTo}
                    variant={p.featured ? 'primary' : 'secondary'}
                  >
                    {p.cta}
                  </Button>
                  {/* The same row on every card, because the MCP server is
                      ungated: a reader compares tiers card by card, and a tier
                      without the row would read as a tier without the clients. */}
                  <div className="mk__works">
                    <span className="mk__workslabel">Works with</span>
                    <div className="mk__marks" style={{ '--marks': WORKS_WITH.length }}>
                      {WORKS_WITH.map(c => <ClientMark key={c.id} client={c} />)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Said once here rather than on four cards: every count on them is an
              account-wide total, and a reader who assumes per-workspace will be
              surprised by the first refusal rather than by the page. */}
          <p className="mk__pricenote">{COUNTING_NOTE}</p>
          {/* Disclosed before the charge, not explained after it. An
              auto-renewing subscription advertised without its terms is the
              pattern consumer-protection rules were written about. */}
          <p className="mk__pricenote">{YEARLY_NOTE} {RENEWAL_NOTE}</p>
        </section>

        {/*
          The design draws a "Metered above plan limits" table. No overage rate
          exists anywhere in the codebase, so there is nothing to put in it and
          the section renders only once OVERAGES has entries. Inventing four
          figures is how backlog/024 started.
        */}
        {OVERAGES.length > 0 ? (
          <section className="mk__section">
            <div className="mk__table">
              <div className="mk__tablehead">
                <h3 className="ad-h3">Metered above plan limits</h3>
              </div>
              {OVERAGES.map(o => (
                <div key={o.label} className="mk__tablerow">
                  <span>{o.label}</span>
                  <span className="ad-mono">{o.rate}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="mk__section">
          <div className="mk__band">
            <div className="mk__bandtext">
              <h2 className="mk__h2">Start on Free. Move up only when you need to.</h2>
              <p className="mk__bandsub">No card required, and no sales call to start.</p>
            </div>
            <Button size="lg" as={Link} to="/signup">Create a free workspace</Button>
          </div>
        </section>

      </div>
      <Footer />
    </div>
  );
}
