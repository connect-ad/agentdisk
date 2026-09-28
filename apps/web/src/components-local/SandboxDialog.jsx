import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, CodeBlock, Modal } from '../components/index.js';

/**
 * The agent-first sandbox (02 PART 4.3, 05 PART 13's `POST /v1/workspaces`),
 * as a dialog over the docs rather than a page of its own (28 Sept 2026).
 *
 * Unlike every other screen in this app, this one talks to the REAL API. It is
 * the one place a first credential can come from: the endpoint creates a
 * workspace without any credential at all, so Turnstile is the entire gate in
 * front of it, and Turnstile has to be solved by a browser.
 *
 * What it shows afterwards is one block holding the two things a person has
 * to keep - the API key and the claim link - so one Copy takes both. The
 * limits, the deletion date and what claiming changes are written in the
 * Quick start's step 1 beside the button that opens this, not repeated here.
 *
 * Two properties this dialog must not lose:
 *
 *  - The key and the link are shown ONCE. Only a SHA-256 of each ever reached
 *    the server, so there is no "show it again" to build. Neither is written
 *    to localStorage or a URL, and both leave when the dialog closes. Closing
 *    by accident costs a fresh sandbox, which the owner accepted over a dialog
 *    that refuses to close.
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
      // The widget's fixed size is 300px wide. Flexible fills the container
      // instead, with the same 300px as its floor, which the modal's body
      // leaves even on a 360px phone.
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
 * The agent's name is chosen here, not typed. `sandbox-agent` alone was the
 * same name on every sandbox a person made, so two of them were told apart
 * only by workspace ID; a UTC stamp makes each one say when it was made and
 * stays inside the API's rule (letters, digits, spaces, `-` and `_`, 64 max).
 */
export function defaultAgentName(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  return `sandbox-agent-${stamp}`;
}

/**
 * The one block a person copies. Two labelled lines, so what lands in a notes
 * file says which is which; the key's name is the variable the Quick start's
 * commands read, so pasting the first line into a shell is already step 2.
 */
export function credentialsBlock(result) {
  const lines = [`AGENTDISK_KEY=${result.apiKey?.token ?? ''}`];
  if (result.claim?.url) lines.push(`CLAIM_LINK=${result.claim.url}`);
  return lines.join('\n');
}

function Credentials({ result, onClose }) {
  const hasLink = Boolean(result.claim?.url);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }} data-testid="sandbox-credentials">
      <p className="ad-meta">
        Shown once. Copy both and keep them private: anyone holding the key can act as
        your agent, and anyone opening the link signed in becomes the owner.
        {' '}Workspace <code className="ad-mono">{result.workspace?.id}</code>.
      </p>
      <CodeBlock filename="sandbox-credentials" code={credentialsBlock(result)} />
      {/* The claim link is the only door from this sandbox into an account,
          and the server keeps only its hash: this is the one time it can be
          shown. A deployment that issued none is said out loud, because that
          sandbox can never become anybody's. */}
      {hasLink ? null : (
        <div role="alert">
          <Alert tone="warn" title="This sandbox has no claim link.">
            The server issued none, so this workspace cannot be claimed later. Use the key
            to read your files back and recreate them in a workspace you own.
          </Alert>
        </div>
      )}
      <Button full onClick={onClose}>I've copied {hasLink ? 'both' : 'the key'}, close</Button>
    </div>
  );
}

export function SandboxDialog({ open, onClose }) {
  const [token, setToken] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const onToken = useCallback((value) => setToken(value), []);
  const onExpire = useCallback(() => setToken(null), []);

  // Everything the dialog held leaves with it. Reopening starts from the bot
  // check with nothing from the last sandbox, which is the "shown once" rule.
  useEffect(() => {
    if (open) return;
    setToken(null); setResult(null); setError(null); setBusy(false);
    setResetKey((key) => key + 1);
  }, [open]);

  const submit = async () => {
    if (!token || busy) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/v1/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnstileToken: token, agentName: defaultAgentName() }),
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

  if (!open) return null;

  if (!SITE_KEY) {
    return (
      <Modal title="Get Sandbox Credentials" onClose={onClose}>
        <Alert tone="warn" title="This build has no Turnstile site key.">
          VITE_TURNSTILE_SITE_KEY was not set when the dashboard was built,
          so the challenge cannot render and no workspace can be created.
        </Alert>
      </Modal>
    );
  }

  if (result) {
    return (
      <Modal title="Your sandbox credentials" size="md" onClose={onClose}>
        <Credentials result={result} onClose={onClose} />
      </Modal>
    );
  }

  return (
    <Modal
      title="Get Sandbox Credentials"
      description="Prove you're human and you get an API key and a claim link, shown once."
      onClose={onClose}
      onSubmit={submit}
      footer={(
        <Button type="submit" full loading={busy} disabled={!token || busy}>
          {busy ? 'Creating sandbox…' : 'Create sandbox'}
        </Button>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
        {/* Alert sets role="alert" itself for the danger tone. */}
        {error ? <Alert tone="danger" title={error} /> : null}
        <Challenge key={resetKey} onToken={onToken} onExpire={onExpire} />
        {/* The one fact a person in this dialog may still need: a browser is
            not the only way in. The claim deadline is not repeated here - the
            Docs step says it, and the credentials screen after a successful
            creation states it beside the key. */}
        <p className="ad-meta">
          Have an agent? It can create the sandbox itself. See &ldquo;Let your agent create it
          instead&rdquo; in the <a href="/docs">Docs</a>.
        </p>
      </div>
    </Modal>
  );
}
