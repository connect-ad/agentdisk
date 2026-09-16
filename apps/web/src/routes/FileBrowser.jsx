import React, { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  PageHead, Panel, DataTable, FileCell, Button, IconButton, Icon, Input, Select,
  Badge, Modal, ConfirmModal, Toast, EmptyState, UploadItem, Checkbox, CodeBlock, Alert
} from '../components/index.js';
import { Drawer } from '../components-local/Drawer.jsx';
import { useResource } from '../lib/useResource.js';
import { useWorkspace } from '../lib/workspace.jsx';
import { uploadFile } from '../lib/upload.js';

/**
 * 8.9 File Browser (MVP-0) + 8.10 File Details drawer + 8.11 Create Folder modal
 * + 8.12 Upload flow. The spec folds 8.10-8.12 into this screen, so they live here.
 *
 * URL: /w/{ws}/files and /w/{ws}/files/{folderPath}
 *
 * `state` prop keeps every specified state reachable before the API exists:
 * populated | loading | empty | no-results | uploading
 */

/** Bytes to something a person reads, at the precision the size deserves. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 172800) return 'yesterday';
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The API returns who created a file as an ID, not a name — an agent ID or a
 * user ID. Resolving those to display names needs an endpoint that does not
 * exist yet, so this shows the distinction it *can* prove (agent versus person)
 * and the ID itself, rather than inventing a name to fill the column.
 */
function actorOf(createdBy) {
  const isAgent = typeof createdBy === 'string' && createdBy.startsWith('agt_');
  return { by: createdBy ?? '—', byAgent: isAgent };
}

function toRow(file) {
  const { by, byAgent } = actorOf(file.createdBy);
  return {
    id: file.id,
    name: file.name,
    path: file.path,
    type: file.mimeType ?? 'application/octet-stream',
    size: formatBytes(file.sizeBytes),
    modified: relativeTime(file.updatedAt),
    checksum: file.checksumSha256 ?? undefined,
    by,
    byAgent
  };
}

const loadFiles = (api, workspaceId) => api.listFiles(workspaceId);

export default function FileBrowser() {
  const { ws } = useParams();
  const { status, data, error, reload } = useResource(loadFiles);
  const loading = status === 'loading';
  const failed = status === 'failed';
  const files = useMemo(() => (data?.files ?? []).map(toRow), [data]);
  const { api, workspaceId, canWrite } = useWorkspace();
  // Uploads are transient state belonging to an upload in progress, not
  // something the server holds. The list is empty until somebody drops a file.
  const [uploads, setUploads] = useState([]);
  const uploading = uploads.length > 0;
  const fileInput = React.useRef(null);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('modified');
  const [selected, setSelected] = useState([]);
  const [detail, setDetail] = useState(null);
  const [dialog, setDialog] = useState(null); // 'new-folder' | 'rename' | 'delete' | 'bulk-delete'
  const [confirmText, setConfirmText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState(null);
  // A dialog's in-flight and failed states. Kept next to `dialog` rather than
  // inside each modal so that closing one always clears both.
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState(null);
  const [folderName, setFolderName] = useState('');
  // The id of the file whose download link is being fetched, so only that one
  // button shows a spinner rather than every Download on the screen.
  const [downloading, setDownloading] = useState(null);

  const rows = useMemo(() => {
    if (loading || failed) return [];
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter(f => f.name.toLowerCase().includes(q));
  }, [query, loading, failed, files]);

  const empty = status === 'loaded' && files.length === 0;

  /**
   * Upload one file and keep its row in `uploads` updated as it goes.
   *
   * Each file gets its own entry keyed by a generated id rather than by name,
   * because dropping two files called `report.pdf` from different folders is
   * ordinary and would otherwise collapse into one row that flickers.
   */
  const startUpload = async file => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setUploads(list => [...list, { id, name: file.name, size: file.size, status: 'uploading', progress: 0 }]);

    const patch = changes =>
      setUploads(list => list.map(u => (u.id === id ? { ...u, ...changes } : u)));

    try {
      await uploadFile(api, workspaceId, file, {
        onProgress: progress => patch({ progress })
      });
      patch({ status: 'done', progress: 1 });
      // Drop the finished row after a beat so the list does not become a
      // permanent history of everything uploaded this session.
      setTimeout(() => setUploads(list => list.filter(u => u.id !== id)), 2500);
      void reload();
    } catch (err) {
      patch({
        status: 'failed',
        // Naming the step matters: a failed `complete` means the bytes are in
        // storage and the row is still pending, which is a different problem
        // from a transfer that never landed.
        error: err.step === 'complete'
          ? `Uploaded, but could not be finalised: ${err.message}`
          : err.message
      });
    }
  };

  const uploadMany = files => {
    for (const file of Array.from(files)) void startUpload(file);
  };

  /** Close whichever dialog is open, and drop the state that belonged to it. */
  const closeDialog = () => {
    setDialog(null); setDialogError(null); setConfirmText(''); setFolderName('');
  };

  /**
   * Create a folder at the workspace root.
   *
   * Root, not "the current folder", because this screen has no folder
   * navigation yet -- `onRowClick` deliberately does nothing for a folder row.
   * Building a path from a location the user cannot actually be in would be
   * inventing state.
   *
   * Validation here is only what saves a round trip on an obviously empty name.
   * Everything else is the API's to judge and its wording is what gets shown:
   * `normalizePath` already rejects backslashes, control characters, '..' and
   * over-long segments, and the duplicate check returns CONFLICT. Re-deciding
   * any of that in the browser would be a second, quietly diverging definition
   * of a valid path.
   */
  const runCreateFolder = async () => {
    const name = folderName.trim();
    if (name === '') {
      setDialogError('Give the folder a name.');
      return;
    }

    setBusy(true);
    setDialogError(null);
    try {
      await api.createFolder(workspaceId, `/${name}`);
      closeDialog();
      void reload();
      setToast({ tone: 'ok', title: 'Folder created', body: `/${name}` });
    } catch (err) {
      // The dialog stays open holding what was typed, so a duplicate name can
      // be edited rather than retyped.
      setDialogError(err?.message ?? 'The folder could not be created.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Which files a delete dialog is pointing at.
   *
   * The drawer's Delete concerns the one file the drawer is showing; the bulk
   * bar's concerns the selection. `detail` wins when both are set, matching the
   * title the dialog already renders.
   */
  const deleteTargets = detail ? [detail.id] : selected;

  /**
   * Fetch a presigned URL for one file and hand it to the browser.
   *
   * **Exactly one call per click.** The API accounts egress when it issues the
   * URL rather than when the bytes move, because R2 does not call back on a
   * GET -- so asking twice for one download bills the file twice. Fetching the
   * URL afterwards costs nothing further, which is why this opens it directly
   * instead of streaming through the app.
   *
   * The anchor carries `download`, which cross-origin responses are free to
   * ignore; whether the file saves or opens is then R2's Content-Disposition to
   * decide, not ours. `noopener` because the URL is a bearer credential for the
   * object and the opened document has no business reaching back.
   */
  const runDownload = async file => {
    setDownloading(file.id);
    try {
      const { url } = await api.downloadFile(workspaceId, file.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.rel = 'noopener';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setToast({
        tone: 'danger',
        title: 'Download failed',
        body: err?.message ?? 'The link could not be created.'
      });
    } finally {
      setDownloading(null);
    }
  };

  /**
   * Delete files, then let the server decide what the list now holds.
   *
   * **Nothing is removed optimistically.** `reload()` re-reads the listing, so a
   * file whose DELETE failed is simply still there afterwards — the honest
   * outcome, reached without a rollback path that could itself be wrong. This
   * screen used to set a "Deleted" toast and call no API at all, which left the
   * file in place and the person believing it was gone.
   *
   * `allSettled` rather than `all`: in a bulk delete one rejection must not
   * hide the files that did go, and the tally of each is what the toast reports.
   */
  const runDelete = async targetIds => {
    if (targetIds.length === 0) return;
    setBusy(true);
    setDialogError(null);

    const results = await Promise.allSettled(
      targetIds.map(id => api.deleteFile(workspaceId, id))
    );
    const failed = results.filter(r => r.status === 'rejected');
    const firstError = failed[0]?.reason?.message ?? 'The server did not say why.';
    setBusy(false);

    // Total failure keeps the dialog open: the rows are all still there, so
    // closing it would look like the work was done.
    if (failed.length === targetIds.length) {
      setDialogError(firstError);
      return;
    }

    closeDialog();
    setSelected([]);
    setDetail(null);
    void reload();

    setToast(
      failed.length > 0
        ? {
            tone: 'warn',
            title: `Deleted ${targetIds.length - failed.length} of ${targetIds.length}`,
            body: `${failed.length} could not be deleted. ${firstError}`
          }
        : {
            tone: 'ok',
            title: targetIds.length === 1 ? 'File deleted' : `${targetIds.length} files deleted`
          }
    );
  };

  const allSelected = rows.length > 0 && selected.length === rows.length;
  const toggleAll = () => setSelected(allSelected ? [] : rows.map(r => r.id));
  const toggleOne = id =>
    setSelected(s => (s.indexOf(id) === -1 ? s.concat(id) : s.filter(x => x !== id)));

  const columns = [
    {
      key: 'sel',
      width: 36,
      header: <Checkbox label="" checked={allSelected} onChange={toggleAll} />,
      render: r => (
        <span onClick={e => e.stopPropagation()}>
          <Checkbox label="" checked={selected.indexOf(r.id) !== -1} onChange={() => toggleOne(r.id)} />
        </span>
      )
    },
    {
      key: 'name',
      header: 'Name',
      primary: true,
      render: r => <FileCell name={r.name} kind={r.kind} meta={r.meta} ext={r.ext} agentWritten={r.byAgent} />
    },
    { key: 'type', header: 'Type', width: 150, render: r => <span className="ad-mono-sm">{r.type}</span> },
    { key: 'size', header: 'Size', align: 'right', width: 96, mono: true },
    {
      key: 'by',
      header: 'Created by',
      width: 190,
      render: r =>
        r.byAgent
          ? <Badge tone="accent" mono>{r.by}</Badge>
          : <span style={{ color: 'var(--ink-2)' }}>{r.by}</span>
    },
    { key: 'modified', header: 'Modified', width: 150, render: r => <span style={{ color: 'var(--ink-3)' }}>{r.modified}</span> },
    {
      key: 'act',
      header: '',
      width: 44,
      render: () => (
        <span onClick={e => e.stopPropagation()}>
          <IconButton icon={<Icon name="more" size={14} />} label="Row actions" />
        </span>
      )
    }
  ];

  const emptyState = query.trim() ? (
    <EmptyState
      icon={<Icon name="search" size={19} />}
      title={`No files match “${query}”`}
      actions={<Button size="sm" variant="secondary" onClick={() => setQuery('')}>Clear search</Button>}
    >
      Search covers filenames, paths and extracted text in this workspace only.
    </EmptyState>
  ) : (
    <EmptyState
      icon={<Icon name="folder" size={19} />}
      title="This folder is empty"
      actions={<Button size="sm" icon={<Icon name="upload" size={13} />}>Upload files</Button>}
    >
      Drag files here, or upload them.
    </EmptyState>
  );

  return (
    <>
      <PageHead
        title="Files"
        subtitle="Everything in this workspace, and which agent put it there."
        actions={
          canWrite ? (
            <>
              <Button variant="secondary" icon={<Icon name="folder" size={14} />} onClick={() => { setDialogError(null); setFolderName(''); setDialog('new-folder'); }}>
                New folder
              </Button>
              {/*
                The keyboard-accessible equivalent of the dropzone. A hidden
                input rather than a styled one: file inputs cannot be restyled
                consistently, and a drag target on its own leaves anybody not
                using a mouse with no way to upload at all.
              */}
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={e => {
                  if (e.target.files?.length) uploadMany(e.target.files);
                  // Reset so choosing the same file twice in a row still fires.
                  e.target.value = '';
                }}
              />
              <Button icon={<Icon name="upload" size={14} />} onClick={() => fileInput.current?.click()}>
                Upload
              </Button>
            </>
          ) : null
        }
      />

      <div className="toolbar">
        <Input
          leadingIcon={<Icon name="search" size={14} style={{ color: 'var(--ink-4)' }} />}
          placeholder="Filename, path or contents"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <span className="toolbar__spacer" />
        <Select
          value={sort}
          onChange={e => setSort(e.target.value)}
          options={[
            { value: 'modified', label: 'Sort: Last modified' },
            { value: 'name', label: 'Sort: Name' },
            { value: 'size', label: 'Sort: Size' }
          ]}
        />
      </div>

      {selected.length > 0 ? (
        <div className="bulkbar">
          <span style={{ fontSize: 'var(--t-13)', fontWeight: 'var(--w-med)' }}>
            {selected.length} selected
          </span>
          <span className="toolbar__spacer" />
          <Button size="sm" variant="secondary" icon={<Icon name="folder" size={13} />}>Move</Button>
          <Button size="sm" variant="secondary" icon={<Icon name="download" size={13} />}>Download as zip</Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Icon name="trash" size={13} />}
            onClick={() => { setConfirmText(''); setDialog(selected.length > 5 ? 'bulk-delete' : 'delete'); }}
          >
            Delete
          </Button>
        </div>
      ) : null}

      {uploading ? (
        <Panel flush title="Uploading" subtitle="Files go straight to storage, never through our API.">
          {uploads.map(u => (
            <UploadItem
              key={u.id}
              name={u.name}
              status={u.status}
              progress={u.progress}
              error={u.error}
              onCancel={() => setUploads(list => list.filter(x => x.id !== u.id))}
            />
          ))}
        </Panel>
      ) : null}

      {/* Drag-and-drop upload target. The Upload button is the keyboard-accessible
          equivalent (spec: Accessibility). */}
      <div
        style={{ position: 'relative' }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          if (!canWrite) {
            setToast({ tone: 'danger', title: 'Read-only access', body: 'Your role on this workspace cannot upload files.' });
            return;
          }
          if (e.dataTransfer?.files?.length) uploadMany(e.dataTransfer.files);
        }}
      >
        {dragging ? (
          <div className="dz-overlay">
            <span style={{ fontSize: 'var(--t-14)', fontWeight: 'var(--w-med)', color: 'var(--accent-ink)' }}>
              Drop to upload
            </span>
          </div>
        ) : null}
        <Panel flush title={query.trim() ? `Results for “${query}”` : 'All files'}>
          <DataTable
            columns={columns}
            rows={rows}
            loading={loading}
            skeletonRows={6}
            empty={emptyState}
            selectedKeys={selected}
            onRowClick={r => (r.kind === 'folder' ? undefined : setDetail(r))}
          />
        </Panel>
      </div>

      {/* --- 8.10 File Details drawer --- */}
      <Drawer
        open={!!detail}
        title={detail ? detail.name : ''}
        onClose={() => setDetail(null)}
        footer={
          <>
            <Button
              size="sm"
              icon={<Icon name="download" size={13} />}
              loading={downloading === detail?.id}
              onClick={() => void runDownload(detail)}
            >
              Download
            </Button>
            <Button size="sm" variant="secondary" icon={<Icon name="link" size={13} />}>Copy signed link</Button>
            <Button size="sm" variant="ghost">Rename</Button>
            <Button size="sm" variant="danger-outline" onClick={() => setDialog('delete')}>Delete</Button>
          </>
        }
      >
        {detail ? (
          <>
            <EmptyState
              compact
              icon={<Icon name="file" size={19} />}
              title="Preview not available for this file type"
              actions={
                <Button
                  size="sm"
                  variant="secondary"
                  loading={downloading === detail.id}
                  onClick={() => void runDownload(detail)}
                >
                  Download
                </Button>
              }
            />
            <dl className="dl">
              <dt>Path</dt><dd className="ad-mono-sm">{detail.path || '—'}</dd>
              <dt>Size</dt><dd>{detail.size}</dd>
              <dt>Type</dt><dd className="ad-mono-sm">{detail.type}</dd>
              <dt>Checksum (SHA-256)</dt>
              <dd className="ad-mono-sm" style={{ overflowWrap: 'anywhere' }}>{detail.checksum || '—'}</dd>
              <dt>Created by</dt>
              <dd>
                {detail.byAgent
                  ? <Badge tone="accent" mono>{detail.by}</Badge>
                  : detail.by}
              </dd>
              <dt>Last modified</dt><dd>{detail.modified}</dd>
            </dl>
            <Input label="Caption" placeholder="Add a caption…" />
            <Input label="Tags" placeholder="Add tags…" hint="Comma-separated. Saved when you click away." />
          </>
        ) : null}
      </Drawer>

      {/* --- 8.11 New folder --- */}
      <Modal
        open={dialog === 'new-folder'}
        title="New folder"
        tone="accent"
        mark={<Icon name="folder" size={16} />}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog}>Cancel</Button>
            <Button loading={busy} onClick={() => void runCreateFolder()}>Create folder</Button>
          </>
        }
      >
        <Input
          label="Folder name"
          placeholder="market-research"
          value={folderName}
          onChange={e => setFolderName(e.target.value)}
          hint="Letters, numbers, dashes and underscores. This becomes part of the path agents use."
        />
        {dialogError ? <Alert tone="danger" title="Not created">{dialogError}</Alert> : null}
      </Modal>

      {/* --- delete: single --- */}
      {/*
        The description says what actually happens. It used to promise "trash for
        30 days" in the same breath as "can't be undone" — self-contradictory,
        and wrong in both halves: the grace period is PURGE_GRACE_MS, 24 hours,
        and no trash screen exists to restore from. The API's POST
        /v1/files/:id/restore is the only route back, so the copy names the
        window without implying the dashboard can use it.
      */}
      <ConfirmModal
        open={dialog === 'delete'}
        title={`Delete ${detail ? detail.name : `${selected.length} item(s)`}?`}
        description="Deleted files stop being listed at once and are removed permanently 24 hours later. The dashboard cannot restore one."
        confirmLabel="Delete"
        loading={busy}
        onClose={closeDialog}
        onConfirm={() => void runDelete(deleteTargets)}
      >
        {dialogError ? <Alert tone="danger" title="Not deleted">{dialogError}</Alert> : null}
      </ConfirmModal>

      {/* --- delete: bulk (>5) requires typing DELETE --- */}
      <Modal
        open={dialog === 'bulk-delete'}
        title={`Delete ${selected.length} items?`}
        tone="danger"
        mark={<Icon name="alert" size={16} />}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={confirmText !== 'DELETE'}
              onClick={() => void runDelete(selected)}
            >
              Delete
            </Button>
          </>
        }
      >
        <Input
          label="Type DELETE to confirm"
          value={confirmText}
          mono
          onChange={e => setConfirmText(e.target.value)}
        />
        {dialogError ? <Alert tone="danger" title="Not deleted">{dialogError}</Alert> : null}
      </Modal>

      {toast ? (
        <div style={{ position: 'fixed', top: 'var(--s-7)', right: 'var(--s-7)', zIndex: 90 }}>
          <Toast tone={toast.tone} title={toast.title} onDismiss={() => setToast(null)}>
            {toast.body}
          </Toast>
        </div>
      ) : null}
    </>
  );
}
