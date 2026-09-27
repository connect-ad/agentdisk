/**
 * `npx agentdisk` — the REST API from a shell, with no dependencies.
 *
 * Everything here is a thin call to a route in `apps/api`; there is no logic
 * a script could not do with curl. It exists because the product feedback of
 * 27 Sept 2026 was right that an agent with a shell reaches for whatever is
 * already installed or one `npx` away, and a curl recipe is neither.
 *
 * Two rules, both inherited from the API and worth restating:
 *
 *   - **The key is the only credential, and it comes from the environment.**
 *     `AGENTDISK_KEY` is read once; nothing here ever prints it, and a key
 *     passed as an argument would land in shell history, so there is no flag.
 *   - **Paths are resolved by listing, never by guessing.** The API addresses
 *     a file by id. `agentdisk cat /memory/tasks.md` lists the parent folder
 *     and matches the exact path, so a typo is "no such file" and never a
 *     neighbouring file that happened to share a prefix.
 *
 * `run()` takes its I/O as arguments so the tests can drive it against a
 * local HTTP server without spawning a process.
 */

import { readFile as readLocal, writeFile as writeLocal, stat } from 'node:fs/promises';
import { basename } from 'node:path';

/** Dev is the only deployed environment today; `AGENTDISK_API` overrides it. */
export const DEFAULT_API = 'https://api-dev.agentdisk.io';

/** The inline read and write cap, mirroring `storage/workspace-scoped.ts`. */
const MAX_INLINE_BYTES = 1024 * 1024;

const HELP = `agentdisk — persistent, audited file storage for AI agents

Usage: agentdisk <command> [arguments] [--session <label>] [--json]

  whoami                          Which workspace and scopes this key holds
  ls [path]                       List files under a folder (default: /)
  cat <path|id>                   Print a file's contents (up to 1 MB)
  put <local-file> <path>         Upload a file; inline up to 1 MB, presigned above
  get <path|id> [local-file]      Download a file to disk (default: its own name)
  rm <path|id> --yes              Delete a file. Permanent: there is no restore
  mkdir <path>                    Create a folder and any missing parents
  search <query>                  Match names, paths, captions and tags

Options:
  --session <label>   Name this run in the audit log (X-AgentDisk-Session)
  --mime <type>       MIME type for put (default: guessed from the extension)
  --json              Print the API's JSON instead of a summary
  --yes               Confirm a destructive command

Environment:
  AGENTDISK_KEY       The API key (required). Never passed as an argument.
  AGENTDISK_API       The API base URL (default: ${DEFAULT_API})

No account yet? Open a sandbox in the browser: https://app-dev.agentdisk.io/sandbox
`;

const MIME_BY_EXT = {
  md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv',
  yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml',
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain',
  py: 'text/x-python', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip',
};

function guessMime(name) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Split argv into positionals and the few flags this tool knows. */
export function parseArgs(argv) {
  const positional = [];
  const flags = { json: false, yes: false, session: null, mime: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--session') flags.session = argv[++i] ?? null;
    else if (arg.startsWith('--session=')) flags.session = arg.slice('--session='.length);
    else if (arg === '--mime') flags.mime = argv[++i] ?? null;
    else if (arg.startsWith('--mime=')) flags.mime = arg.slice('--mime='.length);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

export class UsageError extends Error {}

class ApiFailure extends Error {
  constructor(status, body) {
    const error = body?.error ?? {};
    super(error.message ?? `Request failed with ${status}.`);
    this.status = status;
    this.code = error.code ?? 'UNKNOWN';
    this.requestId = error.requestId ?? null;
  }
}

function makeClient({ env, fetch, session }) {
  const key = env.AGENTDISK_KEY;
  if (!key) throw new UsageError('AGENTDISK_KEY is not set. Mint a key in the dashboard and export it.');
  const base = (env.AGENTDISK_API ?? DEFAULT_API).replace(/\/+$/, '');

  async function request(method, path, body) {
    const headers = { authorization: `Bearer ${key}` };
    if (session) headers['x-agentdisk-session'] = session;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!res.ok) throw new ApiFailure(res.status, parsed);
    return parsed;
  }

  /**
   * A path or an id, to an id. Ids are opaque and start with `fil_` (they
   * come from the API's `newId("file")`), so anything else is a path and is
   * resolved by listing its parent and matching the whole path exactly.
   */
  async function resolve(pathOrId) {
    if (/^fil_[A-Za-z0-9]+$/.test(pathOrId)) return { id: pathOrId, path: null };
    if (!pathOrId.startsWith('/')) throw new UsageError(`Paths are absolute: did you mean /${pathOrId}?`);
    const parent = pathOrId.slice(0, pathOrId.lastIndexOf('/')) || '/';
    let cursor = null;
    do {
      const query = new URLSearchParams({ path: parent, limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const page = await request('GET', `/v1/files?${query}`);
      const hit = (page.files ?? []).find(f => f.path === pathOrId);
      if (hit) return { id: hit.id, path: hit.path };
      cursor = page.nextCursor ?? null;
    } while (cursor);
    throw new ApiFailure(404, { error: { code: 'NOT_FOUND', message: `No such file: ${pathOrId}` } });
  }

  return { request, resolve, base };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const COMMANDS = {
  async whoami({ client, out, flags }) {
    const me = await client.request('GET', '/v1/whoami');
    if (flags.json) return out(JSON.stringify(me, null, 2) + '\n');
    const ops = me.key?.scopes?.ops ?? me.scopes?.ops ?? [];
    const prefix = me.key?.scopes?.pathPrefix ?? me.scopes?.pathPrefix ?? '';
    out(`workspace  ${me.workspace?.name ?? '—'} (${me.workspace?.id ?? '—'})\n`);
    out(`actor      ${me.actor?.type ?? '—'} ${me.actor?.id ?? ''}\n`);
    out(`scopes     ${ops.join(', ') || '—'}${prefix ? `  under ${prefix}` : ''}\n`);
  },

  async ls({ client, out, flags, args }) {
    const path = args[0] ?? '/';
    if (!path.startsWith('/')) throw new UsageError(`Paths are absolute: did you mean /${path}?`);
    const rows = [];
    let cursor = null;
    do {
      const query = new URLSearchParams({ path, limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const page = await client.request('GET', `/v1/files?${query}`);
      rows.push(...(page.files ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    if (flags.json) return out(JSON.stringify({ files: rows }, null, 2) + '\n');
    if (rows.length === 0) return out(`(no files under ${path})\n`);
    for (const f of rows) {
      out(`${f.id}  ${formatSize(f.sizeBytes).padStart(9)}  ${f.path}\n`);
    }
  },

  async cat({ client, out, flags, args }) {
    if (!args[0]) throw new UsageError('cat needs a path or an id.');
    const { id } = await client.resolve(args[0]);
    const body = await client.request('GET', `/v1/files/${id}/content`);
    if (flags.json) return out(JSON.stringify(body, null, 2) + '\n');
    if (body.encoding === 'utf-8') return out(body.content);
    out(Buffer.from(body.content, 'base64'));
  },

  async put({ client, out, flags, args }) {
    const [local, remote] = args;
    if (!local || !remote) throw new UsageError('put needs a local file and a remote path.');
    if (!remote.startsWith('/')) throw new UsageError(`Paths are absolute: did you mean /${remote}?`);
    const mimeType = flags.mime ?? guessMime(basename(local));
    const size = (await stat(local)).size;

    if (size <= MAX_INLINE_BYTES) {
      const bytes = await readLocal(local);
      const created = await client.request('POST', '/v1/files', {
        path: remote, mimeType, content: bytes.toString('base64'),
      });
      if (flags.json) return out(JSON.stringify(created, null, 2) + '\n');
      return out(`${created.file.id}  ${formatSize(created.file.sizeBytes)}  ${created.file.path}\n`);
    }

    // Large: declare, PUT straight to storage, then complete. The API is never
    // in the byte path, and the size it books comes from storage, not from us.
    const declared = await client.request('POST', '/v1/files', { path: remote, mimeType, sizeBytes: size });
    const upload = declared.upload;
    const bytes = await readLocal(local);
    const putRes = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: bytes });
    if (!putRes.ok) throw new Error(`Storage refused the upload with ${putRes.status}.`);
    const completed = await client.request('POST', `/v1/files/${declared.file.id}/complete`, {});
    if (flags.json) return out(JSON.stringify(completed, null, 2) + '\n');
    out(`${completed.file.id}  ${formatSize(completed.file.sizeBytes)}  ${completed.file.path}\n`);
  },

  async get({ client, out, flags, args }) {
    if (!args[0]) throw new UsageError('get needs a path or an id.');
    const { id, path } = await client.resolve(args[0]);
    const target = args[1] ?? basename(path ?? id);
    const link = await client.request('GET', `/v1/files/${id}/download`);
    const res = await fetch(link.url, { method: link.method ?? 'GET' });
    if (!res.ok) throw new Error(`Storage refused the download with ${res.status}.`);
    await writeLocal(target, Buffer.from(await res.arrayBuffer()));
    if (flags.json) return out(JSON.stringify({ id, path, savedTo: target, sizeBytes: link.sizeBytes }, null, 2) + '\n');
    out(`${formatSize(link.sizeBytes)}  ${path ?? id} → ${target}\n`);
  },

  async rm({ client, out, flags, args }) {
    if (!args[0]) throw new UsageError('rm needs a path or an id.');
    if (!flags.yes) throw new UsageError('Deletion is permanent and cannot be undone. Add --yes to confirm.');
    const { id, path } = await client.resolve(args[0]);
    const gone = await client.request('DELETE', `/v1/files/${id}`);
    if (flags.json) return out(JSON.stringify(gone, null, 2) + '\n');
    out(`deleted  ${path ?? id}  (permanent)\n`);
  },

  async mkdir({ client, out, flags, args }) {
    if (!args[0]) throw new UsageError('mkdir needs a path.');
    const created = await client.request('POST', '/v1/folders', { path: args[0] });
    if (flags.json) return out(JSON.stringify(created, null, 2) + '\n');
    out(`created  ${created.folder?.path ?? args[0]}\n`);
  },

  async search({ client, out, flags, args }) {
    if (!args[0]) throw new UsageError('search needs a query.');
    const query = new URLSearchParams({ q: args.join(' '), limit: '200' });
    const found = await client.request('GET', `/v1/search?${query}`);
    if (flags.json) return out(JSON.stringify(found, null, 2) + '\n');
    const rows = found.files ?? found.results ?? [];
    if (rows.length === 0) return out('(no matches)\n');
    for (const f of rows) out(`${f.id}  ${formatSize(f.sizeBytes ?? 0).padStart(9)}  ${f.path}\n`);
    if (found.searched) out(`searched: ${[].concat(found.searched).join(', ')}\n`);
  },
};

/**
 * Run one invocation. Returns the process exit code rather than calling
 * `process.exit`, so a test can assert on it.
 */
export async function run(argv, io) {
  const out = io.stdout;
  const err = io.stderr ?? io.stdout;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n\n${HELP}`);
    return 2;
  }
  const { command, args, flags } = parsed;
  if (flags.help || !command || command === 'help') {
    out(HELP);
    return command || flags.help ? 0 : 2;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    err(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }
  try {
    const client = makeClient({ env: io.env ?? {}, fetch: io.fetch ?? globalThis.fetch, session: flags.session });
    await handler({ client, out, flags, args });
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n`);
      return 2;
    }
    if (e instanceof ApiFailure) {
      err(`${e.code}: ${e.message}${e.requestId ? `  (request ${e.requestId})` : ''}\n`);
      return e.status === 401 || e.status === 403 ? 3 : 1;
    }
    err(`${e.message ?? e}\n`);
    return 1;
  }
}
