import { describe, expect, it } from "vitest";
import {
  ScopeParseError,
  assertScope,
  isSubsetScope,
  normalizePrefix,
  parseScopes,
  scopeAllowsPath,
  type KeyScope,
} from "../src/auth/scopes";
import { ApiError } from "../src/lib/errors";

const scope = (ops: KeyScope["ops"], pathPrefix = ""): KeyScope => ({ ops, pathPrefix });

describe("parseScopes", () => {
  it("reads a well-formed blob", () => {
    const parsed = parseScopes('{"ops":["read","write"],"pathPrefix":"/agents/bot/*"}');
    expect(parsed.ops).toEqual(["read", "write"]);
    expect(parsed.pathPrefix).toBe("/agents/bot");
  });

  it("treats /, /* and an absent prefix as the whole workspace", () => {
    expect(parseScopes('{"ops":["read"],"pathPrefix":"/*"}').pathPrefix).toBe("");
    expect(parseScopes('{"ops":["read"],"pathPrefix":"/"}').pathPrefix).toBe("");
    expect(parseScopes('{"ops":["read"]}').pathPrefix).toBe("");
  });

  it("fails closed on anything it cannot read", () => {
    // Each of these could plausibly be "recovered" by ignoring the bad part and
    // honouring the rest. That recovery is a silent privilege grant, so every
    // one of them must throw instead.
    const bad = [
      "not json at all",
      "[]",
      "null",
      '"read"',
      '{"pathPrefix":"/a"}',
      '{"ops":"read","pathPrefix":"/a"}',
      '{"ops":["read","sudo"],"pathPrefix":"/a"}',
      '{"ops":["read"],"pathPrefix":123}',
      '{"ops":["read"],"pathPrefix":"relative/path"}',
    ];
    for (const blob of bad) {
      expect(() => parseScopes(blob), blob).toThrow(ScopeParseError);
    }
  });

  it("de-duplicates ops", () => {
    expect(parseScopes('{"ops":["read","read","write"]}').ops).toEqual(["read", "write"]);
  });
});

describe("normalizePrefix", () => {
  it("collapses the equivalent spellings of one subtree", () => {
    for (const raw of ["/a/b", "/a/b/", "/a/b/*", "/a/b//"]) {
      expect(normalizePrefix(raw), raw).toBe("/a/b");
    }
  });
});

describe("scopeAllowsPath", () => {
  it("allows the prefix itself and anything under it", () => {
    const s = scope(["read"], "/agents/bot");
    expect(scopeAllowsPath(s, "/agents/bot")).toBe(true);
    expect(scopeAllowsPath(s, "/agents/bot/notes.md")).toBe(true);
    expect(scopeAllowsPath(s, "/agents/bot/deep/nested/file.txt")).toBe(true);
  });

  it("stops at a segment boundary", () => {
    // The bug this exists to catch: a plain startsWith says "/agents/bot"
    // authorizes "/agents/bot-evil/secrets.txt". It must not.
    const s = scope(["read"], "/agents/bot");
    expect(scopeAllowsPath(s, "/agents/bot-evil/secrets.txt")).toBe(false);
    expect(scopeAllowsPath(s, "/agents/botanicals")).toBe(false);
    expect(scopeAllowsPath(s, "/agents/bot2")).toBe(false);
  });

  it("does not allow escaping upwards or sideways", () => {
    const s = scope(["read"], "/agents/bot");
    expect(scopeAllowsPath(s, "/agents")).toBe(false);
    expect(scopeAllowsPath(s, "/")).toBe(false);
    expect(scopeAllowsPath(s, "/other/bot/file")).toBe(false);
  });

  it("an empty prefix covers the workspace", () => {
    expect(scopeAllowsPath(scope(["read"], ""), "/anything/at/all")).toBe(true);
  });
});

describe("assertScope", () => {
  it("rejects an op the key was not granted", () => {
    expect(() => assertScope(scope(["read"]), "write")).toThrow(ApiError);
    try {
      assertScope(scope(["read"]), "delete");
    } catch (err) {
      expect((err as ApiError).code).toBe("FORBIDDEN");
      expect((err as ApiError).status).toBe(403);
    }
  });

  it("rejects a path outside the prefix even when the op is granted", () => {
    expect(() => assertScope(scope(["write"], "/agents/bot"), "write", "/other/file")).toThrow(
      ApiError
    );
  });

  it("allows a granted op on an in-prefix path", () => {
    expect(() =>
      assertScope(scope(["write"], "/agents/bot"), "write", "/agents/bot/out.md")
    ).not.toThrow();
  });
});

describe("isSubsetScope", () => {
  const parent = scope(["read", "write"], "/agents/bot");

  it("permits a narrower child", () => {
    expect(isSubsetScope(scope(["read"], "/agents/bot/notes"), parent)).toBe(true);
    expect(isSubsetScope(scope(["read", "write"], "/agents/bot"), parent)).toBe(true);
  });

  it("refuses a child claiming an op the parent lacks", () => {
    expect(isSubsetScope(scope(["read", "delete"], "/agents/bot"), parent)).toBe(false);
  });

  it("refuses a child reaching outside the parent's subtree", () => {
    expect(isSubsetScope(scope(["read"], "/agents"), parent)).toBe(false);
    expect(isSubsetScope(scope(["read"], "/agents/bot-evil"), parent)).toBe(false);
    expect(isSubsetScope(scope(["read"], ""), parent)).toBe(false);
  });

  it("lets a workspace-wide parent mint anything", () => {
    const root = scope(["read", "write", "delete", "list"], "");
    expect(isSubsetScope(scope(["read"], "/anywhere"), root)).toBe(true);
    expect(isSubsetScope(scope(["read"], ""), root)).toBe(true);
  });
});
