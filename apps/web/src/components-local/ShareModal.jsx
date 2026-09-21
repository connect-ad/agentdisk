import React, { useEffect, useState } from 'react';
import { Alert, Badge, Button, ConfirmModal, Icon, Input, Modal, Select } from '../components/index.js';

/**
 * The dashboard's share-link dialog — Task 10 of the share-links plan.
 *
 * Talks to `POST/GET/DELETE /v1/shares` (Tasks 6-7), which are already built
 * and tested. Everything this dialog refuses is something the server would
 * also refuse; the point of doing it here too is that a control offering a
 * choice the server will reject is a control that lies (8th-day expiry, a
 * disabled-looking button that is actually clickable on the free plan).
 *
 * `api` and `workspaceId` are optional. Without them the dialog still renders
 * correctly from `target` and `limits` alone — every live lookup (an existing
 * link, a folder's current exposure) is skipped rather than attempted, which
 * is what lets this be unit-tested on its own and mounted for real from
 * `FileBrowser`.
 */

/**
 * `ms: null` means "say nothing and take the server's default".
 *
 * That is not a shorthand, it is the fix for a real defect. The 7-day preset
 * used to send `browserNow + 7 days` as an absolute timestamp, and the server
 * refuses anything past `ctx.now + 7 days` — the same constant, so the request
 * carried no tolerance at all and passed only when the server's clock was at
 * or ahead of the browser's. It usually is not: `ctx.now` is captured before
 * any I/O, and a Workers clock only advances on I/O, so on a warm isolate it
 * reads the previous request's time. The ceiling was therefore computed from a
 * timestamp in the past while the browser asked for the full allowance from
 * the present, and the default preset was refused more often than not.
 *
 * Seven days is already what `resolveExpiry` returns for an absent
 * `expiresAt`, computed entirely server-side. Sending nothing is exact rather
 * than approximately right.
 */
const PRESETS = [
  { value: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { value: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7 days', ms: null }
];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The folder path a folder target names, whichever field it arrived in. */
function folderPathOf(target) {
  return target?.path ?? target?.name ?? '';
}

export default function ShareModal({ open, target, limits, onClose, onCreated, api, workspaceId, ws }) {
  const [expiry, setExpiry] = useState('7d');
  const [link, setLink] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [confirmCreateFolder, setConfirmCreateFolder] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [folderStats, setFolderStats] = useState(null);

  const kind = target?.kind ?? null;
  const targetName = target?.name ?? '';
  const folderPath = kind === 'folder' ? folderPathOf(target) : null;

  // A different target (or a fresh open) starts from a clean slate — the
  // expiry choice and any error from a previous file do not belong to this one.
  useEffect(() => {
    if (!open) return;
    setExpiry('7d');
    setError(null);
    setLink(null);
    setFolderStats(null);
    setConfirmCreateFolder(false);
    setConfirmRevoke(false);
  }, [open, kind, target?.id, folderPath]);

  // Whether this target already has a live link. Skipped with no workspace
  // bound behind the dialog — a unit test rendering the dialog on its own, or
  // a target this dialog was not wired up for yet.
  useEffect(() => {
    if (!open || !api?.listShares || !workspaceId || !kind) return;
    let cancelled = false;
    (async () => {
      try {
        const { shares } = await api.listShares(workspaceId);
        const existing = (shares ?? []).find(s =>
          kind === 'file' ? s.kind === 'file' && s.fileId === target.id
            : s.kind === 'folder' && s.path === folderPath
        );
        if (cancelled) return;
        setLink(existing ?? null);
        // A create that failed a moment ago has nothing to say about a link
        // that already exists, and `error && !link` would only hide it until
        // the next revoke brought it back.
        if (existing) setError(null);
      } catch {
        // No live-link answer is not fatal — the create form still works, and
        // the create call itself is the authority on whether one is allowed.
      }
    })();
    return () => { cancelled = true; };
  }, [open, api, workspaceId, kind, target?.id, folderPath]);

  // What a folder link currently exposes — real numbers from the same listing
  // endpoint the file browser itself uses, never invented.
  useEffect(() => {
    if (!open || kind !== 'folder' || !api?.listFiles || !workspaceId || !folderPath) return;
    let cancelled = false;
    (async () => {
      try {
        const { files } = await api.listFiles(workspaceId, { path: folderPath });
        const list = files ?? [];
        if (!cancelled) {
          setFolderStats({
            count: list.length,
            bytes: list.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0)
          });
        }
      } catch {
        if (!cancelled) setFolderStats(null);
      }
    })();
    return () => { cancelled = true; };
  }, [open, kind, api, workspaceId, folderPath]);

  if (!open) return null;

  const shareLinksLimit = limits?.shareLinks ?? 0;
  const allowed = shareLinksLimit > 0;

  const canSubmit = allowed && !creating;

  const runCreate = async () => {
    if (!canSubmit || !api?.createShare) return;
    setCreating(true);
    setError(null);
    try {
      const preset = PRESETS.find(p => p.value === expiry);
      // A null `ms` sends no expiry at all and takes the server's seven-day
      // default. See PRESETS: asking for the ceiling explicitly is what the
      // server refuses.
      const target_ = kind === 'file' ? { fileId: target.id } : { path: folderPath };
      const body = preset?.ms == null
        ? target_
        : { ...target_, expiresAt: new Date(Date.now() + preset.ms).toISOString() };
      const { share } = await api.createShare(workspaceId, body);
      setLink(share);
      onCreated?.(share);
    } catch (err) {
      setError(err?.message ?? 'The share link could not be created.');
    } finally {
      setCreating(false);
      setConfirmCreateFolder(false);
    }
  };

  /**
   * Sharing a folder is the feature's sharpest edge — everything dropped into
   * it later becomes public too — so it gets one more step. That step is
   * additive, not destructive: `destructive={false}` is the whole point,
   * because dressing an additive action in the danger treatment is how people
   * learn to click through the red dialogs that matter.
   */
  const onCreateClick = () => {
    if (!canSubmit) return;
    if (kind === 'folder') { setConfirmCreateFolder(true); return; }
    void runCreate();
  };

  const runRevoke = async () => {
    if (!link || !api?.revokeShare) return;
    setRevoking(true);
    try {
      await api.revokeShare(workspaceId, link.id);
      setLink(null);
      setError(null);
    } catch (err) {
      setError(err?.message ?? 'The link could not be revoked.');
    } finally {
      setRevoking(false);
      setConfirmRevoke(false);
    }
  };

  const copyLink = async () => {
    if (!link?.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be unavailable (permissions, non-secure context);
      // the URL is still on screen to select and copy by hand.
    }
  };

  // One billing destination: the account menu's Billing page. /settings has
  // held no plan control since the Billing tab moved out of it. With no
  // workspace in hand there is nothing to bill, so this falls back to the
  // public pricing page.
  const upgradeHref = ws ? `/w/${ws}/billing` : '/pricing';

  return (
    <>
      <Modal
        open={open}
        title={`Share ${targetName || (kind === 'folder' ? 'this folder' : 'this file')}`}
        mark={<Icon name="link" size={16} />}
        onClose={onClose}
        onSubmit={link ? undefined : () => onCreateClick()}
        footer={
          link ? (
            <Button
              variant="danger-outline"
              icon={<Icon name="trash" size={13} />}
              onClick={() => setConfirmRevoke(true)}
            >
              Revoke link
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={creating} disabled={!canSubmit}>Create link</Button>
            </>
          )
        }
      >
        {!allowed ? (
          <Alert tone="warn" title="Not available on your plan">
            Share links are not available on your plan.{' '}
            <a href={upgradeHref}>Upgrade</a> to share files and folders publicly.
          </Alert>
        ) : null}

        {kind === 'folder' ? (
          <Alert tone="warn" title="Anything added to this folder later becomes public too">
            A folder link is not a snapshot. Every file placed under{' '}
            <code className="ad-mono-sm">{folderPath || '/'}</code> after this link is created is
            exposed the same way, until the link is revoked.
            {folderStats
              ? ` It currently exposes ${folderStats.count} file${folderStats.count === 1 ? '' : 's'} (${formatBytes(folderStats.bytes)}).`
              : ''}
          </Alert>
        ) : null}

        {/* Never beside a live link. A failed attempt used to leave this
            banner standing while the `listShares` effect populated `link`
            underneath it, so the dialog said "Not created" directly above a
            working share URL — two true statements about different links,
            which reads as the product contradicting itself. */}
        {error && !link ? <Alert tone="danger" title="Not created">{error}</Alert> : null}

        {link ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            <div className="row" style={{ gap: 'var(--s-3)' }}>
              <Badge tone="ok" dot>Active</Badge>
              <span className="ad-meta">Expires {new Date(link.expiresAt).toLocaleString()}</span>
            </div>
            <div className="row" style={{ gap: 'var(--s-3)', alignItems: 'flex-end' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Input label="Share link" mono readOnly value={link.url ?? ''} />
              </div>
              <Button
                variant="secondary"
                icon={<Icon name={copied ? 'check' : 'copy'} size={13} />}
                onClick={() => void copyLink()}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        ) : (
          <Select
            label="Expires"
            value={expiry}
            disabled={!allowed}
            onChange={e => setExpiry(e.target.value)}
            options={PRESETS.map(p => ({ value: p.value, label: p.label }))}
          />
        )}
      </Modal>

      <ConfirmModal
        open={confirmCreateFolder}
        title="Share this folder?"
        description={`Everything under ${folderPath || 'this folder'} — now and anything added later — becomes reachable by anyone with the link, until it is revoked.`}
        confirmLabel="Share folder"
        destructive={false}
        loading={creating}
        onClose={() => setConfirmCreateFolder(false)}
        onConfirm={() => void runCreate()}
      />

      <ConfirmModal
        open={confirmRevoke}
        title="Revoke this link?"
        description="Anybody holding the link loses access immediately. This cannot be undone."
        confirmLabel="Revoke"
        loading={revoking}
        onClose={() => setConfirmRevoke(false)}
        onConfirm={() => void runRevoke()}
      />
    </>
  );
}
