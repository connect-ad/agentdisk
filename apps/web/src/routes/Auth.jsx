import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Icon, Alert } from '../components/index.js';
import { useAuth, describeAuthError } from '../lib/auth.jsx';
import { BASE_URL } from '../lib/api.js';
import { FREE_SUMMARY } from '../lib/pricing.js';
import Logo from '../components-local/Logo.jsx';

/**
 * 8.3 Signup · 8.4 Email Verification · 8.5 Forgot Password ·
 * 8.6 Reset Password · 8.7 Login.
 *
 * Built to `AgentDisk Auth.dc.html`. The layout is the reference's: one sheet
 * split `minmax(0,1fr) 480px`, a brand panel on the fluid side and the form in
 * the fixed column, with a Sign up / Log in segment above the heading. The
 * controls are drawn in `app.css` under `.auth__*` rather than taken from the
 * vendored `Input` and `Button`, because the reference's 42px field with a
 * 9.5px mono micro-label is not a variant either component has — the same
 * reason `.mk__*` and `.err__*` exist beside the barrel.
 *
 * ---------------------------------------------------------------------------
 * Content, where the reference and this product disagree
 *
 * The standing rule for this migration is layout from the design, content from
 * the codebase. The Auth file is a mockup and its copy invents freely, so most
 * of what follows is a correction rather than a preference:
 *
 *  - "5 GB and 50,000 requests a month" is not the free tier. The number is
 *    read from `lib/pricing.js` rather than restated here: this panel carried
 *    its own copy, and when the catalogue was finalised the pricing page moved
 *    and the signup page went on advertising the old allowance.
 *  - The login brand panel lists "3 workspaces · Kessler Labs, Nightshift
 *    Research, Personal sandbox", "4 agent identities", and a LAST SESSION card
 *    reading "15 Sep 2026, 18:22 UTC · Berlin, DE · Chrome 141". That is
 *    account data for somebody who is by definition not signed in yet. It is
 *    replaced with statements about how the product behaves, which are true
 *    before anyone authenticates.
 *  - "$ adk auth login" describes a CLI that does not exist.
 *  - "Sessions expire in 12 hours", "device-bound sessions", and "Keep me
 *    signed in for 30 days" describe a session model this app does not have.
 *    Firebase's default persistence keeps a browser signed in until it signs
 *    out, and the ID token refreshes hourly on its own. The checkbox is gone
 *    rather than stubbed — a control that reports a choice nobody honours is
 *    the `backlog/023` defect this migration keeps finding.
 *  - "After five failed attempts we pause sign-in for 15 minutes" is a number
 *    this client would be inventing. The lockout is Firebase's
 *    `auth/too-many-requests`, which does not publish a threshold.
 *  - "Continue with SAML SSO" is not built. Omitted for the same reason.
 *  - "Email me product updates, at most monthly" has nothing behind it.
 *
 * Two of the reference's states cannot be built as drawn at all:
 *
 *  - Its `login_error` frame puts "No account found for this address" under the
 *    email field. That is precisely the oracle doc 06 PART 16 forbids and
 *    `describeAuthError` exists to prevent: it answers "does this address have
 *    an account here" to anyone who asks. A failed sign-in marks both fields
 *    and shows one generic message, which is the same visual weight without
 *    the disclosure.
 *  - Its password error carries "Two attempts left", a counter this client does
 *    not have and could not honour.
 *
 * What the reference does not draw, and this keeps, because it is built and
 * doc 16 PART 30 names it: email-link sign-in, offered under the submit button.
 * ---------------------------------------------------------------------------
 *
 * Security behaviour the copy exists to enforce (doc 06 PART 16), unchanged:
 *  - Login failure is generic. Firebase distinguishes `user-not-found` from
 *    `wrong-password`; `describeAuthError` collapses them into one message.
 *  - Forgot-password shows an identical success whether or not the account
 *    exists — so the screen never awaits a per-address answer.
 *  - Repeated failure locks out with Firebase's own limit, not a number this
 *    client invented and could be talked out of.
 */

/* ------------------------------ brand panels ------------------------------ */

/**
 * The left half of the sheet. `points` is optional so the three screens the
 * reference has no artboard for — verify, forgot, reset — can fill the panel
 * with what is true of that moment instead of padding it out to three bullets.
 *
 * The login footer prints the endpoints from `BASE_URL`, the value the API
 * client itself calls, so the two cannot disagree about which environment this
 * build talks to.
 */
const BRAND = {
  signup: {
    head: 'A disk for every agent you run.',
    body: 'Create a workspace, scope a key, and your agent has persistent storage in about four minutes.',
    points: [
      { title: 'Free tier, no card', note: FREE_SUMMARY },
      { title: 'Scoped by default', note: 'Every key carries explicit operations and an optional path prefix' },
      { title: 'MCP and REST', note: 'Ten MCP tools, or the same operations over HTTP' }
    ],
    footLabel: 'AFTER SIGN-UP',
    footCode: '1  verify your email\n2  a workspace is made for you\n3  mint a key, connect your agent'
  },
  login: {
    head: 'Welcome back.',
    body: 'Your workspaces, keys and audit history are exactly where you left them.',
    points: [
      { title: 'Membership is per workspace', note: 'Being on one workspace of a bill does not put you in the one beside it' },
      { title: 'Your agents stay connected', note: 'API keys are untouched by a browser sign-in, so nothing needs re-authenticating' },
      { title: 'Every action names its actor', note: 'Activity separates what you did from what an agent did' }
    ],
    footLabel: 'ENDPOINTS',
    footCode: `REST  ${BASE_URL}/v1\nMCP   ${BASE_URL}/mcp`
  },
  verify: {
    head: 'One link to go.',
    body: 'Verifying your address is what lets you accept a workspace invitation, so the link goes out the moment you sign up.',
    footLabel: 'IF IT DOES NOT ARRIVE',
    footCode: '1  check your spam folder\n2  wait out the 60s cooldown\n3  resend'
  },
  forgot: {
    head: 'Reset it and carry on.',
    body: 'Enter the address on your account. This page answers the same way whether or not an account exists, so it never confirms who has one.',
    footLabel: 'WHY THE REPLY IS VAGUE',
    footCode: 'a page that says\n"no such account" answers\nthat question for anyone'
  },
  reset: {
    head: 'Set a new password.',
    body: 'The link carries a one-time code. It is checked before this form appears, so an expired link says so now rather than after you have typed a password twice.',
    footLabel: 'AFTER YOU SAVE',
    footCode: 'you are sent to Log in\nand the old link stops\nworking'
  }
};

/* --------------------------------- icons --------------------------------- */

/* The reference's own marks. Drawn here rather than through `Icon` where its
   stroke weight is the point: the 18px brand chip carries a 3px tick and the
   field validity mark a 2.8px one, against the component's 1.6px default. */

function Tick({ size = 11, width = 3 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={width} strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M4 12.5 9 17.5 20 6.5" />
    </svg>
  );
}

function Warn({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.6" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9.2" />
      <path d="M12 7.5v5M12 16.5v.01" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M23 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h6.1c-.3 1.4-1.1 2.6-2.3 3.4v2.8h3.7C21.7 18.4 23 15.6 23 12.2z" />
      <path fill="#34A853" d="M12 23.5c3.1 0 5.6-1 7.5-2.8l-3.7-2.8c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2v3C3.9 21 7.6 23.5 12 23.5z" />
      <path fill="#FBBC05" d="M5.7 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.6.4-2.4v-3H2C1.2 8.3.8 10.1.8 12s.4 3.7 1.2 5.3l3.7-2.9z" />
      <path fill="#EA4335" d="M12 5.1c1.6 0 3.1.6 4.3 1.7l3.2-3.2C17.6 1.7 15.1.5 12 .5 7.6.5 3.9 3 2 6.6l3.7 2.9C6.6 7 9.1 5.1 12 5.1z" />
    </svg>
  );
}

function GithubMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 .8a11.2 11.2 0 0 0-3.5 21.8c.6.1.8-.2.8-.6v-2c-3.1.7-3.8-1.5-3.8-1.5-.5-1.3-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.7 1.1 1.7 1.1 1 1.7 2.6 1.2 3.2.9.1-.7.4-1.2.7-1.5-2.5-.3-5.1-1.2-5.1-5.5 0-1.2.4-2.2 1.1-3-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1a10.5 10.5 0 0 1 5.5 0c2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.8 1.1 1.8 1.1 3 0 4.3-2.6 5.2-5.1 5.5.4.4.8 1.1.8 2.2v3.2c0 .4.2.7.8.6A11.2 11.2 0 0 0 12 .8z" />
    </svg>
  );
}

/* --------------------------------- shell --------------------------------- */

/**
 * The sheet. `tab` names which half of the segment is current, or is left off
 * on the three screens the segment does not apply to — verify, forgot and
 * reset are not a choice between signing up and signing in.
 *
 * The segment's halves are links, not buttons: /signup and /login are separate
 * routes, so a click that only changed local state would leave the address bar
 * describing the wrong screen and break the back button.
 */
function AuthSheet({ brand, tab, children }) {
  return (
    <div className="auth">
      <div className="auth__sheet">
        <div className="auth__split">
          <div className="auth__brandpanel">
            <Link to="/" className="auth__brand">
              <Logo size={30} />
              <span className="auth__wordmark">AgentDisk</span>
            </Link>

            <div>
              <h2 className="auth__brandhead">{brand.head}</h2>
              <p className="auth__brandbody">{brand.body}</p>
              {brand.points ? (
                <div className="auth__points">
                  {brand.points.map(p => (
                    <div className="auth__point" key={p.title}>
                      <span className="auth__pointmark"><Tick /></span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="auth__pointtitle">{p.title}</span>
                        <span className="auth__pointnote">{p.note}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="auth__brandfoot">
              <div className="auth__brandfootlabel">{brand.footLabel}</div>
              <div className="auth__brandfootcode">{brand.footCode}</div>
            </div>
          </div>

          <div className="auth__formpanel">
            <div className="auth__form">
              <Link to="/" className="auth__brand auth__mobilebrand">
                <Logo size={28} />
                <span className="auth__wordmark">AgentDisk</span>
              </Link>

              {tab ? (
                <div className="auth__seg">
                  <Link
                    to="/signup"
                    className={`auth__segbtn${tab === 'signup' ? ' is-on' : ''}`}
                    aria-current={tab === 'signup' ? 'page' : undefined}
                  >
                    Sign up
                  </Link>
                  <Link
                    to="/login"
                    className={`auth__segbtn${tab === 'login' ? ' is-on' : ''}`}
                    aria-current={tab === 'login' ? 'page' : undefined}
                  >
                    Log in
                  </Link>
                </div>
              ) : null}

              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Head({ title, sub }) {
  return (
    <>
      <h1 className="auth__h1">{title}</h1>
      {sub ? <p className="auth__sub">{sub}</p> : null}
    </>
  );
}

/**
 * The reference's field: a mono micro-label over a 42px row.
 *
 * `error` draws the red edge and the message under it; `invalid` draws the
 * edge alone. The login form needs the second one — a failed sign-in marks the
 * email field without claiming anything specific about the address.
 */
function Field({ id, label, error, invalid, valid, trailing, children, labelExtra, compact }) {
  const bad = Boolean(error) || Boolean(invalid);
  return (
    <div className={`auth__group${compact ? ' auth__group--pw' : ''}`}>
      {labelExtra ? (
        <div className="auth__labelrow">
          <label className="auth__label" htmlFor={id}>{label}</label>
          {labelExtra}
        </div>
      ) : (
        <label className="auth__label" htmlFor={id}>{label}</label>
      )}
      <div className={`auth__field${bad ? ' is-bad' : ''}`}>
        {children}
        {valid ? <span className="auth__fieldok"><Tick size={15} width={2.8} /></span> : null}
        {trailing}
      </div>
      {error ? (
        <div className="auth__err" role="alert">
          <Warn />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

/** A reveal toggle, rather than the reference's decorative eye. */
function Reveal({ on, onToggle }) {
  return (
    <button
      type="button"
      className="auth__reveal"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={on ? 'Hide password' : 'Show password'}
    >
      <Icon name="eye" size={16} strokeWidth={2} />
    </button>
  );
}

function Submit({ busy, busyText, children, disabled, gap }) {
  return (
    <button
      type="submit"
      className={`auth__submit${gap ? ' auth__submit--gap' : ''}`}
      aria-busy={busy || undefined}
      disabled={busy || disabled}
    >
      {busy ? <><span className="auth__spin" /> {busyText}</> : children}
    </button>
  );
}

/** The four strength bars, as a block, shared by signup and reset. */
function Strength({ pw }) {
  const st = strengthOf(pw);
  if (!pw) return null;
  return (
    <div className="auth__strength">
      <div className="auth__bars">
        {[0, 1, 2, 3].map(i => (
          <span key={i} className={`auth__bar${i < st.score ? ' is-on' : ''}`} />
        ))}
      </div>
      <div className="auth__strengthrow">
        <span className="auth__strengthnote">{st.note}</span>
        {/* Never colour alone: the word carries the same meaning as the bars. */}
        <span
          className={`auth__strengthtag${st.tone === 'ok' ? '' : ` auth__strengthtag--${st.tone}`}`}
          aria-live="polite"
        >
          {st.label}
        </span>
      </div>
    </div>
  );
}

function Foot({ children }) {
  return <p className="auth__foot">{children}</p>;
}

/** The reference's tail row. Duplicates the segment on purpose — it draws both. */
function Alt({ prompt, to, label }) {
  return (
    <div className="auth__alt">
      <span className="auth__altprompt">{prompt}</span>
      <Link to={to} className="auth__altlink">{label}</Link>
    </div>
  );
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Where to land after signing in, preserving wherever they were headed. */
function useAfterSignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  return () => navigate(location.state?.from ?? '/app', { replace: true });
}

/**
 * Google and GitHub. The reference draws a third, SAML SSO; it is not built,
 * so it is not here.
 */
function ProviderButtons({ disabled, onError, onDone }) {
  const { signInWithGoogle, signInWithGithub } = useAuth();
  const [busy, setBusy] = useState(null);

  const run = async (name, fn) => {
    setBusy(name);
    onError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      // null means they closed the popup themselves — not a failure to report.
      const message = describeAuthError(err);
      if (message) onError(message);
    } finally {
      setBusy(null);
    }
  };

  const off = disabled || busy !== null;

  return (
    <>
      <div className="auth__ssos">
        <button
          type="button"
          className="auth__sso"
          disabled={off}
          onClick={() => run('google', signInWithGoogle)}
        >
          {busy === 'google' ? <span className="auth__spin" /> : <GoogleMark />}
          <span>Continue with Google</span>
        </button>
        <button
          type="button"
          className="auth__sso"
          disabled={off}
          onClick={() => run('github', signInWithGithub)}
        >
          {busy === 'github' ? <span className="auth__spin" /> : <GithubMark />}
          <span>Continue with GitHub</span>
        </button>
      </div>
      <div className="auth__divider">
        <span className="auth__dividertx">OR WITH EMAIL</span>
      </div>
    </>
  );
}

/** Shown instead of a form when the build has no Firebase project configured. */
function NotConfigured() {
  return (
    <Alert tone="danger" title="Sign-in is not configured">
      This build has no Firebase project. Set the VITE_FIREBASE_* build variables
      and redeploy.
    </Alert>
  );
}

/* ------------------------------- 8.3 Signup ------------------------------- */

/**
 * The reference's four strength bars, scored against the password actually
 * typed. Its caption — "14 characters, mixed case, one symbol" — is a
 * description of the password in the field, so it is computed rather than
 * printed: a fixed caption under a live meter is the same class of lie as a
 * hardcoded workspace ID.
 */
export function strengthOf(pw) {
  if (!pw) return { score: 0, label: '', tone: 'bad', note: '' };
  const mixed = /[a-z]/.test(pw) && /[A-Z]/.test(pw);
  const digit = /[0-9]/.test(pw);
  const symbol = /[^A-Za-z0-9]/.test(pw);

  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (digit || symbol) score += 1;
  if (mixed) score += 1;

  const parts = [`${pw.length} character${pw.length === 1 ? '' : 's'}`];
  if (mixed) parts.push('mixed case');
  if (digit) parts.push('a number');
  if (symbol) parts.push('one symbol');

  return {
    score,
    label: score <= 1 ? 'WEAK' : score === 2 ? 'FAIR' : score === 3 ? 'GOOD' : 'STRONG',
    tone: score <= 1 ? 'bad' : score === 2 ? 'warn' : 'ok',
    note: parts.join(', ')
  };
}

export function Signup() {
  const navigate = useNavigate();
  const afterSignIn = useAfterSignIn();
  const { signUpWithPassword, configured } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [reveal, setReveal] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [fieldErr, setFieldErr] = useState({});
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = 'Enter the name you want on your account.';
    if (!EMAIL_RE.test(email)) next.email = 'Enter a valid email address.';
    if (pw.length < 8) next.pw = 'Use at least 8 characters.';
    setFieldErr(next);
    if (Object.keys(next).length > 0) return;

    setErr(null); setBusy(true);
    try {
      await signUpWithPassword(email, pw, name);
      navigate('/verify-email');
    } catch (error) {
      setErr(describeAuthError(error));
      setBusy(false);
    }
  };

  return (
    <AuthSheet brand={BRAND.signup} tab="signup">
      <Head title="Create your account" sub="Free forever on the starter tier. No card required." />

      {err ? (
        <div role="alert" style={{ marginBottom: 'var(--s-6)' }}>
          <Alert tone="danger" title={err} />
        </div>
      ) : null}

      {!configured ? <NotConfigured /> : (
        <>
          <ProviderButtons disabled={busy} onError={setErr} onDone={afterSignIn} />

          <form onSubmit={submit} noValidate>
            <Field id="su-name" label="FULL NAME" error={fieldErr.name}>
              <input
                id="su-name"
                className="auth__input"
                type="text"
                autoComplete="name"
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </Field>

            <Field
              id="su-email"
              label="WORK EMAIL"
              error={fieldErr.email}
              valid={!fieldErr.email && EMAIL_RE.test(email)}
            >
              <input
                id="su-email"
                className="auth__input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </Field>

            <Field
              id="su-pw"
              label="PASSWORD"
              error={fieldErr.pw}
              compact
              trailing={<Reveal on={reveal} onToggle={() => setReveal(v => !v)} />}
            >
              <input
                id="su-pw"
                className={`auth__input${reveal ? '' : ' auth__input--pw'}`}
                type={reveal ? 'text' : 'password'}
                autoComplete="new-password"
                value={pw}
                onChange={e => setPw(e.target.value)}
              />
            </Field>

            <Strength pw={pw} />

            {/* A real gate, not a decoration: submit is blocked until it is on. */}
            <label className="auth__consent">
              <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
              <span className="auth__check"><Tick width={3.4} /></span>
              <span>
                I agree to the <Link to="/terms">terms of service</Link> and{' '}
                <Link to="/privacy">privacy policy</Link>
              </span>
            </label>

            <Submit busy={busy} busyText="Creating your account…" disabled={!agreed}>
              Create account
            </Submit>
          </form>

          <Foot>
            {busy
              ? 'Creating your account and sending a verification link.'
              : 'We never charge without an explicit purchase.'}
          </Foot>
        </>
      )}

      <Alt prompt="Already have an account?" to="/login" label="Log in" />
    </AuthSheet>
  );
}

/* --------------------------- 8.4 Email verification --------------------------- */

export function VerifyEmail() {
  const { user, resendVerification } = useAuth();
  const [cooldown, setCooldown] = useState(0);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const resend = async () => {
    setErr(null);
    try {
      await resendVerification();
      setCooldown(60);
    } catch (error) {
      setErr(describeAuthError(error));
    }
  };

  return (
    <AuthSheet brand={BRAND.verify}>
      <Head
        title="Check your inbox"
        sub={user?.email
          ? <>We sent a verification link to <strong>{user.email}</strong>. Open it to activate your workspace.</>
          : <>We sent you a verification link. Open it to activate your workspace.</>}
      />

      {err ? (
        <div role="alert" style={{ marginBottom: 'var(--s-6)' }}>
          <Alert tone="danger" title={err} />
        </div>
      ) : null}

      <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--s-8) 0' }}>
        <span
          style={{
            width: '2.5rem', height: '2.5rem', borderRadius: 'var(--r-3)', display: 'grid',
            placeItems: 'center', border: '1px solid var(--accBd)',
            background: 'var(--accSoft)', color: 'var(--acc)'
          }}
        >
          <Icon name="link" size={19} />
        </span>
      </div>

      <button type="button" className="auth__submit" disabled={cooldown > 0} onClick={resend}>
        {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend email'}
      </button>

      <Link to="/app" className="auth__ghost" style={{ display: 'block', textAlign: 'center' }}>
        Continue to the dashboard
      </Link>

      <Foot>The verification link can be used once.</Foot>
      {/* Announced at most occasionally, not every tick — avoids screen-reader
          spam — and kept out of the layout so the countdown does not move the
          foot copy about while it runs. */}
      <span className="sr-only" aria-live="polite">
        {cooldown > 0 && cooldown % 10 === 0 ? `Resend available in ${cooldown} seconds` : ''}
      </span>

      <Alt prompt="Wrong email?" to="/signup" label="Start over" />
    </AuthSheet>
  );
}

/* --------------------------- 8.5 Forgot password --------------------------- */

export function ForgotPassword() {
  const { sendReset, configured } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault();
    setBusy(true);
    try {
      await sendReset(email);
    } catch {
      // Swallowed on purpose. Firebase reports `user-not-found` here, and
      // showing it would answer "does this address have an account" to anyone
      // who asks. The screen below is identical either way.
    } finally {
      setBusy(false);
      setSent(true);
    }
  };

  if (sent) {
    return (
      <AuthSheet brand={BRAND.forgot}>
        <Head title="Check your inbox" />
        {/* Deliberately non-committal: identical whether or not the account exists. */}
        <div role="status">
          <Alert tone="ok" title="Reset link sent">
            If an account exists for <strong>{email}</strong>, we&apos;ve sent a password reset link.
          </Alert>
        </div>
        <Alt prompt="Remembered it?" to="/login" label="Back to log in" />
      </AuthSheet>
    );
  }

  return (
    <AuthSheet brand={BRAND.forgot}>
      <Head
        title="Reset your password"
        sub="Enter the email on your account and we'll send a reset link."
      />

      {!configured ? <NotConfigured /> : (
        <>
          <form onSubmit={submit} noValidate>
            <Field id="fp-email" label="WORK EMAIL" valid={EMAIL_RE.test(email)}>
              <input
                id="fp-email"
                className="auth__input"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </Field>
            <Submit busy={busy} busyText="Sending…">Send reset link</Submit>
          </form>
          <Foot>The reply is the same whether or not the address has an account.</Foot>
        </>
      )}

      <Alt prompt="Remembered it?" to="/login" label="Back to log in" />
    </AuthSheet>
  );
}

/* --------------------------- 8.6 Reset password --------------------------- */

/**
 * Reached from the link in the reset email, which carries Firebase's one-time
 * `oobCode`. The code is verified before the form is shown, so an expired link
 * says so immediately rather than after somebody has typed a new password twice.
 */
export function ResetPassword() {
  const navigate = useNavigate();
  const { verifyResetCode, confirmReset } = useAuth();
  const code = new URLSearchParams(window.location.search).get('oobCode');

  const [checking, setChecking] = useState(Boolean(code));
  const [valid, setValid] = useState(false);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const mismatch = confirm.length > 0 && confirm !== pw;

  useEffect(() => {
    if (!code) { setChecking(false); return undefined; }
    let cancelled = false;
    verifyResetCode(code)
      .then(() => { if (!cancelled) setValid(true); })
      .catch(() => { if (!cancelled) setValid(false); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [code, verifyResetCode]);

  if (checking) {
    return (
      <AuthSheet brand={BRAND.reset}>
        <Head title="Set a new password" />
        <p className="auth__foot" style={{ marginTop: 0 }}>Checking your link…</p>
      </AuthSheet>
    );
  }

  if (!code || !valid) {
    return (
      <AuthSheet brand={BRAND.reset}>
        <Head title="Set a new password" />
        <div role="alert" style={{ marginBottom: 'var(--s-6)' }}>
          <Alert tone="danger" title="This reset link is invalid or has expired." />
        </div>
        <Link to="/forgot-password" className="auth__submit" style={{ textDecoration: 'none' }}>
          Request a new link
        </Link>
        <Alt prompt="Know your password?" to="/login" label="Back to log in" />
      </AuthSheet>
    );
  }

  const submit = async e => {
    e.preventDefault();
    if (mismatch || pw.length < 8) {
      setErr('Use at least 8 characters, typed the same twice.');
      return;
    }
    setErr(null); setBusy(true);
    try {
      await confirmReset(code, pw);
      navigate('/login');
    } catch (error) {
      setErr(describeAuthError(error));
      setBusy(false);
    }
  };

  return (
    <AuthSheet brand={BRAND.reset}>
      <Head
        title="Set a new password"
        sub="This replaces the password on your account everywhere."
      />

      {err ? (
        <div role="alert" style={{ marginBottom: 'var(--s-6)' }}>
          <Alert tone="danger" title={err} />
        </div>
      ) : null}

      <form onSubmit={submit} noValidate>
        <Field
          id="rp-pw"
          label="NEW PASSWORD"
          compact
          trailing={<Reveal on={reveal} onToggle={() => setReveal(v => !v)} />}
        >
          <input
            id="rp-pw"
            className={`auth__input${reveal ? '' : ' auth__input--pw'}`}
            type={reveal ? 'text' : 'password'}
            autoComplete="new-password"
            value={pw}
            onChange={e => setPw(e.target.value)}
          />
        </Field>

        <Strength pw={pw} />

        <Field
          id="rp-confirm"
          label="CONFIRM NEW PASSWORD"
          error={mismatch ? "Those passwords don't match." : undefined}
          valid={confirm.length > 0 && !mismatch}
        >
          <input
            id="rp-confirm"
            className="auth__input auth__input--pw"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
          />
        </Field>

        <Submit busy={busy} busyText="Saving…" disabled={mismatch}>Update password</Submit>
      </form>

      <Alt prompt="Know your password?" to="/login" label="Back to log in" />
    </AuthSheet>
  );
}

/* ------------------------------- 8.7 Login ------------------------------- */

export function Login() {
  const afterSignIn = useAfterSignIn();
  const {
    signInWithPassword, sendEmailLink, isEmailLink, completeEmailLink, configured
  } = useAuth();

  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [needsAddress, setNeedsAddress] = useState(false);

  // Arriving back from an email-link: finish the sign-in rather than showing a
  // form the person has already filled in once.
  useEffect(() => {
    if (!configured || !isEmailLink(window.location.href)) return;
    setBusy(true);
    completeEmailLink(window.location.href)
      .then(afterSignIn)
      .catch(error => {
        // The address is only missing when the link is opened in a different
        // browser from the one that requested it — common, and recoverable.
        if (error?.code === 'agentdisk/email-link-needs-address') setNeedsAddress(true);
        else setErr(describeAuthError(error));
      })
      .finally(() => setBusy(false));
    // Intentionally once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async e => {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      if (needsAddress) {
        await completeEmailLink(window.location.href, email);
      } else {
        await signInWithPassword(email, pw);
      }
      afterSignIn();
    } catch (error) {
      setErr(describeAuthError(error));
      setBusy(false);
    }
  };

  const emailLink = async () => {
    if (!EMAIL_RE.test(email)) {
      setErr('Enter your email address first, and we will send you a sign-in link.');
      return;
    }
    setErr(null); setLinkBusy(true);
    try {
      await sendEmailLink(email);
      setLinkSent(true);
    } catch (error) {
      setErr(describeAuthError(error));
    } finally {
      setLinkBusy(false);
    }
  };

  if (linkSent) {
    return (
      <AuthSheet brand={BRAND.login} tab="login">
        <Head title="Check your inbox" />
        <div role="status">
          <Alert tone="ok" title="Sign-in link sent">
            We sent a one-time sign-in link to <strong>{email}</strong>. Open it on this device.
          </Alert>
        </div>
        <Alt prompt="Rather use your password?" to="/login" label="Back to log in" />
      </AuthSheet>
    );
  }

  /* A failed sign-in marks both fields and says one generic thing. The
     reference names the email as the problem, which would tell an attacker
     which half of the guess was right. */
  const bad = Boolean(err);

  return (
    <AuthSheet brand={BRAND.login} tab="login">
      <Head title="Log in" sub="Logging in never charges your card." />

      {needsAddress ? (
        <div role="status" style={{ marginBottom: 'var(--s-6)' }}>
          <Alert tone="warn" title="Confirm your email">
            This link was requested in another browser. Enter the address you asked for it with.
          </Alert>
        </div>
      ) : null}

      {!configured ? <NotConfigured /> : (
        <>
          <ProviderButtons disabled={busy} onError={setErr} onDone={afterSignIn} />

          <form onSubmit={submit} noValidate>
            <Field
              id="li-email"
              label="WORK EMAIL"
              invalid={bad}
              valid={!bad && EMAIL_RE.test(email)}
            >
              <input
                id="li-email"
                className="auth__input"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </Field>

            {!needsAddress ? (
              <Field
                id="li-pw"
                label="PASSWORD"
                error={err ?? undefined}
                compact
                labelExtra={<Link to="/forgot-password" className="auth__forgot">Forgot password?</Link>}
                trailing={<Reveal on={reveal} onToggle={() => setReveal(v => !v)} />}
              >
                <input
                  id="li-pw"
                  className={`auth__input${reveal ? '' : ' auth__input--pw'}`}
                  type={reveal ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={pw}
                  onChange={e => setPw(e.target.value)}
                />
              </Field>
            ) : null}

            <Submit busy={busy} busyText="Signing you in…" gap={!needsAddress}>
              {needsAddress ? 'Finish signing in' : 'Log in'}
            </Submit>
          </form>

          {/* Not in the reference, but built and named by doc 16 PART 30. */}
          <button
            type="button"
            className="auth__ghost"
            disabled={busy || linkBusy}
            onClick={emailLink}
          >
            {linkBusy ? 'Sending a link…' : 'Email me a sign-in link instead'}
          </button>

          <Foot>You stay signed in on this device until you sign out.</Foot>
        </>
      )}

      <Alt prompt="No account yet?" to="/signup" label="Start free" />
    </AuthSheet>
  );
}
