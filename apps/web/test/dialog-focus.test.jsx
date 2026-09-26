/**
 * Focus behaviour of the two dialog containers — the Modal from the design
 * system and the local Drawer.
 *
 * These exist because of a bug that made every dialog in the product unusable:
 * typing one character into any field moved focus to the dialog's close button,
 * so the second character went nowhere. The cause was `onClose` sitting in the
 * dependency array of the effect that moves focus. Every call site passes an
 * inline arrow, so `onClose` was a new function on each render of the parent —
 * and the parent re-renders on every keystroke, because it owns the field's
 * state. The effect therefore re-ran per character and re-focused the first
 * focusable element in the dialog, which is the close button in the header.
 *
 * The tests type through `user.keyboard`, which delivers to whatever
 * `document.activeElement` is, rather than to a named element. Typing straight
 * into the input would pass even with the bug present, because it would keep
 * re-targeting the field the test already knows about — which is the opposite
 * of the thing being checked.
 */

import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../src/components/Modal/Modal.jsx';
import { Input } from '../src/components/Input/Input.jsx';
import { Drawer } from '../src/components-local/Drawer.jsx';

afterEach(cleanup);

/** The shape every real call site has: parent state, inline arrow `onClose`. */
function ModalHarness() {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState('');
  return (
    <Modal open={open} title="Create an agent" onClose={() => setOpen(false)}>
      <Input label="Name" value={name} onChange={e => setName(e.target.value)} />
    </Modal>
  );
}

function DrawerHarness() {
  const [open, setOpen] = useState(true);
  const [caption, setCaption] = useState('');
  return (
    <Drawer open={open} title="File details" onClose={() => setOpen(false)}>
      <Input label="Caption" value={caption} onChange={e => setCaption(e.target.value)} />
    </Drawer>
  );
}

describe('Modal focus', () => {
  it('keeps focus in the field across every keystroke', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    const field = screen.getByLabelText('Name');

    await user.click(field);
    await user.keyboard('research-bot');

    expect(field.value).toBe('research-bot');
    expect(document.activeElement).toBe(field);
  });

  it('opens with the first field focused, not the close button', async () => {
    render(<ModalHarness />);
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    expect(document.activeElement).not.toBe(screen.getByLabelText('Close'));
  });

  it('still closes on Escape', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    expect(screen.getByRole('dialog')).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Drawer focus', () => {
  it('keeps focus in the field across every keystroke', async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    const field = screen.getByLabelText('Caption');

    await user.click(field);
    await user.keyboard('quarterly numbers');

    expect(field.value).toBe('quarterly numbers');
    expect(document.activeElement).toBe(field);
  });

  it('opens with the first field focused, not the close button', () => {
    render(<DrawerHarness />);
    expect(document.activeElement).toBe(screen.getByLabelText('Caption'));
  });

  it('still closes on Escape', async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    expect(screen.getByRole('dialog')).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
