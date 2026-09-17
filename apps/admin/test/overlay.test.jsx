/**
 * The console's dialog primitives — docs/ui-layering.md, and Amendment 1 of the
 * Track B brief.
 *
 * These assert the three bugs the customer app shipped, from the outside, in
 * the form a user would meet them:
 *
 *   1. Typing a character moves focus to the close button, so the second
 *      character goes nowhere.
 *   2. Enter from a text field does nothing, so a single-field dialog cannot be
 *      completed from the keyboard.
 *   3. The footer is pushed below the fold on a short viewport, so the primary
 *      action cannot be reached at all.
 *
 * (3) is geometry and jsdom does not lay out, so it is asserted here as the CSS
 * that produces it — `minHeight: 0` on the scrollable child and `flex: none` on
 * the two parts that must not move — and verified for real at 1366×768 by
 * test/layout.spec.mjs, which drives a real browser. Neither check replaces the
 * other: this one names the mechanism, that one proves the outcome.
 */

import React, { useState } from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmModal, Modal, ToastDock } from '../src/components/Overlay.jsx';

afterEach(cleanup);

/**
 * A dialog whose parent re-renders on every keystroke, because it owns the
 * field's state. This is the shape every real call site has, and the shape that
 * made the customer app's refocus bug fire once per character — a test that
 * held the value locally would never have caught it.
 */
function StatefulDialog({ onSubmit = () => {}, onClose = () => {} }) {
  const [name, setName] = useState('');
  return (
    <Modal
      open
      title="Create API key"
      description="Keys are shown once."
      onClose={() => onClose()}
      onSubmit={() => onSubmit(name)}
      submitLabel="Create key"
    >
      <label>
        Key name
        <input aria-label="Key name" value={name} onChange={event => setName(event.target.value)} />
      </label>
    </Modal>
  );
}

describe('focus', () => {
  it('lands on the first field, not the close button', async () => {
    // "First focusable" opens every dialog with dismiss selected.
    render(<StatefulDialog />);
    expect(document.activeElement).toBe(screen.getByLabelText('Key name'));
  });

  it('does not move again while typing', async () => {
    // The bug: onClose in the effect's dependency array, an inline arrow at
    // every call site, and a parent that re-renders per keystroke. Focus
    // jumped to Close on character two.
    const user = userEvent.setup();
    render(<StatefulDialog />);

    const field = screen.getByLabelText('Key name');
    await user.type(field, 'deploy-bot');

    expect(document.activeElement).toBe(field);
    expect(field).toHaveValue('deploy-bot');
  });

  it('returns focus to the opener when it closes', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} title="A dialog" onClose={() => setOpen(false)} onSubmit={() => {}}>
            <input aria-label="Field" />
          </Modal>
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });

    await user.click(opener);
    await user.keyboard('{Escape}');

    // Closing a dialog must not dump the caret at the top of the document.
    expect(document.activeElement).toBe(opener);
  });
});

describe('keyboard', () => {
  it('submits on Enter from a text field', async () => {
    // Contract point 4. Without it a single-field dialog is unusable by
    // keyboard, which is how Create API key became impossible at 684px.
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<StatefulDialog onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Key name'), 'deploy-bot{Enter}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('deploy-bot');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<StatefulDialog onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<StatefulDialog />);

    const dialog = screen.getByRole('dialog');
    // Round the whole ring and back. Focus must never land outside.
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('does not submit when the primary action is disabled', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal
        open
        title="Delete workspace"
        confirmText="Kessler Labs"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    );

    // Enter must respect the gate too. A disabled button that Enter walks past
    // is not a gate.
    await user.type(screen.getByLabelText('Type Kessler Labs to confirm'), 'kessler labs{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('the modal-scroll contract', () => {
  it('bounds its height and scrolls the body, not the footer', () => {
    render(<StatefulDialog />);
    const dialog = screen.getByRole('dialog');
    const body = dialog.querySelector('[data-dialog-body]');

    // Point 1: bounded.
    expect(dialog.style.maxHeight).toBe('100%');
    expect(dialog.style.display).toBe('flex');
    expect(dialog.style.flexDirection).toBe('column');

    // Point 2: and this is the fix. overflow-y was already present in the
    // customer app; without min-height: 0 the body never shrinks, so it never
    // engages, and the column grows past the cap instead.
    expect(body.style.overflowY).toBe('auto');
    expect(body.style.minHeight).toBe('0px');

    // Point 3: the two parts the browser must not compress to resolve overflow.
    // Asserted as flex-shrink rather than as the `flex: none` shorthand: the
    // shorthand serialises to its longhand `0 0 auto`, and shrink is the half
    // that does the work — a shrinkable head and footer are exactly what the
    // browser compresses when the column will not fit.
    const head = dialog.querySelector('header');
    const foot = dialog.querySelector('footer');
    expect(head.style.flexShrink).toBe('0');
    expect(foot.style.flexShrink).toBe('0');
  });

  it('puts the primary action in the footer as a real submit', () => {
    // A click handler on type="button" would look identical and silently break
    // Enter. The type is the contract.
    render(<StatefulDialog />);
    const foot = screen.getByRole('dialog').querySelector('footer');
    expect(within(foot).getByRole('button', { name: 'Create key' }).type).toBe('submit');
  });
});

describe('confirmation gates', () => {
  it('stays disabled until the name matches exactly', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmModal
        open
        title="Delete workspace"
        confirmText="Kessler Labs"
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    const field = screen.getByLabelText('Type Kessler Labs to confirm');
    expect(confirm).toBeDisabled();

    // No case folding and no trimming. A gate that accepts an approximation
    // only slows down the people who were already being careful.
    await user.type(field, 'kessler labs');
    expect(confirm).toBeDisabled();

    await user.clear(field);
    await user.type(field, 'Kessler Labs');
    expect(confirm).toBeEnabled();
  });

  it('requires a reason when one is asked for, and passes it on', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal
        open
        title="Suspend workspace"
        requireReason
        confirmLabel="Suspend"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    );

    const confirm = screen.getByRole('button', { name: 'Suspend' });
    expect(confirm).toBeDisabled();

    // Whitespace is not a reason.
    const reason = screen.getByRole('textbox');
    await user.type(reason, '   ');
    expect(confirm).toBeDisabled();

    await user.type(reason, 'Abuse report AD-4471.');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('Abuse report AD-4471.');
  });

  it('defaults to the danger treatment, and can be told not to', () => {
    // CLAUDE.md: dressing an additive action in red is how people learn to
    // click through the red dialogs that matter.
    const { unmount } = render(
      <ConfirmModal open title="Delete" onCancel={() => {}} onConfirm={() => {}} />
    );
    expect(screen.getByRole('button', { name: 'Confirm' }).style.background).toBe('rgb(170, 17, 17)');
    unmount();

    render(
      <ConfirmModal open title="Claim" destructive={false} onCancel={() => {}} onConfirm={() => {}} />
    );
    expect(screen.getByRole('button', { name: 'Confirm' }).style.background).not.toBe('rgb(170, 17, 17)');
  });

  it('clears what was typed between openings', async () => {
    // A gate that remembers the last confirmation is a gate that is already
    // satisfied the next time it opens.
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
          <ConfirmModal
            open={open}
            title="Delete workspace"
            confirmText="Kessler Labs"
            onCancel={() => setOpen(false)}
            onConfirm={() => {}}
          />
        </>
      );
    }
    render(<Harness />);

    await user.type(screen.getByLabelText('Type Kessler Labs to confirm'), 'Kessler Labs');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Reopen' }));

    expect(screen.getByLabelText('Type Kessler Labs to confirm')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });
});

describe('the ladder', () => {
  it('uses tokens rather than bare numbers', () => {
    // The point of the shared scale: a raw integer here is how the two apps
    // drift apart, and the inversion in the customer app is what that costs.
    render(<StatefulDialog />);
    const scrim = screen.getByRole('dialog').parentElement;
    expect(scrim.style.zIndex).toBe('var(--z-modal)');

    cleanup();
    render(<ToastDock toasts={[{ id: '1', message: 'Workspace suspended.' }]} />);
    expect(screen.getByRole('status').style.zIndex).toBe('var(--z-toast)');
  });
});

describe('dismissal', () => {
  it('closes on a click that starts and ends on the scrim', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<StatefulDialog onClose={onClose} />);

    await user.click(screen.getByRole('dialog').parentElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on a drag that began inside the dialog', async () => {
    // Selecting text and releasing past the edge is not a decision to discard
    // what was typed.
    const onClose = vi.fn();
    render(<StatefulDialog onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    const scrim = dialog.parentElement;
    const { fireEvent } = await import('@testing-library/react');

    fireEvent.mouseDown(dialog);
    fireEvent.mouseUp(scrim);
    fireEvent.click(scrim);

    expect(onClose).not.toHaveBeenCalled();
  });
});
