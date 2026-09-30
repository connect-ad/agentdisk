import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Icon, Input, Skeleton } from '../components/index.js';
import Logo from '../components-local/Logo.jsx';
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
 * one is noise at best and a dead end at worst. It does not borrow the
 * marketing nav either — that bar sells the product, and this page hands over
 * a file. It carries the mark, the file, and a way to take it.
 *
 * The look is a ticket: the file's extension set large on a tinted tile, the
 * name beside it, then a perforated rule separating what you were sent from
 * how you take it. Every state — loading, password, refusal, file, folder —
 * renders in the same card so the page never changes shape under somebody.
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

/**
 * The extension as the tile shows it: whatever follows the last dot, upper
 * case, at most five characters. A name with no extension, a dotfile, or a
 * long tail like `.sqlite-journal` fall back to the icon rather than a
 * squeezed string nobody can read at that size.
 */
function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  if (ext.length > 5 || !/^[a-z0-9]+$/i.test(ext)) return null;
  return ext.toUpperCase();
}

function Tile({ ext, icon, tone, small }) {
  const cls = ['share__tile'];
  if (small) cls.push('share__tile--sm');
  if (tone) cls.push(`share__tile--${tone}`);
  if (ext) {
    // Three letters fit at the largest size; four and five step down so the
    // tile never grows to fit the word.
    cls.push(`share__tile--${Math.max(3, ext.length)}`);
    return (
      <span className={cls.join(' ')} aria-hidden="true">
        {ext}
      </span>
    );
  }
  cls.push('share__tile--icon');
  return (
    <span className={cls.join(' ')} aria-hidden="true">
      <Icon name={icon} />
    </span>
  );
}

/** The page frame every state shares: mark above, card, one line below. */
function Frame({ children }) {
  return (
    <div className="share">
      <Link to="/" className="share__brand">
        <Logo size={28} />
        <span className="share__wordmark">AgentDisk</span>
        <span className="share__brandnote">Shared with you</span>
      </Link>
      <main className="share__main">
        <div className="share__card">{children}</div>
      </main>
      <footer className="share__foot">
        <span>Stored on AgentDisk, file storage for AI agents.</span>
        <Link to="/privacy">Privacy</Link>
      </footer>
    </div>
  );
}

function Head({ tile, name, from }) {
  return (
    <div className="share__head">
      {tile}
      <div className="share__title">
        <h1 className="share__name">{name}</h1>
        {from ? <p className="share__from">{from}</p> : null}
      </div>
    </div>
  );
}

function Tear() {
  return <div className="share__tear" aria-hidden="true" />;
}

/**
 * An anchor for an open link: the endpoint 302s to a presigned R2 URL, and a
 * normal navigation is what lets the browser follow that and stream the bytes
 * from R2 rather than through this app. A protected link fetches the address
 * with the password first and then navigates the same way.
 */
function DownloadAction({ token, fileId, password, variant, size, label = 'Download' }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  if (password === null) {
    return (
      <a href={sharedDownloadUrl(token, fileId)} download>
        <Button as="span" variant={variant} size={size}>
          {label}
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
    <>
      <Button variant={variant} size={size} loading={busy} onClick={() => void start()}>
        {label}
      </Button>
      {failed ? <span className="ad-meta">{failed}</span> : null}
    </>
  );
}

function PasswordPrompt({ onSubmit, error, busy }) {
  const [draft, setDraft] = useState('');
  return (
    <>
      <Head
        tile={<Tile icon="lock" />}
        name="This link needs a password"
        from="Ask whoever sent it if you don't have it."
      />
      <Tear />
      <div className="share__body">
        <form
          className="share__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft) onSubmit(draft);
          }}
        >
          <div>
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
      </div>
    </>
  );
}

function FileRow({ file, token, password }) {
  return (
    <li className="share__row">
      <Tile ext={extensionOf(file.name)} icon="file" small />
      <span className="share__rowbody">
        <span className="share__rowname">{file.name}</span>
        <span className="share__rowmeta">{formatBytes(file.sizeBytes)}</span>
      </span>
      <span className="share__rowact">
        <DownloadAction token={token} fileId={file.id} password={password} variant="secondary" size="sm" />
      </span>
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
      <Frame>
        <Head
          tile={<Tile icon="alert" tone="danger" />}
          name="This link isn't available."
          // Deliberately no cause. See the header.
          from="Ask whoever sent it for a new one."
        />
        <Tear />
        <div className="share__body">
          <div className="share__take">
            <Button as={Link} to="/" variant="secondary" size="lg">
              What is AgentDisk?
            </Button>
          </div>
        </div>
      </Frame>
    );
  }

  if (!preview && needsPassword) {
    return (
      <Frame>
        <PasswordPrompt onSubmit={(attempt) => void unlock(attempt)} error={passwordError} busy={unlocking} />
      </Frame>
    );
  }

  if (!preview) {
    return (
      <Frame>
        <Head tile={<Tile icon="file" />} name="Opening this link…" />
        <Tear />
        <div className="share__body">
          <Skeleton />
        </div>
      </Frame>
    );
  }

  const expires = formatExpiry(preview.expiresAt);
  const isFile = preview.kind === 'file' && preview.files.length === 1;
  const only = isFile ? preview.files[0] : null;
  // A folder share's name is its path; the leading slash is the browser's
  // business, not the reader's.
  const shown = isFile ? preview.name : preview.name.replace(/^\/+/, '') || 'Shared folder';

  return (
    <Frame>
      <Head
        tile={isFile ? <Tile ext={extensionOf(preview.name)} icon="file" /> : <Tile icon="folder" />}
        name={shown}
        from={`Shared from ${preview.workspaceName}`}
      />
      <Tear />
      <div className="share__body">
        <dl className="share__facts">
          {isFile ? (
            <>
              <dt>Size</dt>
              <dd>{formatBytes(only.sizeBytes)}</dd>
              {only.mimeType ? (
                <>
                  <dt>Type</dt>
                  <dd>{only.mimeType}</dd>
                </>
              ) : null}
            </>
          ) : (
            <>
              <dt>Files</dt>
              <dd>{preview.files.length}</dd>
            </>
          )}
          {expires === null ? null : (
            <>
              <dt>Link valid until</dt>
              <dd>{expires}</dd>
            </>
          )}
        </dl>

        {isFile ? (
          <div className="share__take">
            <DownloadAction token={token} fileId={only.id} password={password} size="lg" />
            <p className="share__note">The file downloads to your device. Nothing opens in this tab.</p>
          </div>
        ) : preview.files.length === 0 ? (
          <p className="share__empty">This folder has nothing in it right now.</p>
        ) : (
          <ul className="share__list">
            {preview.files.map((file) => (
              <FileRow key={file.id} file={file} token={token} password={password} />
            ))}
          </ul>
        )}
      </div>
    </Frame>
  );
}
