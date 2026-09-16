import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/index.js';

/**
 * The workspace's ID, where a person can read it and copy it.
 *
 * It is on the dashboard because the ID is the one thing about a workspace that
 * a human needs and cannot derive: it goes into `X-Workspace-Id`, into an MCP
 * client's config, and into a support conversation. The URL carries it, but a
 * URL is a bad place to read a value from — it is truncated in the address bar,
 * selecting it drags in the scheme and host, and `/dashboard` deliberately does
 * not show it at all.
 *
 * NOT part of the design system: the library's `Badge` is for short status
 * words and wraps its text, which is wrong for a 30-character opaque token that
 * must stay on one line and stay selectable.
 *
 * The copied state changes the label, not just a tint — colour never carries
 * meaning on its own here. `aria-live` on the status means the change is
 * announced rather than only seen, since the clipboard gives no other feedback.
 */
export default function WorkspaceIdChip({ workspaceId, className = '' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  // A component unmounted inside the confirmation window — switching workspace
  // from the dashboard does exactly that — would otherwise set state on a dead
  // component when the timer fires.
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!workspaceId) return null;

  const copy = () => {
    try {
      navigator.clipboard.writeText(workspaceId);
    } catch (e) {
      /* clipboard unavailable */
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <span className={`wsid ${className}`.trim()}>
      <span className="wsid__value">{workspaceId}</span>
      <button
        type="button"
        className="wsid__copy"
        onClick={copy}
        aria-label={`Copy workspace ID ${workspaceId}`}
      >
        <Icon name={copied ? 'check' : 'copy'} size={12} />
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </span>
  );
}
