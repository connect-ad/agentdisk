/**
 * A browser fixture for the modal-scroll contract.
 *
 * jsdom does not lay out, so the assertions in overlay.test.jsx can only name
 * the CSS that produces the behaviour. This page exists so a real engine can be
 * asked the question that actually matters: **at 1366×768, with more content
 * than fits, is the primary action on screen and clickable?**
 *
 * The body is deliberately far longer than any real dialog. A fixture that only
 * just overflows would pass on a machine whose scrollbars are 2px narrower.
 */

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from '../../src/components/Overlay.jsx';
import '../../src/app.css';

function Harness() {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);

  return (
    <div style={{ font: '14px system-ui', padding: 20 }}>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <div data-testid="submitted">{submitted ? 'submitted' : 'not-submitted'}</div>

      <Modal
        open={open}
        title="Create API key"
        description="Keys are shown once and cannot be retrieved afterwards."
        onClose={() => setOpen(false)}
        onSubmit={() => setSubmitted(true)}
        submitLabel="Create key"
      >
        <label style={{ display: 'block', marginBottom: 12 }}>
          Key name
          <input
            aria-label="Key name"
            value={name}
            onChange={event => setName(event.target.value)}
            style={{ width: '100%', padding: 8 }}
          />
        </label>

        {/* Forty paragraphs: comfortably past any plausible viewport. */}
        {Array.from({ length: 40 }, (_, i) => (
          <p key={i} data-filler="" style={{ margin: '0 0 12px' }}>
            Scope line {i + 1}. This dialog is deliberately taller than the viewport so that the
            footer has something to be pushed out by.
          </p>
        ))}
      </Modal>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
