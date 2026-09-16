import React, { useState } from 'react';
import { Icon } from '../Icon/Icon.jsx';
import { Button } from '../Button/Button.jsx';

/**
 * `prefix` is the key's real stored prefix and is rendered verbatim.
 *
 * It used to default to 'ad_live' and have a '_' injected after it, so every
 * masked key in the product read `ad_live_********XXXX` -- a prefix this API has
 * never issued. Keys are `ask_live_`/`ask_test_` plus eight discriminating
 * characters, which is exactly what `key_prefix` holds and what tells two keys
 * apart in a list. A credential display showing a format the product does not
 * use teaches people to ignore the part that identifies the key.
 *
 * No default: a caller that does not know the prefix shows none, rather than a
 * plausible invention. Divergence from the vendored original, recorded in
 * CLAUDE.md with the others.
 */
export function ApiKeyDisplay({ secret, lastFour, prefix = '', revealed = false, onAcknowledge, className = '', ...rest }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try { navigator.clipboard.writeText(secret || ''); } catch (e) { /* clipboard unavailable */ }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  if (!revealed) {
    return (
      <span className="ad-mono" style={{ color: 'var(--ink-2)', letterSpacing: '0.04em' }} {...rest}>
        {prefix}{'\u2022'.repeat(8)}{lastFour}
      </span>
    );
  }
  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 10 }} {...rest}>
      <div style={{
        display: 'flex', alignItems: 'stretch', border: '1px solid var(--warn-line)',
        background: 'var(--warn-soft)', borderRadius: 'var(--r-2)', overflow: 'hidden'
      }}>
        <code className="ad-mono" style={{
          flex: 1, minWidth: 0, padding: '10px 12px', overflowX: 'auto', whiteSpace: 'nowrap', color: 'var(--ink)'
        }}>{secret}</code>
        <button type="button" onClick={copy} style={{
          flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 14px',
          border: 0, borderLeft: '1px solid var(--warn-line)', background: 'transparent',
          color: 'var(--ink)', fontSize: 12, fontWeight: 500, cursor: 'pointer'
        }}><Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="ad-meta" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <Icon name="alert" size={13} style={{ marginTop: 2, flex: 'none', color: 'var(--warn)' }} />
        <span>Copy this key now. It is stored only as a hash, so we cannot show it again. If you lose it, revoke the key and create a new one.</span>
      </p>
      {onAcknowledge ? <div><Button variant="secondary" size="sm" onClick={onAcknowledge}>I&rsquo;ve stored this key</Button></div> : null}
    </div>
  );
}
