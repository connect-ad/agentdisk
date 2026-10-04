// @vitest-environment node
/**
 * The agent discovery documents (scripts/agent-discovery.js): each carries
 * the fields the Cloudflare Agent Readiness checks look for, names this
 * environment's hosts, and agrees with the code it describes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISCOVERY_PATHS, MCP_PROTOCOL_VERSION, MCP_SERVER_INFO, discoveryFiles } from '../scripts/agent-discovery.js';
import { DISCOVERY_TYPES } from '../worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const llmsTxt = readFileSync(join(here, '..', 'public', 'llms.txt'), 'utf8');
const files = discoveryFiles({
  apiBase: 'https://api-dev.agentdisk.io/',
  siteHost: 'dev.agentdisk.io',
  appHost: 'app-dev.agentdisk.io',
  llmsTxt
});
const doc = path => JSON.parse(files[path]);

describe('the discovery documents', () => {
  it('are exactly the files the Worker serves with discovery headers', () => {
    expect(Object.keys(files).sort()).toEqual(Object.values(DISCOVERY_PATHS).sort());
    expect(Object.keys(DISCOVERY_TYPES).sort()).toEqual(Object.values(DISCOVERY_PATHS).sort());
  });

  it('name this environment\'s hosts and never production\'s', () => {
    for (const [path, contents] of Object.entries(files)) {
      if (path === DISCOVERY_PATHS.skill) continue; // llms.txt verbatim, which names prod and says how to swap
      expect(contents, path).not.toMatch(/https:\/\/(api|app)\.agentdisk\.io|https:\/\/agentdisk\.io/);
    }
    expect(files[DISCOVERY_PATHS.authMd]).toContain('POST https://api-dev.agentdisk.io/v1/workspaces');
  });

  it('auth.md opens with an H1 naming auth.md, and documents the method and the credential', () => {
    const md = files[DISCOVERY_PATHS.authMd];
    expect(md.split('\n')[0]).toMatch(/^# .*auth\.md/);
    expect(md).toContain('Authorization: Bearer <apiKey.token>');
    expect(md).toContain('https://api-dev.agentdisk.io/mcp');
  });

  it('the API catalog is an RFC 9727 linkset with service-desc, service-doc and status', () => {
    const [entry] = doc(DISCOVERY_PATHS.apiCatalog).linkset;
    expect(entry.anchor).toBe('https://api-dev.agentdisk.io/v1');
    expect(entry['service-desc'][0].href).toBe('https://dev.agentdisk.io/openapi.json');
    expect(entry['service-doc'].length).toBeGreaterThan(0);
    expect(entry.status[0].href).toBe('https://api-dev.agentdisk.io/v1/healthz');
  });

  it('the OpenAPI document targets this API and lets the sandbox route go without a credential', () => {
    const spec = doc(DISCOVERY_PATHS.openapi);
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers).toEqual([{ url: 'https://api-dev.agentdisk.io' }]);
    expect(spec.paths['/v1/workspaces'].post.security).toEqual([]);
    expect(spec.paths['/v1/files'].post.requestBody).toBeDefined();
  });

  it('the MCP server card names the server, its endpoint and its capabilities', () => {
    const card = doc(DISCOVERY_PATHS.serverCard);
    expect(card.serverInfo).toMatchObject(MCP_SERVER_INFO);
    expect(card.transport.endpoint).toBe('https://api-dev.agentdisk.io/mcp');
    expect(card.capabilities.tools).toBeDefined();
  });

  it('the server card restates the API Worker\'s own server info', () => {
    const source = readFileSync(join(here, '..', '..', 'api', 'src', 'mcp', 'server.ts'), 'utf8');
    expect(source).toContain(`const SERVER_INFO = { name: "${MCP_SERVER_INFO.name}", version: "${MCP_SERVER_INFO.version}" };`);
    expect(source).toContain(`const PROTOCOL_VERSION = "${MCP_PROTOCOL_VERSION}";`);
  });

  it('the skills index lists the skill with the digest of the file served', () => {
    const index = doc(DISCOVERY_PATHS.skillsIndex);
    expect(index.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
    const [skill] = index.skills;
    expect(skill).toMatchObject({ name: 'agentdisk', type: 'skill-md', url: 'https://dev.agentdisk.io/.well-known/agent-skills/agentdisk/SKILL.md' });
    const hex = createHash('sha256').update(files[DISCOVERY_PATHS.skill], 'utf8').digest('hex');
    expect(skill.digest).toBe(`sha256:${hex}`);
    expect(files[DISCOVERY_PATHS.skill]).toMatch(/^---\nname: agentdisk\ndescription: ".+"\n---\n/);
  });

  it('the ARD manifest has a host and entries with exactly one of url or data', () => {
    const catalog = doc(DISCOVERY_PATHS.aiCatalog);
    expect(catalog.specVersion).toBeTruthy();
    expect(catalog.host).toEqual({ displayName: 'AgentDisk', identifier: 'did:web:dev.agentdisk.io' });
    expect(catalog.entries.length).toBeGreaterThan(0);
    for (const entry of catalog.entries) {
      expect(entry.identifier).toMatch(/^urn:air:dev\.agentdisk\.io:/);
      expect(entry.displayName && entry.type).toBeTruthy();
      expect('url' in entry !== 'data' in entry).toBe(true);
      expect(entry.representativeQueries.length).toBeGreaterThanOrEqual(2);
    }
  });
});
