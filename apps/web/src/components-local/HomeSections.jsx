import React from 'react';
import { Link } from 'react-router-dom';
import { Button, Icon } from '../components/index.js';
import { FREE_SUMMARY } from '../lib/pricing.js';

/**
 * The landing page below the diagram, in the diagram's own language: a mono
 * kicker over a display heading, numbered stops, tiles for actors, path
 * chips for what a key may touch, and a hairline ring where something is
 * the centre of attention. Each section states one fact the diagram made
 * a claim about, and shows the real thing beside it: the sandbox call, the
 * scope that was denied, the command that registers the server, the log.
 *
 * Nothing here is reachable from the dashboard, so it lives beside
 * HomeDiagram rather than in the vendored components.
 */

// The same endpoint the docs print, built the same way (Docs.jsx, blog.js),
// so what a visitor copies from the home page is what the tour would give.
const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://api-dev.agentdisk.io';
const MCP_ENDPOINT = `${API_BASE}/mcp`;

/* ── 1. Sandbox to claim ─────────────────────────────────────────────────── */

const SPOT_FLOW = [
  { num: '01', title: 'Sandbox', sub: 'workspace + key, no sign-up', icon: 'bolt', chip: 'POST /v1/sandbox' },
  { num: '02', title: 'Agent works', sub: 'files land, scoped and logged', icon: 'agent', chip: 'write /agents/*' },
  { num: '03', title: 'Claim link', sub: 'one click makes it yours', icon: 'link', chip: 'shown once', claim: true },
];

export function Spotlight() {
  return (
    <section className="mk__section" aria-labelledby="spot-title">
      <div className="mk__spot">
        <div className="mk__spotglow" aria-hidden="true" />
        <div className="mk__spotcol">
          <span className="mk__kicker">NO ACCOUNT · ONE MINUTE</span>
          <h2 className="mk__spoth" id="spot-title">A disk for your agent, before you even sign up.</h2>
          <ol className="mk__spotflow" aria-label="From sandbox to your account">
            {SPOT_FLOW.map((n, i) => (
              <React.Fragment key={n.title}>
                {i > 0 ? <li className="mk__spotarrow" aria-hidden="true"><i /></li> : null}
                <li className={n.claim ? 'mk__spotnode mk__spotnode--claim' : 'mk__spotnode'}>
                  <span className="mk__spothead">
                    <span className={`hd__tile${n.claim ? ' hd__tile--share' : ''}`}><Icon name={n.icon} size={15} /></span>
                    <span className="mk__spotnum">{n.num}</span>
                  </span>
                  <strong>{n.title}</strong>
                  <span className="mk__spotsub">{n.sub}</span>
                  <span className={`hd__chip mk__spotchip${n.claim ? ' hd__chip--read' : ''}`}>{n.chip}</span>
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
  );
}

/* ── 2. Proof cards ──────────────────────────────────────────────────────── */

const FEATURES = [
  {
    kicker: 'SCOPED', icon: 'key',
    title: "Keys that can't overreach",
    body: 'Every key carries explicit scopes and an optional path prefix. A denied call is logged with the scope it needed.',
    proof: [['ops', 'read write list'], ['pathPrefix', '/agents/*']],
  },
  {
    kicker: 'PERSISTENT', icon: 'database',
    title: 'State between runs',
    body: 'Agents pick up where they left off. Notes, task lists and results written in one session are read back in the next.',
    proof: [['read_file', '/memory/tasks.md'], ['', 'next session']],
  },
  {
    kicker: 'MCP NATIVE', icon: 'terminal',
    title: 'One config block',
    body: 'File tools registered in any MCP client. No SDK, no wrapper service to maintain.',
    proof: [['claude mcp add', 'agentdisk'], ['transport', 'http']],
  },
  {
    kicker: 'AUDITED', icon: 'activity',
    title: 'Who touched what',
    body: 'Human and agent actions land in the same log, with actor, path, scope and source IP.',
    proof: [['research-bot', 'create_file'], ['/agents/research/brief.md', '✓']],
  },
];

export function Proof() {
  return (
    <section className="mk__section" aria-labelledby="proof-title">
      <div className="mk__sechead">
        <span className="mk__kicker">WHY A DISK, NOT A BUCKET</span>
        <h2 className="mk__h2" id="proof-title">Built for the way agents actually work.</h2>
      </div>
      <div className="mk__grid4">
        {FEATURES.map(f => (
          <div key={f.kicker} className="mk__card mk__card--proof">
            <div className="mk__cardhead">
              <span className="hd__tile"><Icon name={f.icon} size={15} /></span>
              <span className="mk__kicker">{f.kicker}</span>
            </div>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
            <dl className="mk__proof" aria-label="Example">
              {f.proof.map(([k, v], i) => (
                <div key={i} className="mk__proofrow">
                  {k ? <dt>{k}</dt> : <dt aria-hidden="true" />}
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── 3. Three steps ──────────────────────────────────────────────────────── */

const STEPS = [
  {
    n: '1',
    title: 'Create a key',
    body: 'Pick scopes and a prefix in the dashboard, or over the API. View it again whenever you need it.',
    caption: 'REST',
    // The real request (`routes/keys.ts`); the dashboard's Create-key dialog
    // sends the same fields.
    code: "POST /v1/keys\n{ \"name\": \"research-bot\",\n  \"ops\": [\"read\",\"write\",\"list\"],\n  \"pathPrefix\": \"/projects\" }",
  },
  {
    n: '2',
    title: 'Point your client at it',
    body: 'One command for Claude Code; one config block for Cursor, VS Code, Windsurf, Zed, Gemini CLI or Codex; one header for REST.',
    caption: 'CLAUDE CODE',
    // The same command the docs give, with the same endpoint, so what the
    // visitor copies from the home page is what the tour would have given.
    code: `claude mcp add --transport http agentdisk ${MCP_ENDPOINT} \\\n  --header "Authorization: Bearer $AGENTDISK_KEY"`,
    more: { to: '/docs/quickstart', label: 'Other tools' },
  },
  {
    n: '3',
    title: 'Let the agent work',
    body: 'Watch the audit log fill in as calls arrive, with the key, the path and the scope on every line.',
    caption: 'AUDIT LOG',
    code: "> create_file /projects/notes.md\n  ✓ 4.2 KB · sha256:c81e0f2d\n> delete_file /projects/notes.md\n  ✗ 403 scope_denied · lacks delete",
  },
];

export function Steps() {
  return (
    <section className="mk__section" aria-labelledby="steps-title">
      <div className="mk__panel mk__panel--steps">
        <div className="mk__sechead mk__sechead--tight">
          <span className="mk__kicker">FROM NOTHING TO A WORKING AGENT · FIVE MINUTES</span>
          <h2 className="mk__h2" id="steps-title">Three steps to a working agent workspace</h2>
        </div>
        <ol className="mk__grid3 mk__stepslist" aria-label="Three steps">
          {STEPS.map(s => (
            <li key={s.n} className="mk__step">
              <div className="mk__stephead">
                <span className="hd__stepno" aria-hidden="true">{s.n}</span>
                <span className="mk__steptitle">{s.title}</span>
              </div>
              <p className="mk__stepbody">{s.body}</p>
              <div className="mk__stepblock">
                <span className="mk__stepcap">{s.caption}</span>
                <pre className="mk__stepcode">{s.code}</pre>
              </div>
              {s.more ? (
                <Link to={s.more.to} className="mk__stepmore">
                  {s.more.label}
                  <Icon name="chevronRight" size={13} aria-hidden="true" />
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ── 4. Versus ───────────────────────────────────────────────────────────── */

const ROWS = [
  ['Reachable from any machine', true, false, true],
  ['Starts without an account', false, true, true],
  ['A key sees only its own path', false, false, true],
  ['Read, write, delete set per key', false, false, true],
  ['Every call logged as the agent', false, false, true],
  ['MCP tools built in', false, false, true],
  ['One link hands it to a person', true, false, true],
  ['A human owns it, agents work in it', false, false, true],
];

function Tick({ yes }) {
  return yes
    ? <span className="mk__tick mk__tick--yes"><Icon name="check" size={13} aria-hidden="true" /><span className="sr-only">yes</span></span>
    : <span className="mk__tick mk__tick--no"><Icon name="x" size={12} aria-hidden="true" /><span className="sr-only">no</span></span>;
}

export function Versus() {
  const half = Math.ceil(ROWS.length / 2);
  const cols = [ROWS.slice(0, half), ROWS.slice(half)];
  return (
    <section className="mk__section" aria-labelledby="vs-title">
      <div className="mk__sechead">
        <span className="mk__kicker">WHY NOT DRIVE, OR MY DISK PLUS GIT</span>
        <h2 className="mk__h2" id="vs-title">What an agent gets.</h2>
        <p className="mk__seclead">
          Drive-style storage signs the agent in as you: your whole account, or nothing. A local
          disk gives it everything the process can read, and git records changes without
          stopping them. Neither was built for a key that must see one folder and no more.
        </p>
      </div>
      <div className="mk__vs">
        {cols.map((rows, c) => (
          <table key={c} className="mk__vstable">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Capability</span></th>
                <th scope="col">Drive /<br />Nextcloud</th>
                <th scope="col">Local<br />+ git</th>
                <th scope="col" className="mk__vsus">Agent<br />Disk</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, a, b, us]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td><Tick yes={a} /></td>
                  <td><Tick yes={b} /></td>
                  <td className="mk__vsus"><Tick yes={us} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
      <p className="mk__vsmore">
        Longer comparisons, against the storage products built for agents:{' '}
        <Link to="/compare">all comparisons</Link>.
      </p>
    </section>
  );
}

/* ── 5. Closing band ─────────────────────────────────────────────────────── */

const BAND_TAGS = ['NO CARD REQUIRED', 'REST + MCP', 'HARD-CAPPED PRICING'];

export function Band() {
  return (
    <section className="mk__section" aria-labelledby="band-title">
      <div className="mk__band">
        <div className="mk__bandmark" aria-hidden="true">
          <img src="/agentdisk-logo.png" alt="" width="40" height="40" />
        </div>
        <div className="mk__bandtext">
          <h2 className="mk__h2" id="band-title">Give an agent a disk in five minutes.</h2>
          <p className="mk__bandsub">
            The free tier is {FREE_SUMMARY}. No card, no sales call.
          </p>
          <div className="mk__tags">
            {BAND_TAGS.map(t => <span key={t} className="mk__tag">{t}</span>)}
          </div>
        </div>
        <div className="mk__bandctas">
          <Button size="lg" as={Link} to="/signup" iconRight={<Icon name="chevronRight" size={16} />}>
            Create a workspace
          </Button>
          <Button size="lg" variant="secondary" as={Link} to="/sandbox">Open a sandbox</Button>
        </div>
      </div>
    </section>
  );
}
