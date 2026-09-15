import React from 'react';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';

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
 * without a meter rather than against an invented denominator, and the whole
 * band is hidden until the call resolves rather than showing zeros that look
 * like a real empty workspace.
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

function formatCount(n, unit) {
  if (!Number.isFinite(n)) return { value: '—', unit: '' };
  if (n >= 1_000_000) return { value: (n / 1_000_000).toFixed(2), unit: 'M' };
  return { value: n.toLocaleString(), unit };
}

/**
 * Two calls, once, for the whole shell.
 *
 * `whoami` carries storage / files / requests; the agent count has its own
 * endpoint. Both are fetched here rather than per screen, so navigating between
 * tabs costs nothing — the overview used to make this same pair for itself.
 */
const loadUsage = async (api, workspaceId) => {
  const [me, agents] = await Promise.all([
    api.whoami(workspaceId),
    api.listAgents(workspaceId),
  ]);
  return { me, agents: agents.agents ?? [] };
};

export default function WorkspaceStats() {
  const { workspaceId } = useWorkspace();
  const { status, data } = useResource(loadUsage);

  // Nothing at all until the figures are real. A band of zeros is
  // indistinguishable from an empty workspace, and this sits on every screen.
  if (status !== 'loaded' || !workspaceId) return null;

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
            ) : (
              <div className="wstat__meterfoot wstat__meterfoot--bare">
                <span>{c.note ?? (plan ? `on ${plan}` : '')}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
