/**
 * The real plan editor, open on the Limits tab.
 *
 * The other two fixtures ask whether the Modal *primitive* bounds itself. This
 * one asks the question that actually went wrong on `admin-dev`: with nine
 * limit rows in it, does the dialog stay the height it was asked for and scroll
 * the body, or does it grow to fit them and carry its own header off the top of
 * the screen?
 *
 * It drives `PlanEditor` rather than a stand-in with roughly the same rows,
 * because the number that matters - how many rows are visible above the fold -
 * is a property of the real header, the real tab strip, the real intro
 * paragraph and the real footer, and a copy of those drifts from them.
 */

import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PlanEditor } from '../../src/screens/Plans.jsx';
import '../../src/app.css';

/** The shape `Plans` hands the editor, with the dev environment's Free values. */
const PLAN = {
  id: 'agentdisk-free',
  name: 'AgentDisk Free',
  description: 'For trying it out.',
  amount_cents: 0,
  storage_bytes: 1073741824,
  max_file_bytes: 104857600,
  agents: 1,
  members: 1,
  workspaces: 1,
  api_keys: 2,
  file_count: -1,
  egress_bytes_period: -1,
  requests_period: -1,
  priority_support: 0,
  is_public: 1,
  is_default: 1,
  sort_order: 0
};

function Harness() {
  // The editor opens on the Plan tab; the rows under test are on the other one.
  // Clicking it here rather than exposing a prop keeps the fixture honest about
  // how somebody reaches that tab.
  useEffect(() => {
    const limits = Array.from(document.querySelectorAll('[role="tab"]')).find(
      tab => tab.textContent === 'Limits'
    );
    limits?.click();
  }, []);

  return (
    <PlanEditor
      plan={PLAN}
      open
      busy={false}
      error={null}
      onCancel={() => {}}
      onSubmit={() => {}}
      canRetire
      onRetire={() => {}}
    />
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
