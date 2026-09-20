/**
 * The cookie/storage consent record.
 *
 * ── What this product actually stores, as of this commit ──────────────────
 * Nothing in `apps/api` sends a `Set-Cookie` header — grep it. Sign-in is
 * Firebase, which keeps its session in the browser's own storage, and the API
 * is bearer tokens on `Authorization`. So the only thing in the "essential"
 * category is browser storage this app cannot function without: the Firebase
 * session and the last workspace you had open (`lib/workspace.jsx`), plus the
 * theme and accent preferences (`lib/theme.jsx`).
 *
 * The two optional categories collect nothing today. `routes/Legal.jsx` §9 is
 * the authoritative text and says exactly that. This module exists so that
 * when one of them starts, the choice a person already made is waiting for it
 * rather than being asked for afterwards — which is the wrong order, and the
 * one the policy promises not to take.
 *
 * ── The rule for whoever adds analytics ───────────────────────────────────
 * `analyticsAllowed()` is the gate. Nothing reads it yet, deliberately: there
 * is no analytics call to gate. A tag, a pixel or a `fetch` to a metrics
 * endpoint added without passing through it makes the notice a lie, and a
 * notice that lies is worse than no notice at all — it collects a decision and
 * then ignores it.
 *
 * ── Why a stale record re-asks ────────────────────────────────────────────
 * The design states "Saved for 12 months on this device", so a record older
 * than that is treated as no record: the bar comes back and the question is
 * put again. An indefinite choice is not consent, it is a choice somebody made
 * once about a product that has since changed.
 *
 * Every access is wrapped. Safari in private mode throws on localStorage
 * rather than returning null, and a consent bar is not worth a blank page.
 */

const KEY = 'agentdisk.cookie-consent';

/** Bumped when a category is added or its meaning changes, which re-asks. */
export const CONSENT_VERSION = 1;

/** 12 months, per the design's own promise. */
export const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** The two categories a person can decide. Essential is not among them. */
export const OPTIONAL_CATEGORIES = ['analytics', 'marketing'];

/**
 * The stored decision, or `null` when there is none to honour — no record, a
 * record from an older version, a record past its 12 months, or storage that
 * refused to answer. Every one of those means "ask".
 */
export function readConsent() {
  let raw;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Hand-edited, truncated, or written by a version that stored something
    // else. Not recoverable, and guessing at it would be inventing a consent.
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.v !== CONSENT_VERSION) return null;

  const at = Date.parse(parsed.at);
  if (!Number.isFinite(at) || Date.now() - at > CONSENT_MAX_AGE_MS) return null;

  return {
    at: parsed.at,
    // Absent means off. A category nobody decided is not one you may run.
    analytics: parsed.analytics === true,
    marketing: parsed.marketing === true,
  };
}

/**
 * Records a decision and returns it. Returns the record even when the write
 * failed, because the caller's own state is what dismisses the bar: a person
 * in private mode who answers the question should not be asked again on this
 * page, only on the next load.
 */
export function saveConsent({ analytics = false, marketing = false } = {}) {
  const record = {
    v: CONSENT_VERSION,
    at: new Date().toISOString(),
    analytics: analytics === true,
    marketing: marketing === true,
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    /* Private mode or blocked storage. The bar returns next load. */
  }
  return record;
}

/** Forgets the decision, so the notice is asked again. */
export function clearConsent() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* Nothing was stored anyway. */
  }
}

/**
 * The gate. Absence of a decision is a "no", never a "not yet" — the
 * difference matters because the bar can be dismissed by a reload.
 */
export function analyticsAllowed() {
  const c = readConsent();
  return !!c && c.analytics;
}

/** The same, for attribution. */
export function marketingAllowed() {
  const c = readConsent();
  return !!c && c.marketing;
}
