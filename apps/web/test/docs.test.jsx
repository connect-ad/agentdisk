/**
 * The docs page is written by hand from the code, so the parts most likely to
 * drift are pinned here: the section ids the TOC links to, the ten MCP tool
 * names, the key prefix, and the fact that every client the quick start names
 * gets a config block. A docs page that names a tool the server does not
 * register, or a key prefix it has never issued, is worse than no page.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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
  'deleting-data', 'deleting-account', 'privacy', 'safety', 'reference',
];

/** `apps/api/src/mcp/tools.ts`, in registration order. */
const SERVER_TOOLS = [
  'list_files', 'search_files', 'get_file', 'get_metadata', 'create_file',
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
    expect(screen.getAllByText(/Seven days later/).length).toBeGreaterThan(0);
  });

  it('renders the same page for a nested docs path', () => {
    const { container } = renderAt('/docs/safety');
    expect(container.querySelector('section#safety')).not.toBeNull();
  });
});
