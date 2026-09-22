/**
 * The workspace's usage figures and plan, fetched once for the whole shell.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Two parts of the shell need the same answer. Layer 2 (`WorkspaceStats`) needs
 * storage / files / agents / requests; Layer 1 — the workspace info strip —
 * needs the plan name, which the design draws as the third segment after OWNER
 * and WORKSPACE ID.
 *
 * The strip used to read `plan` off the workspace record from
 * `GET /v1/workspaces`, and that list does not carry one: `listWorkspaces`
 * returns id, name, slug and role, and nothing else. So `open.plan` was always
 * undefined, the segment was behind a truthiness check, and the PLAN block
 * silently never rendered. The markup was right the whole time; it was reading
 * a field that does not exist.
 *
 * `GET /v1/whoami` does carry it, as `workspace.plan`, and `WorkspaceStats` was
 * already calling it. Hoisting that one call into a provider lets the strip
 * read the plan from a request the shell was making anyway — no second round
 * trip, no change to any endpoint, and one fewer reason for `backlog/027` to
 * get worse.
 *
 * The two calls here are exactly the two `WorkspaceStats` used to make on its
 * own. This moves them; it does not add any.
 */

import React, { createContext, useContext } from 'react';
import { useResource } from './useResource.js';
import { fetchAgents, fetchWhoami } from './resources.js';

const UsageContext = createContext(null);

const loadUsage = async (api, workspaceId) => {
  const [me, agents] = await Promise.all([
    fetchWhoami(api, workspaceId),
    fetchAgents(api, workspaceId),
  ]);
  return { me, agents: agents.agents ?? [] };
};

export function WorkspaceUsageProvider({ children }) {
  const resource = useResource(loadUsage, [], 'usage');
  return <UsageContext.Provider value={resource}>{children}</UsageContext.Provider>;
}

/**
 * Returns the raw resource — `{ status, data, error, reload }` — so a consumer
 * can tell "still loading" from "loaded and empty", which is the distinction
 * `useResource` exists to preserve. Outside the provider it reports `loading`
 * rather than throwing, so a screen rendered on its own in a test does not need
 * the provider to mount.
 */
export function useWorkspaceUsage() {
  return useContext(UsageContext) ?? { status: 'loading', data: null, error: null, reload: () => {} };
}

/** The plan name, or null until whoami has answered. */
export function useWorkspacePlan() {
  const { status, data } = useWorkspaceUsage();
  return status === 'loaded' ? (data?.me?.workspace?.plan ?? null) : null;
}
