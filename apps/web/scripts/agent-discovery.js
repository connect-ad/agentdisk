/**
 * The machine-readable discovery documents the site publishes for agents.
 *
 * Written into `dist/` at build by the `agentdisk-security-headers` plugin in
 * vite.config.js, beside robots.txt and the sitemap, from the same `VITE_*`
 * values the bundle is built with: every URL in them names this
 * environment's API and site, so dev's documents describe dev. Added
 * 4 Oct 2026 for the Cloudflare Agent Readiness checks (Skill 12, F20):
 *
 *   /auth.md                                  how an agent gets a credential
 *   /openapi.json                             the agent-facing REST surface
 *   /.well-known/api-catalog                  RFC 9727 linkset naming the above
 *   /.well-known/mcp/server-card.json         the MCP server (SEP-1649)
 *   /.well-known/agent-skills/index.json      skills discovery index, v0.2.0
 *   /.well-known/agent-skills/agentdisk/SKILL.md   llms.txt, as a skill
 *   /.well-known/ai-catalog.json              ARD manifest naming all of it
 *
 * Deliberately absent: OAuth discovery and Protected Resource Metadata (the
 * API has no OAuth authorization server; agents hold API keys), an A2A agent
 * card (AgentDisk is not an agent) and WebMCP (the pages expose no tools).
 * Publishing any of them would describe something that does not exist.
 *
 * `MCP_SERVER_INFO` and `MCP_PROTOCOL_VERSION` restate apps/api's
 * `SERVER_INFO` and `PROTOCOL_VERSION` (src/mcp/server.ts);
 * test/agent-discovery.test.js reads that file and fails when they differ.
 *
 * Plain JavaScript, imported by Node from vite.config.js outside Vite.
 */

import { createHash } from 'node:crypto';

export const MCP_SERVER_INFO = { name: 'agentdisk', version: '1.1.0' };
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** The documents' published paths, in `dist/`. Every one is a file, so the site Worker 404s it when absent. */
export const DISCOVERY_PATHS = {
  authMd: '/auth.md',
  openapi: '/openapi.json',
  apiCatalog: '/.well-known/api-catalog',
  serverCard: '/.well-known/mcp/server-card.json',
  skillsIndex: '/.well-known/agent-skills/index.json',
  skill: '/.well-known/agent-skills/agentdisk/SKILL.md',
  aiCatalog: '/.well-known/ai-catalog.json'
};

const SKILL_DESCRIPTION =
  'Give yourself persistent file storage on AgentDisk: create a sandbox workspace with one POST and no account, ' +
  'store the key, hand the claim link to your person, then read and write files over REST or MCP.';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/* --------------------------------- auth.md -------------------------------- */

function authMd({ api, site, app }) {
  return `# AgentDisk auth.md

How an AI agent gets a credential for AgentDisk, file storage built for AI
agents. AgentDisk has no OAuth flow. An agent either registers itself
anonymously with one request, or is handed an API key by a person.

## Audience

Autonomous agents and scripts with an HTTP tool or a shell. People sign in to
the dashboard at ${app} with Google, GitHub or email; this page is not for them.

## Method 1: anonymous self-registration (sandbox)

No account, no token, no browser, no bot check.

    POST ${api}/v1/workspaces
    Content-Type: application/json

    {"name": "<short name for this job>", "agentName": "<your name>"}

Both fields are optional. \`agentName\` may use letters, digits, spaces, \`-\` and
\`_\`, up to 64 characters. Send no \`Authorization\` header: a request carrying
an API key is refused on this route.

The \`201\` response is shown once and contains:

- \`apiKey.token\`: your credential. Scopes \`read\`, \`write\`, \`delete\`, \`list\`
  on every path of the new workspace. No expiry and no use limit; it works for
  as long as the workspace exists.
- \`claim.url\`: a secret link for the person you work for. Whoever opens it
  signed in becomes the owner. It cannot be reissued.
- \`workspace.limits\` and \`workspace.deleteAfter\`: what the sandbox may hold,
  and when it is deleted with everything in it unless claimed.
- \`nextSteps\`: what to do now, in order.

Limits on this route: 10 creations per hour and 5 unclaimed sandboxes at once,
per IP address. Claiming keeps every file and keeps the key working.

## Method 2: a key issued by a person

The owner of a workspace mints keys in the dashboard (${app}) with a chosen
set of operations (\`read\`, \`write\`, \`delete\`, \`list\`, \`share\`,
\`keys:create\`) and an optional path prefix, and gives the key to the agent.
A key can never mint a broader key than itself.

## Using the credential

Send it as a bearer token on every request, REST and MCP alike:

    Authorization: Bearer <apiKey.token>

- REST: ${api}/v1 (OpenAPI description: ${site}${DISCOVERY_PATHS.openapi})
- MCP (Streamable HTTP): ${api}/mcp
- Check it: \`GET ${api}/v1/whoami\` returns the workspace, the key's scopes and
  usage against the limits.

Store the token in your own configuration, never in a file inside the
workspace: a claimed workspace's readers can see every file in it. A lost
sandbox key is recoverable only by the person who claims the workspace, from
the dashboard's Keys page.

Every authentication failure returns the same \`401\` body, whatever the cause.

## More

- Step-by-step for agents: ${site}/llms.txt
- Full documentation: ${site}/docs
`;
}

/* ------------------------------ openapi.json ------------------------------ */

const ok = description => ({ '2XX': { description, content: { 'application/json': { schema: { type: 'object' } } } } });
const errorResponse = { description: 'Error envelope', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const withErrors = responses => ({ ...responses, '4XX': errorResponse });
const body = (properties, required = []) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required, properties } } }
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const pathQuery = { name: 'path', in: 'query', required: true, description: 'The file path, for example /notes/hello.txt', schema: { type: 'string' } };
const query = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });
const metadata = { type: 'object', description: 'Custom key-value metadata.', additionalProperties: true };
const tags = { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 64 } };

function openapi({ api, site }) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentDisk API',
      version: '1',
      description:
        'The agent-facing REST surface of AgentDisk: sandbox self-registration, files, folders, search and the ' +
        'audit log. Routes only a signed-in person may call (billing, members, keys, account) are not listed. ' +
        `Credentials: ${site}${DISCOVERY_PATHS.authMd}.`
    },
    externalDocs: { url: `${site}/docs` },
    servers: [{ url: api }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'An AgentDisk API key.' } },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                requestId: { type: 'string' },
                details: { type: 'object', additionalProperties: true }
              }
            }
          }
        }
      }
    },
    paths: {
      '/v1/healthz': { get: { summary: 'Service health', security: [], responses: ok('Health report') } },
      '/v1/workspaces': {
        post: {
          summary: 'Create a sandbox workspace (no credential)',
          description: 'Anonymous self-registration. Send no Authorization header. Returns an API key and a claim link, shown once.',
          security: [],
          requestBody: body({
            name: { type: 'string', minLength: 1, maxLength: 64 },
            agentName: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9 _-]*$' },
            turnstileToken: { type: 'string', description: 'Only from a browser that solved the challenge.' }
          }),
          responses: withErrors({ 201: { description: 'Workspace, agent, apiKey, claim and nextSteps', content: { 'application/json': { schema: { type: 'object' } } } } })
        }
      },
      '/v1/whoami': { get: { summary: 'The workspace, scopes and usage of this credential', responses: withErrors(ok('Identity')) } },
      '/v1/files': {
        get: {
          summary: 'List files',
          parameters: [query('path', 'Folder to list'), query('limit', 'Page size', { type: 'integer' }), query('cursor', 'From the previous page')],
          responses: withErrors(ok('A page of files'))
        },
        post: {
          summary: 'Create a file',
          description: 'Send base64 `content` (up to 1 MB) to write inline, or `sizeBytes` to receive a 15-minute presigned PUT, then call complete.',
          requestBody: body(
            {
              path: { type: 'string', minLength: 1 },
              content: { type: 'string', contentEncoding: 'base64' },
              sizeBytes: { type: 'integer', minimum: 0 },
              mimeType: { type: 'string', maxLength: 255 },
              checksumSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              caption: { type: 'string', maxLength: 1024 },
              metadata,
              tags
            },
            ['path']
          ),
          responses: withErrors(ok('The file, or the file and an upload URL'))
        }
      },
      '/v1/files/{id}': {
        parameters: [idParam],
        get: { summary: 'File metadata', responses: withErrors(ok('The file')) },
        patch: {
          summary: 'Update caption, metadata or tags',
          requestBody: body({ caption: { type: ['string', 'null'], maxLength: 1024 }, metadata, tags }),
          responses: withErrors(ok('The file'))
        },
        delete: { summary: 'Delete a file', responses: withErrors(ok('Deleted')) }
      },
      '/v1/files/{id}/content': { parameters: [idParam], get: { summary: 'The bytes inline, up to 1 MB', responses: withErrors(ok('File content')) } },
      '/v1/files/{id}/download': { parameters: [idParam], get: { summary: 'A one-hour presigned download URL', responses: withErrors(ok('Download URL')) } },
      '/v1/files/by-path': {
        parameters: [pathQuery],
        get: { summary: 'A file by its path: the same resource GET /v1/files/{id} returns', responses: withErrors(ok('The file')) },
        patch: { summary: 'Update caption, metadata or tags, by path', requestBody: body({ caption: { type: 'string', maxLength: 1024 }, metadata, tags }), responses: withErrors(ok('The file')) },
        delete: { summary: 'Delete a file by path. Permanent.', responses: withErrors(ok('Deleted')) }
      },
      '/v1/files/by-path/content': { parameters: [pathQuery], get: { summary: 'The bytes inline by path, up to 1 MB', responses: withErrors(ok('File content')) } },
      '/v1/files/by-path/download': { parameters: [pathQuery], get: { summary: 'A one-hour presigned download URL, by path', responses: withErrors(ok('Download URL')) } },
      '/v1/files/{id}/complete': {
        parameters: [idParam],
        post: {
          summary: 'Finish a presigned upload',
          requestBody: body({ sizeBytes: { type: 'integer', minimum: 0 }, checksumSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } }),
          responses: withErrors(ok('The file'))
        }
      },
      '/v1/files/{id}/move': {
        parameters: [idParam],
        post: { summary: 'Move a file', requestBody: body({ path: { type: 'string' } }, ['path']), responses: withErrors(ok('The file')) }
      },
      '/v1/files/{id}/copy': {
        parameters: [idParam],
        post: { summary: 'Copy a file', requestBody: body({ path: { type: 'string' } }, ['path']), responses: withErrors(ok('The new file')) }
      },
      '/v1/search': {
        get: {
          summary: 'Search files',
          parameters: [query('q', 'Search term'), query('limit', 'Page size', { type: 'integer' }), query('cursor', 'From the previous page')],
          responses: withErrors(ok('Matching files'))
        }
      },
      '/v1/folders': {
        get: { summary: 'List folders', parameters: [query('path', 'Parent folder')], responses: withErrors(ok('Folders')) },
        post: { summary: 'Create a folder', requestBody: body({ path: { type: 'string', minLength: 1 } }, ['path']), responses: withErrors(ok('The folder')) }
      },
      '/v1/folders/{id}': {
        parameters: [idParam],
        delete: {
          summary: 'Delete a folder',
          parameters: [query('recursive', 'Delete everything inside', { type: 'boolean' })],
          responses: withErrors(ok('Deleted'))
        }
      },
      '/v1/activity': {
        get: { summary: 'The audit log', parameters: [query('limit', 'Page size', { type: 'integer' })], responses: withErrors(ok('Audit entries')) }
      }
    }
  };
}

/* ------------------------------- the rest -------------------------------- */

function apiCatalog({ api, site }) {
  return {
    linkset: [
      {
        anchor: `${api}/v1`,
        'service-desc': [{ href: `${site}${DISCOVERY_PATHS.openapi}`, type: 'application/openapi+json' }],
        'service-doc': [
          { href: `${site}/docs`, type: 'text/html' },
          { href: `${site}/llms.txt`, type: 'text/plain' }
        ],
        status: [{ href: `${api}/v1/healthz`, type: 'application/json' }]
      }
    ]
  };
}

function serverCard({ api, site }) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: { ...MCP_SERVER_INFO, title: 'AgentDisk' },
    description: 'Persistent, scoped file storage for AI agents: files, folders, metadata and search.',
    documentationUrl: `${site}/docs`,
    transport: { type: 'streamable-http', endpoint: `${api}/mcp` },
    capabilities: { tools: { listChanged: false } },
    authentication: { required: true, schemes: ['bearer'], documentationUrl: `${site}${DISCOVERY_PATHS.authMd}` }
  };
}

function skillMd(llmsTxt) {
  return `---\nname: agentdisk\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${llmsTxt.trim()}\n`;
}

function skillsIndex({ site }, skill) {
  return {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: [
      { name: 'agentdisk', type: 'skill-md', description: SKILL_DESCRIPTION, url: `${site}${DISCOVERY_PATHS.skill}`, digest: sha256(skill) }
    ]
  };
}

function aiCatalog({ site, siteHost }) {
  const id = name => `urn:air:${siteHost}:${name}`;
  return {
    specVersion: '1.0',
    host: { displayName: 'AgentDisk', identifier: `did:web:${siteHost}` },
    entries: [
      {
        identifier: id('server:agentdisk'),
        displayName: 'AgentDisk MCP server',
        type: 'application/mcp-server-card+json',
        url: `${site}${DISCOVERY_PATHS.serverCard}`,
        representativeQueries: ['save this file so I can read it next session', 'list the files in my workspace', 'search my stored notes']
      },
      {
        identifier: id('api:rest'),
        displayName: 'AgentDisk REST API',
        type: 'application/linkset+json',
        url: `${site}${DISCOVERY_PATHS.apiCatalog}`,
        representativeQueries: ['upload a file over HTTP', 'get a presigned download URL', 'create a storage workspace for an agent']
      },
      {
        identifier: id('skill:agentdisk'),
        displayName: 'Use AgentDisk for persistent storage',
        type: 'text/markdown',
        url: `${site}${DISCOVERY_PATHS.skill}`,
        representativeQueries: ['give my agent persistent file storage', 'create a sandbox workspace without an account']
      }
    ]
  };
}

/**
 * Every document, as `{ [published path]: contents }`.
 *
 * `apiBase` is the API origin the bundle calls (`VITE_API_BASE`), `siteHost`
 * and `appHost` the environment's two hostnames, `llmsTxt` the contents of
 * public/llms.txt.
 */
export function discoveryFiles({ apiBase, siteHost, appHost, llmsTxt }) {
  const urls = {
    api: apiBase.replace(/\/+$/, ''),
    site: `https://${siteHost}`,
    app: `https://${appHost}`,
    siteHost
  };
  const skill = skillMd(llmsTxt);
  return {
    [DISCOVERY_PATHS.authMd]: authMd(urls),
    [DISCOVERY_PATHS.openapi]: json(openapi(urls)),
    [DISCOVERY_PATHS.apiCatalog]: json(apiCatalog(urls)),
    [DISCOVERY_PATHS.serverCard]: json(serverCard(urls)),
    [DISCOVERY_PATHS.skill]: skill,
    [DISCOVERY_PATHS.skillsIndex]: json(skillsIndex(urls, skill)),
    [DISCOVERY_PATHS.aiCatalog]: json(aiCatalog(urls))
  };
}
