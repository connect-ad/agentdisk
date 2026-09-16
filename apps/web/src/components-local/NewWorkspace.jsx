import React, { useState } from 'react';
import { Button, Icon, Input, Modal, Alert } from '../components/index.js';

/**
 * The create-a-workspace dialog.
 *
 * Controlled rather than self-opening: it used to own its own trigger button in
 * the topbar, which was one of three places the product offered to talk about
 * workspaces. All three are now the one switcher in the sidebar, so the thing
 * that opens this lives there — see WorkspaceSwitcher.
 *
 * `onCreate` does the creating and whatever should follow it (the caller
 * navigates into the new workspace, because creating a container and then
 * leaving you in the old one is the kind of small disorientation that makes
 * people click the button twice). This component's only jobs are the name, the
 * busy state, and putting the failure where the person who caused it is
 * looking.
 */
export default function NewWorkspace({ open, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const close = () => {
    setName('');
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (!name.trim()) { setError('Give the workspace a name.'); return; }
    setBusy(true); setError(null);
    try {
      await onCreate(name.trim());
      setName('');
      onClose();
    } catch (err) {
      // Stay open. The name is still in the field, so a failure that the person
      // can act on — "only an account owner can create a workspace" — does not
      // also cost them their typing.
      setError(`${err.message}${err.requestId ? ` (request ${err.requestId})` : ''}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Create a workspace"
      tone="accent"
      mark={<Icon name="folder" size={16} />}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button onClick={submit} loading={busy}>Create workspace</Button>
        </>
      }
    >
      {/* <Alert tone="danger"> is role="alert" already; wrapping it in another
          made the failure announce twice. */}
      {error ? <Alert tone="danger" title={error} /> : null}
      <Input
        label="Name"
        required
        placeholder="Client A"
        hint="Files, agents and keys are kept entirely separate between workspaces. Billing is not — every workspace you own is on the same account."
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); }}
      />
    </Modal>
  );
}
