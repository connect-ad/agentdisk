/**
 * The in-memory cache behind `useResource`.
 *
 * Every screen in the workspace shell is a route, and a route unmounts when you
 * leave it. Without this, switching from API keys to MCP connection and back
 * threw away both screens' data and refetched it — so a tab you had open
 * seconds ago cost the same two or three Worker invocations, the same
 * `withAuth` chain and the same D1 reads as a cold one. The skeleton you saw on
 * the second visit was that round trip, paid again for data that had not moved.
 *
 * Three properties matter, and each is here for a specific failure:
 *
 *  - **In-flight requests are shared.** Two screens mounting in the same tick
 *    (or one screen asking for `keys` twice through different loaders) join one
 *    promise rather than racing two identical requests to the API.
 *  - **Failures are never cached.** A remembered error is a screen that stays
 *    broken after the network comes back. Only a fulfilled response is stored,
 *    and a rejection leaves whatever was there before untouched.
 *  - **It is memory only, deliberately.** Nothing here goes to `localStorage` or
 *    IndexedDB. Signing out on a shared machine must not leave the previous
 *    account's key names, scopes and agent list sitting on disk for whoever
 *    sits down next, and encrypting it would only move the problem — the key
 *    would have to live in the same browser. The cost is that a cold client
 *    (a refresh, a new tab, a re-login) starts empty; closing *that* gap is a
 *    server-side job, not a reason to persist tenant data here.
 *
 * Every key is namespaced by workspace, so nothing cached under one workspace
 * can be read while another is open. `clearCache` is still called on sign-out
 * and on any write, because namespacing prevents confusion, not staleness.
 */

/**
 * How long a cached response is served without revalidating.
 *
 * Short on purpose. This is not a correctness mechanism — a write clears the
 * whole cache (see `api.js`), so the TTL only bounds how stale a *third party's*
 * change can look on a screen nobody has touched. Thirty seconds is under the
 * time it takes to notice, and long enough that a burst of tab switching costs
 * nothing.
 */
export const TTL_MS = 30_000;

/**
 * key -> { data?, fetchedAt?, promise? }
 *
 * `promise` present means a request is in flight. `data` present means there is
 * something to show. Both together is a background revalidation over data the
 * screen is already rendering.
 */
const entries = new Map();

/** Has this entry's data aged past the point where we should ask again? */
export function isFresh(entry) {
  return entry != null && Date.now() - entry.fetchedAt < TTL_MS;
}

/**
 * What is cached for `key` right now, stale or not — or `null`.
 *
 * Staleness is the caller's decision rather than this function's: a screen
 * mounting wants to render stale data immediately and revalidate behind it,
 * which is the whole point. Returning `null` for stale data would put the
 * skeleton back.
 */
export function peekCache(key) {
  if (!key) return null;
  const entry = entries.get(key);
  return entry && 'data' in entry ? { data: entry.data, fetchedAt: entry.fetchedAt } : null;
}

/** Record a response somebody else fetched (a composite view, typically). */
export function writeCache(key, data) {
  if (!key) return;
  entries.set(key, { data, fetchedAt: Date.now() });
}

/**
 * Fetch through the cache: a fresh entry is returned as-is, an in-flight
 * request is joined, and anything else runs `fetcher`.
 *
 * `force` skips both — it is what a retry button and a post-write refetch mean,
 * and serving either of those from cache would make the button a lie.
 */
export function fetchCached(key, fetcher, { force = false } = {}) {
  if (!key) return fetcher();

  const existing = entries.get(key);
  if (!force) {
    if (existing?.promise) return existing.promise;
    if (isFresh(existing)) return Promise.resolve(existing.data);
  }

  const promise = fetcher().then(
    data => {
      entries.set(key, { data, fetchedAt: Date.now() });
      return data;
    },
    error => {
      // Drop the in-flight marker, keep any data that was already there. A
      // failed revalidation must not empty a screen that is rendering fine.
      const current = entries.get(key);
      if (current?.promise === promise) {
        if ('data' in current) entries.set(key, { data: current.data, fetchedAt: current.fetchedAt });
        else entries.delete(key);
      }
      throw error;
    }
  );

  entries.set(key, { ...(existing ?? {}), promise });
  return promise;
}

/**
 * Empty the cache.
 *
 * Called on sign-out, on an account switch, and after every successful write.
 * Blunt on purpose: a per-resource invalidation table is a list somebody has to
 * remember to extend, and the day it is not extended the product shows somebody
 * their own change not having happened. Writes are rare next to reads, so the
 * cost of over-clearing is a handful of refetches and the benefit is that no
 * mutation can leave a stale screen behind it.
 */
export function clearCache() {
  entries.clear();
}
