import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Icon, Alert } from '../components/index.js';
import { useAuth, describeAuthError } from '../lib/auth.jsx';
import { PASSWORD_RULES, checkPassword, strengthOf } from '../lib/password.js';
import Logo from '../components-local/Logo.jsx';

/**
 * 8.3 Signup · 8.4 Email Verification · 8.5 Forgot Password ·
 * 8.6 Reset Password · 8.7 Login.
 *
 * One card, centred, scaled to the viewport's height. This replaced the split
 * sheet built to `AgentDisk Auth.dc.html` on 21 Sept 2026: the brand panel
 * beside the form made the page taller than a laptop's content area, and its
 * copy was a second, invented account of the product. The layout, its numbers
 * and what was dropped are in
 * `docs/superpowers/specs/2026-09-21-auth-centred-sheet-design.md`. The
 * controls are drawn in `app.css` under `.auth__*`, in em of the sheet's own
 * scale, rather than taken from the vendored `Input` and `Button`, which are
 * fixed-size and could not follow it.
 *
 * Two idioms carry the design. Every label sits in the edge of the thing it
 * names — the field's name in the field's top border, "Forgot password?" in
 * the same border at the other end — so no label costs a row. And the page's
 * only decoration is a disk, the platter rings behind the card, because that
 * is what the product is.
 *
 * Security behaviour the copy exists to enforce (doc 06 PART 16), unchanged
 * from the sheet before it:
 *  - Login failure is generic. Firebase distinguishes `user-not-found` from
 *    `wrong-password`; `describeAuthError` collapses them into one message,
 *    and a failed sign-in marks both fields rather than naming the address.
 *  - Forgot-password shows an identical success whether or not the account
 *    exists, so the screen never awaits a per-address answer.
 *  - Repeated failure locks out with Firebase's own limit, not a number this
 *    client invented and could be talked out of.
 *  - No "remember me", no session length, no attempts counter: each would be
 *    a control reporting a choice nothing honours (`backlog/023`).
 *
 * Email-link sign-in is offered under the Log in button. It is built, and doc
 * 16 PART 30 names it.
 */

/* --------------------------------- icons --------------------------------- */

/* Drawn here rather than through `Icon` where the stroke weight is the point:
   the consent box carries a 3.4px tick and the field validity mark a 2.8px
   one, against the component's 1.6px default. */

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
 * The platter. Five rings of a disk in the page's hairline colour and one
 * sector of one ring in the accent, fixed behind the card and clipped to the
 * viewport in `app.css`. Decoration, so hidden from assistive technology; no
 * motion, so nothing for reduced-motion to switch off. `non-scaling-stroke`
 * keeps the rings one pixel wide however large the viewport draws the box.
 */
function Platter() {
  return (
    <div className="auth__bg" aria-hidden="true">
      <svg viewBox="0 0 1000 1000" focusable="false">
        {[150, 230, 310, 390, 470].map(r => (
          <circle key={r} className="auth__ring" cx="500" cy="500" r={r} vectorEffect="non-scaling-stroke" />
        ))}
        <path className="auth__arc" d="M780.9 368.9A310 310 0 0 1 768.5 655" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/**
 * The sheet. `tab` names which of Sign up / Log in is current, or is left off
 * on the three screens the choice does not apply to — verify, forgot and reset
 * are not a choice between signing up and signing in.
 *
 * The tabs are links, not buttons: /signup and /login are separate routes, so
 * a click that only changed local state would leave the address bar describing
 * the wrong screen and break the back button.
 */
function AuthSheet({ tab, children }) {
  return (
    <div className="auth">
      <Platter />
      <div className="auth__sheet">
        <Link to="/" className="auth__brand">
          <Logo size={30} />
          <span className="auth__wordmark">AgentDisk</span>
        </Link>

        <div className="auth__card">
          {tab ? (
            <nav className="auth__tabs" aria-label="Sign up or log in">
              <Link
                to="/signup"
                className={`auth__tab${tab === 'signup' ? ' is-on' : ''}`}
                aria-current={tab === 'signup' ? 'page' : undefined}
              >
                Sign up
              </Link>
              <Link
                to="/login"
                className={`auth__tab${tab === 'login' ? ' is-on' : ''}`}
                aria-current={tab === 'login' ? 'page' : undefined}
              >
                Log in
              </Link>
            </nav>
          ) : null}

          {children}
        </div>
      </div>
    </div>
  );
}

function Head({ title, sub }) {
  return (
    <div className="auth__head">
      <h1 className="auth__h1">{title}</h1>
      {sub ? <p className="auth__sub">{sub}</p> : null}
    </div>
  );
}

/**
 * A 42px control with its name in its top edge. The label is absolutely
 * positioned over the border on a slip of the card's background, so it costs
 * no row; `labelExtra` — Log in's "Forgot password?" — sits in the same edge at
 * the other end. Both stay real `<label for>` / link elements, so a click on the
 * name still focuses the field and a screen reader still reads it as the name.
 *
 * `error` draws the red edge and the message under it; `invalid` draws the
 * edge alone. The login form needs the second one — a failed sign-in marks the
 * email field without claiming anything specific about the address.
 */
function Field({ id, label, error, invalid, valid, trailing, children, labelExtra, compact }) {
  const bad = Boolean(error) || Boolean(invalid);
  return (
    <div className={`auth__group${compact ? ' auth__group--pw' : ''}`}>
      <label className="auth__label" htmlFor={id}>{label}</label>
      {labelExtra ? <span className="auth__labelextra">{labelExtra}</span> : null}
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
      {busy
        ? <><span className="auth__spin" /><span className="auth__submittx">{busyText}</span></>
        : <span className="auth__submittx">{children}</span>}
    </button>
  );
}

/**
 * The strength block, shared by signup and reset: one bar per rule met, the
 * verdict in a word beside them, and under that the rules as a row of chips,
 * each ticking as it is satisfied.
 *
 * Chips rather than a list because the list was three rows, and 139px under
 * the password field is what stopped Sign up fitting a laptop's screen. The
 * checklist renders from the first keystroke rather than on failure, because
 * the point is to be told the rules while typing instead of after submitting —
 * Firebase refuses a non-compliant password at `accounts:signUp` whatever this
 * form does, so a person who only learns the rules from the rejection retypes
 * the same password.
 */
function Strength({ pw }) {
  const st = strengthOf(pw);
  const { met } = checkPassword(pw);
  if (!pw) return null;
  return (
    <div className="auth__strength">
      <div className="auth__bars">
        {PASSWORD_RULES.requirements.map((rule, i) => (
          <span key={rule.id} className={`auth__bar${i < st.score ? ' is-on' : ''}`} />
        ))}
        {/* Never colour alone: the word carries the same meaning as the bars. */}
        <span
          className={`auth__strengthtag${st.tone === 'ok' ? '' : ` auth__strengthtag--${st.tone}`}`}
          aria-live="polite"
        >
          {st.label}
        </span>
      </div>
      {/* The gate, written out. `aria-live` is on the tag above rather than
          here: announcing five chips on every keystroke would make the field
          unusable with a screen reader, while the one-word verdict is exactly
          the running commentary that helps. */}
      <ul className="auth__reqs" data-testid="pw-requirements">
        {PASSWORD_RULES.requirements.map(rule => {
          const ok = met.includes(rule);
          return (
            <li key={rule.id} className={`auth__req${ok ? ' is-met' : ''}`}>
              {/* A word, not only a tick and a colour. */}
              <span className="auth__reqmark" aria-hidden="true">
                {ok ? <Tick size={10} width={3.2} /> : <span className="auth__reqdot" />}
              </span>
              <span>{rule.short}</span>
              <span className="sr-only">{ok ? ' — met' : ' — still needed'}</span>
            </li>
          );
        })}
      </ul>
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
 * The reference draws four strength bars with the caption "14 characters, mixed
 * case, one symbol". Both are kept, and both now read from `lib/password.js`:
 * one bar per rule in the policy, and a caption computed from the password
 * actually typed. A fixed caption under a live meter is the same class of lie
 * as a hardcoded workspace ID — and a meter scoring by its own private rule,
 * beside a button that accepted whatever it concluded, was the version of that
 * lie this file used to carry.
 */

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
    // The same rules Firebase will apply, applied before the round-trip rather
    // than after it. `summary` names what is outstanding; the checklist under
    // the field has been showing it since the first keystroke.
    const policy = checkPassword(pw);
    if (!policy.ok) next.pw = `${policy.summary}.`;
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
    <AuthSheet tab="signup">
      <Head title="Create your account" />

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

            {/* Both gates are real, and both are visible before they bite: the
                consent box is on screen, and the checklist above names every
                rule still outstanding. A button that is dim for a reason
                nobody can see is the version of this to avoid. */}
            <label className="auth__consent">
              <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
              <span className="auth__check"><Tick width={3.4} /></span>
              <span className="auth__consenttx">
                I agree to the <Link to="/terms">terms of service</Link> and{' '}
                <Link to="/docs#privacy">privacy policy</Link>
              </span>
            </label>

            <Submit
              busy={busy}
              busyText="Creating your account…"
              disabled={!agreed || !checkPassword(pw).ok}
            >
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
    <AuthSheet>
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
        <span className="auth__submittx">{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend email'}</span>
      </button>

      <Link to="/app" className="auth__ghost">
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
      <AuthSheet>
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
    <AuthSheet>
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
      <AuthSheet>
        <Head title="Set a new password" />
        <p className="auth__foot" style={{ marginTop: 0 }}>Checking your link…</p>
      </AuthSheet>
    );
  }

  if (!code || !valid) {
    return (
      <AuthSheet>
        <Head title="Set a new password" />
        <div role="alert" style={{ marginBottom: 'var(--s-6)' }}>
          <Alert tone="danger" title="This reset link is invalid or has expired." />
        </div>
        <Link to="/forgot-password" className="auth__submit">
          <span className="auth__submittx">Request a new link</span>
        </Link>
        <Alt prompt="Know your password?" to="/login" label="Back to log in" />
      </AuthSheet>
    );
  }

  const submit = async e => {
    e.preventDefault();
    const policy = checkPassword(pw);
    if (mismatch || !policy.ok) {
      setErr(
        mismatch
          ? 'Type the same password in both fields.'
          : `${policy.summary}.`
      );
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
    <AuthSheet>
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

        <Submit busy={busy} busyText="Saving…" disabled={mismatch || !checkPassword(pw).ok}>
          Update password
        </Submit>
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
      <AuthSheet tab="login">
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
    <AuthSheet tab="login">
      <Head title="Log in" />

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
