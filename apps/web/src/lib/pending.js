/**
 * How many API requests are in flight, for the top progress bar.
 *
 * ── Why a counter and not a boolean ───────────────────────────────────────
 * A page refresh fires several calls at once — the shell's `whoami` and agent
 * list, then whatever the screen itself needs. A boolean set by each of them
 * would be cleared by the first one to finish while three were still running,
 * so the bar would vanish and the page would keep moving underneath it. The
 * counter only reads idle when the last request has actually landed.
 *
 * ── Why it notifies only on the edges ─────────────────────────────────────
 * Subscribers care about "is anything happening", not how many. Emitting on
 * every increment would re-render the bar once per request for an answer that
 * did not change; this emits only on the 0 -> 1 and 1 -> 0 transitions.
 *
 * It is deliberately not a React context. `createApiClient` is a plain module
 * with no access to the tree, and threading a setter into it would put a
 * re-render on the path of every API call in the product.
 */

let inFlight = 0;
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

export function beginRequest() {
  inFlight += 1;
  if (inFlight === 1) emit();
}

export function endRequest() {
  // Guarded so an unbalanced end — a double-settled promise, a hot reload
  // across the middle of a request — cannot drive the count negative and leave
  // the bar stuck on forever.
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) emit();
}

export function subscribePending(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The snapshot `useSyncExternalStore` reads: a boolean, so it is referentially stable. */
export function isPending() {
  return inFlight > 0;
}
