/**
 * The docs page is written by hand from the code, so the parts most likely to
 * drift are pinned here: the section ids the TOC links to, the eleven MCP tool
 * names, the key prefix, and the fact that every client the quick start names
 * gets a config block. A docs page that names a tool the server does not
 * register, or a key prefix it has never issued, is worse than no page.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => ({ user: null, loading: false }),
}));

const { Docs, MCP_TOOLS } = await import('../src/routes/Docs.jsx');

afterEach(cleanup);

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/*" element={<Docs />} />
      </Routes>
    </MemoryRouter>
  );
}

const SECTION_IDS = [
  'overview', 'quickstart', 'features', 'data-security',
  'deleting-data', 'deleting-account', 'privacy', 'terms', 'safety', 'reference',
];

/** `apps/api/src/mcp/tools.ts`, in registration order. */
const SERVER_TOOLS = [
  'list_files', 'search_files', 'read_file', 'get_file', 'get_metadata', 'create_file',
  'update_file', 'delete_file', 'create_folder', 'move_file', 'copy_file',
];

describe('docs page', () => {
  it('renders every section the TOC links to, with a matching id', () => {
    const { container } = renderAt('/docs');
    const toc = screen.getByRole('complementary', { name: 'Documentation sections' });
    const hrefs = within(toc).getAllByRole('link').map(a => a.getAttribute('href'));
    expect(hrefs).toEqual(SECTION_IDS.map(id => `#${id}`));
    for (const id of SECTION_IDS) {
      expect(container.querySelector(`section#${id}`), id).not.toBeNull();
    }
    // Every "on this page" anchor resolves to a heading that exists.
    const rail = screen.getByRole('complementary', { name: 'On this page' });
    for (const a of within(rail).getAllByRole('link')) {
      const id = a.getAttribute('href').slice(1);
      // Ids are slugs (lowercase, digits, dashes), so no escaping is needed.
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
  });

  it('lists exactly the tools the MCP server registers, in order', () => {
    expect(MCP_TOOLS.map(t => t.name)).toEqual(SERVER_TOOLS);
    const { container } = renderAt('/docs');
    const names = [...container.querySelectorAll('.doc__toolname')].map(el => el.textContent);
    expect(names).toEqual(SERVER_TOOLS);
  });

  it('uses the prefix the API actually issues in every config block', () => {
    const { container } = renderAt('/docs');
    const code = [...container.querySelectorAll('.doc__codebody')].map(el => el.textContent).join('\n');
    expect(code).toContain('ask_live_');
    expect(code).not.toContain('adk_live');
    expect(code).toContain('/mcp');
  });

  it('offers the Claude Code command per shell, Bash first, and swaps the block on click', async () => {
    const { container } = renderAt('/docs');
    const block = container.querySelector('#client-claude-code');
    const tabs = within(block).getAllByRole('tab').map(t => t.textContent);
    expect(tabs).toEqual(['Bash / zsh', 'PowerShell', 'cmd']);

    const body = () => within(block).getByRole('tabpanel').textContent;
    expect(body()).toContain('export AGENTDISK_KEY=');

    await userEvent.click(within(block).getByRole('tab', { name: 'PowerShell' }));
    expect(body()).toContain('$env:AGENTDISK_KEY = ');
    expect(body()).toContain('Bearer $env:AGENTDISK_KEY');
    expect(body()).not.toContain('export ');

    await userEvent.click(within(block).getByRole('tab', { name: 'cmd' }));
    expect(body()).toContain('set AGENTDISK_KEY=');
    expect(body()).toContain('%AGENTDISK_KEY%');

    // Every shell registers the same server at the same URL with the same key.
    for (const tab of ['Bash / zsh', 'PowerShell', 'cmd']) {
      await userEvent.click(within(block).getByRole('tab', { name: tab }));
      expect(body()).toContain('claude mcp add --transport http agentdisk');
      expect(body()).toContain('/mcp');
      expect(body()).toContain('ask_live_');
    }
  });

  it('tells a Claude Code user what to expect, how to validate, and how to start clean', () => {
    const { container } = renderAt('/docs');
    const text = container.querySelector('#client-claude-code').textContent;
    // The masked header is explained as masking, not as a failure.
    expect(text).toContain('"Authorization": "[REDACTED]"');
    expect(text).toMatch(/not an error/);
    // Validation names the commands and the tool counts the scope filter produces.
    expect(text).toContain('claude mcp get agentdisk');
    expect(text).toContain('claude mcp list');
    expect(text).toMatch(/five tools/);
    expect(text).toMatch(/eleven/);
    // A clean start is remove then add, and the scope flags are named.
    expect(text).toContain('claude mcp remove agentdisk');
    expect(text).toMatch(/-s user/);
    expect(text).toMatch(/-s project/);
  });

  it('gives every named client its own configuration block', () => {
    const { container } = renderAt('/docs');
    for (const id of ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'windsurf', 'zed', 'codex', 'gemini', 'any-client']) {
      const block = container.querySelector(`#client-${id}`);
      expect(block, id).not.toBeNull();
      expect(block.querySelector('.doc__codebody'), id).not.toBeNull();
    }
    // The two clients that cannot take a URL get the bridge, not a config that fails.
    expect(container.querySelector('#client-claude-desktop').textContent).toContain('mcp-remote');
    expect(container.querySelector('#client-claude-code').textContent).toContain('"type": "http"');
  });

  it('says deletion is permanent and the account closes in seven days', () => {
    renderAt('/docs');
    expect(screen.getByRole('heading', { name: 'Deleting your data' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Deleting your account' })).toBeTruthy();
    expect(screen.getAllByText(/"permanent": true/).length).toBeGreaterThan(0);
    // The account-deletion process is a timeline, and day seven is its accent step.
    const flow = screen.getByRole('list', { name: 'Account deletion, step by step' });
    expect(within(flow).getAllByRole('listitem').length).toBe(7);
    expect(within(flow).getByText('Day 7')).toBeTruthy();
  });

  it('names no infrastructure vendor outside the processors table', () => {
    const { container } = renderAt('/docs');
    const article = container.querySelector('article');
    const text = article.textContent;
    // The processors table is a privacy disclosure and may name companies; the
    // rest of the page describes the architecture in generic terms.
    expect(text).not.toMatch(/\bR2\b|\bD1\b|Turnstile|\bWorkers?\b|Terraform/);
  });

  it('guides a first-timer from the sandbox to a claim, for the tool they pick', async () => {
    const user = userEvent.setup();
    const { container } = renderAt('/docs');
    const guideOut = () => within(container.querySelector('.doc__guide'));
    expect(screen.getByText('Pick a goal to get a path written for it.')).toBeTruthy();
    await user.click(screen.getByLabelText(/Try it with no account/));
    expect(screen.getByText('Now pick the tool you use.')).toBeTruthy();
    await user.click(screen.getByLabelText('Cursor'));
    expect(guideOut().getByText('Add AgentDisk to Cursor')).toBeTruthy();
    expect(guideOut().getByRole('link', { name: /Open the sandbox/ }).getAttribute('href')).toBe('/sandbox');
    expect(guideOut().getByText('KEEP WHAT YOU BUILT')).toBeTruthy();
    // A script needs no client and gets the REST path instead.
    await user.click(screen.getByLabelText(/Script against the REST API/));
    expect(screen.queryByText('Which AI tool?')).toBeNull();
    expect(guideOut().getByText('WHO AM I')).toBeTruthy();
  });

  it('renders the same page for a nested docs path', () => {
    const { container } = renderAt('/docs/safety');
    expect(container.querySelector('section#safety')).not.toBeNull();
  });
});
