/**
 * Load something from the API for the current workspace.
 *
 * The three states are kept genuinely distinct — loading, failed, loaded — because
 * collapsing any two produces a specific lie on screen. Treating "still loading"
 * as "loaded and empty" flashes "No files yet" at somebody who has hundreds, and
 * treating "failed" as empty tells them their data is gone when the truth is
 * that one request did not arrive.
 *
 * There is a fourth state this hook deliberately does *not* expose: "showing
 * you what I had while I check". A screen revisited inside the cache's TTL
 * renders its previous data as `loaded` and revalidates behind it, and a
 * revalidation that fails leaves what is on screen alone. Surfacing that as its
 * own status would put a spinner on every tab switch, which is exactly the
 * thing the cache exists to remove.
 *
 * Pass a `key` to get any of that. Without one the hook fetches on every mount,
 * as it always did — right for anything whose answer must be current at the
 * moment it is read.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspace } from './workspace.jsx';
import { clearCache, isFresh, peekCache, writeCache } from './resourceCache.js';

/**
 * `view:` namespaces a screen's whole composed result away from the individual
 * lists in `resources.js`. The two are cached separately and on purpose: the
 * composite is what lets a screen render synchronously on its first paint, and
 * the pieces are what stop two screens fetching the same list.
 */
const viewKey = (workspaceId, key) => (key && workspaceId ? `view:${workspaceId}:${key}` : null);

export function useResource(load, deps = [], key) {
  const { api, workspaceId } = useWorkspace();
  const cacheKey = viewKey(workspaceId, key);

  // Seeded from the cache so a revisit paints real data on its first frame. Set
  // inside the effect instead and there is one frame of skeleton between the
  // commit and the microtask that resolves — brief, but visible as a flicker on
  // every tab switch.
  const [state, setState] = useState(() => {
    const cached = peekCache(cacheKey);
    return cached
      ? { status: 'loaded', data: cached.data, error: null }
      : { status: 'loading', data: null, error: null };
  });

  // Which request the screen is waiting for. A workspace switch, or a `deps`
  // change, can leave an older request in flight; without this it resolves last
  // and writes the previous workspace's data over the current one's.
  const generation = useRef(0);

  const run = useCallback(
    async (force = false) => {
      if (!workspaceId) return;
      const mine = ++generation.current;

      const cached = force ? null : peekCache(cacheKey);
      if (cached) {
        setState({ status: 'loaded', data: cached.data, error: null });
        if (isFresh(cached)) return;
        // Stale: leave it on screen and check behind it.
      } else {
        setState(previous => ({ ...previous, status: 'loading' }));
      }

      try {
        const data = await load(api, workspaceId);
        writeCache(cacheKey, data);
        if (generation.current === mine) setState({ status: 'loaded', data, error: null });
      } catch (error) {
        if (generation.current !== mine) return;
        // A background revalidation that fails keeps the data it was checking.
        // Replacing a working screen with an error page because one refresh did
        // not arrive is worse than being thirty seconds out of date.
        if (cached) return;
        setState({ status: 'failed', data: null, error });
      }
    },
    // `load` is expected to be a stable module-level function or wrapped by the
    // caller; listing it here would re-fetch on every render for inline arrows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, workspaceId, cacheKey, ...deps]
  );

  useEffect(() => {
    void run();
  }, [run]);

  /**
   * "Get me the current state of the world" — a retry after a failure, or a
   * refetch after a write. It empties the cache rather than forcing this one
   * key, because the composed result is built from the shared lists and forcing
   * only the outer key would rebuild it out of the same cached pieces.
   */
  const reload = useCallback(() => {
    clearCache();
    return run(true);
  }, [run]);

  return { ...state, reload };
}
