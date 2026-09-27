/**
 * The CLI against a fake API on localhost. What is pinned: the key is sent as
 * a bearer and never printed, `--session` becomes the audit header, a path is
 * resolved by listing its parent and matching exactly, `cat` prints text as
 * text and binary as bytes, and `rm` refuses without `--yes`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseArgs } from '../src/cli.mjs';

const KEY = 'ask_live_' + 'k'.repeat(32);

/** A tiny fake of the routes the CLI touches. Records every request. */
function fakeApi() {
  const seen = [];
  const files = [
    { id: 'fil_AAA', path: '/memory/tasks.md', sizeBytes: 12, mimeType: 'text/markdown' },
    { id: 'fil_BBB', path: '/memory/tasks.md.bak', sizeBytes: 3, mimeType: 'text/plain' },
    { id: 'fil_CCC', path: '/images/dot.png', sizeBytes: 4, mimeType: 'image/png' },
  ];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body });
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      return send(401, { error: { code: 'UNAUTHORIZED', message: 'Authentication failed.', requestId: 'req_1' } });
    }
    if (url.pathname === '/v1/whoami') {
      return send(200, { workspace: { id: 'ws_1', name: 'Test' }, actor: { type: 'agent', id: 'agt_1' }, key: { scopes: { ops: ['read', 'list'], pathPrefix: '' } } });
    }
    if (url.pathname === '/v1/files' && req.method === 'GET') {
      const under = url.searchParams.get('path') ?? '/';
      const prefix = under === '/' ? '/' : under + '/';
      return send(200, { files: files.filter(f => f.path.startsWith(prefix)), nextCursor: null });
    }
    if (url.pathname === '/v1/files' && req.method === 'POST') {
      const parsed = JSON.parse(body);
      return send(201, { file: { id: 'fil_NEW', path: parsed.path, sizeBytes: Buffer.from(parsed.content, 'base64').length, mimeType: parsed.mimeType } });
    }
    const content = url.pathname.match(/^\/v1\/files\/(fil_\w+)\/content$/);
    if (content) {
      const file = files.find(f => f.id === content[1]);
      if (!file) return send(404, { error: { code: 'NOT_FOUND', message: 'No such file.' } });
      if (file.id === 'fil_CCC') return send(200, { file, encoding: 'base64', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), sizeBytes: 4 });
      return send(200, { file, encoding: 'utf-8', content: '# tasks\n- x\n', sizeBytes: 12 });
    }
    const del = url.pathname.match(/^\/v1\/files\/(fil_\w+)$/);
    if (del && req.method === 'DELETE') return send(200, { id: del[1], status: 'deleted', permanent: true });
    send(404, { error: { code: 'NOT_FOUND', message: 'No such route.' } });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, seen, close: () => new Promise(r => server.close(r)) });
    });
  });
}

function io(api, extraEnv = {}) {
  const chunks = [];
  const errors = [];
  return {
    env: { AGENTDISK_KEY: KEY, AGENTDISK_API: api.base, ...extraEnv },
    fetch: globalThis.fetch,
    stdout: t => chunks.push(t),
    stderr: t => errors.push(t),
    text: () => chunks.map(c => (Buffer.isBuffer(c) ? c.toString('latin1') : c)).join(''),
    err: () => errors.join(''),
    chunks,
  };
}

test('parseArgs separates the command, positionals and the flags it knows', () => {
  const p = parseArgs(['cat', '/a.md', '--session', 'run 7', '--json']);
  assert.equal(p.command, 'cat');
  assert.deepEqual(p.args, ['/a.md']);
  assert.equal(p.flags.session, 'run 7');
  assert.equal(p.flags.json, true);
  assert.throws(() => parseArgs(['ls', '--bogus']), /Unknown option/);
});

test('refuses to run without a key, and never asks for one as an argument', async () => {
  const api = await fakeApi();
  try {
    const t = io(api, { AGENTDISK_KEY: '' });
    assert.equal(await run(['whoami'], t), 2);
    assert.match(t.err(), /AGENTDISK_KEY is not set/);
    assert.equal(api.seen.length, 0);
  } finally { await api.close(); }
});

test('whoami sends the key as a bearer, prints a summary and never the key', async () => {
  const api = await fakeApi();
  try {
    const t = io(api);
    assert.equal(await run(['whoami'], t), 0);
    assert.equal(api.seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.match(t.text(), /workspace\s+Test \(ws_1\)/);
    assert.match(t.text(), /read, list/);
    assert.doesNotMatch(t.text(), new RegExp(KEY));
  } finally { await api.close(); }
});

test('--session becomes the X-AgentDisk-Session header on every request', async () => {
  const api = await fakeApi();
  try {
    const t = io(api);
    await run(['ls', '/memory', '--session', 'nightly #42'], t);
    assert.equal(api.seen[0].headers['x-agentdisk-session'], 'nightly #42');
  } finally { await api.close(); }
});

test('cat resolves a path by listing its parent and matching the whole path', async () => {
  const api = await fakeApi();
  try {
    const t = io(api);
    assert.equal(await run(['cat', '/memory/tasks.md'], t), 0);
    // Listed /memory, then read fil_AAA - not fil_BBB, whose path merely starts the same way.
    assert.match(api.seen[0].path, /^\/v1\/files\?path=%2Fmemory/);
    assert.equal(api.seen[1].path, '/v1/files/fil_AAA/content');
    assert.equal(t.text(), '# tasks\n- x\n');
  } finally { await api.close(); }
});

test('cat by id skips the listing, and prints binary content as bytes', async () => {
  const api = await fakeApi();
  try {
    const t = io(api);
    assert.equal(await run(['cat', 'fil_CCC'], t), 0);
    assert.equal(api.seen[0].path, '/v1/files/fil_CCC/content');
    assert.ok(Buffer.isBuffer(t.chunks[0]));
    assert.deepEqual([...t.chunks[0]], [0x89, 0x50, 0x4e, 0x47]);
  } finally { await api.close(); }
});

test('a missing path is not found, not a neighbour', async () => {
  const api = await fakeApi();
  try {
    const t = io(api);
    assert.equal(await run(['cat', '/memory/tasks'], t), 1);
    assert.match(t.err(), /NOT_FOUND: No such file: \/memory\/tasks/);
  } finally { await api.close(); }
});

test('put sends a small file inline with a guessed MIME type', async () => {
  const api = await fakeApi();
  const dir = await mkdtemp(join(tmpdir(), 'agentdisk-cli-'));
  const local = join(dir, 'notes.md');
  await writeFile(local, 'hello');
  try {
    const t = io(api);
    assert.equal(await run(['put', local, '/memory/notes.md'], t), 0);
    const sent = JSON.parse(api.seen[0].body);
    assert.equal(sent.path, '/memory/notes.md');
    assert.equal(sent.mimeType, 'text/markdown');
    assert.equal(Buffer.from(sent.content, 'base64').toString(), 'hello');
    assert.match(t.text(), /fil_NEW\s+5 B\s+\/memory\/notes\.md/);
  } finally { await api.close(); }
});

test('rm refuses without --yes, and says deletion is permanent', async () => {
  const api = await fakeApi();
  try {
    const t = io(api);
    assert.equal(await run(['rm', '/memory/tasks.md'], t), 2);
    assert.match(t.err(), /permanent/);
    assert.equal(api.seen.length, 0);

    const u = io(api);
    assert.equal(await run(['rm', '/memory/tasks.md', '--yes'], u), 0);
    assert.equal(api.seen.at(-1).method, 'DELETE');
    assert.match(u.text(), /deleted\s+\/memory\/tasks\.md\s+\(permanent\)/);
  } finally { await api.close(); }
});

test('a bad credential exits 3 and shows the API message and request id', async () => {
  const api = await fakeApi();
  try {
    const t = io(api, { AGENTDISK_KEY: 'ask_live_wrong' });
    assert.equal(await run(['whoami'], t), 3);
    assert.match(t.err(), /UNAUTHORIZED: Authentication failed\.\s+\(request req_1\)/);
  } finally { await api.close(); }
});

test('help exits 0 and names every command', async () => {
  const t = io({ base: 'http://unused' });
  assert.equal(await run(['--help'], t), 0);
  for (const cmd of ['whoami', 'ls', 'cat', 'put', 'get', 'rm', 'mkdir', 'search']) {
    assert.match(t.text(), new RegExp(`\\b${cmd}\\b`));
  }
});
