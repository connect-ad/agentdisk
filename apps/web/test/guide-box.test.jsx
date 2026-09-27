/**
 * The docs' "get a path written for you" box (27 Sept 2026).
 *
 * Three things it promises: the trail beside the question reports where you
 * are; every link in the written path opens in a new tab, so the two answers
 * that produced it are not lost to a navigation; and Start over takes the box
 * back to its first question. The look is the harness's business.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => ({ user: null, loading: false }),
}));

const Docs = (await import('../src/routes/Docs.jsx')).default;

afterEach(cleanup);

function mount() {
  render(<MemoryRouter initialEntries={['/docs/quickstart']}><Docs /></MemoryRouter>);
  return screen.getByRole('group', { name: 'Get a path written for you' });
}

const trail = box => within(box).getByRole('list', { name: 'Progress' });

describe('the guide box', () => {
  it('starts on the first stop and moves along as questions are answered', async () => {
    const user = userEvent.setup();
    const box = mount();
    const stops = () => within(trail(box)).getAllByRole('listitem').map(li => li.className);

    expect(stops()[0]).toContain('doc__guidestop--now');
    expect(stops()[1]).toContain('doc__guidestop--later');

    await user.click(within(box).getByLabelText(/Give my agent a disk/));
    expect(stops()[0]).toContain('doc__guidestop--done');
    expect(stops()[1]).toContain('doc__guidestop--now');
    expect(within(box).getByText('Now pick the tool you use.')).toBeTruthy();

    await user.click(within(box).getByLabelText('Claude Code'));
    expect(stops()[1]).toContain('doc__guidestop--done');
    expect(stops()[2]).toContain('doc__guidestop--now');
    expect(within(box).getByText('Your path', { selector: '.doc__guidehead' })).toBeTruthy();
  });

  it('skips the tool question for a script, and says so on the trail', async () => {
    const user = userEvent.setup();
    const box = mount();
    await user.click(within(box).getByLabelText(/Script against the REST API/));
    expect(within(trail(box)).getByText(/No tool needed/)).toBeTruthy();
    expect(within(box).getByText('Your path', { selector: '.doc__guidehead' })).toBeTruthy();
  });

  it('opens every link in the written path in a new tab, except the sandbox, which opens in place', async () => {
    const user = userEvent.setup();
    const box = mount();
    await user.click(within(box).getByLabelText(/Give my agent a disk/));
    await user.click(within(box).getByLabelText('Cursor'));

    const links = within(box).getAllByRole('link', { name: /opens in a new tab/ });
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noreferrer');
    }

    // The sandbox step keeps its address for a middle-click, but a plain
    // click opens the dialog here, so the two answers are not lost.
    await user.click(within(box).getByText('Start over'));
    await user.click(within(box).getByLabelText(/Try it with no account/));
    await user.click(within(box).getByLabelText('Cursor'));
    const sandbox = within(box).getByRole('link', { name: 'Get Sandbox Credentials' });
    expect(sandbox.getAttribute('href')).toBe('/sandbox');
    expect(sandbox.getAttribute('target')).toBeNull();
    await user.click(sandbox);
    expect(screen.getByRole('dialog', { name: 'Get Sandbox Credentials' })).toBeTruthy();
    expect(within(box).getByText('Add AgentDisk to Cursor')).toBeTruthy();
  });

  it('ends every MCP path with two prompts to paste: write a file, then read it back', async () => {
    const user = userEvent.setup();
    const box = mount();
    await user.click(within(box).getByLabelText(/Give my agent a disk/));
    await user.click(within(box).getByLabelText('Codex CLI'));

    expect(within(box).getByText('PROMPT 1 · WRITE A TEST FILE')).toBeTruthy();
    expect(within(box).getByText('PROMPT 2 · READ IT BACK')).toBeTruthy();
    // The prompts name the tool and stay inside the prefix step 3 asked for.
    expect(within(box).getByText(/create a file at \/agents\/<name>\/first-note\.md/)).toBeTruthy();
    expect(within(box).getByText(/Hello from Codex CLI/)).toBeTruthy();
    expect(within(box).getByText(/list the files under \/agents\/<name>/)).toBeTruthy();
  });

  it('uses an unscoped path for the sandbox, whose key has no prefix', async () => {
    const user = userEvent.setup();
    const box = mount();
    await user.click(within(box).getByLabelText(/Try it with no account/));
    await user.click(within(box).getByLabelText('Zed'));
    expect(within(box).getByText(/create a file at \/hello\/first-note\.md/)).toBeTruthy();
    expect(within(box).queryByText(/Replace <name>/)).toBeNull();
  });

  it('Start over returns to the first question', async () => {
    const user = userEvent.setup();
    const box = mount();
    await user.click(within(box).getByLabelText(/Connect my editor/));
    await user.click(within(box).getByLabelText('Zed'));
    await user.click(within(box).getByRole('button', { name: 'Start over' }));

    expect(within(box).queryByText('Your path', { selector: '.doc__guidehead' })).toBeNull();
    expect(within(box).getByText('Pick a goal to get a path written for it.')).toBeTruthy();
    expect(within(box).getByLabelText(/Connect my editor/).checked).toBe(false);
  });
});

describe('the landing page', () => {
  it('sends people straight to the quick start', async () => {
    const { Landing } = await import('../src/routes/Marketing.jsx');
    render(<MemoryRouter initialEntries={['/']}><Landing /></MemoryRouter>);
    // Twice: the hero button and the footer's Product column.
    const quick = screen.getAllByRole('link', { name: /Quick start/ });
    expect(quick.length).toBe(2);
    for (const a of quick) expect(a.getAttribute('href')).toBe('/docs/quickstart');
    expect(quick[0].classList.contains('mk__quick')).toBe(true);
    expect(screen.getByRole('link', { name: 'Read the docs' }).getAttribute('href')).toBe('/docs');
  });
});
