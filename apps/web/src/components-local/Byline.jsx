import React from 'react';
import { COMPANY_BYLINE, COMPANY_NAME, COMPANY_URL } from '../lib/company.js';

/**
 * "A project by Kernelv5", as a link to the company site.
 *
 * A text wordmark, deliberately: the company has no logo, and an <img>
 * waiting for one would be a broken glyph on every page until it arrived.
 * The name is set in the mono caps the site already uses for its small
 * labels, so it reads as a mark beside the AgentDisk wordmark rather than
 * as a sentence.
 *
 * It is its own <a>, never nested inside the brand link: an anchor inside
 * an anchor is invalid HTML and browsers split it unpredictably. Call sites
 * place it as a sibling and position it with `className`.
 *
 * Opens in a new tab because it leaves the product; `rel` closes the opener
 * channel, which is the one thing a `target="_blank"` link must always do.
 */
export default function Byline({ className = '' }) {
  return (
    <a
      href={COMPANY_URL}
      className={['byline', className].filter(Boolean).join(' ')}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${COMPANY_BYLINE} ${COMPANY_NAME}, opens kernelv5.com in a new tab`}
    >
      <span className="byline__lead">{COMPANY_BYLINE}</span>
      <span className="byline__mark">{COMPANY_NAME}</span>
    </a>
  );
}
