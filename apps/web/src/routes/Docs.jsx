import React from 'react';
import { Link } from 'react-router-dom';
import { Nav, Footer } from './Marketing.jsx';

/**
 * A quickstart, not the documentation site.
 *
 * Doc 03 §8.31 lists a full docs site as an intentionally separate build,
 * generated from `openapi.yaml` so it cannot drift from the deployed API. This
 * page is not that. It exists because the marketing nav has linked to /docs
 * since the landing page was written.
 *
 * ── Layout from the design, content from the codebase ─────────────────────
 * `AgentDisk Site.dc.html` draws a three-column docs page — TOC, article,
 * "on this page" rail — and this follows it exactly.
 *
 * Its *content* does not, and deliberately. The design's article tells the
 * reader to `npm install -g @agentdisk/mcp` and run `adk auth login`, then
 * registers the server with a `"command": "npx"` stdio block, and lists five
 * tools named list / read / write / stat / delete.
 *
 * None of that is this product. The MCP server is HTTP, at `/mcp` in the same
 * Worker, configured with a `url` and an Authorization header — exactly what
 * `routes/McpConnection.jsx` shows a signed-in user. There is no npm package
 * and no `adk` CLI, and the ten real tools are named `list_files`,
 * `create_file` and so on. Shipping the design's instructions would hand
 * somebody commands that fail at the first line.
 *
 * So the shape is the design's and the words are the product's.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://api-dev.agentdisk.io';
const MCP_ENDPOINT = `${API_BASE}/mcp`;

const MCP_CONFIG = `{
  "mcpServers": {
    "agentdisk": {
      "url": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer adk_live_…"
      }
    }
  }
}`;

const UPLOAD = `curl -X POST ${API_BASE}/v1/files \
  -H "Authorization: Bearer $AGENTDISK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path":"/reports/q1.pdf","mimeType":"application/pdf",
       "mode":"inline","content":"<base64 bytes>"}'`;

const WHOAMI = `curl ${API_BASE}/v1/whoami?workspaceId=ws_… \
  -H "Authorization: Bearer $AGENTDISK_KEY"`;

/** The ten tools the server actually registers, with the scope each requires. */
const TOOLS = [
  { name: 'list_files', body: 'Enumerate files and folders under a path', scope: 'LIST' },
  { name: 'search_files', body: 'Match a substring against name and path', scope: 'LIST' },
  { name: 'get_file', body: "Metadata plus a short-lived download URL", scope: 'READ' },
  { name: 'get_metadata', body: 'Size, checksum, version and content type', scope: 'READ' },
  { name: 'create_file', body: 'Create a file, inline or by presigned upload', scope: 'WRITE' },
  { name: 'update_file', body: 'Replace an existing file’s contents', scope: 'WRITE' },
  { name: 'create_folder', body: 'Create a folder and any missing parents', scope: 'WRITE' },
  { name: 'move_file', body: 'Move or rename — write at both ends', scope: 'WRITE' },
  { name: 'copy_file', body: 'Copy — read at the source, write at the target', scope: 'WRITE' },
  { name: 'delete_file', body: 'Permanently destroys the file. Not recoverable', scope: 'DELETE' },
];

const TOC = [
  { label: 'GETTING STARTED', items: ['Quickstart', 'Workspaces', 'Regions'] },
  { label: 'AGENTS', items: ['Agent identities', 'Creating your first API key', 'Connecting an agent over MCP', 'Scoping keys to a path prefix'] },
  { label: 'REFERENCE', items: ['REST API', 'MCP tools', 'Webhook events', 'Error codes'] },
];

const ACTIVE = 'Connecting an agent over MCP';

const ON_THIS_PAGE = [
  'Create a scoped key',
  'Register the server with your client',
  'Confirm the tools registered',
  'Troubleshooting',
];

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

export function Docs() {
  return (
    <div className="mk">
      <Nav />
      <div className="mk__wrap">
        <div className="doc">

          <aside className="doc__toc" aria-label="Documentation sections">
            {/*
              The TOC names the pages a full docs site would have. This build is
              one page, so these are labels rather than links — rendering them as
              links to nowhere would be nine dead ends. The entry for this page
              is marked current.
            */}
            {TOC.map(g => (
              <div key={g.label} className="doc__tocgroup">
                <div className="doc__toclabel">{g.label}</div>
                {g.items.map(item => (
                  <span
                    key={item}
                    className={item === ACTIVE ? 'doc__tocitem is-current' : 'doc__tocitem'}
                    aria-current={item === ACTIVE ? 'page' : undefined}
                  >
                    {item}
                  </span>
                ))}
              </div>
            ))}
          </aside>

          <article className="doc__body">
            <nav className="doc__crumb" aria-label="Breadcrumb">
              <span>Docs</span><span aria-hidden="true">/</span>
              <span>Agents</span><span aria-hidden="true">/</span>
              <span className="doc__crumbnow">{ACTIVE}</span>
            </nav>

            <h1 className="doc__h1">Connecting an agent over MCP</h1>
            <p className="doc__lead">
              The AgentDisk MCP server turns a workspace into a set of tools any
              MCP-capable client can call. This guide connects one agent with read
              and write access to a single prefix.
            </p>

            <div className="doc__note">
              <span>
                You need a workspace ID and a key with at least <code>read</code> and{' '}
                <code>list</code>. Create one under <Link to="/app">API keys</Link> in
                the dashboard.
              </span>
            </div>

            <h2 className="doc__h2">1. Create a scoped key</h2>
            <p className="doc__p">
              Keys are minted in the dashboard against an agent identity. Pick the
              operations the agent needs and, optionally, a path prefix it may not
              reach outside of. The key is shown once.
            </p>

            <h2 className="doc__h2">2. Register the server with your client</h2>
            <p className="doc__p">
              The server speaks MCP over HTTP, so a client needs a URL and a header —
              there is no package to install. The workspace the key belongs to scopes
              every call; an agent cannot reach a workspace it was not given.
            </p>
            <Code caption="CLAUDE_DESKTOP_CONFIG.JSON">{MCP_CONFIG}</Code>

            <h2 className="doc__h2">3. Confirm the tools registered</h2>
            <p className="doc__p">
              On a successful handshake the client lists the tools your key's scopes
              allow — <code>tools/list</code> filters on scope, so a read-only key
              sees fewer than a full one. That is the scope model working, not a
              failed handshake.
            </p>
            <div className="doc__tools">
              {TOOLS.map(t => (
                <div key={t.name} className="doc__tool">
                  <span className="doc__toolname">{t.name}</span>
                  <span className="doc__toolbody">{t.body}</span>
                  <span className="doc__toolscope">{t.scope}</span>
                </div>
              ))}
            </div>

            <h2 className="doc__h2">The REST API</h2>
            <p className="doc__p">Everything the MCP tools do is also plain HTTP.</p>
            <Code caption="SHELL">{UPLOAD}</Code>
            <Code caption="SHELL">{WHOAMI}</Code>

            <h2 className="doc__h2">Troubleshooting</h2>
            <p className="doc__p">
              A <code>403 scope_denied</code> means the handshake succeeded but the
              key lacks the scope for that call. Denied calls appear in Activity with
              the scope they needed. A <code>401</code> means the key itself was not
              accepted — every authentication failure returns the same body, so the
              reason is in your dashboard's activity log rather than the response.
            </p>
          </article>

          <aside className="doc__rail" aria-label="On this page">
            <div className="doc__raillabel">ON THIS PAGE</div>
            <div className="doc__raillist">
              {ON_THIS_PAGE.map((o, i) => (
                <span key={o} className={i === 0 ? 'doc__railitem is-current' : 'doc__railitem'}>
                  {o}
                </span>
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
