/**
 * Which hostname is this, and where do the other pages live?
 *
 * The marketing site and the dashboard are one bundle on two hostnames (see
 * worker.js at the package root). The Worker handles the first request; this
 * module handles what the SPA does after it has loaded - which host it is on,
 * and where a link to the other side should go.
 *
 * Both hostnames come from the build (`VITE_SITE_HOST`, `VITE_APP_HOST`),
 * which CI sets from the same environment variables it asserts the Terraform
 * custom domains against. Unset, or the same value, means single-host mode:
 * every route renders wherever it is, which is what `npm run dev`, the tests
 * and the harness see. Everything here reads the environment at call time
 * rather than at import, so a test can set it per case.
 *
 * Nothing touches `window` at module scope: the prerender imports this
 * through App.jsx under Node.
 */

/** `{ siteHost, appHost, siteOrigin, appOrigin }` when the build is split across two hosts, else null. */
export function splitHosts() {
  const siteHost = import.meta.env.VITE_SITE_HOST;
  const appHost = import.meta.env.VITE_APP_HOST;
  if (!siteHost || !appHost || siteHost === appHost) return null;
  return { siteHost, appHost, siteOrigin: `https://${siteHost}`, appOrigin: `https://${appHost}` };
}

/** The hostname the page is running on, or '' outside a browser. */
export function currentHost() {
  return typeof window === 'undefined' ? '' : window.location.hostname;
}

/** True when this is the marketing host of a split build. */
export function onSiteHost(host = currentHost()) {
  const split = splitHosts();
  return split !== null && host === split.siteHost;
}

/**
 * True when this is the app host of a split build.
 *
 * Only the app host itself, not "anything that is not the site": a build
 * split for app-dev.agentdisk.io that is opened on localhost should behave
 * like the single-host product it is being developed as.
 */
export function onAppHost(host = currentHost()) {
  const split = splitHosts();
  return split !== null && host === split.appHost;
}

/** An absolute URL into the app when on the site host, else the path itself. */
export function appUrl(path, host = currentHost()) {
  return onSiteHost(host) ? `${splitHosts().appOrigin}${path}` : path;
}

/** An absolute URL into the marketing site when on the app host, else the path itself. */
export function siteUrl(path, host = currentHost()) {
  return onAppHost(host) ? `${splitHosts().siteOrigin}${path}` : path;
}
