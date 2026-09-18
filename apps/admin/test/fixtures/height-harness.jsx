/**
 * Does `minHeight` actually make the real Modal taller?
 *
 * The scroll harness beside this one asks whether the footer survives content
 * that overflows. This one asks the opposite question: with only a little
 * content, does the dialog still take the height it was asked for, or does it
 * shrink to fit?
 *
 * A separate fixture because the two need opposite bodies — that one is
 * deliberately enormous, this one is deliberately small — and a fixture that
 * tries to be both proves neither.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from '../../src/components/Overlay.jsx';
import '../../src/app.css';

function Harness() {
  return (
    <Modal
      open
      title="Edit AgentDisk Free"
      description="Saving pushes to Stripe first. If Stripe refuses, nothing is written here either."
      onClose={() => {}}
      onSubmit={() => {}}
      submitLabel="Save and push to Stripe"
      width={860}
      minHeight={780}
    >
      <div data-testid="short-body">
        <label style={{ display: 'block', marginBottom: 12 }}>
          Name
          <input aria-label="Name" defaultValue="AgentDisk Free" style={{ width: '100%' }} />
        </label>
      </div>
    </Modal>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
