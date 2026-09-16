/**
 * The sidebar workspace switcher.
 *
 * This replaced three separate controls — an inert card in the sidebar, a raw
 * `<select>` in the topbar, and a "New workspace" button beside it — so the
 * tests here are mostly about the two jobs those three used to split badly:
 * saying which workspace you are in, and getting you into another one.
 *
 * The component takes its data as props rather than reading `useWorkspace()`,
 * which is what lets these tests run the real component against real React
 * rather than a mocked context. `App.jsx` is the single place that reads the
 * context and passes it down.
 *
 * Note what the "current" assertion checks: `aria-checked` on a
 * `menuitemradio`, not the presence of a tick glyph. A checkmark that only
 * exists as an icon says nothing to a screen reader, and it is exactly the kind
 * of state a test can pass on while the real thing is unusable.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WorkspaceSwitcher from '../src/components-local/WorkspaceSwitcher.jsx';

afterEach(cleanup);

const TWO = [
  { id: 'ws_abc', name: 'Abc', role: 'owner' },
  { id: 'ws_mine', name: 'My Workspace', role: 'reader' }
];

function renderSwitcher(props = {}) {
  const onSelect = vi.fn();
  const onCreate = vi.fn().mockResolvedValue(undefined);
  render(
    <WorkspaceSwitcher
      workspaces={TWO}
      currentId="ws_abc"
      onSelect={onSelect}
      onCreate={onCreate}
      {...props}
    />
  );
  return { onSelect, onCreate };
}

describe('WorkspaceSwitcher trigger', () => {
  it('names the workspace you are in, and your role in it', () => {
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: /Abc/ });
    expect(trigger.textContent).toContain('Abc');
    expect(trigger.textContent).toContain('Owner');
  });

  it('starts closed', () => {
    renderSwitcher();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('reports the open state to assistive tech', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: /Abc/ });

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('WorkspaceSwitcher menu', () => {
  it('lists every workspace and marks the current one', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Abc/ }));

    expect(screen.getByRole('menuitemradio', { name: 'Abc', checked: true })).toBeDefined();
    expect(screen.getByRole('menuitemradio', { name: 'My Workspace', checked: false })).toBeDefined();
  });

  it('hands the chosen workspace back by id', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Abc/ }));
    await user.click(screen.getByRole('menuitemradio', { name: 'My Workspace' }));

    expect(onSelect).toHaveBeenCalledWith('ws_mine');
  });

  it('closes once a workspace is chosen', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Abc/ }));
    await user.click(screen.getByRole('menuitemradio', { name: 'My Workspace' }));

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('still opens with one workspace, because it is the only way to make a second', async () => {
    const user = userEvent.setup();
    renderSwitcher({ workspaces: [TWO[0]] });

    await user.click(screen.getByRole('button', { name: /Abc/ }));

    expect(screen.getByRole('menuitem', { name: /New workspace/ })).toBeDefined();
  });
});

describe('WorkspaceSwitcher dismissal', () => {
  it('closes on Escape and puts focus back on the trigger', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: /Abc/ });

    await user.click(trigger);
    // Focus has to actually be somewhere else first. Asserting straight after
    // the click passes whether or not anything restores focus, because the
    // click left it on the trigger and closing a menu does not move it — the
    // test would be green with the restore deleted.
    await user.tab();
    expect(document.activeElement).not.toBe(trigger);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when you click away from it', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Abc/ }));
    await user.click(document.body);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays open while you are clicking inside it', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Abc/ }));
    await user.click(screen.getByRole('menu'));

    expect(screen.getByRole('menu')).toBeDefined();
  });
});

describe('WorkspaceSwitcher creation', () => {
  it('opens the create dialog from the menu', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Abc/ }));
    await user.click(screen.getByRole('menuitem', { name: /New workspace/ }));

    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('closes the menu behind the dialog, so the two are never both open', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Abc/ }));
    await user.click(screen.getByRole('menuitem', { name: /New workspace/ }));

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('passes the trimmed name to the caller', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Abc/ }));
    await user.click(screen.getByRole('menuitem', { name: /New workspace/ }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '  Client A  ');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(onCreate).toHaveBeenCalledWith('Client A');
  });

  it('refuses an empty name without calling the caller', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Abc/ }));
    await user.click(screen.getByRole('menuitem', { name: /New workspace/ }));
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('name');
  });

  it('keeps the dialog open and shows why when creation fails', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockRejectedValue(new Error('Only an account owner can create a workspace.'));
    renderSwitcher({ onCreate });

    await user.click(screen.getByRole('button', { name: /Abc/ }));
    await user.click(screen.getByRole('menuitem', { name: /New workspace/ }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Client A');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('Only an account owner');
  });

  it('keeps focus in the name field across every keystroke', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: /Abc/ }));
    await user.click(screen.getByRole('menuitem', { name: /New workspace/ }));
    const field = screen.getByRole('textbox', { name: 'Name' });
    await user.click(field);
    await user.keyboard('Client A');

    expect(field.value).toBe('Client A');
    expect(document.activeElement).toBe(field);
  });
});
