/**
 * Nothing this Worker serves is for a search engine — in any environment.
 *
 * The API answers JSON to credentials, `/mcp` answers a protocol, and the
 * share-link pages exist for whoever holds the link. None of that belongs in a
 * search index, and the dev deployment least of all: `api-dev.agentdisk.io`
 * and `mcp-dev.agentdisk.io` are the same Worker on public hostnames, and a
 * crawler that finds them lists a staging backend beside the product.
 *
 * Two mechanisms, because they cover different crawlers. `robots.txt` asks
 * well-behaved crawlers not to fetch anything; the `X-Robots-Tag` header tells
 * one that fetched anyway not to index what it got. Neither depends on
 * `ENVIRONMENT`, deliberately — a Worker whose indexability is a variable is a
 * Worker that gets indexed the day the variable is mistyped.
 *
 * The dashboard carries the same pair, generated per environment by
 * `apps/web/scripts/security-headers.js`, because the dashboard's marketing
 * pages *should* be found in prod. There is no such exception here.
 */

/** The value every response carries. */
export const X_ROBOTS_TAG = "noindex, nofollow";

/** The body of `GET /robots.txt`. */
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

/**
 * Rebuild the response with the header attached. Rebuilt rather than mutated
 * for the reason `withCorsHeaders` gives: a constructed Response's headers are
 * immutable on some paths.
 */
export function withNoIndex(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", X_ROBOTS_TAG);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** `GET /robots.txt`, public and credential-free like `/v1/healthz`. */
export function robotsTxtResponse(): Response {
  return new Response(ROBOTS_TXT, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
