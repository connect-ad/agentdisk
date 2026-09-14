import React from 'react';
import { Link } from 'react-router-dom';
import { Button, Icon } from '../components/index.js';
import { useAuth } from '../lib/auth.jsx';
import { PLANS, OVERAGES } from '../lib/pricing.js';
import Logo from '../components-local/Logo.jsx';

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

const HERO_TAGS = ['NO CARD REQUIRED', 'S3-COMPATIBLE', 'EU + US REGIONS'];

/**
 * The hero transcript. `tone` colours a line; absent means body text.
 * Modelled as data rather than markup so the panel stays one element and the
 * tones stay tokens.
 */
const TRANSCRIPT = [
  { text: '> write /projects/research/corpus.parquet' },
  { text: '  ✓ 812 MB · sha256:9f2c41ab · v3', tone: 'ok' },
  { text: '' },
  { text: '> list /projects/research/*' },
  { text: '  corpus.parquet      812 MB   12m ago' },
  { text: '  embeddings.index    504 MB    3h ago' },
  { text: '  run-manifest.json    18 KB    3h ago' },
  { text: '' },
  { text: '> delete /projects/*' },
  { text: '  ✗ 403 scope_denied', tone: 'danger' },
  { text: '  key adk_live_••••4aUgT lacks delete', tone: 'warn' },
];

const FEATURES = [
  {
    kicker: 'SCOPED',
    title: "Keys that can't overreach",
    body: 'Every key carries explicit scopes and an optional path prefix. Denied calls are logged with the scope they needed.',
  },
  {
    kicker: 'PERSISTENT',
    title: 'State between runs',
    body: 'Agents pick up where they left off. Files, folders and metadata survive process restarts.',
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

const STEPS = [
  {
    n: '1',
    title: 'Create a key',
    body: 'Pick scopes and a prefix. The key is shown once.',
    code: "adk keys create \\\n  --scopes read,write,list \\\n  --prefix /projects/*",
  },
  {
    n: '2',
    title: 'Point your client at it',
    body: 'One entry in your MCP config, or one env var for REST.',
    code: "export AGENTDISK_KEY=adk_live_…\nexport AGENTDISK_WORKSPACE=ws_8f3…",
  },
  {
    n: '3',
    title: 'Let the agent work',
    body: 'Watch the audit log fill in as calls arrive.',
    code: "> write /projects/notes.md\n  ✓ 4.2 KB · v1",
  },
];

/* ── shared chrome ────────────────────────────────────────────────────────── */

export function Nav() {
  const { user } = useAuth();
  return (
    <nav className="mk__nav">
      <Link to="/" className="mk__brand">
        <Logo size={28} />
        <span className="mk__wordmark">AgentDisk</span>
      </Link>
      <span className="mk__navlinks">
        <Link to="/">Product</Link>
        <Link to="/pricing">Pricing</Link>
        <Link to="/docs">Docs</Link>
        {user ? (
          <Button size="sm" as={Link} to="/app">Open dashboard</Button>
        ) : (
          <>
            <Link to="/login">Sign in</Link>
            <Button size="sm" as={Link} to="/signup">Start free</Button>
          </>
        )}
      </span>
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="mk__foot">
      <div className="mk__wrap mk__footrow">
        <span className="mk__footbrand">
          <Logo size={22} alt="" />
          <span className="mk__footmark">AgentDisk</span>
          {/* Static in the design and static here. A live status claim needs a
              status source, and there isn't one. */}
          <span className="mk__footmeta">EU-CENTRAL-1</span>
        </span>
        <span className="mk__footlinks">
          <Link to="/docs">Docs</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
        </span>
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
              <Button size="lg" variant="secondary" as={Link} to="/docs">Read the docs</Button>
            </div>
            <div className="mk__tags">
              {HERO_TAGS.map(t => <span key={t} className="mk__tag">{t}</span>)}
            </div>
          </div>
          <TerminalPanel />
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
              <h2 className="mk__h2">Give an agent a disk in four minutes.</h2>
              <p className="mk__bandsub">
                The free tier is {PLANS[0].lines[0]} and {PLANS[0].lines[1]}.
                No card, no sales call.
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

export function Pricing() {
  return (
    <div className="mk">
      <Nav />
      <div className="mk__wrap">

        <section className="mk__hero mk__hero--single">
          <h1 className="mk__h1">Pay for storage and requests. Nothing else.</h1>
          <p className="mk__lead">
            Every plan includes the MCP server, webhooks and the full audit log.
          </p>

          <div className="mk__prices">
            {PLANS.map(p => (
              <div key={p.id} className={p.featured ? 'mk__plan mk__plan--pop' : 'mk__plan'}>
                <div className="mk__planhead">
                  <span className="mk__kicker">{p.kicker}</span>
                  {p.featured ? <span className="mk__planflag">MOST TEAMS</span> : null}
                </div>
                <div className="mk__planprice">
                  <span className="mk__price">{p.price}</span>
                  <span className="mk__planunit">{p.unit}</span>
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
              </div>
            ))}
          </div>
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
