/**
 * The workspace lists more than one screen asks for, fetched through the cache.
 *
 * `listKeys` and `listAgents` were each being fetched independently by four
 * screens, and `listActivity` by three — so opening API keys and then MCP
 * connection asked the API for the same two lists twice, seconds apart, and got
 * the same answer twice. Going through here means the second screen joins the
 * first one's request if it is still in flight, and reads its result if it has
 * landed.
 *
 * Only the *shared* lists live here. A list one screen alone reads (members,
 * webhooks, billing) needs no entry: `useResource` caches that screen's whole
 * composed result under its own key, which already covers revisiting it.
 *
 * The key is namespaced by workspace, and by whatever else changes the answer —
 * a 200-row activity request and a 50-row one are different resources, not the
 * same resource at different sizes.
 */

import { fetchCached } from './resourceCache.js';

export const fetchKeys = (api, workspaceId) =>
  fetchCached(`${workspaceId}:keys`, () => api.listKeys(workspaceId));

export const fetchAgents = (api, workspaceId) =>
  fetchCached(`${workspaceId}:agents`, () => api.listAgents(workspaceId));

export const fetchActivity = (api, workspaceId, limit = 50) =>
  fetchCached(`${workspaceId}:activity:${limit}`, () => api.listActivity(workspaceId, limit));

export const fetchWhoami = (api, workspaceId) =>
  fetchCached(`${workspaceId}:whoami`, () => api.whoami(workspaceId));

export const fetchFiles = (api, workspaceId, params = {}) =>
  fetchCached(`${workspaceId}:files:${new URLSearchParams(params).toString()}`, () =>
    api.listFiles(workspaceId, params)
  );
