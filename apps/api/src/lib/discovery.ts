/**
 * What an agent finds when it lands on the API host with nothing but a URL.
 *
 * Skill 12, F19. `GET /` used to be a JSON 404 and `openapi.json` did not
 * exist on this host, so a first-time agent that probed the API before the
 * site had no way to learn a request shape except by guessing. The documents
 * themselves (OpenAPI, auth.md, llms.txt, the API catalog) are written by the
 * site build from one generator, apps/web/scripts/agent-discovery.js. This
 * host does not carry a second copy that could drift: it indexes them, and
 * redirects the two well-known paths to the site's copies.
 *
 * `siteUrl` is `SITE_URL` from wrangler.toml, the same place `DASHBOARD_URL`
 * lives; hostnames are never typed into code. Without it the index still
 * names this host's own routes and the redirects answer 404, as before.
 */

const SITE_PATHS = {
  openapi: "/openapi.json",
  apiCatalog: "/.well-known/api-catalog",
  llms: "/llms.txt",
  auth: "/auth.md",
  docs: "/docs",
  quickstart: "/docs/quickstart",
} as const;

function site(siteUrl: string | undefined, path: string): string | null {
  if (!siteUrl) return null;
  return `${siteUrl.replace(/\/+$/, "")}${path}`;
}

/** The JSON index served at `GET /`. Every URL is absolute, so it can be followed as-is. */
export function apiIndex(origin: string, siteUrl: string | undefined): Record<string, unknown> {
  return {
    name: "AgentDisk API",
    description:
      "File storage built for AI agents. REST under /v1 and MCP at /mcp on this host; every call " +
      "except the sandbox creation below carries Authorization: Bearer <api key>.",
    openapi: site(siteUrl, SITE_PATHS.openapi),
    apiCatalog: site(siteUrl, SITE_PATHS.apiCatalog),
    docs: {
      llms: site(siteUrl, SITE_PATHS.llms),
      auth: site(siteUrl, SITE_PATHS.auth),
      html: site(siteUrl, SITE_PATHS.docs),
      quickstart: site(siteUrl, SITE_PATHS.quickstart),
    },
    mcp: `${origin}/mcp`,
    health: `${origin}/v1/healthz`,
    sandbox: {
      method: "POST",
      url: `${origin}/v1/workspaces`,
      authentication: "none",
      body: "{} is enough; optional name and agentName",
      returns: "a workspace, its API key (shown once) and a one-time claim link for the person you work for",
    },
  };
}

/**
 * Where a well-known document lives, for `/openapi.json` and
 * `/.well-known/api-catalog` asked of this host. Null when there is no site
 * configured or the path is not one of the two.
 */
export function discoveryRedirect(pathname: string, siteUrl: string | undefined): string | null {
  if (pathname === SITE_PATHS.openapi || pathname === SITE_PATHS.apiCatalog) {
    return site(siteUrl, pathname);
  }
  return null;
}

/**
 * A 302 whose body also names the target, so a client that prints the body
 * without following redirects still learns where to go.
 */
export function redirectResponse(location: string): Response {
  return new Response(JSON.stringify({ location, message: `This document is published at ${location}.` }), {
    status: 302,
    headers: { location, "content-type": "application/json; charset=utf-8" },
  });
}
