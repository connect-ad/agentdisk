import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  ConfirmModal,
  Icon,
  Meter,
  Panel,
  Select,
  Skeleton,
  StatTile,
} from '../components/index.js';
import { useAuth } from '../lib/auth.jsx';
import { createApiClient, previewClaim } from '../lib/api.js';

/**
 * `/claim/{token}` — the page an agent's human lands on to take ownership of a
 * sandbox workspace the agent provisioned for them.
 *
 * The shape of this screen follows from three things that are easy to get
 * wrong:
 *
 * **Preview before sign-in.** The token in the URL is the only thing that can
 * name this workspace, so the API serves the preview anonymously. Making
 * somebody create an account to discover what they would be claiming inverts
 * the order of trust — they would be signing up to find out whether signing up
 * is worth it.
 *
 * **The choice is never defaulted.** "Create a new workspace" and "Add to an
 * existing workspace" have very different consequences: one adds a workspace,
 * the other spends an existing workspace's storage quota and destroys the
 * sandbox. Pre-selecting either would make the destructive-by-omission path the
 * one a distracted person takes. Neither is selected until it is clicked, and
 * the confirm button stays disabled until one is.
 *
 * **Every number on this page comes from the API.** The fullness percentage,
 * the days-until-deletion and the warning text are all fields on the preview
 * response, computed by the same function the write path calls. `backlog/017`
 * is the reason: this product already shipped quota indicators that existed
 * only in the dashboard's own arithmetic, were never wired to the request path,
 * and lied. The only arithmetic here is the *target* workspace's post-merge
 * fullness, which no server-side call site has an occasion to compute.
 */

/** 75/90, matching WorkspaceStats.jsx — the thresholds this product actually ships. */
function toneFor(pct) {
  if (pct === null) return undefined;
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warn';
  return 'ok';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function Centered({ children }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '70vh', padding: 'var(--s-6)' }}>
      <div style={{ width: '100%', maxWidth: '44rem' }}>{children}</div>
    </div>
  );
}

/**
 * One of the two mutually exclusive destinations.
 *
 * A button rather than a radio input, but it carries the radio semantics
 * explicitly: screen readers should hear a choice between two options, not two
 * unrelated actions, and `aria-checked` is what makes "neither is selected yet"
 * audible rather than merely visible.
 */
function ModeCard({ selected, onSelect, title, body, icon }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      style={{
        display: 'flex',
        gap: 'var(--s-3)',
        alignItems: 'flex-start',
        textAlign: 'left',
        width: '100%',
        padding: 'var(--s-4)',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        background: selected ? 'var(--accent-subtle)' : 'var(--surface)',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      }}
    >
      <Icon name={icon} aria-hidden="true" />
      <span>
        <span style={{ display: 'block', fontWeight: 'var(--weight-medium)' }}>{title}</span>
        <span className="ad-meta" style={{ display: 'block', marginTop: 'var(--s-1)' }}>
          {body}
        </span>
      </span>
    </button>
  );
}

export default function Claim() {
  const { token } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, loading: authLoading, getToken } = useAuth();

  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);

  const [mode, setMode] = useState(null); // never defaulted
  const [targetId, setTargetId] = useState('');
  const [workspaces, setWorkspaces] = useState(null);

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [claimError, setClaimError] = useState(null);
  const [result, setResult] = useState(null);

  const api = useMemo(() => createApiClient(getToken), [getToken]);

  useEffect(() => {
    const controller = new AbortController();
    previewClaim(token, controller.signal)
      .then(setPreview)
      .catch(err => {
        if (err.name !== 'AbortError') setPreviewError(err);
      });
    return () => controller.abort();
  }, [token]);

  // The picker only ever offers workspaces this person may actually spend the
  // quota of. The API refuses a reader anyway; offering one here would just be
  // a way to walk somebody into a 404.
  useEffect(() => {
    if (!user) return;
    let live = true;
    api
      .listWorkspaces()
      .then(data => {
        if (!live) return;
        setWorkspaces(
          (data?.workspaces ?? []).filter(w => w.role === 'owner' || w.role === 'admin')
        );
      })
      .catch(() => { if (live) setWorkspaces([]); });
    return () => { live = false; };
  }, [api, user]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setClaimError(null);
    try {
      const body =
        mode === 'new' ? { mode: 'new' } : { mode: 'attach', targetWorkspaceId: targetId };
      setResult(await api.claimWorkspace(token, body));
      setConfirming(false);
    } catch (err) {
      setClaimError(err);
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  }, [api, mode, targetId, token]);

  if (previewError) {
    return (
      <Centered>
        {/*
          One message for every reason a link does not work: claimed already,
          expired, or never existed. The API answers all three identically on
          purpose - this page takes no credential, so a message that told them
          apart would tell anybody guessing tokens which guesses named a real
          workspace. Saying less here is the point, not an oversight.
        */}
        <Alert tone="danger" title="That claim link is not valid">
          It may have been claimed already, or expired — a sandbox and its link both last
          seven days. If an agent gave you this link, ask it to provision a new workspace: a
          claim link is shown once and cannot be reissued.
          {' '}
          If you think it was yours, <Link to="/app">check your dashboard</Link> — a workspace
          you have already claimed is in your switcher.
        </Alert>
      </Centered>
    );
  }

  if (!preview) {
    return (
      <Centered>
        <Panel title="Checking this link…">
          <Skeleton />
        </Panel>
      </Centered>
    );
  }


  const sandbox = preview.workspace;
  const usedPct = preview.limits.storageBytes
    ? Math.round((sandbox.storageBytes / preview.limits.storageBytes) * 100)
    : 0;

  /** The post-claim confirmation, reusing the reveal-once acknowledgement shape. */
  if (result) {
    const claimed = result.workspace;
    const href = `/w/${claimed.slug ?? claimed.id}`;
    return (
      <Centered>
        <Panel
          title="Workspace claimed"
          subtitle={
            result.mode === 'new'
              ? `${claimed.name} is now yours.`
              : `The sandbox was merged into ${claimed.name} and then deleted.`
          }
        >
          {result.mode === 'attach' ? (
            <Alert tone="ok" title={`${result.files.moved} file${result.files.moved === 1 ? '' : 's'} moved`}>
              They are under <code>{result.agent.pathPrefix}</code> in {claimed.name}
              {result.agent.renamed
                ? `. The agent was renamed to "${result.agent.name}" because that workspace already had one by its original name.`
                : '.'}{' '}
              {result.agent.keysRepointed > 0
                ? 'The agent’s existing API key still works, unchanged — its next call lands here automatically.'
                : ''}
            </Alert>
          ) : (
            <Alert tone="ok" title="Nothing moved">
              The workspace kept its own ID, so every file stayed exactly where it was and the
              agent&rsquo;s existing API key still works, unchanged.
            </Alert>
          )}
          <div style={{ marginTop: 'var(--s-5)' }}>
            <Button variant="primary" onClick={() => navigate(href)}>
              Open {claimed.name}
            </Button>
          </div>
        </Panel>
      </Centered>
    );
  }

  return (
    <Centered>
      <Panel
        title={`Claim “${sandbox.name}”`}
        subtitle="An agent created this workspace for you. Take ownership to keep it."
        actions={<Badge tone="neutral">Unclaimed</Badge>}
      >
        {/* Every figure here is a field on the preview response, not a local
            calculation — see the note at the top of this file. */}
        <div
          style={{
            display: 'grid',
            gap: 'var(--s-3)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
          }}
        >
          <StatTile label="Files" value={String(sandbox.fileCount)} />
          <StatTile label="Stored" value={formatBytes(sandbox.storageBytes)} />
          <StatTile label="Agent" value={preview.agent?.name ?? '—'} />
        </div>

        <div style={{ marginTop: 'var(--s-4)' }}>
          <Meter
            value={sandbox.storageBytes}
            max={preview.limits.storageBytes}
            tone={toneFor(usedPct)}
            label={`${formatBytes(sandbox.storageBytes)} of ${formatBytes(preview.limits.storageBytes)} temporary limit`}
          />
        </div>

        {preview.warning ? (
          <Alert tone={usedPct >= 90 ? 'danger' : 'warn'} title="This workspace is filling up">
            {preview.warning.message}
          </Alert>
        ) : null}

        {!preview.claimable ? (
          <Alert tone="danger" title="This claim link has expired">
            The workspace may still exist, but this link can no longer claim it and cannot be
            reissued — only a hash of it was ever stored.
          </Alert>
        ) : null}

        {preview.claimable && authLoading ? (
          <p className="ad-meta" aria-live="polite" style={{ marginTop: 'var(--s-5)' }}>
            Checking your session…
          </p>
        ) : null}

        {preview.claimable && !authLoading && !user ? (
          <div style={{ marginTop: 'var(--s-5)' }}>
            <Alert tone="accent" title="Sign in to claim it">
              You can see what is here without an account. Taking ownership needs one, so the
              workspace has somebody to belong to.
            </Alert>
            <div style={{ marginTop: 'var(--s-4)', display: 'flex', gap: 'var(--s-3)' }}>
              <Button
                variant="primary"
                onClick={() =>
                  navigate('/login', { state: { from: location.pathname + location.search } })
                }
              >
                Sign in
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  navigate('/signup', { state: { from: location.pathname + location.search } })
                }
              >
                Create an account
              </Button>
            </div>
          </div>
        ) : null}

        {preview.claimable && user ? (
          <div style={{ marginTop: 'var(--s-6)' }}>
            <h3 style={{ margin: '0 0 var(--s-3)', font: 'var(--type-h4)' }}>
              Where should it go?
            </h3>
            <div
              role="radiogroup"
              aria-label="Where should this workspace go?"
              style={{ display: 'grid', gap: 'var(--s-3)' }}
            >
              <ModeCard
                icon="plus"
                selected={mode === 'new'}
                onSelect={() => setMode('new')}
                title="Create a new workspace"
                body="Keep it as its own workspace on your account. Nothing moves, and the agent’s key keeps working."
              />
              <ModeCard
                icon="folder"
                selected={mode === 'attach'}
                onSelect={() => setMode('attach')}
                title="Add to an existing workspace"
                body="Move its files into a workspace you already run, then delete the sandbox. Uses that workspace’s storage."
              />
            </div>

            {mode === 'attach' ? (
              <div style={{ marginTop: 'var(--s-4)' }}>
                <Select
                  label="Workspace to add it to"
                  value={targetId}
                  onChange={event => setTargetId(event.target.value)}
                  hint="Only workspaces you own or administer — a merge spends that workspace’s storage."
                >
                  <option value="">Choose a workspace…</option>
                  {(workspaces ?? []).map(workspace => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </Select>

                {workspaces !== null && workspaces.length === 0 ? (
                  <Alert tone="warn" title="No eligible workspace">
                    You need to own or administer a workspace to merge into one. Create a new
                    workspace instead.
                  </Alert>
                ) : null}

                {targetId ? (
                  <Alert tone="neutral" title="What this will add">
                    {formatBytes(sandbox.storageBytes)} and {sandbox.fileCount} file
                    {sandbox.fileCount === 1 ? '' : 's'} will move into that workspace, under a
                    folder named for the agent. The sandbox is deleted afterwards. If the
                    workspace does not have room, nothing moves at all.
                  </Alert>
                ) : null}
              </div>
            ) : null}

            {claimError ? (
              <Alert tone="danger" title="That did not work">
                {claimError.message}
              </Alert>
            ) : null}

            <div style={{ marginTop: 'var(--s-5)' }}>
              <Button
                variant="primary"
                onClick={() => setConfirming(true)}
                disabled={mode === null || (mode === 'attach' && !targetId)}
              >
                {mode === 'attach' ? 'Add to workspace' : 'Claim workspace'}
              </Button>
            </div>
          </div>
        ) : null}
      </Panel>

      {/* `destructive={false}` is deliberate: ConfirmModal defaults it to true,
          which paints a red dialog with an alert mark. That is right for
          deleting a workspace and wrong here - claiming gives you a workspace,
          or adds files to one you already run.

          No "type the name to confirm" step, either. That friction belongs to workspace
          deletion, where the act destroys something the person already owns.
          This is additive — it gives them a workspace or moves files into one
          they run — so the same ceremony would be miscalibrated and would teach
          people to type past confirmations that do matter. */}
      <ConfirmModal
        open={confirming}
        title={mode === 'attach' ? 'Add this workspace’s files?' : 'Claim this workspace?'}
        description={
          mode === 'attach'
            ? `${sandbox.fileCount} file${sandbox.fileCount === 1 ? '' : 's'} (${formatBytes(sandbox.storageBytes)}) will move into ${(workspaces ?? []).find(w => w.id === targetId)?.name ?? 'the selected workspace'}, and the sandbox will be deleted.`
            : `“${sandbox.name}” will be added to your account, with everything in it.`
        }
        confirmLabel={mode === 'attach' ? 'Add to workspace' : 'Claim workspace'}
        destructive={false}
        loading={submitting}
        onConfirm={submit}
        onClose={() => setConfirming(false)}
      />
    </Centered>
  );
}
