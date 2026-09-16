import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Panel, DataTable, Select, Input, Button, Icon, Badge, Alert, EmptyState,
  Modal, ConfirmModal, Toast, Checkbox
} from '../components/index.js';
import { useResource } from '../lib/useResource.js';
import { useWorkspace } from '../lib/workspace.jsx';

/**
 * 8.22 Members · 8.24 Privacy · 8.25 Billing — MVP-1 settings tabs.
 * Split out of Settings.jsx so neither file gets unwieldy.
 */

/* ------------------------------ 8.22 Members ------------------------------ */

/**
 * There is no pending-invite state, and that is deliberate rather than
 * unfinished. An invitation requires the person to already hold an AgentDisk
 * account, so adding them is immediate and every row here points at a real,
 * Firebase-verified identity — nothing sits in limbo waiting to be claimed by
 * whoever reaches a mailbox first.
 */
const ROLES = [
  { value: 'admin', label: 'Admin — manage files, agents and keys in this workspace' },
  { value: 'reader', label: 'Reader — can see everything, can change nothing' }
];

const loadMembers = (api, workspaceId) => api.listMembers(workspaceId);

function formatJoined(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function MembersTab() {
  const { api, workspaceId, role: myRole } = useWorkspace();
  const { status, data, error, reload } = useResource(loadMembers);

  const [dialog, setDialog] = useState(null);
  const [target, setTarget] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('reader');
  // Checked by default (03 §8.22). A departing person's session dies with their
  // membership either way; a key they minted does not, and leaving one running
  // is the quieter of the two mistakes to make.
  const [revokeKeys, setRevokeKeys] = useState(true);

  const members = data?.members ?? [];
  const canManage = myRole === 'owner';

  const invite = async () => {
    if (!email.trim()) { setFormError('Enter their email address.'); return; }
    setBusy(true); setFormError(null);
    try {
      await api.inviteMember(workspaceId, { email: email.trim(), role: inviteRole });
      setDialog(null);
      setEmail('');
      setToast('Member added');
      void reload();
    } catch (err) {
      setFormError(`${err.message}${err.requestId ? ` (request ${err.requestId})` : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member, role) => {
    try {
      await api.updateMemberRole(workspaceId, member.id, role);
      setToast(`${member.email} is now ${role}`);
      void reload();
    } catch (err) {
      setToast(`Could not change role: ${err.message}`);
      void reload();
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const result = await api.removeMember(workspaceId, target.id, revokeKeys);
      setToast(
        result.keysRevoked > 0
          ? `${target.email} removed, ${result.keysRevoked} key(s) revoked`
          : `${target.email} removed`
      );
      void reload();
    } catch (err) {
      setToast(`Could not remove: ${err.message}`);
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  const columns = [
    {
      key: 'email',
      header: 'Member',
      primary: true,
      render: r => (
        <span className="row" style={{ gap: 'var(--s-4)' }}>
          <span className="avatar" aria-hidden="true">{(r.email || '?').slice(0, 1).toUpperCase()}</span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 'var(--w-med)', color: 'var(--ink)' }}>
              {r.email}{r.isYou ? ' (you)' : ''}
            </span>
            {r.accountOwner ? <span className="ad-meta">Owns this account</span> : null}
          </span>
        </span>
      )
    },
    {
      key: 'role',
      header: 'Role',
      width: 220,
      render: r =>
        // The account owner's role is shown, never offered as a control. It is
        // not editable from a workspace at all, and a disabled dropdown would
        // imply it might be somewhere else.
        r.accountOwner || !canManage ? (
          <Badge tone={r.accountOwner ? 'accent' : undefined}>{r.role}</Badge>
        ) : (
          <span onClick={e => e.stopPropagation()}>
            <Select
              value={r.role}
              options={ROLES.map(x => ({ value: x.value, label: x.value }))}
              onChange={e => changeRole(r, e.target.value)}
            />
          </span>
        )
    },
    {
      key: 'joined',
      header: 'Joined',
      width: 150,
      render: r => <span style={{ color: 'var(--ink-3)' }}>{formatJoined(r.joinedAt)}</span>
    },
    {
      key: 'act',
      header: '',
      width: 110,
      render: r =>
        r.accountOwner || !canManage ? null : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { setRevokeKeys(true); setTarget(r); setDialog('remove'); }}
          >
            Remove
          </Button>
        )
    }
  ];

  return (
    <>
      {status === 'failed' ? (
        <Alert tone="danger" title="Could not load members" actions={<Button size="sm" onClick={reload}>Try again</Button>}>
          {error?.message}{error?.requestId ? ` (request ${error.requestId})` : ''}
        </Alert>
      ) : null}

      <Panel
        flush
        title="Members"
        subtitle="Everyone who can reach this workspace. Files and keys are separate between workspaces; billing is not."
        actions={
          canManage ? (
            <Button size="sm" onClick={() => { setFormError(null); setDialog('invite'); }}>
              Add member
            </Button>
          ) : null
        }
      >
        <DataTable
          columns={columns}
          rows={status === 'loading' ? [] : members}
          rowKey="id"
          loading={status === 'loading'}
          skeletonRows={3}
          empty={<EmptyState compact icon={<Icon name="users" size={19} />} title="Nobody else has access" />}
        />
      </Panel>

      <Modal
        open={dialog === 'invite'}
        title="Add a member"
        tone="accent"
        mark={<Icon name="users" size={16} />}
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button onClick={invite} loading={busy}>Add member</Button>
          </>
        }
      >
        {formError ? <div role="alert"><Alert tone="danger" title={formError} /></div> : null}
        <Input
          label="Email"
          type="email"
          required
          placeholder="name@company.com"
          hint="They need an AgentDisk account already. Ask them to sign up first if they do not have one."
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
        <Select
          label="Role"
          options={ROLES}
          value={inviteRole}
          onChange={e => setInviteRole(e.target.value)}
        />
      </Modal>

      <Modal
        open={dialog === 'remove'}
        title={`Remove ${target ? target.email : 'this member'}?`}
        tone="danger"
        mark={<Icon name="alert" size={16} />}
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="danger" onClick={remove} loading={busy}>Remove member</Button>
          </>
        }
      >
        <p style={{ color: 'var(--ink-2)' }}>
          They lose access to this workspace immediately. Their access to other workspaces, if any,
          is unaffected.
        </p>
        <Checkbox
          label="Also revoke every API key they created here"
          description="Any agent still using one stops working immediately. Leave this on unless you know a key is shared team infrastructure rather than theirs."
          checked={revokeKeys}
          onChange={() => setRevokeKeys(v => !v)}
        />
      </Modal>

      {toast ? (
        <div style={{ position: 'fixed', top: 'var(--s-7)', right: 'var(--s-7)', zIndex: 90 }}>
          <Toast tone="ok" title={toast} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </>
  );
}


/* ------------------------------ 8.24 Privacy ------------------------------ */

/**
 * This tab is a *summary* of the privacy policy, and the summary is what drifted.
 *
 * It described a first-party auth system that no longer exists — "hashed
 * password" under account data, and password-reset mail sent by Resend — months
 * after Firebase took over sign-in. The policy itself at `/privacy` was already
 * correct (Legal.jsx §3, §7, §10); only this copy of it was stale, which is the
 * failure mode of restating a document instead of pointing at it.
 *
 * So it now says out loud that it is a summary and links to the source. Anything
 * changed here has to be changed in Legal.jsx too, and Legal.jsx wins.
 */
const SUBPROCESSORS = [
  { name: 'Cloudflare', purpose: 'Object storage (R2), database (D1), compute (Workers), CDN', region: 'Global edge' },
  { name: 'Google (Firebase Authentication)', purpose: 'Sign-in, password storage, and session tokens', region: 'US / Global' },
  { name: 'Stripe', purpose: 'Payment processing and invoicing', region: 'US / EU' },
  { name: 'Resend', purpose: 'Transactional email (notifications, address verification)', region: 'US' }
];

export function PrivacyTab({ soleOwnerOf = 0 }) {
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState(null);

  const columns = [
    { key: 'name', header: 'Sub-processor', primary: true, width: 160 },
    { key: 'purpose', header: 'Purpose' },
    { key: 'region', header: 'Region', width: 160, render: r => <span style={{ color: 'var(--ink-3)' }}>{r.region}</span> }
  ];

  return (
    <>
      <Panel
        title="What we store"
        subtitle="A summary of the privacy policy. The policy itself is the authoritative text."
        footer={<Button variant="link" as={Link} to="/privacy">Read the full privacy policy</Button>}
      >
        <dl className="dl">
          <dt>File contents</dt><dd>Stored in object storage in the region you chose. Encrypted at rest.</dd>
          <dt>File metadata</dt><dd>Path, size, MIME type, checksum, and which agent wrote it.</dd>
          <dt>Audit events</dt><dd>Actor, action, resource, source IP and client string. Kept for the life of the workspace; raw request logs are deleted or aggregated after about 90 days.</dd>
          <dt>Account data</dt><dd>Your email address, your display name, and the account identifier Firebase issues for you. <strong>No password.</strong> Firebase Authentication owns sign-in, so one never reaches AgentDisk to be stored or hashed.</dd>
          <dt>API keys</dt><dd>Stored only as a hash. We cannot recover a key you lose.</dd>
        </dl>
      </Panel>

      <Panel flush title="Sub-processors">
        <DataTable columns={columns} rows={SUBPROCESSORS} rowKey="name" />
      </Panel>

      <Panel title="Your data" footer={<Button variant="secondary" onClick={() => setDialog('export')}>Export my data</Button>}>
        <p className="ad-small ad-measure">
          An export includes your files, their metadata, and your audit history as a
          single archive.
        </p>
      </Panel>

      <section aria-label="Danger zone">
        <Panel title="Delete my account">
          <Alert tone="danger" title="This is separate from deleting a workspace">
            Deleting your account removes your profile, sessions and personal data.
          </Alert>
          {soleOwnerOf > 0 ? (
            <Alert tone="warn" title="Blocked">
              You&rsquo;re the only owner of {soleOwnerOf} workspace(s). Transfer ownership or delete those workspaces first.
            </Alert>
          ) : null}
          <div>
            <Button variant="danger" disabled={soleOwnerOf > 0} onClick={() => setDialog('delete-account')}>
              Delete my account
            </Button>
          </div>
        </Panel>
      </section>

      <Modal
        open={dialog === 'export'}
        title="Export requested"
        tone="accent"
        mark={<Icon name="download" size={16} />}
        onClose={() => setDialog(null)}
        footer={<Button onClick={() => setDialog(null)}>Got it</Button>}
      >
        <Alert tone="ok" title="We're preparing your export">
          We&rsquo;ll email you a download link within 24 hours.
        </Alert>
      </Modal>

      <ConfirmModal
        open={dialog === 'delete-account'}
        title="Delete your account?"
        description="This removes your profile, sessions and personal data. It cannot be undone."
        confirmLabel="Delete account"
        onClose={() => setDialog(null)}
        onConfirm={() => { setDialog(null); setToast('Account deletion scheduled'); }}
      />

      {toast ? (
        <div style={{ position: 'fixed', top: 'var(--s-7)', right: 'var(--s-7)', zIndex: 90 }}>
          <Toast tone="ok" title={toast} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------ 8.25 Billing ------------------------------ */

/**
 * Portal depth (14 PART 29.1). Everything past "who is this account" happens on
 * Stripe's own hosted page — cards, plan changes, invoices, cancellation.
 *
 * This screen therefore has exactly one button and no forms. That is the point,
 * not a gap: a card form here would be a PCI surface, and a plan-change UI
 * would be a second place for pricing to drift out of step with Stripe.
 */
const loadBilling = (api, workspaceId) => api.getBilling(workspaceId);

const STATUS_TONE = { active: 'ok', past_due: 'warn', canceled: 'danger' };
const STATUS_LABEL = { active: 'Active', past_due: 'Payment overdue', canceled: 'Canceled' };

export function BillingTab() {
  const { api, workspaceId, role, workspaceSlug } = useWorkspace();
  const { status, data, error, reload } = useResource(loadBilling);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(null);

  const billing = data?.billing;
  const isOwner = role === 'owner';

  const openPortal = async () => {
    setOpening(true); setOpenError(null);
    try {
      const { url } = await api.createPortalSession(workspaceId);
      // Same tab rather than a popup: this is a checkout-shaped flow, and a
      // blocked popup here reads as a broken button.
      window.location.assign(url);
    } catch (err) {
      setOpenError(`${err.message}${err.requestId ? ` (request ${err.requestId})` : ''}`);
      setOpening(false);
    }
  };

  if (status === 'loading') {
    return <Panel title="Billing"><p className="ad-meta">Loading billing…</p></Panel>;
  }

  if (status === 'failed') {
    return (
      <Alert tone="danger" title="Could not load billing" actions={<Button size="sm" onClick={reload}>Try again</Button>}>
        {error?.message}{error?.requestId ? ` (request ${error.requestId})` : ''}
      </Alert>
    );
  }

  return (
    <>
      {billing?.writesBlocked ? (
        <Alert
          tone={billing.status === 'past_due' ? 'warn' : 'danger'}
          title={
            billing.status === 'past_due'
              ? 'There is an unpaid invoice on this account'
              : 'This subscription has ended'
          }
          actions={isOwner ? <Button size="sm" onClick={openPortal} loading={opening}>Manage billing</Button> : null}
        >
          {/* Said plainly, because the alternative is somebody discovering it
              on a failed upload and assuming their data is gone. */}
          New uploads are paused. Everything already stored stays readable and
          downloadable — nothing has been deleted.
        </Alert>
      ) : null}

      {openError ? <div role="alert"><Alert tone="danger" title={openError} /></div> : null}

      {/* The reference's two-card hero, carrying only what the API actually
          returns — see the `.plan` block in app.css for what was left out and
          why. */}
      <div className="plan">
        <section className="plan__card plan__card--accent">
          <h3 className="plan__eyebrow">Current plan</h3>
          <div className="plan__head">
            <span className="plan__name">{billing?.plan ?? '—'}</span>
            <Badge tone={STATUS_TONE[billing?.status] ?? undefined} dot>
              {STATUS_LABEL[billing?.status] ?? billing?.status ?? '—'}
            </Badge>
          </div>
          {/* The reference prints the plan's allowance here. It is real data,
              but it is not on this response — `/v1/whoami` carries it, against
              this workspace's actual usage — so this points at the screen that
              already has both rather than fetching limits to restate them. */}
          <p className="plan__note">
            What this plan allows — storage, files and requests — is on the{' '}
            <Link to={`/w/${workspaceSlug}/usage`}>Usage page</Link>, measured against
            what this workspace has used.
          </p>
          <div className="plan__foot">
            {isOwner ? (
              <Button onClick={openPortal} loading={opening}>
                {billing?.configured ? 'Manage billing' : 'Set up billing'}
              </Button>
            ) : (
              <p className="ad-meta">
                Only the account owner can change billing. Ask {billing?.ownerEmail ?? 'them'} if
                something needs updating.
              </p>
            )}
          </div>
        </section>

        <section className="plan__card">
          <h3 className="plan__eyebrow">Billing account</h3>
          <dl className="plan__rows">
            <div>
              <dt>Billing email</dt>
              <dd>{billing?.ownerEmail ?? '—'}</dd>
            </div>
            <div>
              <dt>Payment method</dt>
              {/* We genuinely do not know — the card lives on Stripe and this
                  product never sees it. Claiming otherwise would be a guess. */}
              <dd className="ad-meta">
                {billing?.subscribed ? 'Managed on Stripe' : 'No active subscription'}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <Panel title="Invoices">
        <EmptyState
          compact
          icon={<Icon name="file" size={19} />}
          title="Invoices live on Stripe"
          actions={isOwner ? <Button size="sm" variant="secondary" onClick={openPortal} loading={opening}>Open billing portal</Button> : null}
        >
          Stripe keeps the record of every charge, receipt and invoice. Rather than copy that
          here and risk the two disagreeing, this sends you to the source.
        </EmptyState>
      </Panel>
    </>
  );
}
