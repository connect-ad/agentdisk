/**
 * Presigned R2 URLs - 05 PART 12.2 (upload), 12.3 (download), 12.4 (scope).
 *
 * R2 bindings cannot presign: the R2Bucket interface is get/put/head/list and
 * nothing else. Presigning needs R2's S3-compatible endpoint and an AWS SigV4
 * signature, which needs S3 credentials separate from the binding.
 *
 * The signing itself uses aws4fetch rather than hand-rolled SigV4. That is a
 * deliberate dependency: presigning is a cryptographic protocol where a subtle
 * canonicalization bug produces URLs that either silently fail or authorize
 * more than intended, and a 4 KB purpose-built library with wide production use
 * is lower risk than 120 hand-written lines of the same thing.
 *
 * Every URL this file produces is scoped to exactly one object key and exactly
 * one HTTP method, with a short expiry (16.16). None of them may ever be logged
 * in full (16.18) - only that one was issued, to whom, and when.
 */

import { AwsClient } from "aws4fetch";

/** 12.2: "a short expiry (default 15 minutes)". */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** 12.3: "default 1-hour expiry". */
export const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;

/**
 * 12.4 caps expiring share links at 7 days, "no longer-lived expiring links, to
 * bound exposure if a link leaks". Nothing this module issues may exceed it.
 */
export const MAX_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface R2SigningConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class PresignConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresignConfigError";
  }
}

/**
 * Read the signing config out of the environment, or say precisely what is
 * missing. Returns null rather than throwing when presigning is simply switched
 * off, so a caller can distinguish "this deployment has no presigning" from
 * "this deployment is half-configured", which are different bugs.
 *
 * The CREDENTIAL PAIR is what decides which of those it is, not the count of
 * set variables. R2_ACCOUNT_ID and R2_BUCKET_NAME are non-secret identifiers
 * that CI injects into wrangler.toml from `terraform output` on every deploy,
 * so they are present on any deployed Worker whether or not signing is set up.
 * Treating "identifiers present, credentials absent" as half-configured would
 * make the ordinary no-signing deployment look broken - and, because this is
 * read on the request path, would have turned that into a 500 on every route.
 */
export function readSigningConfig(env: {
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}): R2SigningConfig | null {
  const hasKeyId = Boolean(env.R2_ACCESS_KEY_ID);
  const hasSecret = Boolean(env.R2_SECRET_ACCESS_KEY);

  // Neither credential: presigning is off by configuration, which is a
  // supported state. The presign paths refuse; nothing else is affected.
  if (!hasKeyId && !hasSecret) return null;

  // Keyed by the environment variable name, not the config field name: whoever
  // reads this error has to go and set a variable, and "missing: accessKeyId"
  // makes them open the source to find out which one.
  const missing = Object.entries({
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_BUCKET_NAME: env.R2_BUCKET_NAME,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new PresignConfigError(`R2 presigning is half-configured; missing: ${missing.join(", ")}`);
  }

  return {
    accountId: env.R2_ACCOUNT_ID as string,
    bucket: env.R2_BUCKET_NAME as string,
    accessKeyId: env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
  };
}

function endpoint(config: R2SigningConfig, key: string): URL {
  // R2's S3 endpoint. Each key segment is encoded separately: encodeURIComponent
  // would escape the slashes that make it a path.
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return new URL(`https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${encoded}`);
}

function client(config: R2SigningConfig): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    // R2 has no regions; "auto" is what its S3 API expects in the credential scope.
    region: "auto",
  });
}

async function sign(
  config: R2SigningConfig,
  key: string,
  method: "PUT" | "GET",
  ttlSeconds: number
): Promise<string> {
  if (ttlSeconds <= 0 || ttlSeconds > MAX_URL_TTL_SECONDS) {
    throw new PresignConfigError(
      `Refusing to sign a URL valid for ${ttlSeconds}s; the cap is ${MAX_URL_TTL_SECONDS}s.`
    );
  }

  const url = endpoint(config, key);
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));

  const signed = await client(config).sign(new Request(url, { method }), {
    aws: { signQuery: true },
  });

  return signed.url;
}

/** A URL that can PUT exactly this key, and nothing else, for 15 minutes. */
export function presignUpload(
  config: R2SigningConfig,
  key: string,
  ttlSeconds = UPLOAD_URL_TTL_SECONDS
): Promise<string> {
  return sign(config, key, "PUT", ttlSeconds);
}

/** A URL that can GET exactly this key, and nothing else, for an hour. */
export function presignDownload(
  config: R2SigningConfig,
  key: string,
  ttlSeconds = DOWNLOAD_URL_TTL_SECONDS
): Promise<string> {
  return sign(config, key, "GET", ttlSeconds);
}

/**
 * A presigned URL with its query string removed, safe to put in a log line.
 *
 * 16.18 forbids logging one in full: the signature *is* the credential, so a
 * logged URL is a logged capability. This keeps the part that identifies which
 * object was involved and drops the part that grants access to it.
 */
export function redactPresigned(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}?<signature redacted>`;
  } catch {
    return "<unparseable url>";
  }
}
