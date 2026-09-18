/**
 * The staff API client.
 *
 * Speaks `/v1/staff/*` with a Firebase ID token — the same credential the
 * customer dashboard uses, because migration 0014 made staff auth Firebase and
 * left authorisation to the `staff_users` row behind it.
 *
 * ── Nothing here stores a token ────────────────────────────────────────────
 * The previous version kept a staff session token in `sessionStorage`. There is
 * nothing to keep now: the Firebase SDK holds the refresh token and mints a
 * fresh ID token on demand, so every request asks for the current one. A token
 * cached by this module would be the one thing capable of outliving a sign-out.
 *
 * ── The 401 subscription ───────────────────────────────────────────────────
 * A 401 no longer means only "expired". It also means "your staff row was
 * removed or disabled", which takes effect on the very next request. Either way
 * the shell needs to know, so every 401 from a call that carried a token is
 * published to `onSessionLost`. Handled here rather than at sixty call sites,
 * one of which would be forgotten.
 */

import { currentIdToken } from './lib/firebase.js';

const BASE = import.meta.env.VITE_API_BASE ?? 'https://api-dev.agentdisk.io';

export class StaffApiError extends Error {
  constructor(status, code, message, requestId, details) {
    super(message);
    this.name = 'StaffApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId ?? null;
    this.details = details ?? null;
  }
}


const sessionLostListeners = new Set();

/** Subscribe to "the session we were using stopped being accepted". */
export function onSessionLost(listener) {
  sessionLostListeners.add(listener);
  return () => sessionLostListeners.delete(listener);
}

async function request(path, { method = 'GET', body, token, raw = false } = {}) {
  const auth = token ?? (await currentIdToken());

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
    let details = null;
    try {
      const parsed = await res.json();
      if (parsed?.error) {
        code = parsed.error.code ?? code;
        message = parsed.error.message ?? message;
        requestId = parsed.error.requestId ?? null;
        details = parsed.error.details ?? null;
      }
    } catch {
      /* Non-JSON error. The status is all there is. */
    }

    // Only when we actually presented a credential. A 401 with no token is
    // simply "not signed in yet", which the shell already knows.
    if (res.status === 401 && auth) {
      for (const listener of sessionLostListeners) listener();
    }

    throw new StaffApiError(res.status, code, message, requestId, details);
  }

  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

const query = params => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const staffApi = {
  /* ------------------------------- session -------------------------------
   * No login or logout call. Signing in happens in the browser against
   * Firebase; signing out is discarding the token there. `whoami` is how the
   * console asks whether this identity is staff at all, and what role it holds.
   */
  whoami: () => request('/v1/staff/whoami'),

  /* ------------------------------- overview ------------------------------ */
  overview: () => request('/v1/staff/overview'),
  needsAttention: () => request('/v1/staff/workspaces/needs-attention'),

  /* ------------------------------ workspaces ----------------------------- */
  listWorkspaces: q => request(`/v1/staff/workspaces${query({ q })}`),
  getWorkspace: id => request(`/v1/staff/workspaces/${id}`),
  workspaceActivity: id => request(`/v1/staff/workspaces/${id}/activity`),
  workspaceBlastRadius: id => request(`/v1/staff/workspaces/${id}/blast-radius`),
  setWorkspaceStatus: (id, status, reason) =>
    request(`/v1/staff/workspaces/${id}/status`, { method: 'POST', body: { status, reason } }),
  setPlanOverride: (id, planId, reason) =>
    request(`/v1/staff/workspaces/${id}/plan-override`, {
      method: 'PATCH',
      body: { planId, reason }
    }),
  deleteWorkspace: (id, confirmName, reason) =>
    request(`/v1/staff/workspaces/${id}`, { method: 'DELETE', body: { confirmName, reason } }),
  restoreWorkspace: (id, reason) =>
    request(`/v1/staff/workspaces/${id}/restore`, { method: 'POST', body: { reason } }),

  /* --------------------------------- users ------------------------------- */
  findUser: email => request(`/v1/staff/users${query({ email })}`),
  getUser: id => request(`/v1/staff/users/${id}`),
  setUserDisabled: (id, disabled, reason) =>
    request(`/v1/staff/users/${id}/disable`, { method: 'PATCH', body: { disabled, reason } }),
  deletionCheck: id => request(`/v1/staff/users/${id}/deletion-check`),
  deleteUser: (id, confirmEmail, reason, revokeKeys) =>
    request(`/v1/staff/users/${id}`, {
      method: 'DELETE',
      body: { confirmEmail, reason, revokeKeys }
    }),
  restoreUser: (id, reason) =>
    request(`/v1/staff/users/${id}/restore`, { method: 'POST', body: { reason } }),
  forceLogout: (userId, workspaceId) =>
    request(`/v1/staff/users/${userId}/force-logout${query({ workspaceId })}`, { method: 'POST' }),
  revokeUserKeys: userId => request(`/v1/staff/users/${userId}/revoke-keys`, { method: 'POST' }),

  /**
   * Send the customer a password-reset link.
   *
   * The link is never in the response and must never be asked for: it is a
   * bearer credential equal to "own this account", and it goes to the account
   * holder's address, never to the staff member who started it. The reason is
   * mandatory server-side; it is sent here so the audit row means something.
   */
  forcePasswordReset: (userId, reason) =>
    request(`/v1/staff/users/${userId}/password-reset`, { method: 'POST', body: { reason } }),

  transferOwner: (orgId, userId, reason) =>
    request(`/v1/staff/orgs/${orgId}/owner`, { method: 'PATCH', body: { userId, reason } }),

  /* --------------------------- agents and keys --------------------------- */
  setAgentDisabled: (id, disabled, reason) =>
    request(`/v1/staff/agents/${id}`, { method: 'PATCH', body: { disabled, reason } }),
  revokeKey: (id, reason) =>
    request(`/v1/staff/keys/${id}`, { method: 'DELETE', body: { reason } }),

  /* -------------------------------- billing ------------------------------ */
  billing: filter => request(`/v1/staff/billing${query({ filter })}`),

  /* --------------------------------- plans ------------------------------- */
  listPlans: () => request('/v1/staff/plans'),
  updatePlan: (id, patch) => request(`/v1/staff/plans/${id}`, { method: 'PATCH', body: patch }),
  createPlan: input => request('/v1/staff/plans', { method: 'POST', body: input }),
  retirePlan: (id, reason) =>
    request(`/v1/staff/plans/${id}/retire`, { method: 'POST', body: { reason } }),
  stripeDiff: () => request('/v1/staff/plans/stripe-diff'),
  syncFromStripe: (selections, reason) =>
    request('/v1/staff/plans/sync-from-stripe', { method: 'POST', body: { selections, reason } }),
  syncCatalogue: reason => request('/v1/staff/plans/sync', { method: 'POST', body: { reason } }),

  /* --------------------------------- audit ------------------------------- */
  audit: filter => request(`/v1/staff/audit${query(filter ?? {})}`),
  auditFilters: () => request('/v1/staff/audit/filters'),
  auditExportUrl: filter => new URL(`/v1/staff/audit/export${query(filter ?? {})}`, BASE).toString(),
  /**
   * The CSV, fetched rather than linked.
   *
   * A plain <a href> cannot carry the Authorization header, and the export is a
   * bulk pull of the accountability log - it is not going to be made reachable
   * without one. So it is fetched and handed to the browser as a blob.
   */
  auditExport: async filter => {
    const res = await request(`/v1/staff/audit/export${query(filter ?? {})}`, { raw: true });
    return res.text();
  },

  /* ---------------------------- staff accounts --------------------------- */
  listAccounts: () => request('/v1/staff/accounts'),
  /** Grants an address a role. Mints nothing — there is no credential to show. */
  createAccount: (email, role, reason) =>
    request('/v1/staff/accounts', { method: 'POST', body: { email, role, reason } }),
  setAccountRole: (id, role, reason) =>
    request(`/v1/staff/accounts/${id}`, { method: 'PATCH', body: { role, reason } }),
  setAccountDisabled: (id, disabled, reason) =>
    request(`/v1/staff/accounts/${id}/disable`, { method: 'PATCH', body: { disabled, reason } })
};
