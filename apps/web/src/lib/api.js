/**
 * The one place the dashboard talks to the API.
 *
 * Three things it centralises, each of which would otherwise be got subtly
 * wrong in a dozen call sites:
 *
 * 1. **The bearer token comes from the SDK at call time, never from a variable.**
 *    Firebase ID tokens last an hour and the SDK renews them silently. Caching
 *    one in a closure works perfectly for fifty-nine minutes and then starts
 *    returning 401s that look like a backend fault.
 * 2. **`workspaceId` is a query parameter on every workspace-scoped call.** A
 *    person's credential names no workspace - unlike an API key, which carries
 *    its own - so the API asks the caller which one they mean.
 * 3. **The error envelope is unwrapped into a real Error.** Doc 05 PART 13
 *    gives every failure a `code` and a `requestId`; both survive to the caller,
 *    because "something went wrong" without the request ID is unsupportable.
 */

import { beginRequest, endRequest } from './pending.js';

/**
 * Exported so a screen that *names* the API — the auth pages print the REST
 * and MCP endpoints — reads the same value the client calls, rather than
 * repeating a hostname that would then be wrong in every environment but the
 * one it was typed in.
 */
export const BASE_URL = import.meta.env.VITE_API_BASE ?? 'https://api-dev.agentdisk.io';

export class ApiError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId ?? null;
  }
}

/** True when re-authenticating could plausibly fix it. */
export function isAuthError(error) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

async function toError(response) {
  let code = 'UNKNOWN';
  let message = `Request failed with ${response.status}.`;
  let requestId = null;
  try {
    const body = await response.json();
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      requestId = body.error.requestId ?? null;
    }
  } catch {
    // A non-JSON error body (a proxy, an outage). The status is all we have.
  }
  return new ApiError(response.status, code, message, requestId);
}

/**
 * What a claim link is worth, before anybody signs in.
 *
 * Outside `createApiClient` because every method there sends a bearer token and
 * throws without one - and this call deliberately has no credential. The token
 * in the URL is the only thing that can name the workspace, which is the same
 * trust model as a signed download link.
 *
 * A person following a claim link has usually never seen this product. Asking
 * them to create an account before telling them what they would be claiming
 * inverts the order of trust.
 */
export async function previewClaim(claimToken, signal) {
  const response = await fetch(
    new URL(`/v1/workspaces/claim/${encodeURIComponent(claimToken)}`, BASE_URL),
    { signal }
  );
  if (!response.ok) throw await toError(response);
  return response.json();
}

export function createApiClient(getToken) {
  /**
   * Counted in and out of `pending.js` so the top progress bar can show that
   * the app is talking to the API. The count is taken here rather than around
   * `fetch` because the token refresh above is part of the wait — a silent
   * Firebase renewal is the slowest thing that can happen on a call — and it
   * is released in `finally`, so a throw on any path still ends it. A request
   * that leaked would leave the bar running for the rest of the session.
   */
  async function request(path, { method = 'GET', body, workspaceId, signal } = {}) {
    beginRequest();
    try {
      const token = await getToken();
      if (!token) {
        throw new ApiError(401, 'UNAUTHORIZED', 'You are not signed in.', null);
      }

      const url = new URL(path, BASE_URL);
      if (workspaceId) url.searchParams.set('workspaceId', workspaceId);

      const headers = { authorization: `Bearer ${token}` };
      if (body !== undefined) headers['content-type'] = 'application/json';

      const response = await fetch(url, {
        method,
        headers,
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });

      if (!response.ok) throw await toError(response);
      if (response.status === 204) return null;
      return response.json();
    } finally {
      endRequest();
    }
  }

  return {
    request,

    whoami: workspaceId => request('/v1/whoami', { workspaceId }),

    listWorkspaces: () => request('/v1/workspaces'),
    createWorkspace: name => request('/v1/workspaces', { method: 'POST', body: { name } }),
    /**
     * The name is the confirmation, and the API checks it rather than trusting
     * this client to have asked — so a second frontend, a script or a curl
     * cannot skip the step that makes the deletion deliberate. No `workspaceId`
     * option: the workspace is the subject of the URL, not a scope for it.
     */
    deleteWorkspace: (workspaceId, name) =>
      request(`/v1/workspaces/${workspaceId}`, { method: 'DELETE', body: { name } }),

    /**
     * Take ownership of an unclaimed sandbox. `body` is {mode:'new'} or
     * {mode:'attach', targetWorkspaceId}. No `workspaceId` option: which
     * workspace this concerns is what the claim token decides, and the target
     * for an attach is named in the body so the API can authorize it against
     * the caller's own membership rather than a query parameter.
     */
    claimWorkspace: (claimToken, body) =>
      request(`/v1/workspaces/claim/${encodeURIComponent(claimToken)}`, {
        method: 'POST',
        body,
      }),

    listFiles: (workspaceId, params = {}) => {
      const query = new URLSearchParams(params).toString();
      return request(`/v1/files${query ? `?${query}` : ''}`, { workspaceId });
    },
    getFile: (workspaceId, fileId) => request(`/v1/files/${fileId}`, { workspaceId }),
    deleteFile: (workspaceId, fileId) =>
      request(`/v1/files/${fileId}`, { method: 'DELETE', workspaceId }),
    /**
     * Resolves to { url, method, expiresAt, sizeBytes } - a short-lived
     * presigned GET, not the bytes.
     *
     * **Call it once per download.** The API accounts egress when it *issues*
     * the URL, because R2 does not call back on a GET, so a second call for the
     * same click bills the file twice. Fetching the returned URL costs nothing
     * further.
     */
    downloadFile: (workspaceId, fileId) =>
      request(`/v1/files/${fileId}/download`, { workspaceId }),

    listAgents: workspaceId => request('/v1/agents', { workspaceId }),
    getAgent: (workspaceId, agentId) => request(`/v1/agents/${agentId}`, { workspaceId }),
    createAgent: (workspaceId, body) =>
      request('/v1/agents', { method: 'POST', body, workspaceId }),
    updateAgent: (workspaceId, agentId, body) =>
      request(`/v1/agents/${agentId}`, { method: 'PATCH', body, workspaceId }),
    deleteAgent: (workspaceId, agentId) =>
      request(`/v1/agents/${agentId}`, { method: 'DELETE', workspaceId }),

    listKeys: workspaceId => request('/v1/keys', { workspaceId }),
    /** Resolves to { key, secret } — the secret exists in this response only. */
    createKey: (workspaceId, body) =>
      request('/v1/keys', { method: 'POST', body, workspaceId }),
    revokeKey: (workspaceId, keyId) =>
      request(`/v1/keys/${keyId}`, { method: 'DELETE', workspaceId }),

    listWebhooks: workspaceId => request('/v1/webhooks', { workspaceId }),
    /** Resolves to { webhook, secret } — the secret exists in this response only. */
    createWebhook: (workspaceId, body) =>
      request('/v1/webhooks', { method: 'POST', body, workspaceId }),
    updateWebhook: (workspaceId, id, body) =>
      request(`/v1/webhooks/${id}`, { method: 'PATCH', body, workspaceId }),
    deleteWebhook: (workspaceId, id) =>
      request(`/v1/webhooks/${id}`, { method: 'DELETE', workspaceId }),

    listActivity: (workspaceId, limit = 50) =>
      request(`/v1/activity?limit=${limit}`, { workspaceId }),

    listMembers: workspaceId => request('/v1/members', { workspaceId }),
    inviteMember: (workspaceId, body) =>
      request('/v1/members', { method: 'POST', body, workspaceId }),
    updateMemberRole: (workspaceId, membershipId, role) =>
      request(`/v1/members/${membershipId}`, { method: 'PATCH', body: { role }, workspaceId }),
    /**
     * `revokeKeys` is explicit rather than defaulted, matching the API: neither
     * revoking nor not-revoking is safe to assume on somebody's behalf.
     */
    removeMember: (workspaceId, membershipId, revokeKeys) =>
      request(`/v1/members/${membershipId}${revokeKeys ? '?revokeKeys=true' : ''}`, {
        method: 'DELETE',
        workspaceId
      }),

    getBilling: workspaceId => request('/v1/billing', { workspaceId }),
    /** Resolves to { url } — a one-time link into Stripe's hosted portal. */
    createPortalSession: workspaceId =>
      request('/v1/billing/portal-session', { method: 'POST', workspaceId }),

    listFolders: workspaceId => request('/v1/folders', { workspaceId }),
    createFolder: (workspaceId, path) =>
      request('/v1/folders', { method: 'POST', body: { path }, workspaceId }),

    logoutEverywhere: workspaceId =>
      request('/v1/me/logout-all', { method: 'POST', workspaceId })
  };
}
