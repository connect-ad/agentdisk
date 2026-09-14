import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Input, Button, Icon, Alert, Meter } from '../components/index.js';
import { useAuth, describeAuthError } from '../lib/auth.jsx';
import Logo from '../components-local/Logo.jsx';

/**
 * 8.3 Signup · 8.4 Email Verification · 8.5 Forgot Password ·
 * 8.6 Reset Password · 8.7 Login.
 *
 * The layout and copy are unchanged from the original design; what moved is the
 * thing behind them — Firebase now issues and verifies every credential (doc 16
 * PART 30), and this app never sees a password.
 *
 * Security behaviour the copy exists to enforce (doc 06 PART 16), all of which
 * survives the move and one of which Firebase would otherwise break:
 *  - Login failure is generic. Firebase distinguishes `user-not-found` from
 *    `wrong-password`; surfacing that turns this form into an oracle for
 *    whether an address has an account here, so `describeAuthError` collapses
 *    them into one message.
 *  - Forgot-password shows an identical success whether or not the account
 *    exists — so the screen never awaits a per-address answer.
 *  - Repeated failure locks out with a visible countdown; that limit is
 *    Firebase's own (`auth/too-many-requests`), not a number this client
 *    invented and could be talked out of.
 *
 * Google and GitHub ship alongside email rather than in a later tier: Firebase
 * makes them equally cheap, so staging them would be an arbitrary restriction.
 */

function AuthShell({ title, subtitle, children, footer, legal }) {
  return (
    <div className="auth">
      <div className="auth__inner">
        <Link to="/" className="auth__brand">
          <Logo size={26} />
          <span className="auth__wordmark">AgentDisk</span>
        </Link>
        <div className="auth__card">
          <div>
            <h1 className="auth__h1">{title}</h1>
            {subtitle ? <p className="auth__sub" style={{ marginTop: 'var(--s-2)' }}>{subtitle}</p> : null}
          </div>
          {children}
        </div>
        {legal ? <p className="auth__legal">{legal}</p> : null}
        {footer ? <p className="auth__foot">{footer}</p> : null}
      </div>
    </div>
  );
}

/** Where to land after signing in, preserving wherever they were headed. */
function useAfterSignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  return () => navigate(location.state?.from ?? '/app', { replace: true });
}

/** Google and GitHub, plus the rule that separates them from the form below. */
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <Button
        variant="secondary"
        full
        disabled={disabled || busy !== null}
        loading={busy === 'google'}
        onClick={() => run('google', signInWithGoogle)}
      >
        Continue with Google
      </Button>
      <Button
        variant="secondary"
        full
        disabled={disabled || busy !== null}
        loading={busy === 'github'}
        onClick={() => run('github', signInWithGithub)}
      >
        Continue with GitHub
      </Button>
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--s-3)',
        color: 'var(--ink-3)', fontSize: 'var(--t-12)'
      }}
    >
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} aria-hidden="true" />
      or
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} aria-hidden="true" />
    </div>
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

function strengthOf(pw) {
  if (!pw) return { score: 0, label: '' };
  let s = 0;
  if (pw.length >= 8) s += 1;
  if (pw.length >= 12) s += 1;
  if (/[0-9]/.test(pw) || /[^A-Za-z0-9]/.test(pw)) s += 1;
  return { score: s, label: s <= 1 ? 'Weak' : s === 2 ? 'Good' : 'Strong' };
}

export function Signup() {
  const navigate = useNavigate();
  const afterSignIn = useAfterSignIn();
  const { signUpWithPassword, configured } = useAuth();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const st = strengthOf(pw);

  const submit = async e => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setErr('Please enter a valid email address.'); return; }
    if (pw.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setErr(null); setBusy(true);
    try {
      await signUpWithPassword(email, pw);
      navigate('/verify-email');
    } catch (error) {
      setErr(describeAuthError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your workspace"
      legal={<>By continuing, you agree to the <Link to="/terms">Terms of Service</Link> and <Link to="/privacy">Privacy Policy</Link>.</>}
      footer={<>Already have an account? <Link to="/login">Sign in</Link></>}
    >
      {err ? <div role="alert"><Alert tone="danger" title={err} /></div> : null}
      {!configured ? <NotConfigured /> : (
        <>
          <ProviderButtons disabled={busy} onError={setErr} onDone={afterSignIn} />
          <Divider />
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
            <Input label="Email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
              <Input
                label="Password"
                type="password"
                required
                value={pw}
                onChange={e => setPw(e.target.value)}
                hint="At least 8 characters, with a number or symbol."
              />
              {pw ? (
                <>
                  <Meter value={st.score} max={3} label={`Password strength: ${st.label}`} />
                  {/* Text equivalent, announced politely — never colour/bar alone. */}
                  <span className="ad-meta" aria-live="polite">{st.label}</span>
                </>
              ) : null}
            </div>
            <Button type="submit" full loading={busy}>{busy ? 'Creating account…' : 'Create account'}</Button>
          </form>
        </>
      )}
    </AuthShell>
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
    <AuthShell
      title="Check your inbox"
      subtitle={
        user?.email
          ? <>We sent a verification link to <strong>{user.email}</strong>. Click it to activate your workspace.</>
          : <>We sent you a verification link. Click it to activate your workspace.</>
      }
      footer={<>Wrong email? <Link to="/signup">Start over</Link></>}
    >
      {err ? <div role="alert"><Alert tone="danger" title={err} /></div> : null}
      <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--s-6) 0' }}>
        <span style={{
          width: 40, height: 40, borderRadius: 'var(--r-3)', display: 'grid', placeItems: 'center',
          border: '1px solid var(--accent-line)', background: 'var(--accent-soft)', color: 'var(--accent-ink)'
        }}>
          <Icon name="link" size={19} />
        </span>
      </div>
      <Button variant="secondary" full disabled={cooldown > 0} onClick={resend}>
        {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend email'}
      </Button>
      {/* Announced at most occasionally, not every tick — avoids screen-reader spam. */}
      <span className="ad-meta" aria-live="polite" style={{ textAlign: 'center' }}>
        {cooldown > 0 && cooldown % 10 === 0 ? `Resend available in ${cooldown} seconds` : ''}
      </span>
      <p className="auth__foot"><Link to="/app">Continue to the dashboard</Link></p>
    </AuthShell>
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
      <AuthShell title="Reset your password" footer={<Link to="/login">Back to sign in</Link>}>
        {/* Deliberately non-committal: identical whether or not the account exists. */}
        <div role="status">
          <Alert tone="ok" title="Check your inbox">
            If an account exists for <strong>{email}</strong>, we've sent a password reset link.
          </Alert>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter the email on your account and we'll send a reset link."
      footer={<Link to="/login">Back to sign in</Link>}
    >
      {!configured ? <NotConfigured /> : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
          <Input label="Email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
          <Button type="submit" full loading={busy}>{busy ? 'Sending…' : 'Send reset link'}</Button>
        </form>
      )}
    </AuthShell>
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const mismatch = confirm.length > 0 && confirm !== pw;

  useEffect(() => {
    if (!code) { setChecking(false); return; }
    let cancelled = false;
    verifyResetCode(code)
      .then(() => { if (!cancelled) setValid(true); })
      .catch(() => { if (!cancelled) setValid(false); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [code, verifyResetCode]);

  if (checking) {
    return <AuthShell title="Set a new password"><p className="ad-meta">Checking your link…</p></AuthShell>;
  }

  if (!code || !valid) {
    return (
      <AuthShell title="Set a new password">
        <Alert tone="danger" title="This reset link is invalid or has expired." />
        <Button full as={Link} to="/forgot-password">Request a new link</Button>
      </AuthShell>
    );
  }

  const submit = async e => {
    e.preventDefault();
    if (mismatch || pw.length < 8) { setErr('Password must be at least 8 characters.'); return; }
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
    <AuthShell title="Set a new password" footer={<Link to="/login">Back to sign in</Link>}>
      {err ? <div role="alert"><Alert tone="danger" title={err} /></div> : null}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
        <Input label="New password" type="password" required value={pw} onChange={e => setPw(e.target.value)}
          hint="At least 8 characters, with a number or symbol." />
        <Input
          label="Confirm new password"
          type="password"
          required
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          error={mismatch ? "Those passwords don't match." : undefined}
        />
        <Button type="submit" full loading={busy} disabled={mismatch}>Update password</Button>
      </form>
    </AuthShell>
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
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setErr('Enter your email address first, and we will send you a sign-in link.');
      return;
    }
    setErr(null); setBusy(true);
    try {
      await sendEmailLink(email);
      setLinkSent(true);
    } catch (error) {
      setErr(describeAuthError(error));
    } finally {
      setBusy(false);
    }
  };

  if (linkSent) {
    return (
      <AuthShell title="Check your inbox" footer={<Link to="/login">Back to sign in</Link>}>
        <div role="status">
          <Alert tone="ok" title="Sign-in link sent">
            We sent a one-time sign-in link to <strong>{email}</strong>. Open it on this device.
          </Alert>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Sign in" footer={<>New here? <Link to="/signup">Create your workspace</Link></>}>
      {err ? (
        <div role="alert">
          {/* Generic on purpose — never distinguishes bad password from unknown account. */}
          <Alert tone="danger" title={err}>
            <Link to="/forgot-password">Forgot password?</Link>
          </Alert>
        </div>
      ) : null}

      {needsAddress ? (
        <div role="status">
          <Alert tone="warn" title="Confirm your email">
            This link was requested in another browser. Enter the address you asked for it with.
          </Alert>
        </div>
      ) : null}

      {!configured ? <NotConfigured /> : (
        <>
          <ProviderButtons disabled={busy} onError={setErr} onDone={afterSignIn} />
          <Divider />
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
            <Input label="Email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
            {!needsAddress ? (
              <Input label="Password" type="password" required value={pw} onChange={e => setPw(e.target.value)} />
            ) : null}
            <Button type="submit" full loading={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          </form>
          <Button variant="ghost" full disabled={busy} onClick={emailLink}>
            Email me a sign-in link instead
          </Button>
        </>
      )}
      <p className="auth__foot"><Link to="/forgot-password">Forgot password?</Link></p>
    </AuthShell>
  );
}
