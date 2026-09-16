# 027 · The Files page waits on two serial round trips

**Status:** Open — low priority; measured, not guessed

On an empty workspace the Files page shows several seconds of skeleton rows
before resolving to "This folder is empty"
([18](../docs/design/18-full-ui-audit-and-fix-prompt.md) §10).

**Already ruled out, so nobody re-investigates:**

- No artificial delay anywhere in `routes/FileBrowser.jsx`. `loadFiles` is one
  `api.listFiles(workspaceId)`.
- `listFiles` is a single query against `idx_files_workspace_path`. No N+1, no
  presigning on the list path.
- The dev Worker answers in 130–250 ms cold, measured against
  `api-dev.agentdisk.io`.

**What is actually left:** the requests are serial, not slow. `useResource` will
not fire until `workspaceId` exists, and that comes from `WorkspaceProvider`
waiting on `GET /v1/workspaces`, which itself waits on the Firebase SDK restoring
the session and minting an ID token. Three round trips end to end, none of them
overlapping, before the first file query is even sent.

Fixing it means restructuring the workspace bootstrap — resolving the workspace
from the URL optimistically and letting the list confirm it later, so the file
query can start alongside `listWorkspaces` rather than after it. That is a change
to how every screen gets its workspace, which is why it was left alone during a
bug-fix pass.

The skeleton itself is correct and should stay: `useResource` keeps loading,
failed and loaded genuinely distinct precisely so nobody sees "no files" while
their files are still arriving.
