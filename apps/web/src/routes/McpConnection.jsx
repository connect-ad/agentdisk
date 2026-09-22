import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  PageHead, Panel, CodeBlock, Badge, Button, Icon, Alert, Select,
  McpToolList, ActivityRow, EmptyState
} from '../components/index.js';
import { useResource } from '../lib/useResource.js';
import { useWorkspace } from '../lib/workspace.jsx';

/**
 * 8.18 MCP Connection — MVP-1
 * URL: /w/{ws}/mcp
 *
 * **Everything on this page is computed from the workspace's real keys and its
 * real audit log.** It previously was not, and the way it failed is worth
 * keeping written down, because all three symptoms had one cause — the page
 * described a *hypothetical* agent rather than the ones that exist:
 *
 *  - "Available tools" ticked every write tool for a key scoped `read, list`.
 *    The backend was never fooled (`tools/list` filters on scope, and
 *    `tools/call` re-asserts it, so a read-only key genuinely cannot write) —
 *    but a screen telling somebody their read-only key can `create_file` is
 *    teaching them to mistrust the scope model that is in fact protecting them.
 *  - A green "Connected" badge sat above an agent whose Last Active was Never.
 *  - "Recent MCP calls" rendered an empty box with no empty state, on a site
 *    where every other list has one.
 *
 * The scope names shown are the bare ops the API actually uses — `read`,
 * `write`, `delete`, `list` — matching the Create-key modal and the API Keys
 * table. The `files:*` spelling that used to appear here matched nothing a user
 * could see anywhere else on the site.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://api-dev.agentdisk.io';

/** The server speaks JSON-RPC at /mcp. There is no MCP surface at /v1. */
const ENDPOINT = `${API_BASE}/mcp`;
const PLACEHOLDER = '<YOUR_API_KEY>';

/**
 * The tool surface, mirroring `apps/api/src/mcp/tools.ts` — same names, same
 * ops; the descriptions are shorter paraphrases and the order is the screen's
 * own. `op` is the field the backend actually gates on, so it is the field
 * this screen ticks against; anything else here would be a second opinion
 * about a decision that has already been made in one place.
 */
const TOOLS = [
  { name: 'list_files', op: 'list', description: 'List files and folders under a path, with pagination.' },
  { name: 'search_files', op: 'list', description: 'Search files by name or path. Always restricted to the paths this key may read.' },
  { name: 'get_file', op: 'read', description: 'Get a file’s metadata together with a short-lived download URL.' },
  { name: 'get_metadata', op: 'read', description: 'Get a file’s metadata without issuing a download URL, and without counting against egress.' },
  { name: 'create_file', op: 'write', description: 'Create a file inline, or get a presigned upload URL for anything larger than 1 MB.' },
  { name: 'update_file', op: 'write', description: 'Update a file’s caption, tags or metadata. Does not change its contents.' },
  { name: 'create_folder', op: 'write', description: 'Create a folder, including any missing parents along the way.' },
  { name: 'move_file', op: 'write', description: 'Move or rename a file. Write is required at both the source and the destination.' },
  { name: 'copy_file', op: 'write', description: 'Copy a file to a new path. The bytes never travel through the client.' },
  { name: 'delete_file', op: 'delete', description: 'Permanently delete a file. Not recoverable.' }
];

/** An MCP tool call is audited as `mcp.<tool name>` (see mcp/server.ts). */
const isMcpEvent = event => typeof event.action === 'string' && event.action.startsWith('mcp.');

/** How recently a call has to have happened for "connected" to mean anything. */
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

const loadMcp = async (api, workspaceId) => {
  const [keys, agents, activity] = await Promise.all([
    api.listKeys(workspaceId),
    api.listAgents(workspaceId),
    api.listActivity(workspaceId, 200)
  ]);
  return {
    keys: keys.keys ?? [],
    agents: agents.agents ?? [],
    calls: (activity.events ?? []).filter(isMcpEvent)
  };
};

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default function McpConnection() {
  const { ws } = useParams();
  const { api, workspaceId, role } = useWorkspace();
  const [keyId, setKeyId] = useState(null);
  const [secret, setSecret] = useState(null);
  const [revealError, setRevealError] = useState(null);
  const { status, data, error, reload } = useResource(loadMcp);

  const loading = status === 'loading';
  const keys = data?.keys ?? [];
  const agents = data?.agents ?? [];
  const calls = data?.calls ?? [];

  // Only a usable key describes a usable connection. A revoked or expired key,
  // or one whose agent has been disabled, would tick tools nothing can call.
  const usableKeys = useMemo(() => keys.filter(k => k.status === 'active'), [keys]);
  const selected = usableKeys.find(k => k.id === keyId) ?? usableKeys[0] ?? null;

  const agentName = useMemo(() => {
    if (!selected?.agentId) return null;
    return agents.find(a => a.id === selected.agentId)?.name ?? selected.agentId;
  }, [selected, agents]);

  const ops = selected?.scopes?.ops ?? [];
  const pathPrefix = selected?.scopes?.pathPrefix ?? '';

  // The real key for the config block, fetched when the selection changes and
  // only for an owner: the route refuses everybody else, and asking anyway
  // would put a 403 in the console on every visit by a reader. `retrievable`
  // is false for a key minted before keys were kept; nothing can fill that in.
  const selectedId = selected?.id ?? null;
  const canFill = role === 'owner' && selected?.retrievable === true;
  useEffect(() => {
    setSecret(null);
    setRevealError(null);
    if (!canFill || selectedId === null) return undefined;
    let alive = true;
    api.revealKey(workspaceId, selectedId)
      .then(r => { if (alive) setSecret(r.secret); })
      .catch(err => { if (alive) setRevealError(err.message); });
    return () => { alive = false; };
  }, [api, workspaceId, selectedId, canFill]);

  // The whole of the Priority-0 fix: availability is the key's real ops, not a
  // fixed list. With no key selected nothing is ticked, which is also true.
  const tools = useMemo(
    () => TOOLS.map(t => ({ ...t, scope: t.op, enabled: ops.includes(t.op) })),
    [ops]
  );

  const lastCallAt = calls[0]?.at ?? null;
  const recentlyActive =
    lastCallAt !== null && Date.now() - new Date(lastCallAt).getTime() < ACTIVE_WINDOW_MS;

  /** What the badge may honestly claim, in the order the states actually occur. */
  const connection = (() => {
    if (loading) return null;
    if (usableKeys.length === 0) return { tone: 'warn', pulse: false, label: 'No usable key' };
    if (lastCallAt === null) return { tone: undefined, pulse: false, label: 'Never connected' };
    if (recentlyActive) return { tone: 'ok', pulse: true, label: 'Active now' };
    return { tone: undefined, pulse: false, label: `Last call ${relativeTime(lastCallAt)}` };
  })();

  const config = `{
  "mcpServers": {
    "agentdisk": {
      "url": "${ENDPOINT}",
      "headers": {
        "Authorization": "Bearer ${secret ?? PLACEHOLDER}"
      }
    }
  }
}`;

  const download = () => {
    const blob = new Blob([`${config}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mcp.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const keyLabel = k => {
    const agent = k.agentId ? agents.find(a => a.id === k.agentId)?.name ?? k.agentId : null;
    return `${k.name || k.prefix}${agent ? ` · ${agent}` : ''}`;
  };

  /** Why the block still says the placeholder, when it does. */
  const fillNote = (() => {
    if (secret) return 'This block carries the real key. Treat the file as a secret.';
    if (!selected) return 'Choose a key in step 1 and it is filled in here.';
    if (role !== 'owner') return 'Only the workspace owner can fill the key in. Ask them for it.';
    if (!selected.retrievable) return 'This key was created before keys were kept, so it cannot be filled in. Mint a new one.';
    if (revealError) return `Could not fetch the key: ${revealError}`;
    return 'Fetching the key…';
  })();

  return (
    <>
      <PageHead
        title="MCP connection"
        subtitle="Connect an agent over the Model Context Protocol."
        meta={
          connection ? (
            <Badge tone={connection.tone} dot pulse={connection.pulse || undefined}>
              {connection.label}
            </Badge>
          ) : null
        }
      />

      {status === 'failed' ? (
        <Alert
          tone="danger"
          title="Could not load this workspace's keys"
          actions={<Button size="sm" onClick={reload}>Try again</Button>}
        >
          {error?.message}{error?.requestId ? ` (request ${error.requestId})` : ''}
        </Alert>
      ) : null}

      {status === 'loaded' && usableKeys.length === 0 ? (
        <Alert
          tone="warn"
          title="No MCP connection yet"
          actions={<Button size="sm" as={Link} to={`/w/${ws}/keys`}>Create an MCP-scoped key</Button>}
        >
          An agent needs a live API key before it can complete the MCP handshake.
          {keys.length > 0 ? ' Every key in this workspace is revoked, expired, or blocked by a disabled agent.' : ''}
        </Alert>
      ) : null}

      {/*
        Three numbered steps rather than one panel. Step 1 chooses the key,
        step 2 is the config block with that key already in it, step 3 reports
        the real handshake state — the badge this screen computes from actual
        call history, not a fixture.

        Step 1 used to send you to the keys screen and step 2 told you to paste
        the key in by hand, because a key was shown once and stored only as a
        hash, so this screen could not fill it in. Keys are kept now (migration
        0022) and GET /v1/keys/:id/secret hands one to its owner, which is what
        the dropdown drives. The key chosen here is also the key the tools
        panel below is computed from; it had its own picker for that, and two
        pickers for one choice is how a screen contradicts itself.
      */}
      <div className="ds__step">
        <div className="ds__stephead">
          <span className="ds__stepnum">1</span>
          <span className="panel__title">Choose the key</span>
        </div>
        {status === 'loaded' && usableKeys.length === 0 ? (
          <p className="ad-small ad-measure">
            No usable key yet. <Link to={`/w/${ws}/keys`}>Create one</Link> with the narrowest
            scopes the agent needs — a research agent usually wants read, write and list
            under one prefix.
          </p>
        ) : (
          <>
            <p className="ad-small ad-measure" style={{ marginBottom: 'var(--s-5)' }}>
              The agent connects with this key. The config below and the tools further down
              both follow it.
            </p>
            <div style={{ maxWidth: '28rem' }}>
              <Select
                aria-label="API key"
                value={selected?.id ?? ''}
                options={usableKeys.map(k => ({ value: k.id, label: keyLabel(k) }))}
                onChange={e => setKeyId(e.target.value)}
                disabled={loading}
              />
            </div>
          </>
        )}
      </div>

      <div className="ds__step">
        <div className="ds__stephead">
          <span className="ds__stepnum">2</span>
          <span className="panel__title">Add the server to your client</span>
        </div>
        {/*
          One snippet, no client tabs. The tab strip that used to sit here
          changed only the filename label — all four tabs rendered this same
          JSON — and two of the clients it named cannot take this shape at all:
          Claude Desktop's config file is stdio-only, and Claude Code's
          `.mcp.json` reads a URL entry as stdio unless it carries
          `"type": "http"`. A tab that hands somebody a config their client
          rejects is worse than no tab. This is the `url` + `headers` shape
          Cursor and other URL-based clients accept as-is.
        */}
        <CodeBlock
          filename="mcp.json"
          code={config}
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon={<Icon name="download" size={13} />}
              onClick={download}
            >
              Download mcp.json
            </Button>
          }
        />
        <p className="ad-meta ad-measure" role={revealError ? 'alert' : undefined}>
          {fillNote}
        </p>
      </div>

      <div className="ds__step">
        <div className="ds__stephead">
          <span className="ds__stepnum">3</span>
          <span className="panel__title">Verify the handshake</span>
        </div>
        {/*
          The design shows a green "connected 14 minutes ago · 5 tools
          registered" line unconditionally. This reports what actually
          happened: the connection state above is derived from real call
          history, and says "Never connected" or "No usable key" when that is
          the truth. A screen that always claims success teaches people to
          distrust it the first time it is wrong.
        */}
        {connection ? (
          <Alert
            tone={connection.tone}
            title={
              connection.label === 'Active now'
                ? 'This workspace has answered an MCP call recently'
                : connection.label === 'Never connected'
                  ? 'No MCP call has reached this workspace yet'
                  : connection.label
            }
          >
            {connection.label === 'No usable key'
              ? 'An agent needs a live API key before it can complete the handshake.'
              : 'Tool availability follows the connecting key’s own scopes.'}
          </Alert>
        ) : null}
      </div>

      <Panel
        flush
        title="Available tools"
        subtitle={
          selected
            ? 'What this key can call. The server refuses everything else, whether or not a client offers it.'
            : 'Choose a key in step 1 to see what it can call.'
        }
      >
        {selected ? (
          <>
            <div style={{ padding: 'var(--s-4) var(--s-5)', borderBottom: '1px solid var(--line)' }}>
              <span className="row" style={{ gap: 'var(--s-3)', flexWrap: 'wrap' }}>
                <span className="ad-meta">
                  {selected.name || selected.prefix}
                  {agentName ? ` · ${agentName}` : ''}
                </span>
                {ops.map(op => <Badge key={op} tone="accent">{op}</Badge>)}
                <span className="ad-meta">
                  {pathPrefix ? `Limited to ${pathPrefix}/*` : 'Whole workspace'}
                </span>
              </span>
            </div>
            <McpToolList tools={tools} />
          </>
        ) : (
          <EmptyState
            compact
            icon={<Icon name="key" size={19} />}
            title="No key to compute this from"
          >
            Tool availability is decided by the connecting key's scope, so there is nothing
            truthful to show until one exists.
          </EmptyState>
        )}
      </Panel>

      <Panel flush title="Recent MCP calls">
        {loading ? null : calls.length > 0 ? (
          calls.slice(0, 20).map(event => (
            // The server audits `mcp.<tool>`, which ActivityRow has no label
            // for, so passing the raw action made every row read
            // "agt_1 mcp.list_files list_files". `mcp.call` is the one MCP
            // action the row does know ("called"), and the tool goes in the
            // resource slot. The MCP path audits only success or denied —
            // a generic failure is not audited at all — so there is no third
            // status to forward.
            <ActivityRow
              key={event.id}
              action="mcp.call"
              actor={event.actor?.id ?? '—'}
              actorType={event.actor?.type ?? 'agent'}
              resource={event.action.replace(/^mcp\./, '')}
              time={relativeTime(event.at)}
              status={event.result === 'denied' ? 'denied' : 'ok'}
              detail={event.result === 'denied' ? 'Refused by the key’s scope' : undefined}
            />
          ))
        ) : (
          <EmptyState
            compact
            icon={<Icon name="terminal" size={19} />}
            title="No MCP calls yet"
          >
            Once your agent connects and calls a tool, it shows up here and in the activity log.
          </EmptyState>
        )}
      </Panel>
    </>
  );
}
