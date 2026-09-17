import React from 'react';

/**
 * `type` defaults to "button", which is a divergence from the vendored original
 * and a required companion to Modal's Enter-to-submit (backlog/031).
 *
 * A <button> with no type inside a <form> is a submit button. Once Modal wraps
 * its body and footer in a form, an untyped Cancel or Close submits the dialog
 * it was meant to dismiss -- so the destructive reading of "press Escape's
 * neighbour" becomes "confirm". Every form in this app already passes
 * type="submit" explicitly (Auth.jsx, Sandbox.jsx), so nothing relied on the
 * implicit behaviour.
 */
export function Button({
  variant = 'primary', size = 'md', icon, iconRight, loading = false,
  full = false, as: Tag = 'button', className = '', children, disabled,
  type = Tag === 'button' ? 'button' : undefined, ...rest
}) {
  const cls = ['btn', 'btn--' + variant, 'btn--' + size, full ? 'btn--full' : '', loading ? 'is-loading' : '', className]
    .filter(Boolean).join(' ');
  return (
    <Tag className={cls} type={type} disabled={Tag === 'button' ? (disabled || loading) : undefined}
      aria-disabled={disabled || loading || undefined} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="btn__spin" /> : null}
      {icon ? <span className="btn__ico">{icon}</span> : null}
      <span className="btn__label">{children}</span>
      {iconRight ? <span className="btn__ico">{iconRight}</span> : null}
    </Tag>
  );
}
