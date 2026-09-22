import React, { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Panel, DataTable, FileCell, Button, Icon,
  EmptyState, CodeBlock, Alert
} from '../components/index.js';
import { useResource } from '../lib/useResource.js';
import { useWorkspace } from '../lib/workspace.jsx';

/**
 * 8.8 Dashboard / Overview — MVP-0
 * URL: /w/{workspaceId}
 *
 * Every figure comes from the API: quotas and plan from `GET /v1/whoami`,
 * recent files from `GET /v1/files`, the agent count from `GET /v1/agents`,
 * and the quick start's ticks from those plus `GET /v1/keys` and
 * `GET /v1/activity`.
 * None of them is decorative, and none may become so — a dashboard with one
 * made-up number is worse than one with a gap in it, because you cannot tell
 * which of the others to trust. The agents tile read a fixed "Not built yet"
 * for long enough that a workspace with a live agent and a workspace with none
 * rendered identically; if a figure ever loses its endpoint again, say so in
 * the tile rather than leaving a plausible digit behind.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://api-dev.agentdisk.io';

const QUICK_START = `curl -X POST ${API_BASE}/v1/files \\
  -H "Authorization: Bearer $AGENTDISK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"path":"/notes.md","mimeType":"text/markdown","mode":"inline","content":"<base64>"}'`;

/**
 * The quick start, in the order the product needs it done.
 *
 * It opens on the agent, and used not to: the sequence ran key -> MCP ->
 * "give an agent a folder", so the last step named an agent no earlier step
 * had told anybody to create. Nothing failed - `keys.agent_id` is nullable
 * and a workspace-level key works on its own - so you reached the end holding
 * a credential attributed to nobody, which is the opposite of what this
 * product is for. The order is not presentational: attribution is chosen when
 * the key is minted and no screen re-attributes one afterwards, so the agent
 * genuinely has to exist first.
 *
 * `to` is workspace-relative; the screen prepends its own root.
 */
const STEPS = [
  { title: 'Create an agent', body: 'Give it a name.', cta: 'Add agent', to: '/agents' },
  { title: 'Create a key', body: 'Choose what it can read and write.', cta: 'Create key', to: '/keys' },
  { title: 'Connect it', body: 'Paste one config block into your MCP client.', cta: 'View setup', to: '/mcp' },
  { title: 'See it work', body: 'Its actions appear in Activity, under its name.', cta: 'Open Activity', to: '/activity' }
];

/**
 * Which steps are done, read off the same API as everything else here.
 *
 * Each step counts only once the one before it does. Without that, a
 * workspace-level key that has been used would tick "connect it" while "create
 * a key" sat untouched, and a list that says you are past a step you have not
 * done is not a sequence any more. The "for it" in step 2 is literal: a key
 * with no agent does not satisfy it, because the whole point of the order is
 * that the key is attributed.
 *
 * Step 3 ticks on any key's first use. The key row cannot tell MCP from REST -
 * `last_used_at` is one column - and asking activity to distinguish them would
 * be inventing a field it does not have.
 */
function stepsDone({ agents, keys, events }) {
  const each = [
    agents.length > 0,
    keys.some(k => k.agentId && k.revokedAt === null),
    keys.some(k => k.lastUsedAt !== null),
    events.some(e => e.actor?.type === 'agent')
  ];
  const done = [];
  for (let i = 0; i < each.length; i += 1) done.push(each[i] && (i === 0 || done[i - 1]));
  return done;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 172800) return 'yesterday';
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const loadOverview = async (api, workspaceId) => {
  const [me, files, agents, keys, activity] = await Promise.all([
    api.whoami(workspaceId),
    api.listFiles(workspaceId, { limit: '5' }),
    api.listAgents(workspaceId),
    api.listKeys(workspaceId),
    api.listActivity(workspaceId)
  ]);
  return {
    me,
    files: files.files ?? [],
    agents: agents.agents ?? [],
    keys: keys.keys ?? [],
    events: activity.events ?? []
  };
};

export default function Dashboard() {
  const { ws } = useParams();
  const { canWrite, workspaceId } = useWorkspace();
  const root = `/w/${ws}`;
  const { status, data, error, reload } = useResource(loadOverview);

  const loading = status === 'loading';
  const usage = data?.me?.usage ?? {};
  const plan = data?.me?.workspace?.plan ?? '—';
  const files = data?.files ?? [];

  const storageUsed = usage.storageBytes?.used ?? 0;
  const storageMax = usage.storageBytes?.max ?? 0;
  const storagePct = storageMax > 0 ? Math.round((storageUsed / storageMax) * 100) : 0;
  const requestsUsed = usage.requests?.used ?? 0;
  const requestsMax = usage.requests?.max ?? 0;
  const fileCount = usage.files?.used ?? 0;

  // `GET /v1/agents` has existed all along; this tile just never called it and
  // read "Not built yet" on a workspace with a live agent in it.
  const agents = data?.agents ?? [];
  const agentCount = agents.length;
  const activeAgents = agents.filter(a => a.status === 'active').length;

  const done = stepsDone({ agents, keys: data?.keys ?? [], events: data?.events ?? [] });
  const next = done.indexOf(false);

  const empty = status === 'loaded' && fileCount === 0;

  const rows = useMemo(
    () =>
      files.map(f => ({
        id: f.id,
        name: f.name,
        meta: f.path?.replace(/\/[^/]*$/, '') || '/',
        type: f.mimeType ?? 'application/octet-stream',
        size: formatBytes(f.sizeBytes),
        modified: relativeTime(f.updatedAt),
        agent: typeof f.createdBy === 'string' && f.createdBy.startsWith('agt_')
      })),
    [files]
  );

  const columns = [
    {
      key: 'name',
      header: 'Name',
      primary: true,
      render: r => <FileCell name={r.name} kind={r.kind} meta={r.meta} agentWritten={r.agent} />
    },
    { key: 'type', header: 'Type', width: 140, render: r => <span className="ad-mono-sm">{r.type}</span> },
    { key: 'size', header: 'Size', align: 'right', width: 96, mono: true },
    {
      key: 'modified',
      header: 'Modified',
      width: 160,
      render: r => <span style={{ color: 'var(--ink-3)' }}>{r.modified}</span>
    }
  ];

  return (
    <>
      {/*
        No page head here.

        The design goes straight from the tab bar to the content, because the
        strip above already names the workspace, shows the ws_... ID with its
        copy button, and carries the plan. Repeating all three in a heading was
        the same identifier twice on one screen, each with its own copy button —
        which invites the question of which one is the real value.

        The upload action moves to Files, which is where uploading happens and
        where the design puts it.
      */}
      {status === 'failed' ? (
        <Alert
          tone="danger"
          title="Could not load this workspace"
          actions={<Button size="sm" onClick={reload}>Try again</Button>}
        >
          {error?.message}{error?.requestId ? ` (request ${error.requestId})` : ''}
        </Alert>
      ) : null}

      {/*
        The design warns at 78%, well before the limit, because the point of
        the warning is to be seen while there is still time to act — at 95% the
        next upload is already likely to fail. Tone follows severity, and the
        percentage is in the text, so the warning never rests on colour alone.
      */}
      {storagePct >= 75 && !loading ? (
        <Alert
          tone={storagePct >= 90 ? 'danger' : 'warn'}
          title={`Storage is at ${storagePct}% of your ${plan} plan limit`}
          actions={<Button size="sm" variant="secondary" as={Link} to={`${root}/usage`}>Review usage</Button>}
        >
          Agents receive <code className="inline">507 Insufficient Storage</code> once the
          quota is reached. Free space by deleting files, or move to a larger plan.
        </Alert>
      ) : null}

      {/*
        The four headline figures moved into the shell (Layer 2 of the
        design), so they sit above the tab bar and are present on every screen
        rather than only here. WorkspaceStats fetches whoami once for all tabs,
        which is one round trip fewer than this screen used to make.
      */}

      {/*
        Quick start as a sequence, not four doors. The design drew four equal
        cards, each a link, and that read as four things to choose between;
        they are four things to do in order, and the line down the left is the
        dependency drawn. So there is one link in the whole section, on the
        step that is next - the other three are not somewhere to go yet.

        Only once loaded, because the ticks are data: rendering four grey
        steps and then ticking them a moment later would show a state that was
        never true. And it goes once every step is done, the way "Your first
        file" gives way to "Recent files" - a completed quick start is not a
        quick start.
      */}
      {status === 'loaded' && next !== -1 ? (
        <div>
          <h2 className="ds__h2">Quick start</h2>
          <ol className="ds__steps">
            {STEPS.map((step, i) => {
              const state = done[i] ? 'done' : i === next ? 'next' : 'later';
              return (
                <li key={step.to} className={`ds__step ds__step--${state}`}>
                  {/* The mark is decorative: the state is read out in words below. */}
                  <span className="ds__stepmark" aria-hidden="true">
                    {done[i] ? <Icon name="check" size={13} /> : i + 1}
                  </span>
                  <span className="ds__steptext">
                    <span className="ds__steptitle">
                      <span className="sr-only">Step {i + 1}, {state}. </span>
                      {step.title}
                      {state === 'next' ? (
                        <Link to={`${root}${step.to}`} className="ds__stepgo">
                          {step.cta}<Icon name="chevronRight" size={13} />
                        </Link>
                      ) : null}
                    </span>
                    <span className="ds__stepbody">{step.body}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      {empty ? (
        <Panel title="Your first file">
          <EmptyState icon={<Icon name="folder" size={19} />} title="Nothing here yet">
            Mint an API key, then have an agent write its first file. Everything it does will show
            up here.
          </EmptyState>
          <CodeBlock filename="Upload your first file" code={QUICK_START} />
        </Panel>
      ) : (
        <Panel
          flush
          title="Recent files"
          actions={<Button size="sm" variant="link" as={Link} to={`${root}/files`}>View all</Button>}
        >
          <DataTable columns={columns} rows={loading ? [] : rows} loading={loading} skeletonRows={5} />
        </Panel>
      )}

      {/*
        The design also draws a "Storage by type" breakdown here. There is no
        endpoint that returns storage grouped by mime type, and this screen's
        rule — stated at the top of this file — is that every figure comes from
        the API. A plausible-looking breakdown of invented proportions is
        exactly the decorative number that rule exists to prevent, so the panel
        is left out until the data exists rather than filled in.
      */}
    </>
  );
}
