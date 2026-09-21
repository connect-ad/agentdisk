import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Badge, Button, Icon, Panel, Skeleton } from '../components/index.js';
import { previewShare, sharedDownloadUrl } from '../lib/api.js';

/**
 * `/s/{token}` — what somebody sees when a link is shared with them.
 *
 * No shell chrome, no workspace switcher, no account menu: whoever opens this
 * has no account here and probably never will, so every control that assumes
 * one is noise at best and a dead end at worst. Modelled on `Claim.jsx`, the
 * other public, token-in-URL page.
 *
 * **A refusal explains nothing, and that is the feature.** The API answers
 * expired, revoked, never-existed, suspended and soft-deleted with one
 * identical 404 so that the route cannot be used as an oracle to discover which
 * tokens are real. A page that said "this link expired" would hand that oracle
 * straight back, so this one renders the same sentence the API gave it and
 * offers no theory about the cause.
 *
 * **A folder share is resolved live.** The list below is what the link exposes
 * at this moment, not what it exposed when it was made — which is also why a
 * file added to a shared folder tomorrow appears here tomorrow.
 */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatExpiry(iso) {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Centered({ children }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '70vh', padding: 'var(--s-6)' }}>
      <div style={{ width: '100%', maxWidth: '44rem' }}>{children}</div>
    </div>
  );
}

function FileRow({ file, token }) {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--s-3)',
        padding: 'var(--s-3) 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <Icon name="file" aria-hidden="true" />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 'var(--weight-medium)' }}>{file.name}</span>
        <span className="ad-meta" style={{ display: 'block' }}>
          {formatBytes(file.sizeBytes)}
        </span>
      </span>
      {/* An anchor, not a button: the endpoint 302s to a presigned R2 URL, and
          a normal navigation is what lets the browser follow that and stream
          the bytes from R2 rather than through this app. */}
      <a href={sharedDownloadUrl(token, file.id)} download>
        <Button as="span" variant="secondary">
          Download
        </Button>
      </a>
    </li>
  );
}

export default function SharePage() {
  const { token } = useParams();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    previewShare(token, controller.signal)
      .then((body) => {
        if (live) setPreview(body);
      })
      .catch((err) => {
        if (live && err?.name !== 'AbortError') setError(err);
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [token]);

  if (error) {
    return (
      <Centered>
        <Alert tone="danger" title="This link isn't available.">
          {/* Deliberately no cause. See the header. */}
          Ask whoever sent it for a new one.
        </Alert>
      </Centered>
    );
  }

  if (!preview) {
    return (
      <Centered>
        <Panel title="Opening this link…">
          <Skeleton />
        </Panel>
      </Centered>
    );
  }

  const expires = formatExpiry(preview.expiresAt);
  const isFile = preview.kind === 'file';

  return (
    <Centered>
      <Panel
        title={preview.name}
        description={`Shared from ${preview.workspaceName}`}
        actions={
          expires === null ? null : (
            // Tone plus a word: colour never carries the meaning alone.
            <Badge tone="info">Link expires {expires}</Badge>
          )
        }
      >
        {isFile && preview.files.length === 1 ? (
          // The Panel's title is already this file's name, so the row carries
          // the size and the action and does not repeat it.
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)' }}>
            <Icon name="file" aria-hidden="true" />
            <span className="ad-meta" style={{ flex: 1, minWidth: 0 }}>
              {formatBytes(preview.files[0].sizeBytes)}
              {preview.files[0].mimeType ? ` · ${preview.files[0].mimeType}` : ''}
            </span>
            <a href={sharedDownloadUrl(token, preview.files[0].id)} download>
              <Button as="span">Download</Button>
            </a>
          </div>
        ) : preview.files.length === 0 ? (
          <p className="ad-meta">This folder has nothing in it right now.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {preview.files.map((file) => (
              <FileRow key={file.id} file={file} token={token} />
            ))}
          </ul>
        )}
      </Panel>
    </Centered>
  );
}
