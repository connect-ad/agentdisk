/**
 * The staff API client.
 *
 * Deliberately separate from `apps/web`'s: this speaks `/v1/staff/*` with a
 * staff session token, and that token must never end up on a customer route or
 * in the customer dashboard's storage. Sharing a client between the two apps
 * would make that a matter of care rather than of structure.
 *
 * The token lives in `sessionStorage`, not `localStorage`. A staff session is
 * four hours and the single highest-value credential in the system; closing the
 * tab should end it, and it should not sit on disk waiting for the next person
 * to use that machine.
 */

const BASE = import.meta.env.VITE_API_BASE ?? 'https://api-dev.agentdisk.io';
const TOKEN_KEY = 'agentdisk.staff.token';

export class StaffApiError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.name = 'StaffApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId ?? null;
  }
}

export function storedToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token) {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* Storage blocked. The session then lasts as long as the page does. */
  }
}

async function request(path, { method = 'GET', body, token } = {}) {
  const auth = token ?? storedToken();

  const res = await fetch(new URL(path, BASE), {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  if (!res.ok) {
    let code = 'UNKNOWN';
    let message = `Request failed with ${res.status}.`;
    let requestId = null;
    try {
      const parsed = await res.json();
      if (parsed?.error) {
        code = parsed.error.code ?? code;
        message = parsed.error.message ?? message;
        requestId = parsed.error.requestId ?? null;
      }
    } catch {
      /* Non-JSON error. The status is all there is. */
    }
    throw new StaffApiError(res.status, code, message, requestId);
  }

  return res.status === 204 ? null : res.json();
}

export const staffApi = {
  login: (email, password, totp) =>
    request('/v1/staff/login', { method: 'POST', body: { email, password, totp } }),
  logout: () => request('/v1/staff/logout', { method: 'POST' }),
  whoami: () => request('/v1/staff/whoami'),

  overview: () => request('/v1/staff/overview'),
  listWorkspaces: q =>
    request(`/v1/staff/workspaces${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getWorkspace: id => request(`/v1/staff/workspaces/${id}`),
  workspaceActivity: id => request(`/v1/staff/workspaces/${id}/activity`),
  setWorkspaceStatus: (id, status, reason) =>
    request(`/v1/staff/workspaces/${id}/status`, { method: 'POST', body: { status, reason } }),

  forceLogout: (userId, workspaceId) =>
    request(`/v1/staff/users/${userId}/force-logout?workspaceId=${workspaceId}`, { method: 'POST' }),
  revokeUserKeys: userId =>
    request(`/v1/staff/users/${userId}/revoke-keys`, { method: 'POST' })
};
