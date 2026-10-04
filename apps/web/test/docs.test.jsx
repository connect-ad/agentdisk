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
        <Route path="/sandbox" element={<Docs sandbox />} />
      </Routes>
    </MemoryRouter>
  );
}

const SECTION_IDS = [
  'overview', 'quickstart', 'api', 'features', 'data-security',
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

  it('documents the API with the field names and ID prefixes the handlers use', async () => {
    const { container } = renderAt('/docs');
    const section = container.querySelector('section#api');
    const code = [...section.querySelectorAll('.doc__codebody')].map(el => el.textContent).join('\n');

    // `routes/files.ts` refuses unknown fields, so a wrong name here is a 400.
    expect(code).toContain('"mimeType"');
    expect(code).not.toContain('contentType');
    // `lib/ids.ts`: files are fil_, never file_.
    expect(code).toContain('fil_');
    expect(code).not.toMatch(/"file_/);
    // Every area a key can operate has a worked example.
    for (const route of ['/v1/whoami', '/v1/files', '/v1/search', '/v1/folders', '/v1/agents', '/v1/keys', '/v1/shares', '/v1/webhooks', '/v1/activity']) {
      expect(code, route).toContain(route);
    }
    // The upload is three steps: declare, PUT, complete.
    expect(code).toContain('"sizeBytes"');
    expect(code).toContain('/complete');
    expect(code).toContain('recursive=true');

    const script = within(section).getAllByRole('tablist').at(-1);
    expect(within(script).getAllByRole('tab').map(t => t.textContent)).toEqual(['Python', 'Node', 'Bash + jq']);
    await userEvent.click(within(script).getByRole('tab', { name: 'Node' }));
    const panels = within(section).getAllByRole('tabpanel');
    expect(panels.at(-1).textContent).toContain('process.env.AGENTDISK_KEY');
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
    const block = container.querySelector('#client-claude-code');
    const text = block.textContent;
    // In the order a person meets them: the output follows the command that
    // produces it, and the file the command writes comes last.
    const captions = [...block.querySelectorAll('.doc__codecap')].map(el => el.textContent);
    expect(captions).toEqual([
      'TERMINAL', 'EXPECTED OUTPUT', 'VALIDATE', 'ALREADY EXISTS · CLEAN START', '.MCP.JSON (EQUIVALENT)',
    ]);
    // The masked header is explained as masking, not as a failure.
    expect(text).toContain('"Authorization": "[REDACTED]"');
    expect(text).toMatch(/not an error/);
    // Validation shows the stored entry only. Proving the handshake is step 4,
    // so the list command and /mcp are not repeated inside step 2.
    expect(text).toContain('claude mcp get agentdisk');
    expect(text).not.toContain('claude mcp list');
    expect(text).not.toContain('inside a session');
    expect(text).toMatch(/step 4/);
    // A clean start is remove then add, and the scope flags are named.
    expect(text).toContain('claude mcp remove agentdisk');
    expect(text).toMatch(/-s user/);
    expect(text).toMatch(/-s project/);
    // The three leads after the command are exceptions, not steps: each is an
    // Info note, named in a word so the tint is not the only signal.
    const notes = [...block.querySelectorAll('.doc__note')];
    expect(notes).toHaveLength(3);
    for (const n of notes) expect(n.querySelector('.doc__notelabel').textContent).toBe('Info');
    expect(notes[0].textContent).toMatch(/not an error/);
    expect(notes[1].textContent).toMatch(/step 4/);
    expect(notes[2].textContent).toMatch(/already registered/);
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
    // Step 1 says what a sandbox gives and why both parts are kept safe, and
    // its link opens the dialog in place rather than leaving the page.
    const step1 = guideOut().getByText('Get Sandbox access').closest('.doc__guidestep');
    expect(step1.textContent).toMatch(/API key/);
    expect(step1.textContent).toMatch(/claim link/);
    expect(step1.textContent).toMatch(/keep them private/);
    expect(step1.textContent).toMatch(/three days/);
    expect(step1.textContent).toMatch(/key stops working/);
    const open = guideOut().getByRole('link', { name: 'Get Sandbox Credentials' });
    expect(open.getAttribute('href')).toBe('/sandbox');
    expect(open.getAttribute('target')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(open);
    expect(screen.getByRole('dialog', { name: 'Get Sandbox Credentials' })).toBeTruthy();
    // The path that produced it is still on the page underneath.
    expect(guideOut().getByText('Add AgentDisk to Cursor')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(guideOut().getByText('KEEP WHAT YOU BUILT')).toBeTruthy();
    // A script needs no client and gets the REST path instead.
    await user.click(screen.getByLabelText(/Script against the REST API/));
    expect(screen.queryByText('Which AI tool?')).toBeNull();
    expect(guideOut().getByText('WHO AM I')).toBeTruthy();
  });

  it('opens /sandbox as the docs with the dialog already up, and closing lands on the Quick start', async () => {
    const user = userEvent.setup();
    const { container } = renderAt('/sandbox');
    // The page underneath is the docs, not a shell of its own.
    expect(container.querySelector('section#quickstart')).not.toBeNull();
    expect(screen.getByRole('dialog', { name: 'Get Sandbox Credentials' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('section#quickstart')).not.toBeNull();
  });

  it('renders the same page for a nested docs path', () => {
    const { container } = renderAt('/docs/safety');
    expect(container.querySelector('section#safety')).not.toBeNull();
  });
});
