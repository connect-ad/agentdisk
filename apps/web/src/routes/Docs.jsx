import React, { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Nav, Footer } from './Marketing.jsx';

/**
 * The documentation — one page, nine sections, written from the code.
 *
 * Rebuilt 26 September 2026. The previous page was a single MCP quickstart
 * whose sidebar named eight pages that did not exist, and whose key placeholder
 * used a prefix this API has never issued. This is the whole thing: what the
 * product is, how to connect every client, what it does, and how data is kept,
 * deleted and protected.
 *
 * ── Every claim here has a source in `apps/api` ───────────────────────────
 * The tool list is `mcp/tools.ts`; the scope vocabulary is `auth/scopes.ts`;
 * the key prefix is `lib/keys.ts`; the plan table is `lib/plans.ts`; deletion
 * semantics are `routes/files.ts`, `routes/account.ts` and
 * `jobs/pending-deletions.ts`; the webhook signature is
 * `jobs/webhook-delivery.ts`; the error codes are `lib/errors.ts`. When the
 * code changes, this page is wrong until somebody changes it too — there is no
 * generated `openapi.yaml` yet, so `test/docs.test.jsx` pins the parts most
 * likely to drift (tool names, key prefix, section ids).
 *
 * ── What it deliberately does NOT say ─────────────────────────────────────
 * Nothing that is not built. Prices are not repeated here because they live in
 * Stripe and on /pricing; plan *count* gates (agents, keys, members,
 * workspaces) are described as the plan's terms and flagged as not yet on the
 * write path, because they are not (`backlog/001` task 10). Delivery history
 * for webhooks is not promised. Encryption is described as Cloudflare's at-rest
 * encryption, not end-to-end, because that is what it is.
 *
 * ── Layout ────────────────────────────────────────────────────────────────
 * The design's three columns: a table of contents, the article, and an
 * "on this page" rail. The TOC is real links now; the rail follows the section
 * in view. `/docs/<section>` deep-links to a section, and `/docs#<id>` works
 * too.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://api-dev.agentdisk.io';
const MCP_ENDPOINT = `${API_BASE}/mcp`;
const KEY_PLACEHOLDER = 'ask_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

/* ── section registry ──────────────────────────────────────────────────────
   Order here is the order on the page, in the TOC, and in the rail. */
const SECTIONS = [
  { id: 'overview', label: 'Overview', group: 'START HERE',
    subs: ['What AgentDisk is', 'How it fits together', 'The entity model', 'Two surfaces, one authorization chain'] },
  { id: 'quickstart', label: 'Quick start', group: 'START HERE',
    subs: ['Let me guide', 'Before you begin', '1. Get a workspace', '2. Create an agent and a key', '3. Connect your AI tool', '4. Verify the connection', '5. Use the REST API', 'Troubleshooting'] },
  { id: 'features', label: 'Features', group: 'PRODUCT',
    subs: ['Files and folders', 'Agents and scoped keys', 'The MCP server', 'Workspaces and claiming', 'Members', 'Share links', 'Webhooks', 'Activity log', 'Usage, plans and billing', 'The dashboard'] },
  { id: 'data-security', label: 'Data security', group: 'TRUST',
    subs: ['Where your data lives', 'Tenant isolation', 'Encryption', 'Credentials', 'Upload and download integrity', 'What we log'] },
  { id: 'deleting-data', label: 'Deleting your data', group: 'TRUST',
    subs: ['Files', 'Folders', 'Agents and keys', 'Share links and webhooks', 'A whole workspace', 'Exporting first'] },
  { id: 'deleting-account', label: 'Deleting your account', group: 'TRUST',
    subs: ['How to do it', 'What happens, in order', 'What outlives the account', 'If you were a guest'] },
  { id: 'privacy', label: 'Privacy', group: 'TRUST',
    subs: ['What we collect', 'What we never see', 'Processors', 'Retention', 'Cookies', 'International transfers', 'Children', 'Your rights', 'Changes and contact'] },
  { id: 'terms', label: 'Terms of Service', group: 'TRUST',
    subs: ['Acceptance', 'Acceptable use', 'Your responsibility for content', 'Prohibited content', 'API and automated agent use', 'Limits and fair use', 'Storage limits', 'Account suspension', 'Your right to delete', 'Billing', 'Intellectual property', 'Third-party services', 'Warranties', 'Limitation of liability', 'Termination', 'Changes to these Terms', 'Governing law'] },
  { id: 'safety', label: 'Safety', group: 'TRUST',
    subs: ['The platform', 'The request path', 'The edges', 'The operators', 'How we know it works', 'What we do not claim', 'Reporting a vulnerability'] },
  { id: 'reference', label: 'Reference', group: 'REFERENCE',
    subs: ['REST endpoints', 'Error codes', 'Webhook events', 'Activity events', 'Limits'] },
];

const GROUPS = SECTIONS.reduce((acc, s) => {
  (acc[s.group] ??= []).push(s);
  return acc;
}, {});

const slug = text => text.toLowerCase().replace(/^\d+\.\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ── data ────────────────────────────────────────────────────────────────── */

/** `mcp/tools.ts` — the ten tools, in registration order, with the scope each needs. */
export const MCP_TOOLS = [
  { name: 'list_files', body: 'List files and folders under a path, with pagination.', scope: 'list' },
  { name: 'search_files', body: 'Match a substring against name and path. Results never leave the key’s prefix.', scope: 'list' },
  { name: 'get_file', body: 'Metadata plus a short-lived download URL. Counts against egress.', scope: 'read' },
  { name: 'get_metadata', body: 'Metadata only, no download URL. Free of egress.', scope: 'read' },
  { name: 'create_file', body: 'Base64 content up to 1 MB inline, or a presigned upload URL above it.', scope: 'write' },
  { name: 'update_file', body: 'Change caption, tags or custom metadata. Bytes are immutable.', scope: 'write' },
  { name: 'delete_file', body: 'Permanent. The bytes and the record go in the same request.', scope: 'delete' },
  { name: 'create_folder', body: 'Create a folder and any missing parents.', scope: 'write' },
  { name: 'move_file', body: 'Move or rename. Write is required at both the source and the destination.', scope: 'write' },
  { name: 'copy_file', body: 'Copy inside storage. Read at the source, write at the destination.', scope: 'write' },
];

/** `lib/plans.ts` — the floor every plan resolves to when the catalogue is silent. */
const PLANS = [
  { name: 'Free', storage: '1 GB', files: '10,000', egress: '10 GB', file: '100 MB', agents: '1', keys: '2', members: '1', workspaces: '1', shares: '0' },
  { name: 'Basic', storage: '5 GB', files: '100,000', egress: '50 GB', file: '500 MB', agents: '5', keys: '6', members: '2', workspaces: '3', shares: '10' },
  { name: 'Pro', storage: '50 GB', files: '1,000,000', egress: '500 GB', file: '1 GB', agents: '10', keys: '20', members: '5', workspaces: '10', shares: '100' },
  { name: 'Team', storage: '500 GB', files: '10,000,000', egress: '5,000 GB', file: '4.9 GB', agents: '50', keys: '100', members: '25', workspaces: '50', shares: 'Unlimited' },
];

/** `index.ts` — the customer route table. Admin routes are omitted on purpose. */
const ROUTES = [
  ['Self', [
    ['GET', '/v1/whoami', 'Who am I, which workspace, what scopes, how much room is left'],
    ['GET', '/v1/healthz', 'Public liveness check'],
    ['POST', '/v1/me/logout-all', 'Revoke every browser session (person only)'],
    ['DELETE', '/v1/me', 'Close the account (person only, email confirmation in body)'],
    ['POST', '/v1/support', 'Send a support request from the signed-in address'],
  ]],
  ['Workspaces', [
    ['GET', '/v1/workspaces', 'The workspaces the signed-in person can reach'],
    ['POST', '/v1/workspaces', 'Signed in: add a workspace. No credential: bot-checked sandbox'],
    ['PATCH', '/v1/workspaces/:id', 'Rename. The slug never changes'],
    ['DELETE', '/v1/workspaces/:id', 'Destroy a workspace (owner, name in body, never the last one)'],
    ['GET', '/v1/workspaces/claim/:token', 'Preview a sandbox claim, no credential'],
    ['POST', '/v1/workspaces/claim/:token', 'Claim it: keep as new, or merge into one you own'],
  ]],
  ['Files', [
    ['GET', '/v1/files', 'List under a path (default 50, max 200 per page)'],
    ['POST', '/v1/files', 'Create: inline base64 up to 1 MB, or declare sizeBytes for a presigned PUT'],
    ['POST', '/v1/files/:id/complete', 'Confirm a presigned upload; the size is re-read from storage'],
    ['GET', '/v1/files/:id', 'Metadata and a one-hour download URL'],
    ['GET', '/v1/files/:id/download', 'A one-hour presigned GET, counted as egress'],
    ['PATCH', '/v1/files/:id', 'Caption, tags, custom metadata'],
    ['POST', '/v1/files/:id/move', 'Move or rename'],
    ['POST', '/v1/files/:id/copy', 'Copy inside storage'],
    ['DELETE', '/v1/files/:id', 'Permanent deletion'],
    ['GET', '/v1/search', 'Substring match on name, path, caption and tags'],
  ]],
  ['Folders', [
    ['GET', '/v1/folders', 'List folders'],
    ['POST', '/v1/folders', 'Create, including missing parents'],
    ['DELETE', '/v1/folders/:id', 'Delete an empty folder (emptiness is decided by path)'],
  ]],
  ['Agents and keys', [
    ['GET', '/v1/agents', 'List agents'],
    ['POST', '/v1/agents', 'Create an agent identity'],
    ['GET', '/v1/agents/:id', 'One agent'],
    ['PATCH', '/v1/agents/:id', 'Rename, enable or disable (disabling stops every key it holds)'],
    ['DELETE', '/v1/agents/:id', 'Soft delete; its keys are revoked'],
    ['GET', '/v1/keys', 'List keys'],
    ['POST', '/v1/keys', 'Mint a key, never broader than the minter (needs keys:create)'],
    ['GET', '/v1/keys/:id/secret', 'Reveal a kept key (owner, signed in, audited as key.revealed)'],
    ['PATCH', '/v1/keys/:id', 'Disable, or re-enable, which issues a new secret'],
    ['DELETE', '/v1/keys/:id', 'Remove the key'],
  ]],
  ['Sharing, members, webhooks, activity', [
    ['GET', '/v1/shares', 'List share links'],
    ['POST', '/v1/shares', 'Create a link for a file or a folder, up to 7 days, optional password'],
    ['DELETE', '/v1/shares/:id', 'Revoke a link'],
    ['GET', '/v1/shares/open/:token', 'Public: preview a link (POST with a password when one is set)'],
    ['GET', '/v1/shares/open/:token/download/:fileId', 'Public: download one file from a link'],
    ['GET', '/v1/members', 'List members'],
    ['POST', '/v1/members', 'Invite an existing account as a reader (owner only)'],
    ['PATCH', '/v1/members/:id', 'Change a role (owner only)'],
    ['DELETE', '/v1/members/:id', 'Remove a member (owner only)'],
    ['GET', '/v1/webhooks', 'List endpoints'],
    ['POST', '/v1/webhooks', 'Register an endpoint; the signing secret is shown once'],
    ['PATCH', '/v1/webhooks/:id', 'Change URL, events or status'],
    ['DELETE', '/v1/webhooks/:id', 'Remove an endpoint'],
    ['GET', '/v1/activity', 'The audit trail (default 50, max 200)'],
  ]],
  ['Billing', [
    ['GET', '/v1/billing', 'Plan, period, status'],
    ['POST', '/v1/billing/checkout-session', 'Start a hosted checkout for a plan and an interval'],
    ['POST', '/v1/billing/portal-session', 'Open the billing portal for the card and invoices'],
    ['POST', '/v1/billing/change-plan', 'Upgrade now and prorated, or downgrade at the period end'],
    ['POST', '/v1/billing/cancel', 'Cancel at the period end'],
    ['POST', '/v1/billing/resume', 'Take a cancellation back before the date arrives'],
  ]],
];

/** `lib/errors.ts` */
const ERRORS = [
  ['400', 'VALIDATION_ERROR', 'The body or query did not validate. The message says which field.'],
  ['401', 'UNAUTHORIZED', 'The credential was not accepted. Always the same body, whatever the reason.'],
  ['403', 'FORBIDDEN', 'Authenticated, but this operation, path or role is outside what the credential holds.'],
  ['404', 'NOT_FOUND', 'No such route or resource. A file outside your prefix answers this, not 403.'],
  ['409', 'CONFLICT', 'The state refuses it: a path already exists, a file is already deleted, a billing call failed.'],
  ['413', 'PAYLOAD_TOO_LARGE', 'Inline content over 1 MB, or a file over the plan’s per-file cap.'],
  ['429', 'LIMIT_EXCEEDED', 'A quota or rate limit. details.limit names the dimension.'],
  ['500', 'INTERNAL_ERROR', 'Our fault. The requestId in the body is what to quote to support.'],
];

/** `routes/webhooks.ts` */
const WEBHOOK_EVENTS = ['file.created', 'file.updated', 'file.deleted', 'folder.created', 'folder.deleted'];

/** `lib/audit.ts` and the routes that write to it. */
const AUDIT_EVENTS = [
  'file.created', 'file.deleted', 'mcp.<tool>',
  'agent.created', 'agent.updated', 'agent.deleted', 'agent.claimed_and_merged',
  'key.created', 'key.rotated', 'key.disabled', 'key.deleted', 'key.revealed',
  'member.added', 'member.role_changed', 'member.removed',
  'share.created', 'share.revoked',
  'webhook.created', 'webhook.updated', 'webhook.deleted',
  'workspace.claimed', 'workspace.renamed',
];

/* ── client configurations ─────────────────────────────────────────────────
   Every one of these is the same server, the same URL and the same header;
   only the file and the spelling differ per client. The shapes follow each
   client's own published configuration format. Where a client reads a bare
   `url` entry as stdio (Claude Code) or cannot take a URL at all (Claude
   Desktop), the snippet says so instead of handing over a config that fails. */

const CFG_GENERIC = `{
  "mcpServers": {
    "agentdisk": {
      "url": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer ${KEY_PLACEHOLDER}"
      }
    }
  }
}`;

const CFG_CLAUDE_CODE_CLI = `export AGENTDISK_KEY=${KEY_PLACEHOLDER}
claude mcp add --transport http agentdisk ${MCP_ENDPOINT} \\
  --header "Authorization: Bearer $AGENTDISK_KEY"`;

const CFG_CLAUDE_CODE_JSON = `{
  "mcpServers": {
    "agentdisk": {
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer ${KEY_PLACEHOLDER}"
      }
    }
  }
}`;

const CFG_CLAUDE_DESKTOP = `{
  "mcpServers": {
    "agentdisk": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "${MCP_ENDPOINT}",
        "--header", "Authorization:\${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer ${KEY_PLACEHOLDER}"
      }
    }
  }
}`;

const CFG_VSCODE = `{
  "servers": {
    "agentdisk": {
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer ${KEY_PLACEHOLDER}"
      }
    }
  }
}`;

const CFG_WINDSURF = `{
  "mcpServers": {
    "agentdisk": {
      "serverUrl": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer ${KEY_PLACEHOLDER}"
      }
    }
  }
}`;

const CFG_ZED = `{
  "context_servers": {
    "agentdisk": {
      "source": "custom",
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "${MCP_ENDPOINT}",
        "--header", "Authorization:\${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer ${KEY_PLACEHOLDER}"
      }
    }
  }
}`;

const CFG_CODEX = `[mcp_servers.agentdisk]
url = "${MCP_ENDPOINT}"
http_headers = { Authorization = "Bearer ${KEY_PLACEHOLDER}" }`;

const CFG_GEMINI = `{
  "mcpServers": {
    "agentdisk": {
      "httpUrl": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer ${KEY_PLACEHOLDER}"
      }
    }
  }
}`;

const CFG_CURL_MCP = `curl -s -X POST ${MCP_ENDPOINT} \\
  -H "Authorization: Bearer $AGENTDISK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

const CFG_CURL_CALL = `curl -s -X POST ${MCP_ENDPOINT} \\
  -H "Authorization: Bearer $AGENTDISK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"list_files","arguments":{"path":"/"}}}'`;

const CLIENTS = [
  {
    id: 'claude-code', name: 'Claude Code',
    intro: 'One command registers the server for the current project. The transport has to be named: a bare url entry in .mcp.json is read as a stdio server and fails to start.',
    blocks: [
      { caption: 'TERMINAL', code: CFG_CLAUDE_CODE_CLI },
      { caption: '.MCP.JSON (EQUIVALENT)', code: CFG_CLAUDE_CODE_JSON },
    ],
  },
  {
    id: 'claude-desktop', name: 'Claude Desktop',
    intro: 'Claude Desktop’s config file starts local stdio servers only, so it needs a small bridge. mcp-remote turns the HTTP server into one. The header is passed through an environment variable because the app does not reliably forward arguments that contain spaces. Settings → Developer → Edit Config opens the file.',
    blocks: [{ caption: 'CLAUDE_DESKTOP_CONFIG.JSON', code: CFG_CLAUDE_DESKTOP }],
  },
  {
    id: 'cursor', name: 'Cursor',
    intro: 'Cursor accepts the URL shape as-is. Put it in .cursor/mcp.json in the project, or ~/.cursor/mcp.json for every project, then enable the server under Settings → MCP.',
    blocks: [{ caption: '.CURSOR/MCP.JSON', code: CFG_GENERIC }],
  },
  {
    id: 'vscode', name: 'VS Code (GitHub Copilot)',
    intro: 'VS Code keeps MCP servers under a servers key, not mcpServers, and needs the transport named. Save it as .vscode/mcp.json in the workspace, then run MCP: List Servers from the command palette and start it.',
    blocks: [{ caption: '.VSCODE/MCP.JSON', code: CFG_VSCODE }],
  },
  {
    id: 'windsurf', name: 'Windsurf',
    intro: 'Windsurf spells the endpoint serverUrl. The file is ~/.codeium/windsurf/mcp_config.json, also reachable from the Cascade panel’s MCP settings.',
    blocks: [{ caption: 'MCP_CONFIG.JSON', code: CFG_WINDSURF }],
  },
  {
    id: 'zed', name: 'Zed',
    intro: 'Zed launches context servers as local commands, so it uses the same mcp-remote bridge as Claude Desktop. Add this to settings.json.',
    blocks: [{ caption: 'SETTINGS.JSON', code: CFG_ZED }],
  },
  {
    id: 'codex', name: 'OpenAI Codex CLI',
    intro: 'Codex reads TOML from ~/.codex/config.toml. HTTP servers take a url plus a table of headers.',
    blocks: [{ caption: '~/.CODEX/CONFIG.TOML', code: CFG_CODEX }],
  },
  {
    id: 'gemini', name: 'Gemini CLI',
    intro: 'Gemini CLI distinguishes a streamable-HTTP server with httpUrl. The file is ~/.gemini/settings.json, or .gemini/settings.json inside a project.',
    blocks: [{ caption: 'SETTINGS.JSON', code: CFG_GEMINI }],
  },
  {
    id: 'any-client', name: 'Any other MCP client, or a script',
    intro: 'The server speaks JSON-RPC 2.0 over streamable HTTP (protocol version 2025-06-18) and takes the key as a Bearer token. Anything that can POST JSON can use it directly.',
    blocks: [
      { caption: 'LIST THE TOOLS YOUR KEY CAN SEE', code: CFG_CURL_MCP },
      { caption: 'CALL ONE', code: CFG_CURL_CALL },
    ],
  },
];

/* ── REST snippets ───────────────────────────────────────────────────────── */

const REST_WHOAMI = `curl ${API_BASE}/v1/whoami \\
  -H "Authorization: Bearer $AGENTDISK_KEY"`;

const REST_INLINE = `curl -X POST ${API_BASE}/v1/files \\
  -H "Authorization: Bearer $AGENTDISK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "path": "/notes/hello.txt",
    "mimeType": "text/plain",
    "content": "'"$(printf 'hello from an agent' | base64)"'"
  }'`;

const REST_PRESIGNED = `# 1. Declare the file. You get a presigned PUT back.
curl -X POST ${API_BASE}/v1/files \\
  -H "Authorization: Bearer $AGENTDISK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"path":"/reports/q3.pdf","mimeType":"application/pdf","sizeBytes":8421376}'
# → { "file": { "id": "file_…", "status": "pending" },
#     "upload": { "method": "PUT", "url": "https://…", "expiresAt": "…" } }

# 2. Send the bytes straight to storage. The API is not in this path.
curl -X PUT "$UPLOAD_URL" -H "Content-Type: application/pdf" --data-binary @q3.pdf

# 3. Tell the API you are done. It reads the real size from storage and books it.
curl -X POST ${API_BASE}/v1/files/$FILE_ID/complete \\
  -H "Authorization: Bearer $AGENTDISK_KEY" \\
  -H "Content-Type: application/json" -d '{}'`;

const REST_DOWNLOAD = `curl ${API_BASE}/v1/files/$FILE_ID/download \\
  -H "Authorization: Bearer $AGENTDISK_KEY"
# → { "url": "https://…", "method": "GET", "expiresAt": "…", "sizeBytes": 8421376 }`;

const REST_DELETE = `curl -X DELETE ${API_BASE}/v1/files/$FILE_ID \\
  -H "Authorization: Bearer $AGENTDISK_KEY"
# → { "id": "file_…", "status": "deleted", "permanent": true }`;

const REST_DELETE_WORKSPACE = `curl -X DELETE ${API_BASE}/v1/workspaces/$WORKSPACE_ID \\
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"exact workspace name"}'`;

const REST_DELETE_ACCOUNT = `curl -X DELETE ${API_BASE}/v1/me \\
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"confirmEmail":"you@example.com"}'`;

const WEBHOOK_VERIFY = `// agentdisk-signature: t=<unix seconds>,v1=<hex>
// Signed material is "<t>.<raw body>" with HMAC-SHA256 under your endpoint secret.
// Refuse anything older than 300 seconds: the timestamp is inside the signature
// precisely so a captured delivery cannot be replayed later.
const [t, v1] = header.split(',').map(p => p.split('=')[1]);
const expected = hmacSha256Hex(secret, \`\${t}.\${rawBody}\`);
const fresh = Math.abs(Date.now() / 1000 - Number(t)) <= 300;
const ok = fresh && timingSafeEqual(expected, v1);`;

/* ── small building blocks ─────────────────────────────────────────────── */

function Code({ caption, children }) {
  return (
    <div className="doc__code">
      <div className="doc__codebar">
        <span className="doc__codecap">{caption}</span>
      </div>
      <pre className="doc__codebody">{children}</pre>
    </div>
  );
}

function Note({ tone, children }) {
  return (
    <div className={tone === 'warn' ? 'doc__note doc__note--warn' : 'doc__note'} role="note">
      <span>{children}</span>
    </div>
  );
}

function H2({ id, children }) {
  return <h2 id={id} className="doc__h2">{children}</h2>;
}

function H3({ id, children }) {
  return <h3 id={id} className="doc__h3">{children}</h3>;
}

function P({ children }) {
  return <p className="doc__p">{children}</p>;
}

function Table({ caption, head, rows }) {
  return (
    <div className="doc__tablewrap">
      <table className="doc__table">
        {caption ? <caption className="doc__tablecap">{caption}</caption> : null}
        <thead>
          <tr>{head.map(h => <th key={h} scope="col">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function List({ items }) {
  return (
    <ul className="doc__list">
      {items.map((it, i) => <li key={i}>{it}</li>)}
    </ul>
  );
}

/**
 * The architecture, drawn with boxes rather than an image so it inherits the
 * theme's tokens and reads in dark mode and to a screen reader alike.
 */
function ArchitectureDiagram() {
  return (
    <figure className="doc__diag" aria-label="AgentDisk architecture">
      <div className="doc__diagcol">
        <div className="doc__diagbox doc__diagbox--caller">
          <span className="doc__diagkicker">PEOPLE</span>
          <strong>Dashboard</strong>
          <span>app.agentdisk.io</span>
          <span className="doc__diagsub">signed-in session</span>
        </div>
        <div className="doc__diagbox doc__diagbox--caller">
          <span className="doc__diagkicker">AGENTS</span>
          <strong>MCP clients &amp; scripts</strong>
          <span>Claude, Cursor, curl…</span>
          <span className="doc__diagsub">API key · ask_live_…</span>
        </div>
      </div>
      <div className="doc__diagarrow" aria-hidden="true">→</div>
      <div className="doc__diagcol">
        <div className="doc__diagbox doc__diagbox--core">
          <span className="doc__diagkicker">ONE EDGE SERVICE</span>
          <strong>api.agentdisk.io</strong>
          <span>REST at /v1 · MCP at /mcp</span>
          <ol className="doc__diagchain">
            <li>authenticate</li>
            <li>resolve scope</li>
            <li>bind workspace</li>
            <li>authorize op + path</li>
            <li>check quota &amp; billing</li>
            <li>handler</li>
          </ol>
        </div>
      </div>
      <div className="doc__diagarrow" aria-hidden="true">→</div>
      <div className="doc__diagcol">
        <div className="doc__diagbox"><span className="doc__diagkicker">METADATA DB</span><strong>Records</strong><span>files, folders, keys, audit</span></div>
        <div className="doc__diagbox"><span className="doc__diagkicker">OBJECT STORAGE</span><strong>Bytes</strong><span>one prefix per workspace</span></div>
        <div className="doc__diagbox"><span className="doc__diagkicker">CACHE · QUEUE · SCHEDULER</span><strong>Rate limits, webhooks, sweeps</strong></div>
        <div className="doc__diagbox doc__diagbox--ext"><span className="doc__diagkicker">OUTSIDE</span><strong>Identity · Billing · Bot check</strong><span>sign-in, payments, sandbox gate</span></div>
      </div>
      <figcaption className="doc__diagcap">
        Both surfaces enter the same service and the same six-step authorization chain. A handler
        never sees a raw database or bucket, only a copy already bound to one workspace.
      </figcaption>
    </figure>
  );
}

/* ── let me guide ────────────────────────────────────────────────────────
   Two questions, one tailored path. Everything it renders is drawn from the
   same CLIENTS and REST snippets as the reference material below it, so the
   guided and the unguided routes cannot disagree. Nothing is sent anywhere;
   the state lives in the component. */

const GOALS = [
  { id: 'try', label: 'Try it with no account', hint: 'A sandbox workspace and a key in a minute. Claim it later if you like it.' },
  { id: 'agent', label: 'Give my agent a disk', hint: 'I have an account. My agent needs its own scoped space.' },
  { id: 'editor', label: 'Connect my editor', hint: 'Claude, Cursor, VS Code and friends, in a workspace I own.' },
  { id: 'script', label: 'Script against the REST API', hint: 'curl, Python, Node. No MCP client involved.' },
];

const CLIENT_LABELS = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  'any-client': 'Other / raw HTTP',
};

function ClaimPromo({ lead }) {
  return (
    <div className="doc__promo" role="note">
      <span className="doc__promokicker">KEEP WHAT YOU BUILT</span>
      <p>
        {lead} Open the claim link, sign in (free, no card), and choose <strong>Keep as a new
        workspace</strong> or <strong>Merge into one you own</strong>. Your agent's key keeps
        working either way, with no re-authentication. A sandbox holds 50 MB and is scheduled for
        removal after seven days if nobody claims it.
      </p>
    </div>
  );
}

function guideSteps(goal, chosen) {
  const clientName = chosen ? CLIENT_LABELS[chosen.id] : 'your client';
  const connect = chosen
    ? { title: `Add AgentDisk to ${clientName}`, body: chosen.intro, blocks: chosen.blocks }
    : null;
  const verify = {
    title: 'Verify',
    body: `Ask ${clientName} to list the files at /. An empty listing is a success: the handshake worked and the key is scoped. The dashboard's MCP connection page reports the last call it saw from that key, and lists exactly the tools its scopes allow.`,
  };

  if (goal === 'try') {
    return {
      steps: [
        { title: 'Open the sandbox', body: 'No sign-up. Pass the bot check and you get a workspace ID, an API key and a claim link. Copy all three: the key and the link are shown once.', link: { to: '/sandbox', label: 'Open the sandbox' } },
        connect,
        verify,
      ],
      promo: 'You already have a claim link from step 1.',
    };
  }
  if (goal === 'agent' || goal === 'editor') {
    const who = goal === 'agent' ? 'your agent' : 'your editor';
    return {
      steps: [
        { title: 'Sign in and pick a workspace', body: 'Every workspace has its own agents, keys and files. Use the switcher at the top of the dashboard if you have more than one.', link: { to: '/login', label: 'Sign in' } },
        { title: `Create an identity for ${who}`, body: 'Agent access → Agent identities → New. The name is a label people read beside its keys and its activity, so make it say what the agent is for.' },
        { title: 'Mint a scoped key', body: goal === 'agent'
            ? 'API keys → New. Give it read, write and list, add delete only if it must destroy files, and set a path prefix such as /agents/<name> so it cannot see the rest of the workspace. The key is shown when minted and can be revealed again by the owner.'
            : 'API keys → New. Read, write and list, with a path prefix per project such as /projects/<name>, so the editor works in its own corner. The key is shown when minted and can be revealed again by the owner.' },
        connect,
        verify,
      ],
      promo: 'Made a sandbox earlier while trying things out?',
    };
  }
  return {
    steps: [
      { title: 'Get a key', body: 'Either the sandbox, with no account, or Agent access → Agent identities → API keys once signed in. Scope it to what the script does.', link: { to: '/sandbox', label: 'Open the sandbox' } },
      { title: 'Keep it out of your history', body: 'Export it once and reference the variable. Never put a key in a URL: the API refuses it and tells you to rotate.', blocks: [{ caption: 'SHELL', code: `export AGENTDISK_KEY=${KEY_PLACEHOLDER}` }] },
      { title: 'Ask who you are', body: 'The answer names the workspace, the scopes, and the room left on the account.', blocks: [{ caption: 'WHO AM I', code: REST_WHOAMI }] },
      { title: 'Write a file', body: 'Up to 1 MB inline. Larger files use the presigned flow in step 5 below.', blocks: [{ caption: 'CREATE A SMALL FILE', code: REST_INLINE }] },
    ],
    promo: 'Started from the sandbox?',
  };
}

function GuideMe() {
  const [goal, setGoal] = useState(null);
  const [client, setClient] = useState(null);
  const needsClient = goal !== null && goal !== 'script';
  const chosen = needsClient ? CLIENTS.find(c => c.id === client) ?? null : null;
  const ready = goal === 'script' || chosen !== null;
  const guide = ready ? guideSteps(goal, chosen) : null;

  return (
    <div className="doc__guide">
      <fieldset className="doc__pickgroup">
        <legend className="doc__picklegend">What do you want to do?</legend>
        <div className="doc__picks">
          {GOALS.map(g => (
            <label key={g.id} className={goal === g.id ? 'doc__pick is-on' : 'doc__pick'}>
              <input type="radio" name="guide-goal" value={g.id} checked={goal === g.id} onChange={() => setGoal(g.id)} />
              <span className="doc__picklabel">{g.label}</span>
              <span className="doc__pickhint">{g.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {needsClient ? (
        <fieldset className="doc__pickgroup">
          <legend className="doc__picklegend">Which AI tool?</legend>
          <div className="doc__picks doc__picks--dense">
            {CLIENTS.map(c => (
              <label key={c.id} className={client === c.id ? 'doc__pick is-on' : 'doc__pick'}>
                <input type="radio" name="guide-client" value={c.id} checked={client === c.id} onChange={() => setClient(c.id)} />
                <span className="doc__picklabel">{CLIENT_LABELS[c.id]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {guide ? (
        <div className="doc__guideout" aria-live="polite">
          <div className="doc__guidehead">Your path</div>
          <ol className="doc__guidesteps">
            {guide.steps.filter(Boolean).map((s, i) => (
              <li key={i} className="doc__guidestep">
                <div className="doc__guidetitle">{s.title}</div>
                <p className="doc__p">{s.body}</p>
                {s.link ? <Link to={s.link.to} className="doc__guidelink">{s.link.label} →</Link> : null}
                {s.blocks ? s.blocks.map(b => <Code key={b.caption} caption={b.caption}>{b.code}</Code>) : null}
              </li>
            ))}
          </ol>
          <ClaimPromo lead={guide.promo} />
        </div>
      ) : (
        <p className="doc__guideempty" aria-live="polite">
          {goal === null ? 'Pick a goal to get a path written for it.' : 'Now pick the tool you use.'}
        </p>
      )}
    </div>
  );
}

/* ── the account-deletion process, as a timeline ───────────────────────── */

const DELETION_FLOW = [
  { when: 'You', title: 'Confirm', body: 'Profile → Delete account, then type your email address. Over the API it is DELETE /v1/me with a signed-in token. An API key is refused.' },
  { when: 'Instant', title: 'Billing is settled first', body: 'Every live subscription is cancelled and the saved card detached. If the payment processor refuses, nothing is deleted and you get a 409 to try again.' },
  { when: 'Instant', title: 'Workspaces you own are destroyed', body: 'Keys, agents, memberships, webhooks, share links, folders and file records go in this request. Everyone you invited loses access. Up to 20 workspaces per request.' },
  { when: 'Instant', title: 'Your guest seats are removed', body: 'Seats, keys and share links you held in other people’s workspaces. Their workspaces are untouched.' },
  { when: 'Instant', title: 'You are signed out everywhere', body: 'Your record is marked. From here nothing of yours is reachable.' },
  { when: 'Day 7', title: 'Bytes erased, identity released', body: 'The last file bytes are removed, your sign-in identity is deleted and your email address is released. One confirmation email is sent first; if it cannot be delivered it is retried for 48 hours, then the release goes ahead.', accent: true },
  { when: 'Stays', title: 'Invoices, for seven years', body: 'At the payment processor, because tax law requires it. Request logs for around 90 days on their normal schedule. Nothing else.', muted: true },
];

function DeletionFlow() {
  return (
    <ol className="doc__flow" aria-label="Account deletion, step by step">
      {DELETION_FLOW.map(s => (
        <li key={s.title} className={`doc__flowstep${s.accent ? ' is-accent' : ''}${s.muted ? ' is-muted' : ''}`}>
          <span className="doc__flowwhen">{s.when}</span>
          <span className="doc__flowdot" aria-hidden="true" />
          <div className="doc__flowbody">
            <div className="doc__flowtitle">{s.title}</div>
            <p>{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ── scroll spy ─────────────────────────────────────────────────────────── */

function useActiveSection(ids) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActive(visible[0].target.id);
      },
      { rootMargin: '-10% 0px -70% 0px' }
    );
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

/* ── the page ────────────────────────────────────────────────────────────── */

export function Docs() {
  const params = useParams();
  const ids = React.useMemo(() => SECTIONS.map(s => s.id), []);
  const active = useActiveSection(ids);

  // `/docs/quickstart` and `/docs#privacy` both scroll to the section on
  // arrival. The browser handles a hash on a full load, but a client-side
  // navigation (the footer's Privacy link, the /privacy redirect) does not
  // scroll on its own, so both forms are handled here.
  const location = useLocation();
  useEffect(() => {
    const target = params['*'] || location.hash.slice(1);
    if (!target) return;
    const el = document.getElementById(target.replace(/\/+$/, ''));
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView();
  }, [params, location.hash]);

  const current = SECTIONS.find(s => s.id === active) ?? SECTIONS[0];

  return (
    <div className="mk">
      <Nav />
      <div className="mk__wrap">
        <div className="doc">

          <aside className="doc__toc" aria-label="Documentation sections">
            {Object.entries(GROUPS).map(([label, items]) => (
              <div key={label} className="doc__tocgroup">
                <div className="doc__toclabel">{label}</div>
                {items.map(s => (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    className={s.id === active ? 'doc__tocitem is-current' : 'doc__tocitem'}
                    aria-current={s.id === active ? 'location' : undefined}
                  >
                    {s.label}
                  </a>
                ))}
              </div>
            ))}
          </aside>

          <article className="doc__body">
            {/*
              The phone's table of contents. The sidebar TOC is hidden below
              875px, which used to leave nine sections and a hundred screens
              of text with no way to move between them except scrolling. This
              is the same list, folded shut under the breadcrumb: a native
              <details>, so it needs no script, is a button to a screen
              reader, and closes itself nowhere — following a link scrolls
              the page and the block stays where it was. CSS hides it above
              875px, where the sidebar takes over.
            */}
            <details className="doc__mtoc">
              <summary className="doc__mtocsum">
                <span className="doc__mtoclabel">Contents</span>
                <span className="doc__mtocnow">{current.label}</span>
              </summary>
              <div className="doc__mtoclist">
                {Object.entries(GROUPS).map(([label, items]) => (
                  <div key={label} className="doc__tocgroup">
                    <div className="doc__toclabel">{label}</div>
                    {items.map(s => (
                      <a
                        key={s.id}
                        href={`#${s.id}`}
                        className={s.id === active ? 'doc__tocitem is-current' : 'doc__tocitem'}
                      >
                        {s.label}
                      </a>
                    ))}
                  </div>
                ))}
              </div>
            </details>
            <nav className="doc__crumb" aria-label="Breadcrumb">
              <span>Docs</span><span aria-hidden="true">/</span>
              <span className="doc__crumbnow">{current.label}</span>
            </nav>

            <h1 className="doc__h1">AgentDisk documentation</h1>
            <p className="doc__lead">
              Everything you need to give an AI agent a disk: what the product is, how to connect
              the tools you already use, what it can do, and exactly how your data is kept,
              deleted and protected. Every statement on this page describes the code that is
              running, not a roadmap.
            </p>

            {/* ════════════════════════ OVERVIEW ════════════════════════ */}
            <section id="overview" className="doc__section">
              <H2 id="overview-heading">Overview</H2>

              <H3 id={slug('What AgentDisk is')}>What AgentDisk is</H3>
              <P>
                AgentDisk is file storage built for AI agents. Every agent gets a scoped,
                persistent workspace of files, folders and metadata, reachable over a plain REST
                API and over an MCP server that any MCP-capable client can connect to. You mint
                the credentials, you decide which paths and operations each one may touch, and you
                keep the audit log of everything an agent did.
              </P>
              <P>
                It is serverless end to end. There is nothing to run: the API, the MCP server and
                the dashboard run at the edge, file bytes live in block-based object storage, and
                metadata in an edge database. Pricing is hard-capped per plan, so a runaway agent
                can hit a limit but never a surprise bill.
              </P>
              <P>
                The problem it solves is that an agent given an S3 bucket or a shared drive gets
                everything in it. AgentDisk keys carry operations and a path prefix, the server
                enforces both on every call, and a key scoped to <code>/agents/research-bot</code>{' '}
                cannot see, list or guess what sits beside it.
              </P>

              <H3 id={slug('How it fits together')}>How it fits together</H3>
              <ArchitectureDiagram />

              <H3 id={slug('The entity model')}>The entity model</H3>
              <List items={[
                <><strong>Account.</strong> A person who signed in (Google, GitHub, email and password, or an email link). An account owns a billing account with one plan and one card.</>,
                <><strong>Workspace.</strong> The unit of storage and isolation. One billing account owns many workspaces. Each has a URL slug that never changes and a <code>ws_…</code> ID that the API uses.</>,
                <><strong>Member.</strong> A person invited into one workspace as a <em>reader</em>. Membership is per workspace, so inviting somebody into one client's workspace never shows them the one beside it. Readers cannot write; writing belongs to the owner and to the keys they mint.</>,
                <><strong>Agent.</strong> A named identity inside a workspace that keys belong to. Disabling an agent stops every key it holds on the next request.</>,
                <><strong>API key.</strong> The credential an agent presents. It carries a set of operations (<code>read</code>, <code>write</code>, <code>delete</code>, <code>list</code>, <code>share</code>, <code>keys:create</code>) and an optional path prefix, and a key can never mint a broader key than itself.</>,
                <><strong>File and folder.</strong> A file is a path, bytes and metadata: MIME type, size, SHA-256, caption, tags, custom key-values. Folders are created lazily and exist so an empty directory can be listed.</>,
              ]} />

              <H3 id={slug('Two surfaces, one authorization chain')}>Two surfaces, one authorization chain</H3>
              <P>
                The MCP tools do not reimplement anything. Each one builds the same request the
                REST handler expects and calls that handler, so the two surfaces are literally the
                same code and cannot drift in what they permit. Whatever a key may do over REST it
                may do over MCP, and nothing more. Workspace, agent and key management are
                deliberately absent from MCP: letting a model mint its own credentials or delete a
                workspace is a larger blast radius than any use case needs.
              </P>
            </section>

            {/* ══════════════════════ QUICK START ══════════════════════ */}
            <section id="quickstart" className="doc__section">
              <H2 id="quickstart-heading">Quick start</H2>
              <P>
                A few minutes from nothing to an agent reading and writing files. Steps 1 and 2 happen
                in the dashboard; step 3 is one config block in the tool you already use.
              </P>

              <H3 id={slug('Let me guide')}><strong>Let me guide</strong></H3>
              <P>
                Answer two questions and get the exact steps for your situation, with the config
                block for the tool you use. The full reference follows below if you would rather
                read it all.
              </P>
              <GuideMe />

              <H3 id={slug('Before you begin')}>Before you begin</H3>
              <List items={[
                <>An AgentDisk account. <Link to="/signup">Start free</Link> with Google, GitHub or email. No card is asked for.</>,
                <>Or no account at all: <Link to="/sandbox">the sandbox</Link> creates a workspace and a key from a browser, behind a bot check. It holds a tighter allowance (50 MB, 500 files, 500 MB egress, 10,000 requests) and is scheduled for removal after seven days unless you claim it from the link it shows you.</>,
                <>An MCP-capable client, or just <code>curl</code>. The MCP server is HTTP; there is no package to install and no CLI of ours to log in with.</>,
              ]} />

              <H3 id={slug('1. Get a workspace')}>1. Get a workspace</H3>
              <P>
                Signing up creates your first workspace for you. Its ID is on the Overview screen as
                a chip you can copy; its address in the dashboard is <code>/w/&lt;slug&gt;</code>.
                You can add more workspaces under the same billing account from the workspace
                switcher, up to your plan's allowance.
              </P>

              <H3 id={slug('2. Create an agent and a key')}>2. Create an agent and a key</H3>
              <P>
                Open <strong>Agent identities</strong> under Agent access, create one with a name,
                then open <strong>API keys</strong> and mint a key against it. Pick the operations it needs and, unless it genuinely
                needs the whole workspace, a path prefix such as <code>/agents/research-bot</code>.
                A key for an agent that only reads and searches needs <code>read</code> and{' '}
                <code>list</code>; give it <code>write</code> only if it creates files and{' '}
                <code>delete</code> only if it must destroy them.
              </P>
              <Note>
                Keys look like <code>ask_live_…</code> (or <code>ask_test_…</code> for a test-mode
                key). The dashboard shows the full key when it is minted and, because keys are kept
                sealed, the workspace owner can reveal it again later from the keys table. Every
                reveal is written to the Activity log.
              </Note>

              <H3 id={slug('3. Connect your AI tool')}>3. Connect your AI tool</H3>
              <P>
                Every client below points at the same endpoint with the same header. Replace the
                placeholder with your key. Where a client cannot take a URL directly, the snippet
                includes the bridge it needs rather than a config that will not start.
              </P>
              <Code caption="THE ENDPOINT">{`${MCP_ENDPOINT}\nAuthorization: Bearer ${KEY_PLACEHOLDER}`}</Code>
              <Note tone="warn">
                A key in a config file is a credential on disk. Project-level files such as{' '}
                <code>.mcp.json</code>, <code>.cursor/mcp.json</code> and <code>.vscode/mcp.json</code>{' '}
                get committed unless you add them to <code>.gitignore</code>; prefer the user-level
                file, or a key scoped to a prefix so a leak is bounded. If a key lands in a
                repository, a chat or a URL, disable it under API keys at once. Re-enabling issues
                a new secret.
              </Note>

              {CLIENTS.map(c => (
                <div key={c.id} className="doc__client" id={`client-${c.id}`}>
                  <h4 className="doc__h4">{c.name}</h4>
                  <P>{c.intro}</P>
                  {c.blocks.map(b => <Code key={b.caption} caption={b.caption}>{b.code}</Code>)}
                </div>
              ))}

              <H3 id={slug('4. Verify the connection')}>4. Verify the connection</H3>
              <P>
                On a successful handshake the client lists the tools your key's scopes allow. The
                server filters <code>tools/list</code> by scope, so a key with <code>read</code> and{' '}
                <code>list</code> sees four tools, not ten. That is the scope model working, not a
                broken handshake. The dashboard's <strong>MCP connection</strong> page shows the same
                list for whichever key you select, and reports the last call it saw from that key.
              </P>
              <div className="doc__tools">
                {MCP_TOOLS.map(t => (
                  <div key={t.name} className="doc__tool">
                    <span className="doc__toolname">{t.name}</span>
                    <span className="doc__toolbody">{t.body}</span>
                    <span className="doc__toolscope">{t.scope.toUpperCase()}</span>
                  </div>
                ))}
              </div>

              <H3 id={slug('5. Use the REST API')}>5. Use the REST API</H3>
              <P>
                Everything the MCP tools do is plain HTTPS with a JSON body. Start by asking who you
                are: the answer names the workspace, the key's scopes, and how much of the account's
                allowance is left.
              </P>
              <Code caption="WHO AM I">{REST_WHOAMI}</Code>
              <P>Small files, up to 1 MB, go inline as base64 in one call.</P>
              <Code caption="CREATE A SMALL FILE">{REST_INLINE}</Code>
              <P>
                Larger files never pass through the API. You declare the file and its size, upload
                the bytes straight to storage with the presigned URL you get back, and then confirm.
                The size that is booked against your quota is read from storage, not from your
                declaration.
              </P>
              <Code caption="UPLOAD A LARGE FILE">{REST_PRESIGNED}</Code>
              <Code caption="DOWNLOAD">{REST_DOWNLOAD}</Code>
              <Code caption="DELETE — PERMANENT">{REST_DELETE}</Code>
              <P>
                The full route table is in the <a href="#reference">Reference</a>.
              </P>

              <H3 id={slug('Troubleshooting')}>Troubleshooting</H3>
              <List items={[
                <><strong>401 UNAUTHORIZED.</strong> The credential was not accepted. Unknown, revoked, expired, disabled-agent and malformed keys all return the same body on purpose; the reason goes to our server log, never to the response. Check the key's status and its agent's status in the dashboard.</>,
                <><strong>403 FORBIDDEN.</strong> Authenticated, but the key lacks the operation for this call, or the path is outside its prefix. The message says which. Over MCP a refused tool call is also recorded in Activity as <code>mcp.&lt;tool&gt;</code> with the result <em>denied</em>; a refused REST call is not.</>,
                <><strong>400 mentioning the URL.</strong> You put the key in a query string. It is already in logs and shell history; rotate it.</>,
                <><strong>The client lists fewer than ten tools.</strong> Expected. Tools you cannot call are not shown.</>,
                <><strong>Claude Code says the server failed to start.</strong> The <code>.mcp.json</code> entry is missing <code>"type": "http"</code>, so it tried to spawn the URL as a command.</>,
                <><strong>Claude Desktop shows nothing.</strong> Its config cannot hold a URL; use the mcp-remote bridge above and restart the app.</>,
                <><strong>429 LIMIT_EXCEEDED.</strong> A quota (the body's <code>details.limit</code> says which: storage, files, egress) or a rate limit. Free space, upgrade, or wait for the window.</>,
                <><strong>Every write fails with a billing message.</strong> The account is past due or expired. Fix the card under Billing; reads keep working throughout.</>,
              ]} />
            </section>

            {/* ═══════════════════════ FEATURES ═══════════════════════ */}
            <section id="features" className="doc__section">
              <H2 id="features-heading">Features</H2>

              <H3 id={slug('Files and folders')}>Files and folders</H3>
              <List items={[
                <><strong>Two upload paths.</strong> Inline base64 for anything up to 1 MB; a presigned PUT straight to storage above that, up to the plan's per-file cap. The API is never in the byte path for large files.</>,
                <><strong>Integrity.</strong> Declare a SHA-256 with an inline upload and storage verifies it, refusing a body that does not match. On a presigned upload the checksum you declare is recorded with the file, not verified against the bytes. Every file record carries its checksum.</>,
                <><strong>Metadata that agents can reason about.</strong> MIME type, size, a caption, up to 32 tags, and custom key-value metadata. Search matches name, path, caption and tags, and tells you which fields it looked at.</>,
                <><strong>Move, copy, rename.</strong> Moves check write at both ends. Copies check read at the source and write at the destination, and the bytes stay inside storage.</>,
                <><strong>Folders are lazy.</strong> A file can be created at any depth without folder rows above it. A folder only refuses deletion when a file's path is inside it, however the file was created.</>,
                <><strong>Permanent deletion.</strong> Deleting a file destroys the bytes and the record in the same request. There is no recycle bin. The dashboard's confirmation says exactly that.</>,
                <><strong>Downloads through the browser.</strong> The dashboard's file browser opens a drawer per file with its metadata, a download button and its share links.</>,
              ]} />

              <H3 id={slug('Agents and scoped keys')}>Agents and scoped keys</H3>
              <List items={[
                <><strong>Operations.</strong> <code>read</code>, <code>write</code>, <code>delete</code>, <code>list</code>, <code>share</code> and <code>keys:create</code>. A blob the server does not recognise grants nothing.</>,
                <><strong>Path prefix.</strong> Matched on whole segments: a key for <code>/agents/bot</code> does not reach <code>/agents/bot-evil/secrets.txt</code>. Listings and searches are clipped to the prefix, so an agent cannot learn what exists outside it.</>,
                <><strong>Least privilege is structural.</strong> A key can only mint a key that is a subset of itself, and only if it holds <code>keys:create</code>. A read-only key cannot become a writer.</>,
                <><strong>Disable, re-enable, rotate.</strong> Disabling a key stops it on the next request. Re-enabling issues a <em>new</em> secret under the same row, so the token that was live at the moment of disable never works again. Disabling an agent stops every key it holds.</>,
                <><strong>Kept, sealed, revealable.</strong> Keys are stored encrypted so the owner can view one again. Only a signed-in owner can reveal, never an API key, never a reader, and every reveal is audited.</>,
                <><strong>Live and test modes.</strong> <code>ask_live_</code> and <code>ask_test_</code> prefixes, so a test key can be recognised at a glance in a config file.</>,
              ]} />

              <H3 id={slug('The MCP server')}>The MCP server</H3>
              <P>
                JSON-RPC 2.0 over streamable HTTP at <code>/mcp</code>, in the same service as the
                REST API. Authentication is an API key, exactly as REST; there is deliberately no
                human sign-in path, because MCP is how an agent connects and a person's session is
                not something a model should hold. Tool results carry the JSON payload as text and
                as <code>structuredContent</code>, so both kinds of client read it without parsing.
                Errors carry the same code and message the REST caller would have seen.
              </P>

              <H3 id={slug('Workspaces and claiming')}>Workspaces and claiming</H3>
              <List items={[
                <><strong>Many per account.</strong> One billing account, one plan, many workspaces. Storage and file count pool across them; egress is per workspace.</>,
                <><strong>Slugs.</strong> Dashboard URLs are <code>/w/&lt;slug&gt;</code>. A slug is derived once at creation and a rename never changes it, so a link never breaks. The <code>ws_…</code> ID stays the identifier the API uses.</>,
                <><strong>Agent-first sandbox.</strong> A workspace and a key can be created with no account at all, from a browser, behind a bot check and a per-IP limit. The response includes a one-time claim link.</>,
                <><strong>Claiming.</strong> Opening the claim link previews the sandbox without signing in. Claiming it, signed in, either keeps it as a new workspace under your account or merges its files into a workspace you already own and repoints the agent's existing key, so the agent's next call lands in the new home with no re-authentication. A merge is all-or-nothing against your quota.</>,
                <><strong>Sweep.</strong> Unclaimed sandboxes are scheduled for removal after seven days.</>,
              ]} />

              <H3 id={slug('Members')}>Members</H3>
              <P>
                Under <strong>Settings → Members</strong>, the owner can invite anyone who already
                has an AgentDisk account into a workspace as a reader. Readers see files, agents, keys and activity and change nothing. There
                is no pending-invite state that a stranger could claim from a mailbox, and only the
                owner can invite, change or remove a member.
              </P>

              <H3 id={slug('Share links')}>Share links</H3>
              <List items={[
                <><strong>Files or folders.</strong> One link per file or folder, opened at <code>/s/&lt;token&gt;</code> on the dashboard by anyone who holds it.</>,
                <><strong>Seven days at most.</strong> The default and the ceiling are both seven days, to bound exposure if a link leaks. Expired links stop serving at once.</>,
                <><strong>Optional password.</strong> Six to 128 characters, stored only as a hash, checked before the link reveals anything about the workspace or the files. Wrong guesses are limited to ten per fifteen minutes per link.</>,
                <><strong>Downloads, not previews.</strong> Every shared file is served as an attachment.</>,
                <><strong>Revocable and audited.</strong> Revoke from the file drawer or the API. Creation and revocation are in the Activity log. Free plans hold no share links; paid plans hold 10, 100 or unlimited.</>,
              ]} />

              <H3 id={slug('Webhooks')}>Webhooks</H3>
              <P>
                Register an HTTPS endpoint and choose events. Deliveries go through a queue, so your
                endpoint being slow or down never slows or fails the upload that caused the event.
                Retryable failures are retried by the queue; a 404 or 410 from your endpoint is
                treated as permanent. Every delivery is signed.
              </P>
              <Table
                head={['Header', 'Holds']}
                rows={[
                  [<code>agentdisk-signature</code>, 't=<unix seconds>,v1=<HMAC-SHA256 hex over "t.body">'],
                  [<code>agentdisk-event</code>, 'The event name, e.g. file.created'],
                  [<code>agentdisk-delivery</code>, 'A delivery ID, for de-duplication'],
                  [<code>user-agent</code>, 'AgentDisk-Webhooks/1.0'],
                ]}
              />
              <Code caption="VERIFYING A DELIVERY">{WEBHOOK_VERIFY}</Code>
              <Note>
                The signing secret is shown once, at registration, and never again. Rotating it
                means creating a new endpoint. Payloads carry the file's id, path and size and
                nothing sensitive: no download URLs, no content.
              </Note>

              <H3 id={slug('Activity log')}>Activity log</H3>
              <P>
                Creates and deletes of files, every change to agents, keys, members, share links
                and webhooks, every key reveal, and every MCP tool call are recorded with who did it
                (a person or an agent key), the source IP, what it touched, and whether it
                succeeded. A refused MCP tool call is recorded as denied, because a log of only
                successes hides the thing most worth seeing. Metadata edits, moves and copies over
                REST are not yet audited. The log is read-only: nothing a client sends can write to
                it. It is kept for the life of the workspace. The full event list is in the{' '}
                <a href="#activity-events">Reference</a>.
              </P>

              <H3 id={slug('Usage, plans and billing')}>Usage, plans and billing</H3>
              <P>
                Four plans. Storage and file count belong to the billing account and pool across
                its workspaces; the per-file cap and the share-link count are per plan. Prices are
                on <Link to="/pricing">Pricing</Link>; yearly is fifteen percent off twelve months,
                rounded down.
              </P>
              <Table
                caption="Plan allowances"
                head={['Plan', 'Storage', 'Files', 'Egress / month', 'Max file', 'Agents', 'Keys', 'Members', 'Workspaces', 'Share links']}
                rows={PLANS.map(p => [p.name, p.storage, p.files, p.egress, p.file, p.agents, p.keys, p.members, p.workspaces, p.shares])}
              />
              <Note tone="warn">
                Storage, file count, egress, the per-file cap and share-link counts are enforced on
                every write today. The agent, key, member and workspace counts are the plan's terms
                and are being wired into the request path; until they are, the dashboard reports them
                but the API does not refuse on them.
              </Note>
              <List items={[
                <><strong>Requests are unlimited</strong> on every plan. Storage and file count pool across the account; egress is counted per workspace per month and resets on the workspace's own period.</>,
                <><strong>Warnings before walls.</strong> A write that lands the account at 80% or 95% of its allowance carries a warning on the response; a write that would exceed it is refused with 429 and the dimension named.</>,
                <><strong>Monthly or yearly, auto-renewing.</strong> Checkout happens on our payment processor's page, where promotion codes are entered. Cards and invoices live in its portal; we never see or store card numbers.</>,
                <><strong>Upgrades are immediate and prorated; downgrades wait for the period end</strong>, so nobody is dropped below the storage they are already using mid-period.</>,
                <><strong>Cancel and resume are ours.</strong> Cancelling stops renewal at the period end and keeps everything you paid for until then; resume takes it back any time before the date.</>,
                <><strong>A failing card does not delete anything quickly.</strong> Writes are blocked while the account is past due, reads continue, and the seven-day grace is counted on our clock and announced by email before any data is scheduled for removal. A successful payment clears the schedule.</>,
              ]} />

              <H3 id={slug('The dashboard')}>The dashboard</H3>
              <P>
                Overview, Files, Agent identities, API keys, MCP connection, Webhooks, Activity,
                Usage, Billing, Settings (including Members), Profile and Support, per workspace,
                with a switcher across workspaces. Sign-in is
                Google, GitHub, email and password, or an email link. Log out everywhere from
                Profile revokes every browser session at once.
              </P>
            </section>

            {/* ═════════════════════ DATA SECURITY ═════════════════════ */}
            <section id="data-security" className="doc__section">
              <H2 id="data-security-heading">Data security</H2>
              <P>
                How your data is kept while it is with us. The short version: one workspace's bytes
                and rows are reachable only through objects that were bound to that workspace before
                any handler ran, every credential is hashed or sealed, and every URL that touches a
                byte is short-lived and scoped to one object.
              </P>

              <H3 id={slug('Where your data lives')}>Where your data lives</H3>
              <Table
                head={['Data', 'Where', 'Notes']}
                rows={[
                  ['File bytes', 'Block-based object storage', 'One object per file, under a per-workspace prefix built from server IDs. Your path is metadata and never part of the object key.'],
                  ['Metadata, keys, memberships, audit', 'Edge database', 'Keys are stored as a SHA-256 hash for authentication and as AES-256-GCM ciphertext for reveal.'],
                  ['Rate-limit counters, key cache', 'Edge cache', 'Short-lived, no file content.'],
                  ['Webhook deliveries', 'Delivery queue', 'Payloads carry ids, paths and sizes only.'],
                  ['Identity', 'Managed sign-in provider', 'Passwords, OAuth and session tokens. We receive the verified identifier and email, never a password.'],
                  ['Billing', 'Payment processor', 'Card, invoices, subscription. We store the customer and subscription ids and a mirror of the period.'],
                ]}
              />

              <H3 id={slug('Tenant isolation')}>Tenant isolation</H3>
              <P>
                A route handler never receives a raw database or a raw bucket. The authorization
                chain binds the workspace from the credential, never from anything the client sent,
                and hands the handler repositories and a storage object whose constructor already
                holds that workspace. Every storage method takes a file ID and derives the object key
                itself; no method accepts a workspace ID or a raw key, so there is no argument
                through which a handler could name another tenant's object, even by mistake. The
                one cross-workspace operation in the product, the sandbox merge, takes two
                already-bound storage objects and no workspace ID, so a caller can only cross a
                boundary it has legitimately opened both sides of. The isolation tests seed two
                workspaces and prove that every route answers the other tenant's IDs with 404.
              </P>

              <H3 id={slug('Encryption')}>Encryption</H3>
              <List items={[
                <><strong>In transit.</strong> TLS everywhere: browser to dashboard, client to API, presigned upload and download to storage. The dashboard sends HSTS for a year with subdomains included.</>,
                <><strong>At rest.</strong> Object storage and the database are encrypted at rest by our infrastructure provider. This is provider-managed encryption, not end-to-end: our own service can read your files when a request authorizes it to, which is what serving them requires.</>,
                <><strong>Secrets at rest.</strong> API keys are sealed with AES-256-GCM under a key that exists only as a runtime secret, never in infrastructure state or build output, and each ciphertext is bound to its own row so a copied ciphertext opens as nothing. Share-link passwords are PBKDF2 hashes. Claim tokens and API keys are looked up by SHA-256.</>,
              ]} />

              <H3 id={slug('Credentials')}>Credentials</H3>
              <List items={[
                <>Keys are 32 base62 characters of CSPRNG output, about 190 bits, read from the Authorization header and nowhere else. A key in a query string is rejected with a message telling you to rotate it.</>,
                <>Every authentication failure returns one identical body, so the API is never an oracle telling somebody which of their guesses is a real key that merely expired.</>,
                <>Scopes fail closed: an unparseable or unrecognised scope grants nothing.</>,
                <>Human sessions are signed identity tokens verified in our service against the sign-in provider's public keys. A deleted or disabled account is refused from our own record before the provider's, so a token that is still technically valid cannot outlive the account.</>,
                <>An API key can never act as a person: it cannot close the account, delete a workspace, reveal another key, invite a member or end browser sessions.</>,
              ]} />

              <H3 id={slug('Upload and download integrity')}>Upload and download integrity</H3>
              <List items={[
                <>Presigned upload URLs last 15 minutes and are scoped to exactly one object and one HTTP method. Download URLs last one hour. Nothing this product issues may exceed seven days.</>,
                <>The size booked against your quota comes from storage, never from your declaration. A client that declares 1 KB and uploads 1 GB has its bytes deleted, not its quota mis-booked.</>,
                <>A SHA-256 declared with an inline upload is verified by storage on write. On the presigned path it is recorded, not verified.</>,
                <>Presigned URLs are never logged in full: only that one was issued, to whom, and when.</>,
              ]} />

              <H3 id={slug('What we log')}>What we log</H3>
              <P>
                Structured request logs: endpoint, method, status, latency, request ID and the
                identity that called. Never request or response bodies that hold file content or
                secrets. Infrastructure logs are kept around 90 days; your workspace's Activity log is
                kept for the life of the workspace.
              </P>
            </section>

            {/* ═════════════════════ DELETING DATA ═════════════════════ */}
            <section id="deleting-data" className="doc__section">
              <H2 id="deleting-data-heading">Deleting your data</H2>
              <P>
                Everything you create can be deleted from the dashboard, the API, or (for files) the
                MCP tools. Deletion is not reversible anywhere in the product, and no screen implies
                otherwise.
              </P>

              <H3 id={slug('Files')}>Files</H3>
              <P>
                <code>DELETE /v1/files/:id</code>, the <code>delete_file</code> tool, or Delete in
                the file drawer. The bytes are removed from storage and the record from the database
                in the same request; the response says <code>"permanent": true</code>. The usage
                counters are released immediately. There is no restore and no grace period. A
                webhook <code>file.deleted</code> fires and the Activity log records it.
              </P>

              <H3 id={slug('Folders')}>Folders</H3>
              <P>
                <code>DELETE /v1/folders/:id</code> removes an empty folder. Emptiness is decided by
                path, so a folder that still holds files, however they were created, refuses with
                409. Delete the files first; the product never deletes files as a side effect of
                deleting a folder.
              </P>

              <H3 id={slug('Agents and keys')}>Agents and keys</H3>
              <List items={[
                <><strong>A key</strong> is removed with <code>DELETE /v1/keys/:id</code> or the keys table. If you might need it back, disable it instead; re-enabling issues a new secret.</>,
                <><strong>An agent</strong> is soft-deleted: its keys are revoked at once and its record stays so that Activity rows still resolve to a name. It is not shown again and cannot be re-enabled.</>,
              ]} />

              <H3 id={slug('Share links and webhooks')}>Share links and webhooks</H3>
              <P>
                Revoking a share link stops it serving at once, and expired links are removed on
                the hourly sweep. Deleting a webhook endpoint stops deliveries; a delivery already in
                the queue may still arrive.
              </P>

              <H3 id={slug('A whole workspace')}>A whole workspace</H3>
              <P>
                Settings → Danger zone, or <code>DELETE /v1/workspaces/:id</code>. This is a
                person's act: it refuses an API key, requires the account owner, requires the
                workspace's exact name in the request, and refuses your last workspace so you are
                never left with an account that has nowhere to land.
              </P>
              <Code caption="DELETE A WORKSPACE">{REST_DELETE_WORKSPACE}</Code>
              <List items={[
                <><strong>In the request:</strong> every key, agent, membership, webhook, share link and folder is destroyed, and every file record is removed. Nothing in the workspace is reachable by anyone from that moment.</>,
                <><strong>Within seven days:</strong> the file bytes are removed from storage by the hourly sweep. This delay is when the bytes go, not a chance to change your mind; nothing is recoverable by you in that window.</>,
              ]} />

              <H3 id={slug('Exporting first')}>Exporting first</H3>
              <P>
                There is no packaged export yet, and we would rather say so than imply a button that
                does not exist. Download what you need through the file browser, or list and
                download through the API, before you delete.
              </P>
            </section>

            {/* ════════════════════ DELETING ACCOUNT ════════════════════ */}
            <section id="deleting-account" className="doc__section">
              <H2 id="deleting-account-heading">Deleting your account</H2>
              <P>
                You can close your account yourself, at any time, without asking anyone. It is a
                button, not a request.
              </P>

              <H3 id={slug('How to do it')}>How to do it</H3>
              <P>
                Open <strong>Profile</strong>, scroll to <strong>Delete account</strong>, and type your
                email address to confirm. The same act over the API is <code>DELETE /v1/me</code>{' '}
                with a signed-in person's token; an API key is refused outright, because an agent
                must never be able to close the account of the person who issued it.
              </P>
              <Code caption="CLOSE THE ACCOUNT">{REST_DELETE_ACCOUNT}</Code>

              <H3 id={slug('What happens, in order')}>What happens, in order</H3>
              <DeletionFlow />
              <P>
                The order is the point: billing is settled before anything is destroyed, because an
                account that keeps being billed with nobody able to sign in is recoverable by
                nobody, while pressing the button again is. Workspaces go exactly as in{' '}
                <a href="#deleting-data">Deleting your data</a>: records now, bytes within seven
                days, nothing recoverable by you in between.
              </P>

              <H3 id={slug('What outlives the account')}>What outlives the account</H3>
              <List items={[
                <><strong>Invoices</strong>, at the payment processor, for seven years. Tax law requires it and GDPR Article 17(3)(b) exempts it. They hold your billing name, address and amounts, and nothing about your files.</>,
                <><strong>Infrastructure request logs</strong>, for around 90 days, on their normal schedule.</>,
                <><strong>Nothing else.</strong> You can sign up again with the same address afterwards; nothing is restored.</>,
              ]} />

              <H3 id={slug('If you were a guest')}>If you were a guest</H3>
              <P>
                If your account owned no workspaces and you were only ever invited into other
                people's, closing it removes your seats and your own record. The hosts' workspaces,
                files and subscriptions are not affected.
              </P>
            </section>

            {/* ═══════════════════════ PRIVACY ═══════════════════════ */}
            <section id="privacy" className="doc__section">
              <H2 id="privacy-heading">Privacy</H2>
              <p className="doc__meta">Privacy Policy · last updated 26 September 2026</p>
              <P>
                This is AgentDisk's privacy policy. It explains how AgentDisk collects, uses and shares information when you
                use the website, the dashboard, the API and the MCP server. It applies to human
                account holders and to information generated by AI agents acting under an account
                holder's authorisation. Files an agent creates are treated exactly as files a
                person uploads; nothing here differs by who acted.
              </P>

              <H3 id={slug('What we collect')}>What we collect</H3>
              <List items={[
                <><strong>Account information:</strong> the identifier our sign-in provider issues for you, your email address, and which sign-in method you used.</>,
                <><strong>Your content:</strong> the files you and your agents store, with the metadata you attach.</>,
                <><strong>Request logs:</strong> endpoint, method, status, latency, request ID and the calling identity, for security, quota enforcement and debugging. IP addresses, for rate limiting and abuse prevention, on the same schedule.</>,
                <><strong>Support requests:</strong> what you send through the Support form, from the address you signed in with.</>,
              ]} />

              <H3 id={slug('What we never see')}>What we never see</H3>
              <List items={[
                <><strong>Your password.</strong> Sign-up, reset and change all go to the sign-in provider. This backend never receives, hashes or stores one, and the password policy is enforced there.</>,
                <><strong>Your card number.</strong> Checkout and the portal are the payment processor's pages. We hold its customer and subscription identifiers and nothing about the card.</>,
                <><strong>Your file contents, in the ordinary course.</strong> We compute a checksum, sign a URL and measure a size. We do not open, view or process contents except to investigate abuse, a security incident or a valid legal request, and we do not claim the architecture makes that impossible, because it does not.</>,
                <><strong>Analytics or marketing cookies.</strong> Strictly necessary session and security storage only. Consent will be asked before that changes.</>,
              ]} />

              <H3 id={slug('Processors')}>Processors</H3>
              <Table
                head={['Processor', 'For']}
                rows={[
                  ['Cloudflare, Inc.', 'Compute, object storage, database, cache, queues, bot verification, and outbound email'],
                  ['Google LLC (Firebase Authentication)', 'Sign-in and session tokens'],
                  ['Stripe, Inc.', 'Payments, invoices, the customer portal'],
                ]}
              />
              <P>
                No AI processor touches your files. Optional per-workspace AI features are not
                enabled in this release, and the policy will name the processor before that changes,
                because it is the one case where content would leave the storage boundary.
              </P>

              <H3 id={slug('Retention')}>Retention</H3>
              <List items={[
                <>Account and file data: while the account and workspace exist.</>,
                <>A deleted file: gone in the request.</>,
                <>A deleted workspace or account: records gone in the request, bytes within seven days, the email address and sign-in released on day seven with one confirmation message.</>,
                <>Request logs: around 90 days. Your workspace's Activity log: the life of the workspace.</>,
                <>Invoices: seven years, at the payment processor.</>,
                <>We may hold data longer where an active dispute or a legal obligation demands it.</>,
              ]} />

              <H3 id={slug('Cookies')}>Cookies</H3>
              <P>
                Strictly necessary session and security storage only. There are no analytics or
                marketing cookies, and this policy will be updated and consent asked before that
                changes. Your theme choice is kept in your browser and never sent to us.
              </P>

              <H3 id={slug('International transfers')}>International transfers</H3>
              <P>
                Our infrastructure and sign-in providers operate global networks, so your data may
                be processed outside your home country. The specific transfer mechanisms will be
                stated here once the operating entity is finalised.
              </P>

              <H3 id={slug('Children')}>Children</H3>
              <P>
                The service is not directed to anyone under 16, and we do not knowingly collect
                their information. If we learn that we have, we delete it.
              </P>

              <H3 id={slug('Your rights')}>Your rights</H3>
              <P>
                Depending on where you live you may have rights to access, correct, delete, export
                or object to the processing of your data. Deletion and export are in your own hands
                in the product, see <a href="#deleting-data">Deleting your data</a> and{' '}
                <a href="#deleting-account">Deleting your account</a>. For anything else, contact
                us.
              </P>

              <H3 id={slug('Changes and contact')}>Changes and contact</H3>
              <P>
                Material changes are posted here with an updated date, and account owners are
                notified by email for significant ones. Questions about this policy go to{' '}
                <code>connect@agentdisk.io</code> or the Support form in the dashboard.
              </P>
            </section>

            {/* ════════════════════════ TERMS ════════════════════════ */}
            <section id="terms" className="doc__section">
              <H2 id="terms-heading">Terms of Service</H2>
              <p className="doc__meta">Terms of Service · last updated 26 September 2026</p>
              <P>
                These are the terms under which AgentDisk is provided. They apply to you and to
                any agent acting under credentials you control. The <a href="#privacy">Privacy
                Policy</a> above is part of them.
              </P>

              <H3 id={slug('Acceptance')}>1. Acceptance</H3>
              <P>
                By creating an account or using the Service, including through an API key, a
                sandbox workspace or an MCP connection, you agree to these Terms.
              </P>

              <H3 id={slug('Acceptable use')}>2. Acceptable use</H3>
              <P>
                You may not use the Service to store, transmit or process content that is illegal
                in your jurisdiction; malware or anything designed to attack systems, including
                ours; content that infringes another party's intellectual property; content
                involving the sexual exploitation of minors, which we report to the appropriate
                authorities without exception; or content intended to harass, threaten or
                facilitate violence against real people.
              </P>

              <H3 id={slug('Your responsibility for content')}>3. Your responsibility for content</H3>
              <P>
                You, and any agent acting under your account, are solely responsible for the files
                and data you store. We do not pre-screen content, but may review, remove or
                restrict access to content that violates these Terms or the law, and may suspend
                accounts for repeated or severe violations.
              </P>

              <H3 id={slug('Prohibited content')}>4. Prohibited content</H3>
              <P>
                You may not upload content you do not have the right to store or share. You may
                not use the Service as a public content-distribution network: share links exist
                so a person can hand a file to another person, not to serve the public. You may
                not circumvent storage limits or the sandbox allowance through automated account
                or workspace creation.
              </P>

              <H3 id={slug('API and automated agent use')}>5. API and automated agent use</H3>
              <P>
                The API and the MCP server are meant to be used by AI agents and automated systems
                acting on your behalf under credentials you control. <strong>You are responsible for
                what your agents do with your API keys, exactly as you would be for your own
                actions.</strong> Scope keys to what an agent needs. Do not share keys across
                unrelated parties or resell access without our written agreement.
              </P>

              <H3 id={slug('Limits and fair use')}>6. Limits and fair use</H3>
              <P>
                We enforce the quotas of your plan, and rate limits where they apply, to keep the
                Service reliable for everyone. We may throttle or temporarily suspend access we
                reasonably believe is abusive, is degrading reliability for others, or is
                circumventing those limits.
              </P>

              <H3 id={slug('Storage limits')}>7. Storage limits</H3>
              <P>
                Your plan defines storage, file count, egress and per-file limits, see{' '}
                <Link to="/pricing">Pricing</Link> and the <a href="#features">plan table</a>.
                Responses warn you as an account approaches its storage allowance; a write that
                would exceed a limit is refused until you upgrade, free space or, for egress, the
                workspace's period resets.
              </P>

              <H3 id={slug('Account suspension')}>8. Account suspension</H3>
              <P>
                We may suspend or terminate accounts that violate these Terms, pose a security risk,
                or where required by law. Suspension comes first and is reversible; where practical
                we will give notice and an opportunity to download your data before anything is
                deleted, except where immediate action is required.
              </P>

              <H3 id={slug('Your right to delete')}>9. Your right to delete</H3>
              <P>
                You may delete your files, workspaces or account at any time, from the dashboard or
                the API. Deletion is permanent, with no recovery, as described under{' '}
                <a href="#deleting-data">Deleting your data</a> and{' '}
                <a href="#deleting-account">Deleting your account</a>.
              </P>

              <H3 id={slug('Billing')}>10. Billing</H3>
              <P>
                Paid plans are billed in advance, monthly or yearly, and renew automatically until
                you cancel. Cancelling stops renewal at the end of the paid period and you keep the
                plan until then. Fees are non-refundable except as required by law or as we state at
                the time of purchase. An upgrade takes effect immediately and is prorated; a
                downgrade takes effect at the end of the paid period, and if your usage is then over
                the new plan's limits, new writes are refused until it is back within them. If a
                payment fails, writes are blocked while the account is past due, reads continue, and
                you are notified by email before any data is scheduled for removal.
              </P>

              <H3 id={slug('Intellectual property')}>11. Intellectual property</H3>
              <P>
                You keep all rights to the content you store. You grant us only the limited rights
                needed to store, process, transmit and display that content back to you and the
                people and agents you authorise. We keep all rights to the Service itself.
              </P>

              <H3 id={slug('Third-party services')}>12. Third-party services</H3>
              <P>
                The Service relies on the third-party infrastructure, sign-in and payment providers
                named in the Privacy Policy. No third-party AI processor handles your files today;
                if an optional feature ever sends content to one, the Privacy Policy will name it
                before that happens. We are not responsible for the availability or acts of services
                outside our control, though we select and monitor them as part of running the
                Service responsibly.
              </P>

              <H3 id={slug('Warranties')}>13. Warranties</H3>
              <P>
                The Service is provided "as is" without warranties of any kind, express or implied,
                including merchantability, fitness for a particular purpose and non-infringement,
                except as expressly stated here or required by law.
              </P>

              <H3 id={slug('Limitation of liability')}>14. Limitation of liability</H3>
              <P>
                To the maximum extent permitted by law, we are not liable for indirect, incidental,
                special or consequential damages, or for lost data, profits or revenue, arising from
                your use of the Service.
              </P>

              <H3 id={slug('Termination')}>15. Termination</H3>
              <P>
                You may stop using the Service and delete your account at any time. We may terminate
                or suspend access for breach of these Terms. Sections 11, 13 and 14 survive
                termination.
              </P>

              <H3 id={slug('Changes to these Terms')}>16. Changes to these Terms</H3>
              <P>
                We may update these Terms. For material changes we will notify account owners by
                email before the change takes effect, and the date above will move.
              </P>

              <H3 id={slug('Governing law')}>17. Governing law</H3>
              <P>
                To be specified once the operating entity is finalised.
              </P>
            </section>

            {/* ════════════════════════ SAFETY ════════════════════════ */}
            <section id="safety" className="doc__section">
              <H2 id="safety-heading">Safety</H2>
              <P>
                How the infrastructure itself is protected. This section describes what is built and
                deployed, and closes with what we do not claim.
              </P>

              <H3 id={slug('The platform')}>The platform</H3>
              <List items={[
                <><strong>Serverless at the edge.</strong> No servers, no SSH, no patching window. The API with its MCP server, the dashboard and the admin console are three edge services; the data is in block-based object storage, an edge database, a cache and a queue in the same account.</>,
                <><strong>Custom domains only.</strong> The provider's default public hostname is switched off for every service, so there is no second entry point that bypasses the named domains.</>,
                <><strong>Infrastructure as code.</strong> Everything is declared, one configuration per environment, with a guard that refuses to run in any other. Only one pipeline may apply changes; the others read outputs and cannot write.</>,
                <><strong>Resource IDs are never typed by hand.</strong> The deploy injects them from the infrastructure outputs and asserts every name against the environment before deploying, so a stale selection fails loudly instead of applying one environment's intent to another's resources.</>,
                <><strong>Secrets that decrypt data never enter infrastructure state or build artifacts.</strong> The database encryption key and the session signing key live only as runtime secrets.</>,
              ]} />

              <H3 id={slug('The request path')}>The request path</H3>
              <List items={[
                <><strong>One authorization chain</strong> for REST and MCP: authenticate, resolve scope, bind the workspace from the credential, authorize the operation and the path, check quota and billing, then run the handler with only workspace-bound access. A handler cannot write an unscoped query because it never holds anything that could run one.</>,
                <><strong>Identical failures.</strong> Every authentication failure returns one body, and so does every refusal on a public share link other than the password prompt itself. Reasons go to the log.</>,
                <><strong>Prefixes match whole segments</strong>, listings are clipped to the prefix, and a file outside it answers 404 rather than confirming it exists.</>,
                <><strong>Moves and copies check both ends</strong>, so write on a source never buys write on a destination.</>,
                <><strong>Sizes come from storage</strong>, and a lie about size costs the bytes, not the quota.</>,
              ]} />

              <H3 id={slug('The edges')}>The edges</H3>
              <List items={[
                <><strong>The dashboard</strong> ships a Content-Security-Policy that names only the API it was built against, the sign-in provider, the bot check, the font host and the upload host; plus HSTS, <code>X-Frame-Options: DENY</code>, <code>nosniff</code> and a strict referrer policy. A CORS allow-list names the dashboard and console origins and nothing else.</>,
                <><strong>The one unauthenticated write</strong>, sandbox creation, sits behind a bot check verified server-side and a per-IP limit of ten per hour. The check failing closed means we stop issuing sandboxes rather than start issuing them to bots.</>,
                <><strong>Share-link passwords</strong> are limited to ten wrong guesses per fifteen minutes per link, and share tokens are 32 random characters looked up by hash.</>,
                <><strong>Webhook deliveries</strong> are signed with a timestamp inside the signed material and a five-minute replay window.</>,
              ]} />

              <H3 id={slug('The operators')}>The operators</H3>
              <List items={[
                <><strong>A separate console on a separate origin.</strong> Support engineers use an internal admin console with its own hostname and its own look, so an operator always knows which surface they are in.</>,
                <><strong>Being an operator is a row in a table</strong>, read fresh on every request, never a claim baked into a token. Removing the row takes effect immediately.</>,
                <><strong>Every operator action is audited</strong>, including refusals, by a base class no admin area can bypass. Deleting a customer's workspace or account from the console is a two-step act: suspend first, which is instant and reversible, then delete, which sets a 30-day timestamp and stops; the actual removal is a separate job that defaults to reporting rather than deleting.</>,
                <><strong>Operators never see card numbers</strong>, and the console renders nothing it cannot source.</>,
              ]} />

              <H3 id={slug('How we know it works')}>How we know it works</H3>
              <List items={[
                <>The API has over 950 automated tests, including repository and route tests that seed two workspaces and prove each answers the other's IDs with nothing, and a sweep across every authenticated route that proves a missing credential is answered like an invalid one.</>,
                <>Every security-critical behaviour in the storage core was mutation-tested: 22 deliberate breaks, each confirmed to turn the suite red.</>,
                <>Branch protection requires the application and infrastructure checks to pass before anything merges; the deployment pipeline ends with a smoke test against the live hostnames that fails the run if a security header goes missing.</>,
                <>Destructive background jobs, the sandbox sweep, the admin purge and the billing ladder, each default to reporting and need an explicit flag per environment to delete anything.</>,
              ]} />

              <H3 id={slug('What we do not claim')}>What we do not claim</H3>
              <List items={[
                <>Not end-to-end encrypted. Our service can read your files when a request authorizes it; encryption at rest is the infrastructure provider's.</>,
                <>No compliance certification is claimed.</>,
                <>Log out everywhere invalidates every issued session token but cannot revoke the sign-in provider's underlying refresh token; a stolen device should also change its password.</>,
                <>No per-key rate limit on the authenticated surface yet. Quotas are the throttle there; the rate limits that exist guard sandbox creation and share-link passwords, and are coarse and eventually consistent.</>,
              ]} />

              <H3 id={slug('Reporting a vulnerability')}>Reporting a vulnerability</H3>
              <P>
                Email <code>connect@agentdisk.io</code> with "Security" in the subject, or use the
                Support form in the dashboard. Please do not open a public issue. If you have pasted
                a key somewhere it should not be, disable it under API keys first; re-enabling
                issues a new secret.
              </P>
            </section>

            {/* ═══════════════════════ REFERENCE ═══════════════════════ */}
            <section id="reference" className="doc__section">
              <H2 id="reference-heading">Reference</H2>

              <H3 id={slug('REST endpoints')}>REST endpoints</H3>
              <P>
                Base URL <code>{API_BASE}</code>. Every request carries{' '}
                <code>Authorization: Bearer &lt;key or ID token&gt;</code> unless marked public.
                Bodies and responses are JSON. Errors are{' '}
                <code>{'{ "error": { "code", "message", "requestId", "details"? } }'}</code>.
              </P>
              {ROUTES.map(([group, rows]) => (
                <Table
                  key={group}
                  caption={group}
                  head={['Method', 'Path', 'Does']}
                  rows={rows.map(([m, p, d]) => [<span className="doc__method">{m}</span>, <code>{p}</code>, d])}
                />
              ))}

              <H3 id={slug('Error codes')}>Error codes</H3>
              <Table head={['Status', 'Code', 'Meaning']} rows={ERRORS.map(([s, c, m]) => [s, <code>{c}</code>, m])} />

              <H3 id={slug('Webhook events')}>Webhook events</H3>
              <P>
                Subscribe to any subset. Anything else is refused at registration. Today only{' '}
                <code>file.created</code> and <code>file.deleted</code> are emitted; the other
                three can be registered now and will fire when metadata edits and folder changes
                become audited events.
              </P>
              <div className="doc__chips">{WEBHOOK_EVENTS.map(e => <code key={e} className="doc__chip">{e}</code>)}</div>

              <H3 id={slug('Activity events')}>Activity events</H3>
              <P>
                What the Activity log and the <code>/v1/activity</code> route can show.{' '}
                <code>mcp.&lt;tool&gt;</code> is one row per MCP tool call, named for the tool,
                with a result of ok or denied.
              </P>
              <div className="doc__chips">{AUDIT_EVENTS.map(e => <code key={e} className="doc__chip">{e}</code>)}</div>

              <H3 id={slug('Limits')}>Limits</H3>
              <Table
                head={['Limit', 'Value']}
                rows={[
                  ['Inline upload', '1 MB'],
                  ['Per-file cap', 'By plan: 100 MB, 500 MB, 1 GB, 4.9 GB'],
                  ['Storage, file count', 'By plan, pooled across the account; see the plan table'],
                  ['Egress', 'By plan, per workspace per month; see the plan table'],
                  ['Sandbox allowance', '50 MB, 500 files, 500 MB egress, 10,000 requests, 1 agent, 1 key'],
                  ['Presigned upload URL', '15 minutes'],
                  ['Download URL', '1 hour'],
                  ['Share link lifetime', '7 days, default and maximum'],
                  ['Share password', '6 to 128 characters; 10 wrong guesses per 15 minutes per link'],
                  ['Sandbox creation', '10 per hour per IP, plus a bot check'],
                  ['Page size', '50 default, 200 maximum'],
                  ['Tags per file', '32'],
                  ['Agent and key names', '15 characters'],
                  ['Webhook replay window', '300 seconds'],
                  ['Workspaces closed per account deletion', '20'],
                ]}
              />
            </section>
          </article>

          <aside className="doc__rail" aria-label="On this page">
            <div className="doc__raillabel">ON THIS PAGE</div>
            <div className="doc__railhead">{current.label}</div>
            <div className="doc__raillist">
              {current.subs.map(o => (
                <a key={o} href={`#${slug(o)}`} className="doc__railitem">{o}</a>
              ))}
            </div>
          </aside>

        </div>
      </div>
      <Footer />
    </div>
  );
}

export default Docs;
