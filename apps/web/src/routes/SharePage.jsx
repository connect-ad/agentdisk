import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Badge, Button, Icon, Input, Panel, Skeleton } from '../components/index.js';
import {
  isPasswordRequired,
  previewShare,
  sharedDownloadUrl,
  sharedDownloadWithPassword,
} from '../lib/api.js';

/**
 * `/s/{token}` — what somebody sees when a link is shared with them.
 *
 * No shell chrome, no workspace switcher, no account menu: whoever opens this
 * has no account here and probably never will, so every control that assumes
 * one is noise at best and a dead end at worst. Modelled on `Claim.jsx`, the
 * other public, token-in-URL page.
 *
 * **A refusal explains nothing, and that is the feature.** The API answers
 * expired, revoked, never-existed, suspended and deleted with one
 * identical 404 so that the route cannot be used as an oracle to discover which
 * tokens are real. A page that said "this link expired" would hand that oracle
 * straight back, so this one renders the same sentence the API gave it and
 * offers no theory about the cause.
 *
 * **A folder share is resolved live.** The list below is what the link exposes
 * at this moment, not what it exposed when it was made — which is also why a
 * file added to a shared folder tomorrow appears here tomorrow.
 *
 * **A password-protected link asks before it shows anything.** The API names
 * no file until the password is right, and every download then goes through
 * a POST that returns the address — a password in a plain link would sit in
 * the URL, the history and every log in between.
 *
 * Every file downloads rather than opening in the tab; that is decided by the
 * `Content-Disposition` R2 is told to send, since the anchor's `download`
 * attribute is ignored for a cross-origin URL.
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

/**
 * An anchor for an open link: the endpoint 302s to a presigned R2 URL, and a
 * normal navigation is what lets the browser follow that and stream the bytes
 * from R2 rather than through this app. A protected link fetches the address
 * with the password first and then navigates the same way.
 */
function DownloadAction({ token, fileId, password, variant }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  if (password === null) {
    return (
      <a href={sharedDownloadUrl(token, fileId)} download>
        <Button as="span" variant={variant}>
          Download
        </Button>
      </a>
    );
  }

  const start = async () => {
    setBusy(true);
    setFailed(null);
    try {
      window.location.assign(await sharedDownloadWithPassword(token, fileId, password));
    } catch (err) {
      setFailed(err?.message ?? 'The download could not be started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
      {failed ? <span className="ad-meta">{failed}</span> : null}
      <Button variant={variant} loading={busy} onClick={() => void start()}>
        Download
      </Button>
    </span>
  );
}

function PasswordPrompt({ onSubmit, error, busy }) {
  const [draft, setDraft] = useState('');
  return (
    <Panel title="This link needs a password" description="Ask whoever sent it if you don't have it.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (draft) onSubmit(draft);
        }}
        style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'flex-end' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <Input
            label="Password"
            type="password"
            autoComplete="off"
            autoFocus
            value={draft}
            error={error ?? undefined}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Button type="submit" loading={busy} disabled={!draft}>
          Open
        </Button>
      </form>
    </Panel>
  );
}

function FileRow({ file, token, password }) {
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
      <DownloadAction token={token} fileId={file.id} password={password} variant="secondary" />
    </li>
  );
}

export default function SharePage() {
  const { token } = useParams();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  // `null` until a password has been accepted; the open-link path never sets it.
  const [password, setPassword] = useState(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordError, setPasswordError] = useState(null);
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    previewShare(token, controller.signal)
      .then((body) => {
        if (live) setPreview(body);
      })
      .catch((err) => {
        if (!live || err?.name === 'AbortError') return;
        if (isPasswordRequired(err)) setNeedsPassword(true);
        else setError(err);
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [token]);

  const unlock = async (attempt) => {
    setUnlocking(true);
    setPasswordError(null);
    try {
      const body = await previewShare(token, undefined, attempt);
      setPassword(attempt);
      setPreview(body);
    } catch (err) {
      // A wrong password and a locked link both keep the prompt up, with the
      // server's own sentence; anything else is the one refusal.
      if (isPasswordRequired(err)) setPasswordError(err.message);
      else setError(err);
    } finally {
      setUnlocking(false);
    }
  };

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

  if (!preview && needsPassword) {
    return (
      <Centered>
        <PasswordPrompt onSubmit={(attempt) => void unlock(attempt)} error={passwordError} busy={unlocking} />
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
            <DownloadAction token={token} fileId={preview.files[0].id} password={password} />
          </div>
        ) : preview.files.length === 0 ? (
          <p className="ad-meta">This folder has nothing in it right now.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {preview.files.map((file) => (
              <FileRow key={file.id} file={file} token={token} password={password} />
            ))}
          </ul>
        )}
      </Panel>
    </Centered>
  );
}
