/**
 * `POST /v1/support` — the dashboard's Support form, end to end through the
 * real Worker with a real RSA-signed Firebase token and the EMAIL binding
 * stubbed.
 *
 * What is pinned: who may send (a person, never a key), what the message
 * carries (the *verified* address, the topic as the screen words it, the
 * workspace), where it goes and who it comes from, and that a failed send is a
 * failure rather than a 200 — the `backlog/023` rule, at its most important on
 * the one screen people reach when something is already wrong.
 */

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, ORG_ID, WORKSPACE_A, WORKSPACE_B, seedApiKey, seedTwoWorkspaces } from "./helpers";
import { SUPPORT_INBOX, SUPPORT_SENDER } from "../src/lib/email";

const URL_BASE = "https://api-dev.agentdisk.io";
const PROJECT_ID = "agentdisk-dev";
const KID = "support-test-key";
const USER = "usr_SUPPORTUSER";
const USER_UID = "firebase-uid-support-user";
const USER_EMAIL = "rina@kesslerlabs.dev";

type TestJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
let privateKey: CryptoKey;
let publicJwk: TestJwk;

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function seg(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}
async function mint(uid: string, email: string): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: KID, typ: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: uid,
    iat: seconds,
    exp: seconds + 3600,
    email,
    email_verified: true,
    firebase: { sign_in_provider: "password" },
  };
  const input = `${seg(header)}.${seg(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

/** A message as the Worker handed it to the EMAIL binding. */
interface Sent {
  from: { email: string; name: string };
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}

/** The one message a test expects to have been handed to the binding. */
function only(sent: Sent[]): Sent {
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

function stubEmail(outcome: "accepted" | "rejected" = "accepted"): { sent: Sent[] } {
  const sent: Sent[] = [];
  vi.spyOn(env.EMAIL!, "send").mockImplementation(async (message: unknown) => {
    sent.push(message as Sent);
    if (outcome === "rejected") {
      throw Object.assign(new Error("sender is not verified"), { code: "E_SENDER_NOT_VERIFIED" });
    }
    return { messageId: "msg-test" };
  });
  return { sent };
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };
});

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.CACHE.put("firebase:jwks:v1", JSON.stringify({ keys: [publicJwk] }));
  await env.DB.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(USER).run();
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(USER).run();
  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, email_verified_at, is_provisional,
                        session_revoked_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
  ).bind(USER, USER_EMAIL, USER_UID, NOW, NOW, NOW).run();
  // A reader, deliberately: asking for help must not need write access.
  await env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
     VALUES ('mem_SUPPORTUSER', ?, ?, ?, 'reader', ?)`
  ).bind(ORG_ID, USER, WORKSPACE_A, NOW).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(token: string, body: unknown, workspaceId = WORKSPACE_A): Promise<Response> {
  return SELF.fetch(`${URL_BASE}/v1/support?workspaceId=${workspaceId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const REQUEST = {
  topic: "keys",
  subject: "Agent gets 403 on /reports since 09:00",
  message: "Key ending abcd, path /reports/q3.csv, every call since 09:00 UTC.",
};

describe("POST /v1/support", () => {
  it("refuses an API key, whatever its scope", async () => {
    const { sent } = stubEmail();
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const res = await post(token, REQUEST);
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("sends one message to the support inbox, from the web support sender, reply-to the person", async () => {
    const { sent } = stubEmail();
    const token = await mint(USER_UID, USER_EMAIL);

    const res = await post(token, REQUEST);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    const message = only(sent);
    expect(message.to).toBe(SUPPORT_INBOX);
    expect(message.from.email).toBe(SUPPORT_SENDER);
    expect(message.replyTo).toBe(USER_EMAIL);
    expect(message.subject).toContain(REQUEST.subject);
  });

  it("puts the signed-in email, the topic as the screen words it, and the workspace in the body", async () => {
    const { sent } = stubEmail();
    const token = await mint(USER_UID, USER_EMAIL);

    await post(token, REQUEST);

    const message = only(sent);
    const text = message.text ?? "";
    expect(text).toContain(`From: ${USER_EMAIL}`);
    expect(text).toContain("Topic: Key or scope problem");
    expect(text).toContain(`Workspace: Workspace A (${WORKSPACE_A})`);
    expect(text).toContain(REQUEST.message);
    // The HTML part carries the same facts.
    expect(message.html).toContain(USER_EMAIL);
    expect(message.html).toContain("Key or scope problem");
  });

  it("takes the email from the credential, never from the body", async () => {
    const { sent } = stubEmail();
    const token = await mint(USER_UID, USER_EMAIL);

    const res = await post(token, { ...REQUEST, email: "forged@example.com" });

    expect(res.status).toBe(200);
    const message = only(sent);
    expect(message.text).toContain(`From: ${USER_EMAIL}`);
    expect(message.text).not.toContain("forged@example.com");
    expect(message.replyTo).toBe(USER_EMAIL);
  });

  it("escapes the message in the HTML part", async () => {
    const { sent } = stubEmail();
    const token = await mint(USER_UID, USER_EMAIL);

    await post(token, { ...REQUEST, message: "<script>alert(1)</script>" });

    const message = only(sent);
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });

  it("refuses an unknown topic, an empty subject and an empty message, sending nothing", async () => {
    const { sent } = stubEmail();
    const token = await mint(USER_UID, USER_EMAIL);

    for (const body of [
      { ...REQUEST, topic: "bogus" },
      { ...REQUEST, subject: "   " },
      { ...REQUEST, message: "" },
    ]) {
      const res = await post(token, body);
      expect(res.status).toBe(400);
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses a workspace the person is not a member of", async () => {
    const { sent } = stubEmail();
    const token = await mint(USER_UID, USER_EMAIL);
    const res = await post(token, REQUEST, WORKSPACE_B);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(sent).toHaveLength(0);
  });

  it("is a failure, not a 200, when Email Service rejects the message", async () => {
    stubEmail("rejected");
    const token = await mint(USER_UID, USER_EMAIL);
    const res = await post(token, REQUEST);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string } };
    // The provider's own words never reach the caller.
    expect(JSON.stringify(body)).not.toContain("not verified");
  });
});
