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
              No account needed. You get a workspace, an agent, and one API key —
              shown once.
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
