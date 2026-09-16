/**
 * The security-header policy.
 *
 * A CSP fails in exactly one direction that matters: too tight, in a browser,
 * for a real person, on a path no unit test walks. So the assertions below are
 * mostly *inclusion* checks tied to the specific line of application code that
 * needs each source — because the way this policy will actually break is
 * somebody deleting a directive they cannot see a reason for.
 *
 * The tightness assertions are confined to `script-src`, which is the directive
 * that does the security work.
 */

import { describe, expect, it } from 'vitest';
import {
  REQUIRED_HEADERS,
  contentSecurityPolicy,
  renderHeadersFile,
  securityHeaders
} from '../scripts/security-headers.js';

const OPTIONS = {
  apiBase: 'https://api-dev.agentdisk.io',
  firebaseAuthDomain: 'agentdisk-dev.firebaseapp.com'
};

/** The sources for one directive, as a list. */
function directive(policy, name) {
  const found = policy
    .split(';')
    .map(part => part.trim())
    .find(part => part === name || part.startsWith(`${name} `));
  if (found === undefined) return null;
  return found.slice(name.length).trim().split(/\s+/).filter(Boolean);
}

describe('the five headers the audit asked for', () => {
  it('are all present with non-empty values', () => {
    const headers = new Map(securityHeaders(OPTIONS));
    for (const name of [
      'Content-Security-Policy',
      'Strict-Transport-Security',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy'
    ]) {
      expect(headers.get(name), name).toBeTruthy();
    }
    expect(REQUIRED_HEADERS).toHaveLength(5);
  });

  it('carry the exact values specified', () => {
    const headers = new Map(securityHeaders(OPTIONS));
    expect(headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('script-src — the directive that does the work', () => {
  const sources = () => directive(contentSecurityPolicy(OPTIONS), 'script-src');

  it('is not a wildcard and permits no inline or eval', () => {
    expect(sources()).not.toContain('*');
    expect(sources()).not.toContain("'unsafe-inline'");
    expect(sources()).not.toContain("'unsafe-eval'");
    expect(sources()).not.toContain('https:');
  });

  it('allows only self and the two hosts that actually serve script', () => {
    // Turnstile: routes/Sandbox.jsx loads its api.js. apis.google.com: the
    // Firebase popup helper. Nothing else in this app loads a third-party
    // script, and a third entry here should be treated as a question.
    expect(sources().sort()).toEqual(
      ['\'self\'', 'https://apis.google.com', 'https://challenges.cloudflare.com'].sort()
    );
  });

  it('cannot be framed, by either spelling', () => {
    expect(directive(contentSecurityPolicy(OPTIONS), 'frame-ancestors')).toEqual(["'none'"]);
    expect(new Map(securityHeaders(OPTIONS)).get('X-Frame-Options')).toBe('DENY');
  });
});

describe('the sources the app genuinely needs', () => {
  const policy = () => contentSecurityPolicy(OPTIONS);

  /** Deleting this breaks every upload over 1 MB — see lib/upload.js. */
  it('lets the browser PUT straight to R2', () => {
    expect(directive(policy(), 'connect-src')).toContain('https://*.r2.cloudflarestorage.com');
  });

  /** Deleting these breaks sign-in. The SDK builds them at runtime, so they
      appear in no bundle and no grep will justify them later. */
  it('lets the Firebase SDK reach its own endpoints', () => {
    const sources = directive(policy(), 'connect-src');
    expect(sources).toContain('https://identitytoolkit.googleapis.com');
    expect(sources).toContain('https://securetoken.googleapis.com');
  });

  it('names the API this build was compiled against', () => {
    expect(directive(policy(), 'connect-src')).toContain('https://api-dev.agentdisk.io');
    // A prod build must produce a prod policy — the two are compiled from the
    // same variable the bundle uses, so they cannot disagree.
    const prod = contentSecurityPolicy({ ...OPTIONS, apiBase: 'https://api.agentdisk.io' });
    expect(directive(prod, 'connect-src')).toContain('https://api.agentdisk.io');
    expect(directive(prod, 'connect-src')).not.toContain('https://api-dev.agentdisk.io');
  });

  /** Deleting these strips the app's typography — styles.css line 1. */
  it('allows the Google Fonts stylesheet and its font files', () => {
    expect(directive(policy(), 'style-src')).toContain('https://fonts.googleapis.com');
    expect(directive(policy(), 'font-src')).toContain('https://fonts.gstatic.com');
  });

  /**
   * 41 source files style elements with React's `style={{…}}`, which lands as
   * an inline style attribute. No hash or nonce covers those. This assertion
   * exists so that removing 'unsafe-inline' is a deliberate act paired with
   * that refactor, not a tidy-up.
   */
  it('still allows inline style attributes, because the UI is built on them', () => {
    expect(directive(policy(), 'style-src')).toContain("'unsafe-inline'");
  });

  it('frames the Turnstile challenge and the Firebase auth domain', () => {
    const sources = directive(policy(), 'frame-src');
    expect(sources).toContain('https://challenges.cloudflare.com');
    expect(sources).toContain('https://agentdisk-dev.firebaseapp.com');
  });

  /**
   * A build with no Firebase project (the marketing pages alone) must omit the
   * source rather than emit "https://undefined", which looks configured and
   * matches nothing.
   */
  it('omits the auth domain rather than inventing one', () => {
    const policyWithout = contentSecurityPolicy({ apiBase: OPTIONS.apiBase });
    expect(policyWithout).not.toContain('undefined');
    expect(directive(policyWithout, 'frame-src')).not.toContain('https://undefined');
  });
});

describe('the _headers file', () => {
  it('applies to every path, so SPA deep links are covered too', () => {
    const file = renderHeadersFile(OPTIONS);
    expect(file.split('\n')[1]).toBe('/*');
  });

  it('indents each header under the rule, as the format requires', () => {
    for (const line of renderHeadersFile(OPTIONS).split('\n')) {
      if (line === '' || line.startsWith('#') || line === '/*') continue;
      expect(line).toMatch(/^ {2}[A-Za-z-]+: .+/);
    }
  });

  it('writes no value containing a newline, which would truncate the file', () => {
    for (const [, value] of securityHeaders(OPTIONS)) {
      expect(value).not.toMatch(/[\r\n]/);
    }
  });

  /**
   * Cross-Origin-Opener-Policy is the usual sixth header here and is left off
   * deliberately: `same-origin` severs `window.opener`, which Firebase's
   * signInWithPopup depends on. Pinned so that adding it is a decision rather
   * than a completion.
   */
  it('does not set COOP, which would break popup sign-in', () => {
    expect(renderHeadersFile(OPTIONS)).not.toContain('Cross-Origin-Opener-Policy');
  });
});
