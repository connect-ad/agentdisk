// Mock API answers for the responsive harness. Realistic and long, so that
// truncation and wrapping actually get exercised.
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
export const WS = { id: 'ws_01HTXK6V7Q8R9S0T1U2V3W4X5Y', name: 'Kessler Labs', slug: 'kessler-labs', role: 'owner' };
export const WS2 = { id: 'ws_01HTXK6V7Q8R9S0T1U2V3W4X5Z', name: 'qa-1609-throwaway-long-name', slug: 'qa-1609-throwaway-long-name', role: 'reader' };

export const whoami = {
  workspace: { id: WS.id, name: WS.name, plan: 'pro' },
  usage: {
    storageBytes: { used: 41984000000, max: 53687091200 },
    files: { used: 12481, max: 1000000 },
    requests: { used: 1940000, max: 5000000 },
    egressBytes: { used: 12000000000, max: 536870912000 },
    shareLinks: { used: 3, max: 100 },
    periodResetAt: iso(-86400000 * 12),
  },
};
const mk = (i, name, mime, size, agent) => ({
  id: `fil_${String(i).padStart(26, '0')}`, name, path: `/research/${name}`, mimeType: mime,
  sizeBytes: size, updatedAt: iso(3600000 * (i + 1)), createdBy: agent ? 'agt_01HTXK6V7Q8R9S0T1U2V3W4X5A' : 'usr_01HARNESS0000000000000000',
  checksumSha256: 'ab'.repeat(32),
});
export const files = { files: [
  mk(1, 'competitive-landscape-q3-2026-final-revision.md', 'text/markdown', 2048, true),
  mk(2, 'report.pdf', 'application/pdf', 4096000, false),
  mk(3, 'transcript-2026-09-14.json', 'application/json', 812345, true),
  mk(4, 'a-very-long-file-name-without-any-spaces-that-goes-on-and-on.csv', 'text/csv', 51234, true),
  mk(5, 'photo.png', 'image/png', 2400000, false),
  mk(6, 'notes.md', 'text/markdown', 512, false),
]};
export const agents = { agents: [
  { id: 'agt_01HTXK6V7Q8R9S0T1U2V3W4X5A', name: 'research-crawler', description: 'Pulls competitor pages nightly.', status: 'active', createdAt: iso(86400000 * 30), createdBy: 'usr_01HARNESS0000000000000000', lastSeenAt: iso(120000) },
  { id: 'agt_01HTXK6V7Q8R9S0T1U2V3W4X5B', name: 'summariser', description: '', status: 'active', createdAt: iso(86400000 * 10), createdBy: 'usr_01HARNESS0000000000000000', lastSeenAt: null },
  { id: 'agt_01HTXK6V7Q8R9S0T1U2V3W4X5C', name: 'retired-bot', description: 'Old.', status: 'disabled', createdAt: iso(86400000 * 90), createdBy: 'usr_01HARNESS0000000000000000', lastSeenAt: iso(86400000 * 40) },
]};
const key = (i, name, agentId, ops, prefix, status, extra = {}) => ({
  id: `key_${String(i).padStart(26, '0')}`, name, agentId, prefix: 'ask_live_', lastFour: String(1000 + i),
  scopes: { ops, pathPrefix: prefix }, status, lastUsedAt: i % 2 ? iso(600000 * i) : null,
  createdAt: iso(86400000 * i), expiresAt: null, revokedAt: status === 'revoked' ? iso(1000) : null,
  retrievable: true, ...extra,
});
export const keys = { keys: [
  key(1, 'crawler production key', 'agt_01HTXK6V7Q8R9S0T1U2V3W4X5A', ['read', 'write', 'list'], '/research', 'active'),
  key(2, 'summariser', 'agt_01HTXK6V7Q8R9S0T1U2V3W4X5B', ['read', 'list'], '', 'active'),
  key(3, 'workspace-wide ci key with a long name', null, ['read', 'write', 'delete', 'list'], '/build/artifacts/nightly', 'disabled'),
  key(4, 'old', 'agt_01HTXK6V7Q8R9S0T1U2V3W4X5C', ['read'], '', 'active', { disabledBy: 'agent' }),
  key(5, 'revoked one', null, ['read'], '', 'revoked'),
]};
const ev = (i, action, type, name, result = 'success') => ({
  id: `evt_${i}`, action, actor: { id: type === 'agent' ? 'agt_01HTXK6V7Q8R9S0T1U2V3W4X5A' : 'usr_01HARNESS0000000000000000', type },
  resource: { id: `fil_${i}` }, at: iso(60000 * i * 7), result, metadata: { name },
  ip: '203.0.113.42', client: 'Claude Desktop/1.4.2 (Macintosh)', requestId: `req_01HTXK6V7Q8R9S0T1U2V3W4X${i}`,
});
export const activity = { events: [
  ev(1, 'mcp.create_file', 'agent', '/research/competitive-landscape-q3-2026-final-revision.md'),
  ev(2, 'file.deleted', 'user', 'report-old.pdf'),
  ev(3, 'mcp.list_files', 'agent', '/research'),
  ev(4, 'key.created', 'user', 'crawler production key'),
  ev(5, 'mcp.delete_file', 'agent', '/secrets/prod.env', 'denied'),
  ev(6, 'mcp.get_file', 'agent', '/research/transcript-2026-09-14.json'),
  ev(7, 'member.invited', 'user', 'colleague@example.com'),
  ev(8, 'mcp.search_files', 'agent', 'landscape'),
]};
export const webhooks = { deliveryEnabled: false, availableEvents: ['file.created', 'file.updated', 'file.deleted', 'folder.created'], webhooks: [
  { id: 'whk_1', url: 'https://hooks.example.com/agentdisk/very/long/path/that/keeps/going/for/a/while', events: ['file.created', 'file.updated', 'file.deleted'], status: 'active', lastDeliveryAt: iso(3600000), failures: 0 },
  { id: 'whk_2', url: 'https://broken.example.net/x', events: ['file.created'], status: 'failing', lastDeliveryAt: iso(86400000), failures: 5 },
]};
export const members = { members: [
  { id: 'mem_1', email: 'rina.kessler@example.com', role: 'owner', joinedAt: iso(86400000 * 40), isYou: true, accountOwner: true },
  { id: 'mem_2', email: 'a.really.long.colleague.address@subdomain.example-company.com', role: 'reader', joinedAt: iso(86400000 * 3), isYou: false, accountOwner: false },
], soleOwnerOf: 1 };
export const billing = {
  billing: { plan: 'pro', status: 'active', configured: true, subscribed: true, ownerEmail: 'rina.kessler@example.com', writesBlocked: false, interval: 'month', cancelAtPeriodEnd: false, periodEndsAt: now + 86400000 * 18, renewalAmountCents: 2000, pastDueSince: null, graceEndsAt: null, purgeAfter: null },
  purchasable: [
    { id: 'basic', monthlyCents: 900, yearlyCents: 9100, savePercent: 15 },
    { id: 'pro', monthlyCents: 2000, yearlyCents: 20400, savePercent: 15 },
    { id: 'team', monthlyCents: 8000, yearlyCents: 81600, savePercent: 15 },
  ],
};
export const shares = { shares: [] };
export const folders = { folders: [{ id: 'fld_1', path: '/research' }] };
export const claimPreview = {
  workspace: { id: WS2.id, name: 'sandbox-7f3a', createdAt: iso(3600000), expiresAt: iso(-86400000 * 6), storageBytes: 1200000, fileCount: 4 },
  limits: { storageBytes: 52428800 },
  agent: { name: 'claude-desktop' },
  warning: null,
  claimable: true,
};
export const sharePreview = {
  kind: 'folder', name: '/research', path: '/research', workspaceName: 'Kessler Labs',
  expiresAt: iso(-86400000 * 5), passwordProtected: false,
  files: [
    { id: 'fil_1', name: 'competitive-landscape-q3-2026-final-revision.md', sizeBytes: 2048, mimeType: 'text/markdown' },
    { id: 'fil_2', name: 'report.pdf', sizeBytes: 4096000, mimeType: 'application/pdf' },
  ],
};

export function answer(url, method) {
  const p = new URL(url).pathname.replace(/^\/__api/, '');
  if (p === '/v1/whoami') return whoami;
  if (p === '/v1/workspaces' && method === 'GET') return { workspaces: [WS, WS2] };
  if (p.startsWith('/v1/workspaces/claim/')) return claimPreview;
  if (p.startsWith('/v1/shares/')) return sharePreview;
  if (p === '/v1/shares') return shares;
  if (p === '/v1/files') return files;
  if (p.startsWith('/v1/files/')) return { file: files.files[0], url: 'about:blank' };
  if (p === '/v1/agents') return agents;
  if (p.startsWith('/v1/agents/')) return { agent: agents.agents[0] };
  if (p === '/v1/keys') return keys;
  if (/^\/v1\/keys\/[^/]+\/secret$/.test(p)) return { secret: 'ask_live_h4rn3ssh4rn3ssh4rn3ssh4rn3ss1001' };
  if (p === '/v1/webhooks') return webhooks;
  if (p.startsWith('/v1/activity')) return activity;
  if (p === '/v1/members') return members;
  if (p === '/v1/billing') return billing;
  if (p === '/v1/folders') return folders;
  return null;
}
