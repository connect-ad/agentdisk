/**
 * The console shell with almost nothing in it.
 *
 * This fixture exists to catch a scrollbar that no content asked for. `:root`
 * carries `zoom: 1.25`, and `vh` does not participate in zoom -- so a shell
 * bounded by `min-height: 100vh` laid out one window tall and then painted
 * 1.25 windows tall, giving every screen in the console a permanent vertical
 * scrollbar at every window size. `/admin`, one table, a quarter of a window
 * of scroll below it.
 *
 * The content here is deliberately tiny. A fixture with enough in it to fill
 * the window could not tell a phantom scrollbar from an honest one.
 *
 * jsdom cannot answer this: it parses the declarations and never lays them
 * out, and the declarations looked right for as long as the bug existed.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from '../../src/components/Shell.jsx';
import '../../src/app.css';

const ADMIN = { id: 'stf_fixture', email: 'fixture@agentdisk.io', role: 'super_admin' };

function Harness() {
  return (
    <Shell
      admin={ADMIN}
      path="/admin"
      counts={{ workspaces: 17 }}
      attention={0}
      onNavigate={() => {}}
      onSignOut={() => {}}
      title="Admin accounts"
      subtitle="Internal accounts and their roles."
    >
      <div data-fixture-content style={{ fontSize: '13px', color: 'var(--tx2)' }}>
        One short line, so anything that scrolls is the shell and not the page.
      </div>
    </Shell>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
