import { describe, expect, it } from "vitest";
import {
  ObjectKeyError,
  keyBelongsToWorkspace,
  objectKey,
  workspacePrefix,
} from "../src/storage/keys";
import {
  DOWNLOAD_URL_TTL_SECONDS,
  MAX_URL_TTL_SECONDS,
  PresignConfigError,
  UPLOAD_URL_TTL_SECONDS,
  presignDownload,
  presignUpload,
  readSigningConfig,
  redactPresigned,
} from "../src/storage/presign";
import { newId } from "../src/lib/ids";

const WS = newId("workspace");
const FILE = newId("file");

const config = {
  accountId: "0ec7524392f478e9e0fda7ad8eba364f",
  bucket: "agentdisk-dev-files",
  accessKeyId: "TESTACCESSKEYID",
  secretAccessKey: "TESTSECRETACCESSKEY",
};

describe("objectKey", () => {
  it("is built only from server-generated IDs", () => {
    expect(objectKey(WS, FILE)).toBe(`tenant/${WS}/${FILE}`);
  });

  it("cannot be steered by a client path", () => {
    // 06 PART 16.12: the whole point of the ID-based key is that a traversal
    // string in the client's `path` can only reach the display column. There is
    // no parameter here it could arrive through.
    expect(objectKey.length).toBe(2);
    expect(() => objectKey(WS, "../../etc/passwd")).toThrow(ObjectKeyError);
    expect(() => objectKey("../other-tenant", FILE)).toThrow(ObjectKeyError);
    expect(() => objectKey(WS, `${FILE}/../${FILE}`)).toThrow(ObjectKeyError);
  });

  it("rejects a malformed ID rather than building a key from it", () => {
    for (const bad of ["", "ws_short", "nope", "ws_" + "x".repeat(26), `${WS} `]) {
      expect(() => objectKey(bad, FILE), JSON.stringify(bad)).toThrow(ObjectKeyError);
    }
  });
});

describe("workspacePrefix", () => {
  it("ends with a separator, so one workspace cannot prefix-match another", () => {
    const prefix = workspacePrefix(WS);
    expect(prefix).toBe(`tenant/${WS}/`);
    expect(prefix.endsWith("/")).toBe(true);
  });

  it("recognises its own keys and no one else's", () => {
    const other = newId("workspace");
    expect(keyBelongsToWorkspace(objectKey(WS, FILE), WS)).toBe(true);
    expect(keyBelongsToWorkspace(objectKey(other, FILE), WS)).toBe(false);
  });
});

describe("presigning", () => {
  it("uses the expiries 12.2 and 12.3 specify", () => {
    expect(UPLOAD_URL_TTL_SECONDS).toBe(15 * 60);
    expect(DOWNLOAD_URL_TTL_SECONDS).toBe(60 * 60);
    expect(MAX_URL_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("scopes an upload URL to one key and one method", async () => {
    const key = objectKey(WS, FILE);
    const url = new URL(await presignUpload(config, key));

    expect(url.host).toBe(`${config.accountId}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${config.bucket}/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(UPLOAD_URL_TTL_SECONDS));
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // The credential scope must name R2's pseudo-region, not a real AWS one.
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");
    // The secret must never travel in the URL - only a signature derived from it.
    expect(url.href).not.toContain(config.secretAccessKey);
  });

  it("signs GET and PUT differently, so an upload URL cannot read", async () => {
    const key = objectKey(WS, FILE);
    const put = new URL(await presignUpload(config, key));
    const get = new URL(await presignDownload(config, key));

    expect(put.searchParams.get("X-Amz-Signature")).not.toBe(
      get.searchParams.get("X-Amz-Signature")
    );
  });

  it("signs each key differently, so one URL cannot reach another object", async () => {
    const a = new URL(await presignUpload(config, objectKey(WS, FILE)));
    const b = new URL(await presignUpload(config, objectKey(WS, newId("file"))));
    expect(a.searchParams.get("X-Amz-Signature")).not.toBe(b.searchParams.get("X-Amz-Signature"));
  });

  it("refuses an expiry beyond the 7-day cap 12.4 sets", async () => {
    await expect(presignUpload(config, objectKey(WS, FILE), MAX_URL_TTL_SECONDS + 1)).rejects.toThrow(
      PresignConfigError
    );
    await expect(presignUpload(config, objectKey(WS, FILE), 0)).rejects.toThrow(PresignConfigError);
  });
});

describe("readSigningConfig", () => {
  it("returns null when presigning is simply not configured", () => {
    expect(readSigningConfig({})).toBe(null);
  });

  it("returns null when the identifiers are set but neither credential is", () => {
    // The normal state of a deployment without a signing token. CI always
    // injects R2_ACCOUNT_ID and R2_BUCKET_NAME from `terraform output`, so
    // treating their presence as half-configured would make every ordinary
    // no-signing deploy look broken - and, because this is read on the request
    // path, would 500 every route rather than just the presign ones.
    expect(
      readSigningConfig({ R2_ACCOUNT_ID: "x", R2_BUCKET_NAME: "y" })
    ).toBe(null);
  });

  it("throws when one credential is set without the other, naming what is missing", () => {
    // Half-configured and not-configured are different bugs and must not look
    // the same: one is a deploy that forgot a secret, the other is by design.
    try {
      readSigningConfig({ R2_ACCOUNT_ID: "x", R2_BUCKET_NAME: "y", R2_ACCESS_KEY_ID: "c" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PresignConfigError);
      expect((err as Error).message).toContain("R2_SECRET_ACCESS_KEY");
    }
  });

  it("throws when credentials are set but the endpoint identifiers are not", () => {
    try {
      readSigningConfig({ R2_ACCESS_KEY_ID: "c", R2_SECRET_ACCESS_KEY: "d" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PresignConfigError);
      expect((err as Error).message).toContain("R2_ACCOUNT_ID");
      expect((err as Error).message).toContain("R2_BUCKET_NAME");
    }
  });

  it("returns the config when it is complete", () => {
    expect(
      readSigningConfig({
        R2_ACCOUNT_ID: "a",
        R2_BUCKET_NAME: "b",
        R2_ACCESS_KEY_ID: "c",
        R2_SECRET_ACCESS_KEY: "d",
      })
    ).toEqual({ accountId: "a", bucket: "b", accessKeyId: "c", secretAccessKey: "d" });
  });
});

describe("redactPresigned", () => {
  it("keeps which object, drops the capability", async () => {
    const url = await presignUpload(config, objectKey(WS, FILE));
    const redacted = redactPresigned(url);

    expect(redacted).toContain(FILE);
    expect(redacted).not.toContain("X-Amz-Signature");
    expect(redacted).not.toContain(config.accessKeyId);
  });

  it("does not throw on something that is not a URL", () => {
    expect(redactPresigned("nonsense")).toBe("<unparseable url>");
  });
});
