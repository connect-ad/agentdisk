/**
 * Workspace-scoped object storage - the R2 counterpart to db/workspace-scoped.ts,
 * and it exists for exactly the same reason.
 *
 * A raw R2Bucket binding can read, overwrite and delete any object in the
 * bucket, which means every tenant's bytes. Handing one to a route handler would
 * undo on the storage side the isolation guarantee 06 PART 16.1 establishes on
 * the database side: it would make cross-tenant access something a handler has
 * to remember not to do, rather than something it cannot express.
 *
 * So the same invariant applies here. The workspace ID is bound in the
 * CONSTRUCTOR. Every method takes a file ID and derives the object key itself
 * through storage/keys.ts; no method accepts an object key, and no method
 * accepts a workspace ID. A handler holding this class cannot name an object
 * outside its own tenant prefix, because there is no argument through which to
 * say one.
 *
 * Rules for anyone editing this file:
 *   - never add a method that accepts a workspaceId or a raw object key
 *   - never expose the R2 binding or the signing credentials
 *   - never log a presigned URL without redactPresigned() (16.18)
 */

import { ApiError } from "../lib/errors";
import { objectKey, workspacePrefix } from "./keys";
import {
  presignDownload,
  presignUpload,
  type R2SigningConfig,
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
} from "./presign";

/**
 * 05 PART 10.4: files at or below 1 MB may be sent inline as base64 in the
 * create call, and the Worker writes them through the binding. Above it, the
 * bytes go direct to R2 and never touch the Worker.
 */
export const MAX_INLINE_BYTES = 1024 * 1024;

export interface PutOptions {
  contentType: string;
  /**
   * Hex SHA-256 the client claims for these bytes. Passed to R2, which verifies
   * it and rejects the write on a mismatch - so a corrupted or tampered body is
   * refused by storage itself rather than by a comparison we would have to
   * remember to write.
   */
  sha256?: string | undefined;
}

/**
 * How the signing credentials are obtained.
 *
 * A thunk rather than a value so that reading them is deferred to the routes
 * that actually presign. Reading eagerly on every request meant a
 * half-configured deployment returned 500 for `whoami` and every other route
 * that has nothing to do with R2 - one broken variable taking down the whole
 * API instead of one feature.
 */
export type SigningSource = R2SigningConfig | null | (() => R2SigningConfig | null);

export class WorkspaceScopedStorage {
  private resolved: R2SigningConfig | null | undefined;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly signing: SigningSource,
    private readonly workspaceId: string
  ) {
    if (!workspaceId) {
      throw new Error("WorkspaceScopedStorage constructed without a workspace ID.");
    }
  }

  /** The only place a key is built, and it is built from the bound workspace. */
  private key(fileId: string): string {
    return objectKey(this.workspaceId, fileId);
  }

  /**
   * The key to store on the file row, for this workspace's file.
   *
   * Exposed because `files.r2_object_key` has to hold it, and the alternative -
   * letting the route call objectKey(ctx.workspaceId, id) itself - would put
   * key construction back in handler code, which is exactly what this class
   * exists to prevent. Here the workspace half still cannot be chosen.
   */
  objectKeyFor(fileId: string): string {
    return this.key(fileId);
  }

  /**
   * Resolve once per request. A thunk that throws (half-configured) throws
   * here, at the point where a presigned URL was actually wanted.
   */
  private config(): R2SigningConfig | null {
    if (this.resolved === undefined) {
      this.resolved = typeof this.signing === "function" ? this.signing() : this.signing;
    }
    return this.resolved;
  }

  /** Whether this deployment can issue presigned URLs at all. */
  get canPresign(): boolean {
    return this.config() !== null;
  }

  private requireSigning(): R2SigningConfig {
    const config = this.config();
    if (config === null) {
      // A deployment-level gap, not a caller mistake, so it says so plainly
      // rather than blaming the request. Fails closed: no fallback to proxying
      // bytes through the Worker, which would quietly change the egress and
      // CPU profile the design rejected in 10.4.
      throw new ApiError(
        "INTERNAL_ERROR",
        "Direct uploads and downloads are not available on this deployment.",
        { internalReason: "R2 signing credentials are not configured" }
      );
    }
    return config;
  }

  /** A URL that can PUT exactly this file's object, and nothing else. */
  uploadUrl(fileId: string, ttlSeconds = UPLOAD_URL_TTL_SECONDS): Promise<string> {
    return presignUpload(this.requireSigning(), this.key(fileId), ttlSeconds);
  }

  /** A URL that can GET exactly this file's object, and nothing else. */
  downloadUrl(fileId: string, ttlSeconds = DOWNLOAD_URL_TTL_SECONDS): Promise<string> {
    return presignDownload(this.requireSigning(), this.key(fileId), ttlSeconds);
  }

  /** Write bytes through the binding. Used only by the inline path (10.4). */
  async put(fileId: string, body: ArrayBuffer, options: PutOptions): Promise<void> {
    await this.bucket.put(this.key(fileId), body, {
      httpMetadata: { contentType: options.contentType },
      ...(options.sha256 === undefined ? {} : { sha256: options.sha256 }),
    });
  }

  /**
   * What R2 actually holds. This is how `complete` learns the real byte count
   * rather than believing the client's claim about a body it never saw.
   */
  async head(fileId: string): Promise<{ size: number; etag: string } | null> {
    const object = await this.bucket.head(this.key(fileId));
    if (object === null) return null;
    return { size: object.size, etag: object.etag };
  }

  /**
   * Duplicate one file's object into another file's key.
   *
   * Streamed, not buffered: a copy must not be bounded by how much of a file
   * fits in a Worker's memory. R2's binding has no server-side copy, so this
   * is a read of one key piped into a write of another - both keys derived
   * from this workspace, so a copy can never cross a tenant boundary in either
   * direction.
   */
  async copy(fromFileId: string, toFileId: string): Promise<void> {
    const source = await this.bucket.get(this.key(fromFileId));
    if (source === null) {
      throw new ApiError("CONFLICT", "This file's contents are no longer available.", {
        internalReason: `copy source object missing for ${fromFileId}`,
      });
    }
    await this.bucket.put(this.key(toFileId), source.body, {
      httpMetadata: source.httpMetadata,
    });
  }

  async delete(fileId: string): Promise<void> {
    await this.bucket.delete(this.key(fileId));
  }

  /**
   * Every object belonging to this workspace. For workspace deletion and the
   * reconciliation sweep (10.8) - both of which need a prefix, and neither of
   * which may be handed one for a workspace other than this.
   */
  prefix(): string {
    return workspacePrefix(this.workspaceId);
  }
}
