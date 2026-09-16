# 015 · Rename AgentDrive → AgentDisk in the design system

**Status:** Open — needs an upstream change in Claude Design, then a re-import

The product was renamed to **AgentDisk** in Sept 2026, matching the
`agentdisk.io` domain it had already been given by
[doc 12](../docs/design/12-deployment-roadmap-agentdisk-io.md). Every file this
repo owns was updated in that pass. `design-system/` was not, because it is a
byte-verified mirror of the Claude Design project
`agent-storage-mcp` (`d311bfd0-9751-4a9b-84f4-b33e7a09378e`) and editing it
locally silently forks the two.

## What still carries the old name

32 occurrences across 18 files:

| Form | Count | Where |
|---|---|---|
| `AgentDrive` | 24 | 13 component `card.html` previews, `AppShell.jsx`, three `.d.ts` files, `readme.md`, `_ds_manifest.json`, `_ds_bundle.js` |
| `agentdrive.ai` | 5 | `Input/card.html` and the bundle — an old domain in a prefix example |
| `AGENTDRIVE` | 2 | `CodeBlock/card.html` — `AGENTDRIVE_KEY` in a sample snippet |
| `agentdrive` | 1 | `styles.css` |

## What was already fixed locally, and why that is drift

`apps/web/src/components/` is vendored from the mirror, and five of its files
carried the name — including `AppShell.jsx:14`, which renders the **visible
wordmark** in the deployed dashboard. Those were fixed in place: the alternative
was shipping a dashboard that says "AgentDrive" to users, which the rename
exists to prevent.

So `apps/web/src/components/` and `design-system/` are now knowingly out of sync
in exactly these files:

- `AppShell/AppShell.jsx` — the wordmark
- `FileCell/FileCell.d.ts`, `Icon/Icon.d.ts`, `Input/Input.d.ts` — doc comments
- `index.js` — the generated barrel's header comment

`Input.d.ts` also had its `agentdrive.ai/` example changed to `agentdisk.io/`.

## Doing it

1. Rename in the Claude Design project — the `card.html` previews are the bulk
   of it, and `_ds_bundle.js`/`_ds_manifest.json` are generated there, not by
   hand.
2. Re-import per [001](001-import-design-system.md), which restores the mirror
   to byte-identical and lands the same change on the vendored copies.
3. Confirm the drift above is gone rather than re-applied on top:
   `grep -ri agentdrive design-system apps/web/src/components` must be silent.

Until then, a re-import from the current upstream would **reintroduce the old
name into the shipped dashboard**. That is the actual risk this item tracks.
