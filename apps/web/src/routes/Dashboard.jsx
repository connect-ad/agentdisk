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
 * recent files from `GET /v1/files`, the agent count from `GET /v1/agents`.
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
  const [me, files, agents] = await Promise.all([
    api.whoami(workspaceId),
    api.listFiles(workspaceId, { limit: '5' }),
    api.listAgents(workspaceId)
  ]);
  return { me, files: files.files ?? [], agents: agents.agents ?? [] };
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
        Quick start, from the design. Three cards rather than one code block.
        They are links to the screens that actually do each step, so every one
        goes somewhere real.
      */}
      <div>
        <h2 className="ds__h2">Quick start</h2>
        <div className="ds__quick">
          {[
            { n: '1', title: 'Create a scoped key', body: 'Read, write, list or delete — optionally locked to one path prefix.', cta: 'Create key', to: `${root}/keys` },
            { n: '2', title: 'Connect over MCP', body: 'Paste one config block into Claude Desktop, VS Code or the CLI.', cta: 'View setup', to: `${root}/mcp` },
            { n: '3', title: 'Give an agent a folder', body: 'Scope it to a path prefix and watch the audit log fill in.', cta: 'Open Files', to: `${root}/files` },
          ].map(q => (
            <Link key={q.n} to={q.to} className="ds__qcard">
              <span className="ds__qnum">{q.n}</span>
              <span className="ds__qtitle">{q.title}</span>
              <span className="ds__qbody">{q.body}</span>
              <span className="ds__qcta">{q.cta}<Icon name="chevronRight" size={13} /></span>
            </Link>
          ))}
        </div>
      </div>

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
