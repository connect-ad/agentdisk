import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch on activation, cache for the session, never poll.
 *
 * The design's own note — "Refreshed on activation, not polled" — as behaviour.
 * A staff console watched by a handful of people has no reason to hold open a
 * request loop against the customer database, and a number that changes under
 * somebody's cursor while they are reading it is worse than a slightly stale
 * one with a visible refresh button and a timestamp saying when it was taken.
 *
 * `busy` is separate from `loading` so a refresh does not blank the screen the
 * operator is reading. The first load shows skeletons; a refresh dims nothing.
 */
export function useResource(loader, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(null);

  // The loader is an inline arrow at every call site, so the parent re-creating
  // it must not re-run the effect. It is needed *current*, not as a dependency -
  // the same mistake that made every dialog in the customer app steal focus on
  // each keystroke.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (isRefresh = false) => {
    if (isRefresh) setBusy(true);
    else setLoading(true);
    setError(null);
    try {
      const result = await loaderRef.current();
      if (!alive.current) return;
      setData(result);
      setFetchedAt(Date.now());
    } catch (err) {
      if (!alive.current) return;
      // The previous data is deliberately kept. A failed refresh should not
      // replace what the operator was reading with an empty screen.
      setError(err);
    } finally {
      if (alive.current) {
        setLoading(false);
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, busy, fetchedAt, refresh: () => run(true), setData };
}

/** "as of 14:02 UTC", for the freshness label beside Refresh. */
export function freshnessLabel(fetchedAt) {
  if (!fetchedAt) return null;
  return `AS OF ${new Date(fetchedAt).toISOString().slice(11, 16)} UTC`;
}
