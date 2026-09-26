/**
 * Formatting, with one rule running through all of it.
 *
 * **Never render an invented value.** Where the backend could not supply
 * something, these return a marker the operator can read as "not known" rather
 * than a zero or a blank, because a blank reads as "nothing" and a zero reads
 * as "none" — and both are claims about a customer's account that we would be
 * making up. `unavailable()` is that marker, and it exists so there is one of
 * them instead of eleven.
 */

/** What a cell says when the value genuinely is not known. */
export const UNAVAILABLE = 'unavailable';
/** What a cell says when the product does not record this at all. */
export const NOT_TRACKED = 'not tracked yet';

export function bytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNAVAILABLE;
  if (value < 0) return 'Unlimited';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  // One decimal, but never a trailing ".0": "1 GB" is what an operator reads,
  // and "1.0 GB" invites the question of what the missing precision was.
  const text =
    scaled >= 100 || exponent === 0
      ? String(Math.round(scaled))
      : scaled.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[exponent]}`;
}

/**
 * A quota dimension.
 *
 * `null` and `-1` are different answers and must stay different on screen.
 * `-1` is unlimited; `null` means the plan row did not say, which defers to the
 * code floor — and an operator looking at a plan needs to be able to tell those
 * apart, because one is a decision and the other is a gap.
 */
export function quota(value) {
  if (value === null || value === undefined) return 'from code default';
  if (value < 0) return 'Unlimited';
  return count(value);
}

export function count(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNAVAILABLE;
  return value.toLocaleString('en-US');
}

export function money(cents, currency = 'usd') {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return UNAVAILABLE;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2
  }).format(cents / 100);
}

export function dateTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return UNAVAILABLE;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function date(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return UNAVAILABLE;
  return new Date(ms).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

/** "3 days ago", for the age of a condition. */
export function since(ms, now = Date.now()) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return UNAVAILABLE;
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Percentage of a limit, or null when there is no limit to be a percentage of. */
export function percentOf(used, limit) {
  if (typeof used !== 'number' || typeof limit !== 'number') return null;
  if (limit <= 0) return null;
  return Math.round((used * 100) / limit);
}

export function planLabel(id) {
  if (typeof id !== 'string' || id === '') return UNAVAILABLE;
  return id.charAt(0).toUpperCase() + id.slice(1);
}
