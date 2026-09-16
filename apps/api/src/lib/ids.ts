/**
 * ULID generation, built on Web Crypto rather than a dependency.
 *
 * ULIDs are used instead of UUIDs because they sort chronologically as strings:
 * `audit_events` relies on that for time-ordered listing without a secondary
 * index, and it makes every table's primary key naturally ordered by creation.
 */

/** Crockford base32: no I, L, O or U, so it survives being read aloud or typed. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Monotonic guard: two ULIDs generated in the same millisecond must still order. */
let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % 32;
    out = ENCODING[mod] + out;
    now = (now - mod) / 32;
  }
  return out;
}

function randomChars(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  // Map each byte into the 32-char alphabet. Modulo bias is irrelevant here:
  // these bits are for collision resistance within a millisecond, not secrecy.
  return Array.from(bytes, (b) => b % 32);
}

/** Increment the random component, so same-millisecond ULIDs still sort. */
function bumpRandom(previous: number[]): number[] {
  const next = [...previous];
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const value = next[i];
    if (value === undefined) continue;
    if (value < 31) {
      next[i] = value + 1;
      return next;
    }
    next[i] = 0;
  }
  // Overflowed a full millisecond's worth of increments. Astronomically
  // unlikely; start fresh rather than return a duplicate.
  return randomChars();
}

export function ulid(now = Date.now()): string {
  if (now === lastTime) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom.map((i) => ENCODING[i]).join("");
}

/** Entity ID prefixes, per the schema comments in 05 PART 11.1. */
export const ID_PREFIX = {
  organization: "org",
  user: "usr",
  membership: "mem",
  workspace: "ws",
  agent: "agt",
  apiKey: "key",
  folder: "fld",
  file: "fil",
  auditEvent: "evt",
  webhook: "whk",
  // Staff are not customers and never appear in a workspace's entity graph, but
  // they get the same sortable IDs: an investigation reads both trails.
  staffUser: "stf",
  staffSession: "ssn",
  // Not an entity: request IDs are never stored, only echoed in error bodies
  // and logs (05 PART 13's envelope). Same generator, same sortability.
  request: "req",
} as const;

export type EntityKind = keyof typeof ID_PREFIX;

export function newId(kind: EntityKind, now = Date.now()): string {
  return `${ID_PREFIX[kind]}_${ulid(now)}`;
}
