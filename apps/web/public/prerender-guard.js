/*
 * Hide prerendered markup that does not belong to this URL, before first paint.
 *
 * dist/index.html carries the prerendered landing page, and it is also the
 * SPA fallback for every deep link - /login, /w/acme/files, a refresh anywhere
 * in the dashboard. Without this, each of those would paint the homepage for
 * the few hundred milliseconds before React mounts and replaces it.
 *
 * Runs synchronously from <head>, so it settles before the body renders. It
 * only sets an attribute; app.css hides `[data-prerendered]` under it, and
 * React's first commit discards that element anyway, so nothing needs undoing.
 *
 * A plain script rather than an inline one because the Content-Security-Policy
 * allows 'self' for scripts and nothing inline. Kept dependency-free and
 * pre-ES2015 on purpose: it must run in whatever fetched the page.
 */
(function () {
  var meta = document.querySelector('meta[name="agentdisk:prerendered"]');
  if (!meta) return;
  var path = location.pathname.replace(/\/+$/, '') || '/';
  // The homepage on the app host is a redirect into the app (App.jsx `Home`),
  // so its prerendered markup would only flash. `agentdisk:site-host` is
  // written by the build when the bundle is split across two hostnames.
  var site = document.querySelector('meta[name="agentdisk:site-host"]');
  var elsewhere = site && path === '/' && location.hostname !== site.content;
  if (path !== meta.content || elsewhere) {
    document.documentElement.setAttribute('data-prerender', 'skip');
  }
})();
