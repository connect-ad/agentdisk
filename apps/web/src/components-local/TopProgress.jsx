import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { subscribePending, isPending } from '../lib/pending.js';

/**
 * The page-level loading indicator: a hairline across the very top of the
 * viewport, running while any API request is in flight.
 *
 * ── Why it outlives the request ───────────────────────────────────────────
 * A bar that disappears the instant the last response lands reads as a glitch
 * — on a fast connection it can appear and vanish inside two frames, which is
 * a flicker rather than feedback. So when the count reaches zero the fill
 * completes and fades over `--d-2`, and only then does the element leave the
 * tree. `finishing` is what keeps it mounted across that window.
 *
 * ── Why it is hidden from assistive technology ────────────────────────────
 * It says nothing that is not already said where the data is going to appear:
 * the stat tiles carry `aria-busy` and their own "Loading" text. A second
 * announcement of the same fact, from a decorative line with no context, is
 * noise. `role="presentation"` states that positively rather than leaving a
 * bare div to be guessed at.
 *
 * Under `prefers-reduced-motion` the global rule in styles.css collapses the
 * animation, and it degrades to a static accent line for the duration of the
 * load — still an indicator, with nothing moving.
 */
export default function TopProgress() {
  const busy = useSyncExternalStore(subscribePending, isPending, () => false);
  const [finishing, setFinishing] = useState(false);
  const wasBusy = useRef(false);

  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      setFinishing(false);
      return undefined;
    }
    if (!wasBusy.current) return undefined;
    wasBusy.current = false;
    setFinishing(true);
    const timer = setTimeout(() => setFinishing(false), 400);
    return () => clearTimeout(timer);
  }, [busy]);

  if (!busy && !finishing) return null;

  return (
    <div className={`tprog${busy ? '' : ' tprog--done'}`} role="presentation">
      <div className="tprog__fill" />
    </div>
  );
}
