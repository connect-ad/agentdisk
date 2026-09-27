import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ApiKeyDisplay, Button, CodeBlock, Input } from '../components/index.js';

/**
 * The agent-first sandbox flow (02 PART 4.3, 05 PART 13's `POST /v1/workspaces`).
 *
 * Unlike every other screen in this app, this one talks to the REAL API. It is
 * the one place a first credential can come from: the endpoint creates a
 * workspace without any credential at all, so Turnstile is the entire gate in
 * front of it, and Turnstile has to be solved by a browser.
 *
 * Two properties this page must not lose:
 *
 *  - The API key is shown ONCE. Only a SHA-256 of it ever reached the server,
 *    so there is no "show it again" to build. It is never written to
 *    localStorage or a URL, and it leaves this component when the page does.
 *  - The Turnstile token is single-use and short-lived. A failed submit resets
 *    the widget rather than retrying with a spent token, which would fail
 *    server-side and look like a bug in the gate.
 */

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
const API_BASE = import.meta.env.VITE_API_BASE || '';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Load the Turnstile script once per page, no matter how many mounts. */
function useTurnstileScript() {
  const [state, setState] = useState(() => (window.turnstile ? 'ready' : 'loading'));

  useEffect(() => {
    if (window.turnstile) { setState('ready'); return undefined; }

    let script = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    const onLoad = () => setState('ready');
    const onError = () => setState('failed');
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
    return () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
    };
  }, []);

  return state;
}

function Challenge({ onToken, onExpire }) {
  const containerRef = useRef(null);
  const widgetRef = useRef(null);
  const scriptState = useTurnstileScript();

  useEffect(() => {
    if (scriptState !== 'ready' || !containerRef.current || widgetRef.current !== null) return undefined;

    widgetRef.current = window.turnstile.render(containerRef.current, {
      sitekey: SITE_KEY,
      callback: onToken,
      // The widget's fixed size is 300px wide, which is wider than a 360px
      // phone leaves inside the card. Flexible fills the container instead,
      // with the same 300px as its floor, so the card's padding is what has to
      // give on a phone rather than the widget running out of it (app.css).
      size: 'flexible',
      // A solved challenge does not stay solved. Clearing our copy on expiry
      // means the button disables rather than submitting a token the server
      // will (correctly) reject.
      'expired-callback': onExpire,
      'error-callback': onExpire,
    });

    return () => {
      if (widgetRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetRef.current);
        widgetRef.current = null;
      }
    };
  }, [scriptState, onToken, onExpire]);

  if (scriptState === 'failed') {
    return (
      <Alert tone="danger" title="The verification challenge could not load.">
        It is served by Cloudflare. Check that no extension or network policy is
        blocking challenges.cloudflare.com, then reload.
      </Alert>
    );
  }

  return <div ref={containerRef} />;
}

/**
 * The claim link, shown once, beside the key it travels with.
 *
 * A null URL means the deployment issued none (the API builds it from
 * `DASHBOARD_URL`, and sends null when that is unset). That is said out loud
 * rather than hidden, because a sandbox with no claim link can never become
 * anybody's and its files have to be moved out by hand before the sweep.
 */
function ClaimLink({ claim }) {
  const url = claim?.url ?? null;
  const expires = claim?.expiresAt ? new Date(claim.expiresAt) : null;
  const expiresText = expires && !Number.isNaN(expires.getTime())
    ? expires.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
    : null;

  if (!url) {
    return (
      <div role="alert">
        <Alert tone="warn" title="This sandbox has no claim link.">
          The server issued none, so this workspace cannot be claimed later. Use the key
          to read your files back and recreate them in a workspace you own.
        </Alert>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }} data-testid="claim-link">
      <p className="ad-meta">
        <strong>Your claim link, shown once.</strong> Open it signed in to make this
        workspace yours, or send it to the person you work for. It cannot be shown again:
        only a hash of it is kept.
        {expiresText ? <> It expires on {expiresText}.</> : null}
      </p>
      <CodeBlock filename="claim-link" code={url} />
    </div>
  );
}

function fmtBytes(n) {
  if (typeof n !== 'number') return '—';
  if (n >= 1024 * 1024 * 1024) return `${Math.round(n / (1024 * 1024 * 1024))} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function fmtDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
    : null;
}

/**
 * What the person now holds, in numbers: how long the key works, how long
 * the workspace lasts unclaimed, what it may hold meanwhile, and what claiming
 * changes. Every value comes from the response, so this cannot promise a limit
 * the API does not enforce; the fallback text is for a response that lacks a
 * field, never a number typed here.
 */
function SandboxTerms({ result }) {
  const ws = result.workspace ?? {};
  const limits = ws.limits ?? {};
  const deleteAfter = fmtDate(ws.deleteAfter);
  const rows = [
    ['API key', 'No expiry and no use limit. Works for as long as this workspace exists, and keeps working after you claim it.'],
    ['Workspace', deleteAfter
      ? `Unclaimed, deleted on ${deleteAfter} with everything in it unless somebody claims it first.`
      : 'Unclaimed. Deleted after seven days with everything in it unless somebody claims it first.'],
    ['Storage', `${fmtBytes(limits.storageBytes)} · ${limits.files ?? '—'} files · ${fmtBytes(limits.maxFileBytes)} per file`],
    ['Traffic', `${fmtBytes(limits.egressBytesPerPeriod)} download · ${limits.requestsPerPeriod?.toLocaleString() ?? '—'} requests per period`],
    ['Share links', limits.shareLinks === 0 ? 'None until claimed' : String(limits.shareLinks ?? '—')],
    ['After claiming', 'The key keeps working, the workspace moves onto your plan, and the deletion date is cleared.'],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }} data-testid="sandbox-terms">
      <p className="ad-meta"><strong>What you have.</strong></p>
      <dl className="dl">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

export function Sandbox() {
  const [agentName, setAgentName] = useState('sandbox-agent');
  const [token, setToken] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const onToken = useCallback((value) => setToken(value), []);
  const onExpire = useCallback(() => setToken(null), []);

  const submit = async (event) => {
    event.preventDefault();
    if (!token || busy) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/v1/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnstileToken: token, agentName: agentName.trim() || undefined }),
      });
      const body = await response.json();

      if (!response.ok) {
        // The server's message is written for a human and never contains the
        // reason a credential failed; showing it verbatim is safe and useful.
        setError(body?.error?.message || 'That did not work. Please try again.');
        return;
      }
      setResult(body);
    } catch {
      setError('Could not reach the API. Check your connection and try again.');
    } finally {
      setBusy(false);
      // Whatever happened, this token is spent. Force a fresh challenge.
      setToken(null);
      setResetKey((key) => key + 1);
    }
  };

  if (!SITE_KEY) {
    return (
      <div className="auth auth--card">
        <div className="auth__inner">
          <div className="auth__card">
            <Alert tone="warn" title="This build has no Turnstile site key.">
              VITE_TURNSTILE_SITE_KEY was not set when the dashboard was built,
              so the challenge cannot render and no workspace can be created.
            </Alert>
          </div>
        </div>
      </div>
    );
  }

  if (result) {
    const base = API_BASE || 'https://api-dev.agentdisk.io';
    return (
      <div className="auth auth--card">
        <div className="auth__inner">
          <div className="auth__card" style={{ gap: 'var(--s-6)' }}>
            <div>
              <h1 className="auth__h1">Your sandbox is ready</h1>
              <p className="auth__sub" style={{ marginTop: 'var(--s-2)' }}>
                Workspace <code className="ad-mono">{result.workspace?.id}</code>, agent{' '}
                <code className="ad-mono">{result.agent?.name}</code>.
              </p>
            </div>

            <ApiKeyDisplay revealed secret={result.apiKey?.token} lastFour={result.apiKey?.lastFour} />

            {/* The claim link is the only door from this sandbox into an
                account, and the server keeps only its hash: this is the one
                time it can be shown. Until 27 Sept 2026 this screen dropped
                it, so every browser-made sandbox was unclaimable from birth. */}
            <ClaimLink claim={result.claim} />

            <SandboxTerms result={result} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
              <p className="ad-meta">Upload a file, then read it back:</p>
              <CodeBlock
                filename="round-trip.sh"
                code={[
                  `KEY='${result.apiKey?.token}'`,
                  '',
                  '# Create a file inline (base64, up to 1 MB)',
                  `curl -sS ${base}/v1/files \\`,
                  '  -H "authorization: Bearer $KEY" \\',
                  '  -H "content-type: application/json" \\',
                  `  -d '{"path":"/notes/hello.txt","mimeType":"text/plain","content":"aGVsbG8gYWdlbnRkaXNr"}'`,
                  '',
                  '# List what is there',
                  `curl -sS ${base}/v1/files -H "authorization: Bearer $KEY"`,
                ].join('\n')}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth auth--card">
      <div className="auth__inner">
        <div className="auth__brand">
          <span className="auth__logo" aria-hidden="true">A</span>
          <span className="auth__wordmark">AgentDisk</span>
        </div>
        <div className="auth__card">
          <div>
            <h1 className="auth__h1">Start a sandbox</h1>
            <p className="auth__sub" style={{ marginTop: 'var(--s-2)' }}>
              No account needed. You get a workspace, an agent, and one API key. Copy
              it now; once you claim the workspace you can view it again.
            </p>
          </div>

          {error ? <div role="alert"><Alert tone="danger" title={error} /></div> : null}

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
            <Input
              label="Agent name"
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              hint="Letters, digits, spaces, hyphens and underscores."
              maxLength={64}
            />
            <Challenge key={resetKey} onToken={onToken} onExpire={onExpire} />
            <Button type="submit" full loading={busy} disabled={!token || busy}>
              {busy ? 'Creating sandbox…' : 'Create sandbox'}
            </Button>
          </form>
        </div>
        <p className="auth__legal">
          Sandboxes are rate limited and start on the Free plan. Claim it with an
          account later to keep it.
        </p>
      </div>
    </div>
  );
}
