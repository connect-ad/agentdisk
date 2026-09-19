import { describe, expect, it } from "vitest";
import { basename, dirname, escapeLikePattern, normalizePath, PathValidationError } from "../src/lib/paths";

/**
 * Path validation (06 PART 16.12) with real traversal payloads, not a
 * hand-wave. `..` must be REJECTED, never resolved-and-collapsed: collapsing
 * silently turns a hostile path into a plausible one and destroys the evidence
 * that someone tried.
 */
describe("normalizePath", () => {
  it("accepts and canonicalizes ordinary paths", () => {
    expect(normalizePath("/projects/demo/output.json")).toBe("/projects/demo/output.json");
    expect(normalizePath("/a//b///c")).toBe("/a/b/c");
    expect(normalizePath("/trailing/")).toBe("/trailing");
    expect(normalizePath("/")).toBe("/");
  });

  it("rejects traversal payloads outright", () => {
    const payloads = [
      "/../../etc/passwd",
      "/projects/../../../etc/passwd",
      "/projects/./demo",
      "/..",
      "/a/../b",
      "/a/b/..",
    ];
    for (const payload of payloads) {
      expect(() => normalizePath(payload), payload).toThrow(PathValidationError);
    }
  });

  it("rejects a path that does not start with a slash", () => {
    expect(() => normalizePath("relative/path")).toThrow(/must start with/);
    expect(() => normalizePath("../escape")).toThrow(PathValidationError);
  });

  it("rejects backslashes, null bytes and control characters", () => {
    expect(() => normalizePath("/a\\..\\b")).toThrow(/backslash/);
    expect(() => normalizePath("/a\u0000b")).toThrow(/null byte/);
    expect(() => normalizePath("/a\u0007b")).toThrow(/control characters/);
    // Right-to-left override, used to disguise a file extension on screen.
    expect(() => normalizePath("/invoice\u202Egnp.exe")).not.toThrow();
  });

  it("enforces length and depth limits", () => {
    expect(() => normalizePath("/" + "a".repeat(256))).toThrow(/segment exceeds/);
    expect(() => normalizePath("/" + "a/".repeat(40))).toThrow(/levels deep/);
    expect(() => normalizePath("/" + "a".repeat(2000))).toThrow(/exceeds 1024/);
  });

  it("normalizes Unicode so two visually identical paths cannot both exist", () => {
    // NFD "e" + combining acute vs NFC precomposed. Without normalization these
    // are different byte sequences and both could occupy the same visible name,
    // defeating UNIQUE(workspace_id, path).
    const decomposed = "/caf\u0065\u0301.txt";
    const precomposed = "/caf\u00e9.txt";
    expect(normalizePath(decomposed)).toBe(normalizePath(precomposed));
  });

  it("rejects empty input", () => {
    expect(() => normalizePath("")).toThrow(/required/);
  });
});

describe("basename and dirname", () => {
  it("splits a path", () => {
    expect(basename("/projects/demo/output.json")).toBe("output.json");
    expect(dirname("/projects/demo/output.json")).toBe("/projects/demo");
    expect(dirname("/top.txt")).toBe("/");
    expect(basename("/")).toBe("");
  });
});

describe("escapeLikePattern", () => {
  it("escapes LIKE wildcards so a prefix query cannot silently widen", () => {
    // Without escaping, listing '/a_b' would also match '/axb'.
    expect(escapeLikePattern("/a_b")).toBe("/a\\_b");
    expect(escapeLikePattern("/50%")).toBe("/50\\%");
    expect(escapeLikePattern("/back\\slash")).toBe("/back\\\\slash");
  });

  it("leaves ordinary paths untouched", () => {
    expect(escapeLikePattern("/projects/demo")).toBe("/projects/demo");
  });
});
