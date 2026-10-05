import React from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/index.js';
import { WORKS_WITH } from '../lib/clients.js';

/**
 * The landing page's one picture of what AgentDisk is: the disk in the
 * middle, agents and applications feeding it on the left, the owner above,
 * and whoever picks the work up on the right. Three numbered steps run across
 * the top so the eye reads it left to right even though the lines radiate.
 *
 * The geometry is a 1000×600 stage. The lines are an SVG in that viewBox; the
 * nodes and the path chips are HTML placed by percentage of the stage, so
 * their type stays crisp and their size does not scale with the viewport.
 * Below 1125px the stage would be unreadable, so the whole thing restacks into
 * a plain list: inputs, the disk, outputs. Same facts, no geometry.
 *
 * Client marks come from `WORKS_WITH`, the same vendored set the pricing
 * cards use, so a tool is drawn the same everywhere on the site.
 */

const W = 1000;
const H = 600;
const HUB = { x: 500, y: 318, r: 74 };

const marks = Object.fromEntries(WORKS_WITH.map(c => [c.id, c]));

function Mark({ id, size = 15 }) {
  const m = marks[id];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d={m.path} fill={m.color} />
    </svg>
  );
}

/**
 * One node per spoke. `kind` picks the line: writes go in, reads and shares
 * come out, the owner's line comes down, and the denied one stops short of
 * the ring. `chip` is the path the key may use, printed on the spoke.
 */
const NODES = [
  { id: 'claude',  x: 118, y: 112, side: 'left',  kind: 'write',  chip: '/projectA/tech', name: 'Claude Code', sub: 'MCP', icon: <Mark id="claude" /> },
  { id: 'cursor',  x: 118, y: 212, side: 'left',  kind: 'write',  chip: '/projectB/docs', name: 'Cursor', sub: 'MCP', icon: <Mark id="cursor" /> },
  { id: 'cluster', x: 118, y: 318, side: 'left',  kind: 'write',  chip: '/projectC', name: 'Any MCP client', sub: 'Copilot · Gemini · Zed',
    icon: <span className="hd__stack"><Mark id="copilot" size={12} /><Mark id="gemini" size={12} /><Mark id="windsurf" size={12} /><Mark id="zed" size={12} /></span> },
  { id: 'custom',  x: 118, y: 424, side: 'left',  kind: 'denied', chip: '✗ 403 · /projectA/tech', name: 'Custom agent', sub: 'MCP · key scoped to /projectC', icon: <span className="hd__custom">&gt;_</span> },
  { id: 'app',     x: 118, y: 524, side: 'left',  kind: 'write',  chip: '/uploads', name: 'Your application', sub: 'REST · one header', icon: <Icon name="terminal" size={15} /> },
  { id: 'owner',   x: 500, y: 60,  side: 'top',   kind: 'owner',  chip: null, name: 'You', sub: 'dashboard · owns it all', icon: <Icon name="dashboard" size={15} /> },
  { id: 'reader',  x: 882, y: 136, side: 'right', kind: 'read',   chip: '/projectA/tech', name: 'Another agent', sub: 'reads what the first wrote', icon: <Mark id="mcp" /> },
  { id: 'writer2', x: 882, y: 246, side: 'right', kind: 'write',  chip: '/projectB/out', name: 'Agent 4', sub: 'writes the next step', icon: <Mark id="windsurf" /> },
  { id: 'customer',x: 882, y: 392, side: 'right', kind: 'share',  chip: null, name: 'Customer', sub: 'share link · download', icon: <Icon name="users" size={15} /> },
  { id: 'public',  x: 882, y: 500, side: 'right', kind: 'share',  chip: null, name: 'Public', sub: 'public link · no account', icon: <Icon name="link" size={15} /> },
];

const STEPS = [
  'Connect',
  'Write to your path',
  'Others pick it up',
];

const pct = (x, y) => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` });

function spoke(n) {
  const dx = HUB.x - n.x, dy = HUB.y - n.y;
  const d = Math.hypot(dx, dy);
  const ux = dx / d, uy = dy / d;
  const s = { x: n.x + ux * 26, y: n.y + uy * 26 };
  const e = { x: HUB.x - ux * (HUB.r + 6), y: HUB.y - uy * (HUB.r + 6) };
  if (n.kind === 'denied') {
    const q = { x: n.x + dx * 0.47, y: n.y + dy * 0.47 };
    return { x1: s.x, y1: s.y, x2: q.x, y2: q.y };
  }
  // reads and shares point away from the disk; everything else points in
  if (n.kind === 'read' || n.kind === 'share') return { x1: e.x, y1: e.y, x2: s.x, y2: s.y };
  return { x1: s.x, y1: s.y, x2: e.x, y2: e.y };
}

function chipAt(n) {
  const t = n.kind === 'read' ? 0.5 : n.kind === 'denied' ? 0.47 : 0.58;
  return pct(n.x + (HUB.x - n.x) * t, n.y + (HUB.y - n.y) * t);
}

const verb = { write: 'write', read: 'read', denied: 'write' };

function Arrow({ id, cls }) {
  return (
    <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" className={cls} />
    </marker>
  );
}

function Node({ n }) {
  return (
    <span className={`hd__node hd__node--${n.side}`} style={pct(n.x, n.y)}>
      <span className={`hd__tile hd__tile--${n.kind}`}>{n.icon}</span>
      <span className="hd__text">
        <b>{n.name}</b>
        <i>{n.sub}</i>
      </span>
    </span>
  );
}

export default function HomeDiagram() {
  return (
    <section className="mk__section hd" aria-label="How AgentDisk works">
      {/* No heading of its own: the hero's headline is the claim this
          picture draws, and repeating it put two pitches above the fold.
          The three step labels are the section's only words before the
          picture, so they are kept to one line each at every width. */}
      <ol className="hd__steps" aria-label="How it works">
        {STEPS.map((s, i) => (
          <li key={s} className="hd__step"><span className="hd__stepno" aria-hidden="true">{i + 1}</span>{s}</li>
        ))}
      </ol>

      <div className="hd__stage" role="img" aria-label="Agents and applications write to their own paths on one AgentDisk workspace; the owner sees everything; other agents, customers and the public pick files up from the other side.">
        <svg className="hd__lines" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
          <defs>
            <Arrow id="hd-m-write" cls="hd__m hd__m--write" />
            <Arrow id="hd-m-read" cls="hd__m hd__m--read" />
            <Arrow id="hd-m-share" cls="hd__m hd__m--share" />
            <Arrow id="hd-m-owner" cls="hd__m hd__m--owner" />
          </defs>
          <circle className="hd__ring" cx={HUB.x} cy={HUB.y} r={HUB.r + 40} />
          {NODES.map(n => {
            const l = spoke(n);
            const marker = n.kind === 'denied' ? undefined : `url(#hd-m-${n.kind})`;
            return <line key={n.id} className={`hd__line hd__line--${n.kind}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} markerEnd={marker} />;
          })}
        </svg>

        <div className="hd__hub">
          <img src="/agentdisk-logo.png" alt="" width="44" height="44" />
          <span className="hd__hubname">AgentDisk</span>
          <span className="hd__hubsub">EVERY CALL<br />LOGGED</span>
        </div>

        {NODES.filter(n => n.chip).map(n => (
          <span key={n.id} className={`hd__chip hd__chip--${n.kind}`} style={chipAt(n)}>
            <em>{verb[n.kind]}</em>{n.chip}
          </span>
        ))}
        {NODES.map(n => <Node key={n.id} n={n} />)}
      </div>

      {/* The same facts as a list, for narrow screens where the stage would
          not be readable. Hidden on wide screens by CSS, not by JS, so the
          prerender carries both and the browser picks. */}
      <div className="hd__list" aria-hidden="true">
        <div className="hd__col">
          <div className="hd__colhead">1 · Agents and apps connect</div>
          {NODES.filter(n => n.side === 'left').map(n => (
            <div key={n.id} className="hd__row">
              <Node n={n} />
              <span className={`hd__chip hd__chip--${n.kind}`}><em>{verb[n.kind]}</em>{n.chip}</span>
            </div>
          ))}
        </div>
        <div className="hd__col">
          <div className="hd__colhead">2 · One disk, every call logged</div>
          <div className="hd__row"><Node n={NODES.find(n => n.id === 'owner')} /></div>
        </div>
        <div className="hd__col">
          <div className="hd__colhead">3 · Others pick it up</div>
          {NODES.filter(n => n.side === 'right').map(n => (
            <div key={n.id} className="hd__row">
              <Node n={n} />
              {n.chip ? <span className={`hd__chip hd__chip--${n.kind}`}><em>{verb[n.kind]}</em>{n.chip}</span> : null}
            </div>
          ))}
        </div>
      </div>

      <p className="hd__bridge"><span>The disk that bridges agents and humans.</span></p>
      <ul className="hd__legend" aria-label="Legend">
        <li><i className="hd__sw hd__sw--write" />agent writes</li>
        <li><i className="hd__sw hd__sw--read" />agent reads</li>
        <li><i className="hd__sw hd__sw--owner" />human owns</li>
        <li><i className="hd__sw hd__sw--share" />shared out</li>
        <li><i className="hd__sw hd__sw--denied" />outside its path · 403, logged</li>
      </ul>
      <p className="hd__more">
        Every key, scope and path above is real. <Link to="/docs/quickstart">Follow the guided tour</Link> to
        set one up for your own tool, or <Link to="/compare">see how this compares</Link> to what you use today.
      </p>
    </section>
  );
}
