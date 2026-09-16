# 012 · Put the project under git

**Status:** Done

The working tree is now a git repository, pushed to
`https://github.com/connect-ad/agentdisk` (branch `main`, 217 files).

Decisions made while closing this:

- **`design-system/` is tracked, not ignored.** It is a byte-verified mirror of
  Claude Design project `d311bfd0`, so tracking it means a diff catches any
  accidental edit to files that are supposed to be read-only. That protection is
  worth the 532 KB.
- **`.gitattributes` pins line endings.** Git on this machine converts LF to
  CRLF on checkout, which would have silently broken the byte-verification the
  moment anyone re-cloned. `* text=auto eol=lf` covers the repo, and
  `design-system/** -text` exempts the mirror from conversion entirely.
- **`.gitignore` covers** `node_modules/`, `apps/web/dist/`, logs and OS cruft.
  The 48 MB of installed dependencies stays out.

A secret scan ran before the first push. Every credential-shaped string in the
tree (`ad_live_…`, `whsec_…`) is mock data in a UI screen for a product with no
backend — there were no real credentials, no `.env`, and no key material.

**The repository is public.** That was its existing setting, not a choice made
here. `gh repo edit connect-ad/agentdisk --visibility private` flips it.

Both [`cpack`](../.claude/commands/cpack.md) and
[`cpush`](../.claude/commands/cpush.md) are now fully operational — the git
sources they read all resolve, and there is a remote to push to.
