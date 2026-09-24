import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Panel, DataTable, Select, Input, Button, Icon, Badge, Alert, EmptyState,
  Modal, Toast, Checkbox
} from '../components/index.js';
import { useResource } from '../lib/useResource.js';
import { useWorkspace } from '../lib/workspace.jsx';
// The one public copy of the pricing numbers. The server sends only
// `purchasable` — a list of plan ids — and deliberately restates no prices, so
// this module is where every figure on the picker comes from.
import { COUNTING_NOTE, PLANS } from '../lib/pricing.js';

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
  const { status, data, error, reload } = useResource(loadMembers, [], 'members');

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
      const count = result.keysDisabled ?? result.keysRevoked ?? 0;
      setToast(
        count > 0
          ? `${target.email} removed, ${count} key(s) disabled`
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
          label="Also disable every API key they created here"
          description="Any agent still using one stops working immediately. You can enable a key again later, which issues it a new value. Leave this on unless you know a key is shared team infrastructure rather than theirs."
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
  { name: 'Cloudflare', purpose: 'Object storage (R2), database (D1), compute (Workers), CDN, transactional email', region: 'Global edge' },
  { name: 'Google (Firebase Authentication)', purpose: 'Sign-in, password storage, and session tokens', region: 'US / Global' },
  { name: 'Stripe', purpose: 'Payment processing and invoicing', region: 'US / EU' }
];

/**
 * How many workspaces this person is the *only* owner of.
 *
 * It cannot be read off `listWorkspaces`, which knows the caller's own role but
 * not how many other owners a workspace has — so each owned workspace needs its
 * member list. The fan-out is bounded by the number of workspaces somebody
 * owns, and it runs only when the Privacy tab is opened.
 *
 * A workspace whose members cannot be read is counted as *not* solely owned.
 * Guessing the other way would block account deletion on a request that simply
 * failed.
 */
async function loadSoleOwnership(api) {
  const { workspaces = [] } = await api.listWorkspaces();
  const owned = workspaces.filter(w => w.role === 'owner');

  const counts = await Promise.all(
    owned.map(async w => {
      try {
        const { members = [] } = await api.listMembers(w.id);
        return members.filter(m => m.role === 'owner').length;
      } catch {
        return 0;
      }
    })
  );

  return { soleOwnerOf: counts.filter(owners => owners === 1).length };
}

export function PrivacyTab() {
  // Computed, never passed in. Settings.jsx used to hand this a literal 0, so
  // the "only owner" block could not render and the button it gates could not
  // disable -- a guard that was permanently off while looking present.
  const { data } = useResource(loadSoleOwnership, [], 'sole-ownership');
  const soleOwnerOf = data?.soleOwnerOf ?? 0;

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
          <dt>File contents</dt><dd>Stored in Cloudflare R2 and encrypted at rest.</dd>
          <dt>File metadata</dt><dd>Path, size, MIME type, checksum, and which agent wrote it.</dd>
          <dt>Audit events</dt><dd>Actor, action, resource, source IP and client string. Kept for the life of the workspace; raw request logs are deleted or aggregated after about 90 days.</dd>
          <dt>Account data</dt><dd>Your email address, your display name, and the account identifier Firebase issues for you. <strong>No password.</strong> Firebase Authentication owns sign-in, so one never reaches AgentDisk to be stored or hashed.</dd>
          <dt>API keys</dt><dd>Stored only as a hash. We cannot recover a key you lose.</dd>
          <dt>When you delete</dt><dd>A single file is erased <strong>immediately</strong> — there is no recycle bin. Deleting a workspace or an account destroys its keys, agents and structure at once, and erases the files seven days later. Nothing is recoverable in that window.</dd>
          <dt>Invoices</dt><dd>Kept for seven years, because tax law requires it. They hold your billing name, address and amounts — nothing else about your account. Your saved card is removed the moment you close the account.</dd>
        </dl>
      </Panel>

      <Panel flush title="Sub-processors">
        <DataTable columns={columns} rows={SUBPROCESSORS} rowKey="name" />
      </Panel>

      {/*
        P0-1. This opened a modal announcing "We'll email you a download link
        within 24 hours" and then did nothing at all -- no job, no request, no
        record that anybody had asked. Nothing in the product could have honoured
        it: there is no export endpoint, and no delivery path wired to send one.

        Disabled rather than removed, because unlike Move or Download-as-zip this
        is a right the privacy policy grants (§13) and will be built. A disabled
        control with a reason says "not yet"; a success message said "done".
      */}
      <Panel
        title="Your data"
        footer={<Button variant="secondary" disabled>Export my data</Button>}
      >
        <p className="ad-small ad-measure">
          An export would include your files, their metadata, and your audit history as a
          single archive.
        </p>
        <Alert tone="warn" title="Not available yet">
          Self-service export is not built. Your files and metadata can be retrieved
          today through the API, which is the same data an archive would contain.
          <br />
          <Link to="/privacy">Privacy policy §13 and §18</Link> cover the right itself
          and where to send a request.
        </Alert>
      </Panel>

      <section aria-label="Danger zone">
        {/* Same stack as the two other danger zones — alerts sitting directly on
            a destructive button — so it takes the same spacing class. */}
        <Panel title="Delete my account" className="danger-zone">
          <Alert tone="danger" title="This is separate from deleting a workspace">
            Deleting your account removes your profile, sessions and personal data.
          </Alert>
          {soleOwnerOf > 0 ? (
            <Alert tone="warn" title="You are the only owner of a workspace">
              You&rsquo;re the only owner of {soleOwnerOf} workspace
              {soleOwnerOf === 1 ? '' : 's'}. Transfer ownership or delete
              {soleOwnerOf === 1 ? ' it' : ' them'} first &mdash; deleting your account
              cannot orphan a workspace other people may still be working in.
            </Alert>
          ) : null}
          {/*
            P0-2. This set a toast reading "Account deletion scheduled" and
            scheduled nothing. Of the two false promises on this screen it was the
            worse one: somebody who believes their account is being deleted stops
            taking any other step to protect it.

            Deleting an account is not just a row -- it has to settle the
            workspaces they solely own, their agents' live keys and an open Stripe
            subscription. None of that is built, so the control stays off.
          */}
          <Alert tone="warn" title="Not available yet">
            Self-service account deletion is not built. You can delete a workspace and
            everything in it today from Settings &rarr; General, and revoke every key
            from the API keys screen. <Link to="/privacy">Privacy policy §13 and §18</Link>
            cover the right itself and where to send a request.
          </Alert>
          <div>
            <Button variant="danger" disabled>
              Delete my account
            </Button>
          </div>
        </Panel>
      </section>

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

const STATUS_TONE = {
  active: 'ok', past_due: 'warn', canceled: 'danger', expired: 'warn'
};
const STATUS_LABEL = {
  active: 'Active',
  past_due: 'Payment overdue',
  canceled: 'Canceled',
  // The state manual renewal actually produces. Named for what happened rather
  // than for what it costs — "Expired" is a fact, "Blocked" would be a verdict.
  expired: 'Expired'
};

/** "14 October 2026", matching the wording the renewal emails use. */
function planDate(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return new Date(at).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

/**
 * What a plan card offers, given who is looking and where the period stands.
 *
 * All of it in one function, because the interesting cases are the
 * combinations — an expired owner looking at a plan that is not theirs, a
 * reader looking at anything — and spreading those across JSX conditionals is
 * how one of them ends up unreachable.
 *
 * Returns `{ label, action }`, where a null action means render no button.
 * `action` is 'checkout' or 'portal'; nothing else exists.
 */
function cardAction(plan, billing, purchasable, isOwner) {
  if (!isOwner) return { label: null, action: null };

  const isCurrent = plan.id === billing?.plan;
  const hasSubscription = billing?.subscribed === true;

  // A real Stripe subscription, from before manual renewal or made by hand.
  // Checkout refuses these outright, so the only honest offer is the portal.
  if (hasSubscription) {
    return isCurrent
      ? { label: 'Manage subscription', action: 'portal' }
      : { label: 'Change plan', action: 'portal' };
  }

  // Free is the absence of a purchase. There is nothing to buy, and leaving a
  // paid plan means letting it lapse rather than pressing a button here.
  if (plan.id === 'free') return { label: null, action: null };

  // The catalogue has the plan but this environment has no Stripe price for
  // it, which means the sync has not run. Saying so beats a button whose only
  // possible outcome is a 500.
  if (!purchasable.includes(plan.id)) {
    return { label: 'Not available yet', action: null, disabled: true };
  }

  if (isCurrent) {
    // Only inside the last seven days, or once it has lapsed. The server
    // decides this — `renewalOpen` — so a clock-skewed browser cannot offer a
    // button that is about to be refused.
    return billing?.renewalOpen
      ? { label: 'Renew', action: 'checkout' }
      : { label: null, action: null };
  }

  // Switching plans mid-period is refused server-side, because proration is
  // out of scope. Said in words on the card rather than discovered on a 409.
  if (billing?.renewalOpen === false) return { label: null, action: null };

  return { label: 'Subscribe', action: 'checkout' };
}

/**
 * When this plan runs out, and what happens then.
 *
 * Under manual renewal this is the fact a customer most needs and the one the
 * product was least able to tell them — there was no column for it until
 * migration 0027. Free accounts get nothing here rather than a reassuring
 * "never expires", because they have no period at all and inventing one would
 * be the same kind of lie in the other direction.
 */
function RenewalLine({ billing }) {
  const ends = planDate(billing?.periodEndsAt);
  if (ends === null) return null;

  const graceEnds = planDate(billing?.graceEndsAt);

  if (billing?.status === 'expired') {
    return (
      <p className="plan__note">
        <strong>Ended {ends}.</strong> Uploads are paused and everything you have stored
        stays readable.{' '}
        {graceEnds === null
          ? null
          : `Renew before ${graceEnds} to keep it — after that this account's data is scheduled for deletion.`}
      </p>
    );
  }

  return (
    <p className="plan__note">
      <strong>Ends {ends}.</strong> This plan does not renew automatically — we never
      charge a card without you asking. We will email you a week before.
    </p>
  );
}

export function BillingTab() {
  const { api, workspaceId, role, workspaceSlug } = useWorkspace();
  const { status, data, error, reload } = useResource(loadBilling, [], 'billing');
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(null);
  /**
   * Which card is mid-checkout, by plan id.
   *
   * A single boolean would spin every button on the grid at once, which reads
   * as "the whole page is thinking" rather than "the thing you pressed is".
   */
  const [buying, setBuying] = useState(null);

  const billing = data?.billing;
  const isOwner = role === 'owner';
  const purchasable = data?.purchasable ?? [];

  const startCheckout = async planId => {
    setBuying(planId); setOpenError(null);
    try {
      const { url } = await api.createCheckoutSession(workspaceId, planId);
      // Same tab, matching openPortal: this is a checkout-shaped flow and a
      // blocked popup here reads as a broken button.
      window.location.assign(url);
    } catch (err) {
      setOpenError(`${err.message}${err.requestId ? ` (request ${err.requestId})` : ''}`);
      setBuying(null);
    }
  };

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
          {/* The single most important fact on this screen under manual
              renewal: when it runs out, and that nothing will renew it. */}
          <RenewalLine billing={billing} />

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

      <Panel
        title="All plans"
        subtitle="Pick a plan to subscribe. Each purchase covers one month and does not renew on its own."
      >
        <div className="plan plan--picker">
          {PLANS.map(plan => {
            const offer = cardAction(plan, billing, purchasable, isOwner);
            const isCurrent = plan.id === billing?.plan;
            return (
              <section
                key={plan.id}
                className={`plan__card${isCurrent ? ' plan__card--accent' : ''}`}
              >
                <h4 className="plan__eyebrow">{plan.kicker}</h4>
                <div className="plan__head">
                  <span className="plan__name">{plan.price}</span>
                  <span className="plan__unit">{plan.unit}</span>
                </div>

                {/* A word, never a tint alone. "Your plan" rather than
                    "Current plan", which the hero card above already uses as
                    its eyebrow — two elements with the same words on one
                    screen read as a rendering mistake. */}
                {isCurrent ? <Badge tone="ok" dot>Your plan</Badge> : null}

                <ul className="plan__lines">
                  {plan.lines.map(line => (
                    <li key={line}>
                      <Icon name="check" size={15} aria-hidden="true" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>

                <div className="plan__foot">
                  {offer.label === null ? null : (
                    <Button
                      variant={isCurrent ? 'primary' : 'secondary'}
                      disabled={offer.disabled === true}
                      loading={buying === plan.id}
                      onClick={
                        offer.action === 'checkout'
                          ? () => startCheckout(plan.id)
                          : offer.action === 'portal'
                            ? openPortal
                            : undefined
                      }
                    >
                      {offer.label}
                    </Button>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        <p className="ad-meta plan__promo">
          {/* No field and no endpoint. Stripe's own page carries the promotion
              code box — `allow_promotion_codes` at checkout — and validating a
              code here would mean passing `discounts` instead, which Stripe
              refuses to accept alongside it. */}
          Have a promo code? Enter it on the payment page after you choose a plan.
        </p>

        <p className="ad-meta">{COUNTING_NOTE}</p>
      </Panel>

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
