import React from 'react';
import { useWorkspace } from '../lib/workspace.jsx';
import { useWorkspaceUsage } from '../lib/usage.jsx';

/**
 * Layer 2 of the design: the workspace's headline figures, on every screen.
 *
 * ── Why this lives in the shell and fetches once ──────────────────────────
 * The design puts these four cards above the tab bar, so they are present on
 * files, activity, settings — everywhere, not only the overview. The obvious
 * implementation is for each screen to fetch its own usage, which would be one
 * extra round trip per navigation and would worsen exactly the first-paint
 * problem `backlog/027` tracks.
 *
 * Instead this fetches `whoami` once, in the shell, and every tab reads the
 * same result. The overview used to make that call for itself; now it does not
 * have to.
 *
 * ── Figures are real or absent ────────────────────────────────────────────
 * The design shows 39.1 GB, 12,481 objects, 4 identities and 1.94 M requests.
 * Those are mockup values. A card whose metric has no limit configured renders
 * without a meter rather than against an invented denominator, and no tile
 * shows a zero it has not been told — a band of zeros is indistinguishable
 * from a real empty workspace.
 *
 * ── Why it no longer unmounts while loading ───────────────────────────────
 * It used to satisfy that rule by returning null until the call resolved. The
 * band is 118px of the page, above every screen's content, and `workspaceId`
 * changing puts the fetch back into `loading` — so switching workspace removed
 * the band, threw the whole page up by 118px, and dropped it back when the
 * answer arrived. The rule is about not *stating* a figure, not about the tile
 * existing: the four labels are static, so the tiles now hold their shape and
 * spin where the number will be. Nothing claims a value it does not have, and
 * nothing moves.
 *
 * A failed load keeps the same shape and shows an em dash. The screen inside
 * the shell raises the error; the band's job is to not lie and to not jump.
 */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return { value: '—', unit: '' };
  if (bytes < 1024) return { value: String(bytes), unit: 'B' };
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  // One decimal up to three digits, as the design's "39.1 GB" shows. Rounding
  // at ten would print "39 GB" and lose the tenth the figure is carrying.
  return { value: v >= 100 ? String(Math.round(v)) : v.toFixed(1), unit: units[u] };
}

/**
 * The four tiles' labels — the part of the band that is known before any
 * request is made, and therefore the part that can hold the layout still while
 * one is in flight. Order matches `cards` below.
 *
 * Every loading tile draws a meter, including AGENTS, which has none when it
 * arrives: until the answer lands nothing here knows which tiles carry a quota,
 * and the band's height is set by the tallest tile in the row either way.
 */
const PLACEHOLDERS = ['STORAGE', 'FILES', 'AGENTS', 'REQUESTS THIS PERIOD'];

function formatCount(n, unit) {
  if (!Number.isFinite(n)) return { value: '—', unit: '' };
  if (n >= 1_000_000) return { value: (n / 1_000_000).toFixed(2), unit: 'M' };
  return { value: n.toLocaleString(), unit };
}

export default function WorkspaceStats() {
  const { workspaceId } = useWorkspace();
  /* The same two calls as before — whoami for storage / files / requests, and
     the agent count from its own endpoint — but made once by the provider in
     the shell, so the Layer 1 strip can read the plan off the same answer. */
  const { status, data } = useWorkspaceUsage();

  // No workspace at all — the account area — has no figures to hold space for.
  if (!workspaceId) return null;

  if (status !== 'loaded') {
    return (
      <div className="shell__statsinner">
        {PLACEHOLDERS.map(label => (
          <div className="wstat wstat--pending" key={label} aria-busy={status === 'loading'}>
            <div className="wstat__head">
              <span className="wstat__label">{label}</span>
            </div>
            {/* The struts are how the tile keeps its exact height rather than
                approximately: a hidden figure and unit in the same classes the
                real ones use, so the row is built out of the same line boxes
                instead of a min-height guessed at from the type scale. They
                are aria-hidden and invisible — a measuring stick, not a value
                anyone is shown or told. */}
            <div className="wstat__figure">
              <span className="wstat__value wstat__strut" aria-hidden="true">0</span>
              {status === 'loading' ? (
                <>
                  <span className="wstat__skel wstat__skel--figure" aria-hidden="true" />
                  <span className="sr-only">Loading</span>
                </>
              ) : (
                <span className="wstat__value wstat__value--none">—</span>
              )}
            </div>
            {/* The meter keeps its box so the tile is the same height either
                way. Loading fills it with the reference's indeterminate
                treatment — a segment sweeping a --surf3 track — because the one
                thing that is true is that something is happening; the caption
                says so in words rather than printing a percentage nothing has
                measured, and the limit beside it is a skeleton for the same
                reason. */}
            <div className="wstat__meter">
              <div className="ds__bar">
                {status === 'loading'
                  ? <span className="wstat__sweep" aria-hidden="true" />
                  : null}
              </div>
              <div className="wstat__meterfoot" aria-hidden="true">
                <span>{status === 'loading' ? 'LOADING…' : ''}</span>
                {status === 'loading'
                  ? <span className="wstat__skel wstat__skel--limit" />
                  : <span />}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const usage = data?.me?.usage ?? {};
  const plan = data?.me?.workspace?.plan ?? null;
  const agents = data?.agents ?? [];
  const activeAgents = agents.filter(a => a.status === 'active').length;

  const cards = [
    {
      label: 'STORAGE',
      ...formatBytes(usage.storageBytes?.used ?? 0),
      used: usage.storageBytes?.used,
      max: usage.storageBytes?.max,
      limitLabel: Number.isFinite(usage.storageBytes?.max)
        ? `${formatBytes(usage.storageBytes.max).value} ${formatBytes(usage.storageBytes.max).unit}`
        : null,
    },
    {
      label: 'FILES',
      ...formatCount(usage.files?.used ?? 0, 'objects'),
      used: usage.files?.used,
      max: usage.files?.max,
      limitLabel: Number.isFinite(usage.files?.max) ? usage.files.max.toLocaleString() : null,
    },
    {
      /**
       * The agent count, with no meter — the design draws it as a bare figure
       * with "7 active keys" beneath, and there is no quota on identities to
       * measure against.
       *
       * CLAUDE.md records this figure once reading a fixed "Not built yet",
       * which made a workspace holding a live agent and one holding none render
       * identically. It is a real count or it is nothing.
       */
      label: 'AGENTS',
      value: agents.length.toLocaleString(),
      unit: agents.length === 1 ? 'identity' : 'identities',
      used: null,
      max: null,
      limitLabel: null,
      note: agents.length === 0
        ? 'No agents yet'
        : activeAgents === agents.length
          ? `${activeAgents} active`
          : `${activeAgents} active, ${agents.length - activeAgents} disabled`,
    },
    {
      label: 'REQUESTS THIS PERIOD',
      ...formatCount(usage.requests?.used ?? 0, ''),
      used: usage.requests?.used,
      max: usage.requests?.max,
      limitLabel: Number.isFinite(usage.requests?.max) ? usage.requests.max.toLocaleString() : null,
    },
  ];

  return (
    <div className="shell__statsinner">
      {cards.map(c => {
        const hasMeter = Number.isFinite(c.max) && c.max > 0 && Number.isFinite(c.used);
        const pct = hasMeter ? Math.min(100, Math.round((c.used / c.max) * 100)) : null;
        const tone = pct === null ? null : pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : null;

        return (
          <div key={c.label} className="wstat">
            <div className="wstat__head">
              <span className="wstat__label">{c.label}</span>
              {/* The flag pairs a tone with the number itself, so the warning
                  never rests on colour alone. */}
              {tone ? <span className={`wstat__flag wstat__flag--${tone}`}>{pct}%</span> : null}
            </div>
            <div className="wstat__figure">
              <span className="wstat__value">{c.value}</span>
              {c.unit ? <span className="wstat__unit">{c.unit}</span> : null}
            </div>
            {hasMeter ? (
              <div className="wstat__meter">
                <div className="ds__bar">
                  <div
                    className={`ds__barfill${tone ? ` ds__barfill--${tone}` : ''}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="wstat__meterfoot">
                  <span>{pct}% USED</span>
                  <span>{c.limitLabel}</span>
                </div>
              </div>
            ) : c.note ? (
              /* The design gives a tile with no quota a trend line instead of a
                 meter: a rising arrow in --ok, then the figure in body type.
                 The arrow only appears beside an actual count — the plan-name
                 fallback below is not a delta and must not be drawn as one. */
              <div className="wstat__delta">
                <svg
                  className="wstat__deltaico"
                  width="12" height="12" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.6"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                >
                  <path d="M4 15l5-5 4 3 7-7" />
                  <path d="M20 6v5h-5" />
                </svg>
                <span>{c.note}</span>
              </div>
            ) : (
              <div className="wstat__meterfoot wstat__meterfoot--bare">
                <span>{plan ? `on ${plan}` : ''}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
