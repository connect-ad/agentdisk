/**
 * The modal contract from docs/ui-layering.md §2.
 *
 * At a 684px-tall viewport the Create API key dialog's footer fell below the
 * fold, its body did not scroll, and Enter did nothing — so minting a key, step
 * 1 of the product's own Quick start, was impossible. Two halves, tested two
 * ways.
 *
 * **Points 1–3 are asserted against the stylesheet text**, in the manner of
 * site-sheet.test.js and for the same reason: jsdom computes no layout, so a
 * rendering test would pass just as happily against a modal whose footer is off
 * screen. The wording *is* the thing being protected — and the trap here is that
 * the vendored sheet already says `overflow-y:auto`, which is what made this
 * look solved for months. `min-height:0` is the rule that actually engages it.
 *
 * **Point 4 is asserted by behaviour**, because it is markup, not CSS.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../src/components/Modal/Modal.jsx';
import { Button } from '../src/components/Button/Button.jsx';

afterEach(cleanup);

const app = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');

/** Strip comments so a rule quoted in prose cannot satisfy an assertion. */
const rules = app.replace(/\/\*[\s\S]*?\*\//g, '');

describe('modal scroll contract (docs/ui-layering.md §2)', () => {
  it('bounds the dialog by sizing the scrim row from the window, not from the dialog', () => {
    // Point 1 was recorded as already met by max-height:100% and was not: a
    // percentage resolves against the grid row, an auto row grows to fit its
    // content, so the cap was the dialog's own height whenever the dialog
    // was taller than the window. The Create API key footer fell off screen
    // with points 2 and 3 both in place. The row must be container-sized.
    expect(app).toMatch(/\.scrim\{[^}]*grid-template-rows:minmax\(0,1fr\)/);
  });

  it('lets the scrollable body shrink, which is what engages overflow-y', () => {
    // The fix is min-height, not overflow-y. The vendored sheet has had
    // overflow-y:auto all along and the footer still fell off the screen.
    expect(rules).toMatch(/\.modal__body\{[^}]*min-height:0/);
  });

  it('holds the head and footer rigid so the overflow is taken from the body', () => {
    expect(rules).toMatch(/\.modal__head,\.modal__foot\{[^}]*flex:none/);
  });

  it('keeps the whole ladder in tokens, with the modal above the drawer', () => {
    // The inversion this document exists for: .dw was 80 and .scrim 60, so a
    // confirmation opened from the drawer rendered underneath it.
    const drawer = /--z-drawer:(\d+)/.exec(rules);
    const modal = /--z-modal:(\d+)/.exec(rules);
    const toast = /--z-toast:(\d+)/.exec(rules);
    expect(Number(drawer[1])).toBeLessThan(Number(modal[1]));
    expect(Number(modal[1])).toBeLessThan(Number(toast[1]));
    expect(rules).toMatch(/\.scrim\{z-index:var\(--z-modal\)\}/);
    expect(rules).toMatch(/\.dw\{[^}]*z-index:var\(--z-drawer\)/);
  });
});

describe('modal contract point 4 — Enter submits', () => {
  it('submits from a text field, without touching the mouse', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Modal title="New folder" onSubmit={onSubmit} onClose={() => {}}
        footer={<Button type="submit">Create folder</Button>}>
        <input aria-label="Folder name" />
      </Modal>
    );

    await user.type(screen.getByLabelText('Folder name'), 'research{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not let Cancel submit the dialog it exists to dismiss', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <Modal title="New folder" onSubmit={onSubmit} onClose={onClose}
        footer={<>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit">Create folder</Button>
        </>}>
        <input aria-label="Folder name" />
      </Modal>
    );

    // A <button> with no type inside a <form> is a submit button. Button
    // defaults to type="button" precisely so this cannot happen.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves a dialog with no onSubmit exactly as it was', async () => {
    const user = userEvent.setup();
    render(
      <Modal title="Plain" onClose={() => {}} footer={<Button>OK</Button>}>
        <input aria-label="Field" />
      </Modal>
    );

    expect(document.querySelector('.modal form')).toBeNull();
    // And Enter in the field does not throw or navigate.
    await user.type(screen.getByLabelText('Field'), 'x{Enter}');
    expect(screen.getByLabelText('Field').value).toBe('x');
  });
});
