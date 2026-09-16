# 029 · Does MCP enforce `pathPrefix`? Live testing and the code disagree

**Status:** Open — unresolved contradiction, not a diagnosed bug. Settle it
before doc 19's public MCP launch, which names it as a blocker.

## The claim

`docs/design/18-full-ui-audit-and-fix-prompt.md` §9.4 Scenario 2 reports, from
live JSON-RPC calls against `api-dev.agentdisk.io/mcp` with DOM-verified keys
and reproduced twice: a key scoped to `/path1/*` could `create_file` and
`list_files` under `/path2/*` over MCP and got a successful result, while the
same keys over REST correctly returned `403`. Operation scope (`read`/`write`/
`list`) was verified correct on both surfaces; only path scope diverged.

If true this is a real security bug — `pathPrefix` is the only mechanism a
workspace owner has to give one agent `/invoices/*` and another `/logs/*`, and
MCP is the product's primary agent interface.

## What the code says

Reading the current tree does not reproduce the claim, and the two halves of it
fail for different reasons:

- **`create_file` should refuse.** MCP tools are not reimplementations — they
  call the REST handlers through `viaHandler` (`apps/api/src/mcp/tools.ts`), and
  `createFile` asserts the path itself at `apps/api/src/routes/files.ts:220`
  (`assertScopedPath(ctx.scope, "write", body.path)`). The same line runs for
  both surfaces. This half of the report and the code cannot both be right.
- **`list_files` succeeding is expected, and is not by itself a bypass.**
  `listFiles` deliberately does *not* scope-assert the requested path
  (`routes/files.ts`, ~line 512): a listing wider than the key's scope is
  narrowed by `effectiveListPrefix` rather than refused, and a comment records
  that a mutation test caught an earlier version that asserted first and made the
  narrowing unreachable. So a `/path1` key listing `/path2` returns **200 with
  `/path1`'s files**. A tester reading "no error" as "bypass" without checking
  *which* files came back would report exactly what §9.4 reports.

Note also that `withAuth` is called from MCP with `{ op: tool.op }` and no
`path` (`apps/api/src/mcp/server.ts`), so middleware-level path checking never
runs for MCP — but it does not run for REST either (`index.ts` passes bare ops).
On both surfaces path enforcement lives inside the handlers. That is the design,
not the defect, but it means there is no single chokepoint to point at.

## How to settle it

Not by reading more code — both sides have been read. Reproduce it:

1. Mint two keys on one agent, `/path1` and `/path2`, ops `read, write, list`.
2. `create_file` at `/path2/x.txt` with the `/path1` key over MCP. A
   `FORBIDDEN` tool failure means the code is right and §9.4's create result was
   a testing artefact; a success means a real bypass.
3. `list_files` at `/path2` with the `/path1` key and **inspect the returned
   paths**, not just the status.
4. Check what dev was actually running on 2026-09-08/09 — a deployed Worker
   older than the tree would explain a real observation against correct code.

Whatever the answer, add the case to `apps/api/test/mcp.test.ts`: the suite
covers MCP operation scope but has no path-scope case, which is why neither the
bug nor its absence is currently provable from the suite.

## Related

`CLAUDE.md` states that MCP tools call the REST handlers "so the two surfaces
are literally the same code and cannot drift in what they allow." That claim is
what §9.4 disputes. It stands until this is settled — the code supports it — but
it should not be treated as settling the question on its own.
