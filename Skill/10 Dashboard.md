# 10 · Dashboard

`apps/web`: the customer SPA and the marketing site in one bundle. Where it
is served is [5 Hostnames](5%20Hostnames.md); how to build and test it is
[1 Build](1%20Build.md).

---

## Where the code is

`src/components/` is vendored from the Claude Design project and
`src/components/index.js` is generated from it. Hand-written code lives in
`src/routes/` and `src/components-local/`. Import components from the barrel
only, style with `var(--*)` tokens, never raw hex, never px for spacing, and
never let colour carry meaning alone: every status pairs a tone with a word.

Four vendored files deliberately diverge from upstream, all awaiting one trip
back into Claude Design:

| File | Why |
|---|---|
| `AppShell/AppShell.jsx` | Three earlier fixes plus the Kernelv5 byline under the wordmark, which imports `components-local/Byline.jsx` |
| `Modal/Modal.jsx` and `Button/Button.jsx` | Enter-to-submit. `Button` has to default to `type="button"` or an untyped Cancel inside the modal's form submits the dialog it exists to dismiss |
| `ApiKeyDisplay/ApiKeyDisplay.jsx` | Its `prefix` defaulted to a prefix this API never issued, and its note said keys were only hashed, which stopped being true when keys were kept |

**AgentDisk is the brand; Kernelv5 Inc. is the company.** The legal name is
what Stripe prints, so it appears in the footer's copyright, the byline in the
header, footer and auth sheet, the Terms and Privacy text, and the billing
page's note. All of it reads `src/lib/company.js`; change the name there and
nowhere else.

## Rules that bite

- **One overlay ladder, and a dialog always outranks a drawer.**
  `Skill/13 UI Layering.md` owns the scale and `app.css` defines it as `--z-*`
  tokens. A `z-index` only ranks siblings within the nearest stacking context,
  so modals stay siblings of the drawer, never children. The local `app.css`
  wins over the vendored sheet because `main.jsx` imports it second.
- **A dialog moves focus once, when it opens.** Handlers that only need to be
  current belong in a ref, never in a dependency array; with `onClose` in the
  array every keystroke re-ran the focus effect and threw focus onto Close.
- **`ConfirmModal` defaults `destructive` to true.** Pass `destructive={false}`
  for an additive act like claiming a workspace; dressing additive actions in
  red teaches people to click through the red dialogs that matter.
- **`useWorkspace().loading` is derived, and `/app` never redirects to
  /login.** Firebase restores a session asynchronously, so `loading` means
  "there is a user and the list is not theirs yet". No workspace is the
  `NoWorkspace` explanation, never a login. `test/app-redirect.test.jsx`
  restores the session after mount, the way Firebase does.
- **Clearing the resource cache is the refetch signal; nothing else is.**
  `clearCache` notifies every mounted `useResource`, which refetches behind
  what it is showing. `reload()` no longer clears the cache itself, so a test
  that stubs a write method must call `clearCache()` in the stub. The usage
  provider takes the pathname as a dependency so a change made through the API
  shows on the next navigation once the cached answer is past `TTL_MS`.
- **Settings → Privacy is a summary of `routes/Legal.jsx`**, which is the
  authoritative text and still carries its "reviewed by no lawyer" banner.
  Change both together, and Legal.jsx wins.
- **The Docs and MCP pages list the MCP tools by hand**, and two tests pin
  the count against the server's.
- Nothing in the prerendered trees may touch a browser global while rendering;
  see [5 Hostnames](5%20Hostnames.md).

## Route groups

`App.jsx` has three groups: the marketing routes (`/`, `/pricing`, `/docs`,
`/sandbox`, `/terms`, `/privacy`), the public-by-design pages (`/claim/:token`,
`/s/:token`, the error pages), and everything behind `RequireAuth`. The
marketing group is the same list as `worker.js`'s `SITE_ROUTES`; the other two
sit under `AppHostOnly`. `/app` and `/dashboard` both resolve the current
workspace through one component so neither can drift into being unprotected.

## Sign-up and sign-in

Google, GitHub, email with password and email link, all through Firebase. The
three password forms call `checkPassword`, which restates the console's policy.
`describeAuthError` turns Firebase's codes into sentences, including the one a
tightened policy produces. `Login` sends an already-signed-in visitor on to
`from` or `/app`.
