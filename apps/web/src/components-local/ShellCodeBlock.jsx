import React, { useId, useState } from 'react';
import { CodeBlock } from '../components/index.js';

/**
 * A CodeBlock with one tab per shell, the way the Docs page shows a command
 * for Bash, PowerShell and cmd. The tabs sit in the block's own header beside
 * Copy, so the button copies whichever variant is showing.
 *
 * `variants` is `[{ label, filename, code }]`, Bash first: Linux, macOS and
 * WSL. The header keeps the vendored CodeBlock's classes; only the tabs are
 * local (`.code__tab*` in app.css), on the dark tokens the header already uses.
 */
export function ShellCodeBlock({ label, variants, ...rest }) {
  const [active, setActive] = useState(0);
  const id = useId();
  const current = variants[Math.min(active, variants.length - 1)];
  const tabs = (
    <div className="code__tabs" role="tablist" aria-label={label}>
      {variants.map((v, i) => (
        <button
          key={v.label}
          type="button"
          role="tab"
          id={`${id}-${i}`}
          aria-selected={i === active}
          className={i === active ? 'code__tab code__tab--on' : 'code__tab'}
          onClick={() => setActive(i)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
  return (
    <CodeBlock
      filename={current.filename}
      code={current.code}
      actions={tabs}
      role="tabpanel"
      aria-labelledby={`${id}-${active}`}
      {...rest}
    />
  );
}
