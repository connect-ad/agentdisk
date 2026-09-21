/**
 * The password policy, stated once.
 *
 * ---------------------------------------------------------------------------
 * Where the policy actually lives
 *
 * Not here. This product never receives a password: `signUpWithPassword`,
 * `confirmReset` and `changePassword` all hand it to Firebase, which posts it
 * to `identitytoolkit.googleapis.com`. So the enforcement that matters is the
 * one configured on the Firebase project — Authentication → Settings →
 * Password policy, set to **Require enforcement** — because that is the only
 * thing standing between a weak password and an account when the caller is a
 * `curl` holding the public web API key rather than this bundle.
 *
 * What is written below is the *client half* of those same rules, and it exists
 * for two reasons neither of which is security:
 *
 *  - a person is told the rules while they type, instead of after they have
 *    filled in a form Firebase was always going to refuse;
 *  - the forms decline to make a call that cannot succeed.
 *
 * **This file must therefore agree with the console.** The alternative — the
 * SDK's `validatePassword`, which fetches the live policy — was considered and
 * rejected: it is a network round-trip on a field somebody is typing into, and
 * it fails awkwardly offline. The drift that buys is covered from the other
 * side: `auth/password-does-not-meet-requirements` is handled in `auth.jsx`, so
 * if the console is tightened and this file is not, the person is still told
 * something true and actionable rather than "something went wrong".
 *
 * The console is the authority. If you change it, change this, and say so in
 * both places.
 *
 * ---------------------------------------------------------------------------
 * Why one module rather than a check per screen
 *
 * Because that is what was wrong before. Signup and reset both tested
 * `pw.length < 8`, Settings tested nothing at all while its hint promised 12,
 * and a four-bar strength meter scored the password by a third rule of its own
 * and then let it through whatever it concluded. A meter that says WEAK beside
 * a button that accepts WEAK is the `backlog/023` class of defect: a control
 * reporting a judgement nothing acts on. Here the bars, the summary line and
 * the gate are three readings of one function.
 */

/**
 * The five requirements, in the order they are shown.
 *
 * `label` completes "Your password still needs …", so each one is a noun
 * phrase; that is also how it reads in the Settings hint and the Firebase
 * rejection. `short` is the same rule as a chip under the sign-up field, where
 * five of them share one row and an article would be padding.
 */
export const PASSWORD_RULES = {
  minLength: 8,
  requirements: [
    { id: 'length', label: '8 characters or more', short: '8+ characters', test: pw => pw.length >= 8 },
    { id: 'upper', label: 'an uppercase letter', short: 'uppercase', test: pw => /[A-Z]/.test(pw) },
    { id: 'lower', label: 'a lowercase letter', short: 'lowercase', test: pw => /[a-z]/.test(pw) },
    { id: 'digit', label: 'a number', short: 'number', test: pw => /[0-9]/.test(pw) },
    { id: 'symbol', label: 'a special character', short: 'special character', test: pw => /[^A-Za-z0-9]/.test(pw) }
  ]
};

/**
 * The policy as one sentence, for the places that have no field to hang a
 * checklist under — the Firebase rejection in `describeAuthError`, and the hint
 * over the Settings field before anything has been typed.
 *
 * Derived rather than written out, so there is no second copy of the rules to
 * fall behind the first.
 */
export const POLICY_SENTENCE = `Use ${listOf(PASSWORD_RULES.requirements.map(r => r.label))}.`;

/** Joins labels the way a sentence does: "a, b and c". */
function listOf(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Check `pw` against every rule.
 *
 * Returns the requirements split into met and unmet — not a boolean — because
 * every caller needs the detail: the meter draws one bar per rule, the checklist
 * ticks them individually, and the error names the ones outstanding. A caller
 * that only wants a yes/no reads `ok`.
 */
export function checkPassword(pw) {
  const value = pw ?? '';
  const met = PASSWORD_RULES.requirements.filter(r => r.test(value));
  const unmet = PASSWORD_RULES.requirements.filter(r => !r.test(value));

  return {
    ok: unmet.length === 0,
    met,
    unmet,
    /** What is left to do, or what they have when there is nothing left. */
    summary: unmet.length > 0
      ? `Still needs ${listOf(unmet.map(r => r.label))}`
      : `${value.length} characters, and every requirement met`
  };
}

/**
 * The meter under the field: one bar per requirement met, so it cannot outrank
 * the gate beside it.
 *
 * The tone is tied to compliance rather than to the count, because a password
 * missing one rule is refused exactly as firmly as one missing four — colouring
 * it green for being close would be the meter disagreeing with the button
 * again. The word carries the same meaning as the colour, per the standing rule
 * that colour never carries meaning alone.
 *
 * STRONG is held back for a compliant password of 12 or more. A password can
 * satisfy all five rules at 8 characters, and calling that the top of the scale
 * would tell somebody they had done better than they have.
 */
export function strengthOf(pw) {
  const value = pw ?? '';
  const result = checkPassword(value);
  const score = result.met.length;

  if (!value) return { score: 0, label: '', tone: 'bad', note: '', ok: false };

  let label;
  let tone;
  if (result.ok) {
    label = value.length >= 12 ? 'STRONG' : 'GOOD';
    tone = 'ok';
  } else {
    label = score >= 3 ? 'FAIR' : 'WEAK';
    tone = score >= 3 ? 'warn' : 'bad';
  }

  return { score, label, tone, note: result.summary, ok: result.ok };
}
