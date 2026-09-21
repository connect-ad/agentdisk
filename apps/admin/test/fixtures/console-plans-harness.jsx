/**
 * The plan editor where it actually lives: inside the console shell, on the
 * Plans screen, opened by clicking Edit.
 *
 * The plan-editor harness beside this one mounts `PlanEditor` alone at the
 * document root, and it passed while the deployed console collapsed the same
 * dialog to a few rows. Whatever the difference was, it lived in everything
 * around the dialog rather than in it - so this fixture keeps everything
 * around it: `React.StrictMode`, the `Shell`, the `Plans` screen and its data
 * loading. Only the network is replaced, by the browser check routing
 * `/v1/admin/plans` to a fixture response.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from '../../src/components/Shell.jsx';
import { Plans } from '../../src/screens/Plans.jsx';
import '../../src/app.css';

const admin = { email: 'harness@agentdisk.io', role: 'super_admin' };

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Shell
      admin={admin}
      path="/plans"
      onNavigate={() => {}}
      onSignOut={() => {}}
      title="Plans"
      subtitle="Plan definitions and their Stripe mapping."
    >
      <Plans role={admin.role} onToast={() => {}} />
    </Shell>
  </React.StrictMode>
);
