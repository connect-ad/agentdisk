import React from 'react';
import { Icon } from '../components/index.js';

/**
 * Named architecture diagrams a blog post can place inline (7 Oct 2026).
 *
 * A post has no HTML and no image block — `lib/markdown.js` parses seven
 * block types and none of them carry markup — so a diagram is addressed by
 * name from a fenced block tagged `diagram`, and `Markdown.jsx` swaps the
 * fence for the component. An unrecognised name falls back to the ordinary
 * code block there, so a typo shows the name instead of leaving a hole.
 *
 * The geometry follows HomeDiagram.jsx, which earned it: lines are an SVG in
 * a fixed viewBox, tiles are HTML placed by percentage of the stage so their
 * type stays crisp at any width, and below 875px — where an article column
 * cannot hold four columns of labels — the stage is replaced by the same
 * facts as a list rather than being shrunk into illegibility. 875 is one of
 * the three breakpoints the stylesheet already had, and `responsive.test.jsx`
 * holds that set closed, so a diagram does not get to invent a fourth.
 *
 * `automation-lanes` draws the three automations in the post as three lanes
 * through one disk, because that is the architecture: one disk, one path
 * convention per job, and a different trigger on each lane.
 */

const W = 960;
const H = 430;

/** Lane centres, and the four stops every lane makes across the stage. */
const LANE_Y = [86, 215, 344];
const X = { trigger: 100, agent: 330, consumer: 820 };
const BAND = { x1: 455, x2: 625 };

/**
 * One lane per automation. `kind` picks the colour, and every colour is
 * paired with the lane's name in the legend and in the fallback list, so the
 * hue is never the only thing carrying the meaning.
 */
const LANES = [
  {
    id: 'memory',
    kind: 'memory',
    lane: 'Memory',
    trigger: { name: 'Session starts', sub: 'MCP client connects', icon: 'bolt' },
    agent: { name: 'Your agent', sub: 'read_file · create_file', icon: 'agent' },
    path: '/memory/',
    consumer: { name: 'Next session', sub: 'reads the state back', icon: 'refresh' },
  },
  {
    id: 'handoff',
    kind: 'handoff',
    lane: 'Handoff',
    trigger: { name: 'file.created', sub: 'webhook fires', icon: 'activity' },
    agent: { name: 'Agent A', sub: 'key scoped /inbox', icon: 'agent' },
    path: '/inbox/ → /done/',
    consumer: { name: 'Agent B', sub: 'key scoped /done', icon: 'agent' },
  },
  {
    id: 'schedule',
    kind: 'schedule',
    lane: 'Schedule',
    trigger: { name: 'Cron 06:00', sub: 'GitHub Actions', icon: 'clock' },
    agent: { name: 'Report agent', sub: 'POST /v1/files', icon: 'terminal' },
    path: '/reports/<date>/',
    consumer: { name: 'You', sub: 'dashboard · share link', icon: 'users' },
  },
];

const pct = (x, y) => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` });

/** The three arrows on a lane: into the agent, into the disk, out to whoever reads it. */
function hops(y) {
  return [
    { x1: X.trigger + 95, x2: X.agent - 100, y },
    { x1: X.agent + 100, x2: BAND.x1 - 8, y },
    { x1: BAND.x2 + 8, x2: X.consumer - 106, y },
  ];
}

function Arrow({ id, cls }) {
  return (
    <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" className={cls} />
    </marker>
  );
}

function Tile({ stop, kind }) {
  return (
    <span className="pd__tilewrap">
      <span className={`pd__tile pd__tile--${kind}`}><Icon name={stop.icon} size={15} /></span>
      <span className="pd__text">
        <b>{stop.name}</b>
        <i>{stop.sub}</i>
      </span>
    </span>
  );
}

const DIAGRAMS = {
  'automation-lanes': function AutomationLanes() {
    return (
      <figure className="pd">
        <div
          className="pd__stage"
          role="img"
          aria-label="Three automations through one AgentDisk workspace. A session start drives an agent that reads and writes /memory/, which the next session reads back. A file.created webhook drives Agent A, scoped to /inbox, writing files that Agent B picks up from /done. A six a.m. cron drives a report agent that writes /reports/<date>/, which the owner reads in the dashboard or hands out as a share link."
        >
          <svg className="pd__lines" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
            <defs>
              <Arrow id="pd-m-memory" cls="pd__m pd__m--memory" />
              <Arrow id="pd-m-handoff" cls="pd__m pd__m--handoff" />
              <Arrow id="pd-m-schedule" cls="pd__m pd__m--schedule" />
            </defs>
            <rect
              className="pd__band"
              x={BAND.x1} y={28} width={BAND.x2 - BAND.x1} height={H - 56} rx={16}
            />
            {LANES.map((l, i) => hops(LANE_Y[i]).map((h, j) => (
              <line
                key={`${l.id}-${j}`}
                className={`pd__line pd__line--${l.kind}`}
                x1={h.x1} y1={h.y} x2={h.x2} y2={h.y}
                markerEnd={`url(#pd-m-${l.kind})`}
              />
            )))}
          </svg>

          <span className="pd__bandlabel" style={pct((BAND.x1 + BAND.x2) / 2, 14)}>
            ONE WORKSPACE · EVERY CALL LOGGED
          </span>

          {LANES.map((l, i) => (
            <React.Fragment key={l.id}>
              <span className={`pd__lane pd__lane--${l.kind}`} style={pct(X.trigger - 95, LANE_Y[i] - 46)}>
                {l.lane}
              </span>
              <span className="pd__stop pd__stop--trigger" style={pct(X.trigger, LANE_Y[i])}>
                <Tile stop={l.trigger} kind={l.kind} />
              </span>
              <span className="pd__stop pd__stop--agent" style={pct(X.agent, LANE_Y[i])}>
                <Tile stop={l.agent} kind={l.kind} />
              </span>
              <span className={`pd__path pd__path--${l.kind}`} style={pct((BAND.x1 + BAND.x2) / 2, LANE_Y[i])}>
                {l.path}
              </span>
              <span className="pd__stop pd__stop--consumer" style={pct(X.consumer, LANE_Y[i])}>
                <Tile stop={l.consumer} kind={l.kind} />
              </span>
            </React.Fragment>
          ))}
        </div>

        {/* The same facts as a list, for the widths where four columns of
            labels cannot fit in an article. Hidden by CSS, not by JS, so the
            prerender carries both and the browser picks one. */}
        <div className="pd__list">
          {LANES.map(l => (
            <div key={l.id} className="pd__lrow">
              <div className={`pd__lhead pd__lhead--${l.kind}`}>{l.lane}</div>
              <ol className="pd__lsteps">
                <li><b>{l.trigger.name}</b> — {l.trigger.sub}</li>
                <li><b>{l.agent.name}</b> — {l.agent.sub}</li>
                <li><code>{l.path}</code> on one workspace, every call logged</li>
                <li><b>{l.consumer.name}</b> — {l.consumer.sub}</li>
              </ol>
            </div>
          ))}
        </div>

        <figcaption className="pd__cap">
          Three triggers, one disk. The lane is the only thing that changes: a path
          convention, a scoped key, and whoever reads it next.
        </figcaption>
      </figure>
    );
  },
};

/** Whether a name is drawable, so a caller can choose its own fallback. */
export const hasDiagram = name => Object.hasOwn(DIAGRAMS, String(name).trim());

export const DIAGRAM_NAMES = Object.keys(DIAGRAMS);

/** The diagram `name` asks for, or `null` when nothing answers to that name. */
export default function PostDiagram({ name }) {
  const Found = DIAGRAMS[String(name).trim()];
  return Found ? <Found /> : null;
}
