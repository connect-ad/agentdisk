/**
 * Load something from the API for the current workspace.
 *
 * The three states are kept genuinely distinct — loading, failed, loaded — because
 * collapsing any two produces a specific lie on screen. Treating "still loading"
 * as "loaded and empty" flashes "No files yet" at somebody who has hundreds, and
 * treating "failed" as empty tells them their data is gone when the truth is
 * that one request did not arrive.
 */

import { useCallback, useEffect, useState } from 'react';
import { useWorkspace } from './workspace.jsx';

export function useResource(load, deps = []) {
  const { api, workspaceId } = useWorkspace();
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  const run = useCallback(async () => {
    if (!workspaceId) return;
    setState(previous => ({ ...previous, status: 'loading' }));
    try {
      const data = await load(api, workspaceId);
      setState({ status: 'loaded', data, error: null });
    } catch (error) {
      setState({ status: 'failed', data: null, error });
    }
    // `load` is expected to be a stable module-level function or wrapped by the
    // caller; listing it here would re-fetch on every render for inline arrows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, workspaceId, ...deps]);

  useEffect(() => {
    void run();
  }, [run]);

  return { ...state, reload: run };
}
