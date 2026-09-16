import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '../components/index.js';
import { useAuth } from '../lib/auth.jsx';
import { Nav, Footer } from './Marketing.jsx';

/**
 * The error surface — 8.27 404 · 8.28 403 · 8.29 500 · 8.30 Maintenance, plus
 * the six the design adds.
 *
 * Rebuilt to `AgentDisk Site.dc.html`, which draws ten codes in a two-column
 * layout: code chip, family, title, body, a two-row fact box, optional spinner
 * note and two actions on the left; a "where to go instead" list on the right.
 *
 * ── Two rules the design's data does not follow, and this does ────────────
 *
 * **Fact boxes carry real values or nothing.** The design fills them with
 * mockup account data — "Signed in as rina@kesslerlabs.dev", a reference ID of
 * 9f2c41ab7de04c18, an invented URL. Rendering those would be showing a person
 * somebody else's session as if it were their own. Rows resolve from real state
 * where it exists (404 shows the path that actually failed, 403 the address you
 * are actually signed in as) and are dropped where it does not.
 *
 * **Links go somewhere or are not rendered.** The design lists three related
 * links per code, several of which — "Contact support", "Request access",
 * "Status page" — name pages this product does not have. A list of dead links
 * on an error page is a second dead end, so only entries with a real
 * destination survive. That is why some codes show fewer than three.
 */

/** Where each related link actually goes. Anything absent is not rendered. */
const DEST = {
  home: '/',
  pricing: '/pricing',
  docs: '/docs',
  login: '/login',
  signup: '/signup',
  reset: '/forgot-password',
  app: '/app',
  privacy: '/privacy',
  terms: '/terms',
};

const ERRORS = {
  '301': {
    family: 'REDIRECT', tone: 'info',
    title: 'This page has moved',
    body: 'We reorganised the documentation. You will be sent to the new location in a moment — update your bookmark while you are here.',
    cta: { label: 'Go to the new page', to: DEST.docs },
    alt: { label: 'Browse all docs', to: DEST.docs },
    timer: 'Redirecting automatically in a moment',
    links: [
      { label: 'Documentation', note: 'Guides and API reference', to: DEST.docs },
      { label: 'Pricing', note: 'Every plan on one page', to: DEST.pricing },
    ],
  },
  '304': {
    family: 'REDIRECT', tone: 'info',
    title: "You're already up to date",
    body: 'Nothing on this page has changed since you last loaded it, so your cached copy was served. If something still looks stale, force a refresh.',
    cta: { label: 'Force refresh', reload: true },
    alt: { label: 'Back to home', to: DEST.home },
    links: [
      { label: 'Documentation', note: 'See what changed recently', to: DEST.docs },
    ],
  },
  '400': {
    family: 'CLIENT', tone: 'warn',
    title: 'That link looks malformed',
    body: "Part of the address could not be read — usually a truncated link from an email client, or a stray character pasted at the end.",
    cta: { label: 'Back to home', to: DEST.home },
    alt: { label: 'Read the docs', to: DEST.docs },
    links: [
      { label: 'Documentation home', note: 'Start from the top', to: DEST.docs },
      { label: 'Pricing', note: 'Every plan on one page', to: DEST.pricing },
    ],
  },
  '401': {
    family: 'CLIENT', tone: 'warn',
    title: 'Please sign in to continue',
    body: "This page is part of the dashboard. Your session expired, or you opened the link on a device you haven't signed in on.",
    cta: { label: 'Log in', to: DEST.login },
    alt: { label: 'Create an account', to: DEST.signup },
    links: [
      { label: 'Log in', note: 'Sessions last 12 hours', to: DEST.login },
      { label: 'Reset your password', note: "If you've lost access", to: DEST.reset },
    ],
  },
  '403': {
    family: 'CLIENT', tone: 'warn',
    title: "You don't have access to this",
    body: "You're signed in, but this workspace isn't one of yours. Ask an owner to invite you, or switch to a workspace you belong to.",
    cta: { label: 'Switch workspace', to: DEST.app },
    alt: { label: 'Back to home', to: DEST.home },
    links: [
      { label: 'Your workspaces', note: 'The ones you can open right now', to: DEST.app },
      { label: 'Documentation', note: 'How members and roles work', to: DEST.docs },
    ],
  },
  '404': {
    family: 'CLIENT', tone: 'warn',
    title: "We couldn't find that page",
    body: 'The address is valid but nothing lives there. It may have been renamed, or the link that brought you here is out of date.',
    cta: { label: 'Back to home', to: DEST.home },
    alt: { label: 'Search the docs', to: DEST.docs },
    links: [
      { label: 'Pricing', note: 'Every plan on one page', to: DEST.pricing },
      { label: 'Documentation', note: 'Guides and API reference', to: DEST.docs },
    ],
  },
  '410': {
    family: 'CLIENT', tone: 'warn',
    title: 'This page was retired',
    body: "This page was removed and isn't coming back. There may be no direct replacement for what was here.",
    cta: { label: 'Read the docs', to: DEST.docs },
    alt: { label: 'Back to home', to: DEST.home },
    links: [
      { label: 'Documentation', note: 'Current and supported', to: DEST.docs },
    ],
  },
  '429': {
    family: 'CLIENT', tone: 'warn',
    title: 'Too many requests from this browser',
    body: 'You have hit the per-minute limit for anonymous page loads. It clears on its own in a few seconds — no action needed.',
    cta: { label: 'Try again', reload: true },
    alt: { label: 'Back to home', to: DEST.home },
    timer: 'Retrying automatically when the window resets',
    links: [
      { label: 'Documentation', note: 'How rate limits work', to: DEST.docs },
    ],
  },
  '500': {
    family: 'SERVER', tone: 'danger',
    title: 'Something went wrong on our end',
    body: "This wasn't caused by anything you did. The error is logged. If you contact us, quote the reference below.",
    cta: { label: 'Reload the page', reload: true },
    alt: { label: 'Back to home', to: DEST.home },
    links: [
      { label: 'Back to home', note: 'Try again from the start', to: DEST.home },
    ],
  },
  '503': {
    family: 'SERVER', tone: 'danger',
    title: "We're back shortly",
    body: 'Scheduled maintenance is in progress. The dashboard may be read-only and the site may be slow. Stored data is unaffected.',
    cta: { label: 'Try again', reload: true },
    alt: { label: 'Back to home', to: DEST.home },
    timer: 'This page refreshes itself periodically',
    links: [],
  },
};

/**
 * One layout, ten codes.
 *
 * `facts` is supplied per-route rather than baked into the table above,
 * because the interesting rows are the ones only the running app knows — the
 * path that actually failed, the address you are actually signed in as. A row
 * with no value is not rendered.
 */
export function ErrorPage({ code, facts = [], reference, onRetry }) {
  const e = ERRORS[code] || ERRORS['404'];
  const rows = facts.filter(f => f && f.value);

  const act = (spec, variant) => {
    if (!spec) return null;
    if (spec.reload) {
      return (
        <Button size="lg" variant={variant}
          onClick={onRetry || (() => window.location.reload())}>
          {spec.label}
        </Button>
      );
    }
    return <Button size="lg" variant={variant} as={Link} to={spec.to}>{spec.label}</Button>;
  };

  return (
    <div className="mk">
      <Nav />
      <div className="mk__wrap">
        <section className="err">
          <div className="err__main">
            <div className="err__codebar">
              <span className={`err__code err__code--${e.tone}`}>{code}</span>
              <span className="err__family">{e.family}</span>
            </div>
            <h1 className="err__title">{e.title}</h1>
            <p className="err__body">{e.body}</p>

            {rows.length > 0 ? (
              <div className="err__facts">
                {rows.map(f => (
                  <div key={f.value} className="err__fact">
                    <span className={`err__dot err__dot--${e.tone}`} aria-hidden="true" />
                    <span className="err__factval">{f.value}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {reference ? (
              <p className="err__ref">
                Reference <span className="ad-mono">{reference}</span>
              </p>
            ) : null}

            {e.timer ? (
              <p className="err__timer" role="status">
                <span className="err__spin" aria-hidden="true" />
                {e.timer}
              </p>
            ) : null}

            <div className="err__actions">
              {act(e.cta, 'primary')}
              {act(e.alt, 'secondary')}
            </div>
          </div>

          {e.links.length > 0 ? (
            <div className="err__side">
              <div className="err__panel">
                <div className="err__panelhead">WHERE TO GO INSTEAD</div>
                {e.links.map(l => (
                  <Link key={l.label} to={l.to} className="err__link">
                    <span className="err__linkbody">
                      <span className="err__linklabel">{l.label}</span>
                      <span className="err__linknote">{l.note}</span>
                    </span>
                    <span className="err__chev" aria-hidden="true">›</span>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>
      <Footer />
    </div>
  );
}

/* ── the routed pages ─────────────────────────────────────────────────────── */

export function NotFound({ echoPath = true }) {
  const { pathname } = useLocation();

  /**
   * The generic 404 shows the address that actually failed — useful when the
   * cause is a typo, and safe, because it is the reader's own input.
   *
   * `echoPath={false}` is for the workspace 404 in App.jsx, and it is a
   * security decision rather than a cosmetic one. That screen answers both
   * "no such workspace" and "that workspace exists but is not yours" with the
   * same page, so a stranger cannot use it to discover which workspace IDs are
   * real. The strongest form of that guarantee is that the two responses are
   * byte-identical, which a page containing *anything* derived from the
   * requested URL cannot be — and the address bar already shows it, so nothing
   * is lost by leaving it out.
   */
  const facts = echoPath
    ? [{ value: pathname }, { value: 'No page at this address' }]
    : [];

  return <ErrorPage code="404" facts={facts} />;
}

export function Forbidden() {
  const { user } = useAuth();
  return (
    <ErrorPage
      code="403"
      facts={[{ value: user?.email ? `Signed in as ${user.email}` : null }]}
    />
  );
}

export function ServerError({ onRetry, reference }) {
  // `reference` is only rendered when a real request ID is in scope. The
  // design shows one unconditionally; a fabricated reference sends somebody to
  // support with a number that matches no log line.
  return <ErrorPage code="500" reference={reference} onRetry={onRetry} />;
}

export function Maintenance() {
  return <ErrorPage code="503" />;
}

export function Gone() { return <ErrorPage code="410" />; }
export function BadRequest() { return <ErrorPage code="400" />; }
export function RateLimited() { return <ErrorPage code="429" />; }
export function NotModified() { return <ErrorPage code="304" />; }
export function MovedPermanently() { return <ErrorPage code="301" />; }

export function Unauthorized() {
  const { pathname } = useLocation();
  return <ErrorPage code="401" facts={[{ value: pathname }]} />;
}
