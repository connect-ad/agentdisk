/**
 * The 1366×768 check, in a real browser.
 *
 * Amendment 1 of the Track B brief asks for the modal contract to be *verified*
 * at that viewport, and jsdom cannot do it: it parses CSS but never lays out,
 * so `overlay.test.jsx` can assert the declarations and not the outcome. The
 * declarations were already right in the customer app — `overflow-y: auto` was
 * present on a body that never scrolled — which is exactly why asserting them
 * is not enough on its own.
 *
 * Deliberately NOT part of `npm test`. It needs a browser binary, and making
 * the console's CI job depend on one would slow every PR for a check that moves
 * only when the dialog does. Run it when the dialog changes:
 *
 *     npm run verify:layout
 *
 * Playwright is resolved from regression-tests/, the one place in this repo
 * that already owns a browser. Adding a second copy to apps/admin would mean a
 * second version to keep in step for one file.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const adminRoot = path.resolve(here, '..');
const require = createRequire(path.join(adminRoot, '../../regression-tests/package.json'));
const { chromium } = require('playwright');

const VIEWPORT = { width: 1366, height: 768 };
/** The viewport the customer app's Create API key modal is unusable at. */
const SHORT = { width: 1366, height: 684 };

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function assertContract(page, label) {
  await page.setViewportSize(label === 'short' ? SHORT : VIEWPORT);
  await page.reload();
  await page.waitForSelector('[role="dialog"]');

  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const body = dialog.querySelector('[data-dialog-body]');
    const foot = dialog.querySelector('footer');
    const submit = foot.querySelector('button[type="submit"]');
    return {
      viewportHeight: window.innerHeight,
      dialogBottom: dialog.getBoundingClientRect().bottom,
      submit: submit.getBoundingClientRect(),
      bodyScrollHeight: body.scrollHeight,
      bodyClientHeight: body.clientHeight,
    };
  });

  const { viewportHeight, dialogBottom, submit, bodyScrollHeight, bodyClientHeight } = geometry;

  check(
    `[${label}] the dialog fits the viewport`,
    dialogBottom <= viewportHeight + 1,
    `bottom ${Math.round(dialogBottom)} / viewport ${viewportHeight}`
  );

  check(
    `[${label}] the body actually scrolls`,
    bodyScrollHeight > bodyClientHeight + 1,
    `content ${bodyScrollHeight} > visible ${bodyClientHeight}`
  );

  check(
    `[${label}] the primary action is on screen`,
    submit.bottom <= viewportHeight + 1 && submit.top >= 0 && submit.height > 0,
    `submit ${Math.round(submit.top)}–${Math.round(submit.bottom)} / viewport ${viewportHeight}`
  );

  // The one that matters: on screen is not the same as clickable. A footer
  // covered by something else passes a bounding-box check and still cannot be
  // used. This asks the engine what is actually at that point.
  const hitsSubmit = await page.evaluate(() => {
    const foot = document.querySelector('[role="dialog"] footer');
    const submit = foot.querySelector('button[type="submit"]');
    const box = submit.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === submit || submit.contains(hit);
  });
  check(`[${label}] and nothing covers it`, hitsSubmit);

  // And it works: click it, and the dialog's onSubmit ran.
  await page.click('[role="dialog"] footer button[type="submit"]');
  const submittedByClick =
    (await page.textContent('[data-testid="submitted"]')) === 'submitted';
  check(`[${label}] clicking it submits`, submittedByClick);
}

async function assertEnterSubmits(page) {
  await page.setViewportSize(SHORT);
  await page.reload();
  await page.waitForSelector('[role="dialog"]');

  // Contract point 4, at the viewport where the footer used to be unreachable:
  // even with the button off screen, the keyboard must finish the job.
  await page.fill('input[aria-label="Key name"]', 'deploy-bot');
  await page.press('input[aria-label="Key name"]', 'Enter');

  const submitted = (await page.textContent('[data-testid="submitted"]')) === 'submitted';
  check('[short] Enter from the name field submits', submitted);
}

/**
 * The plan editor, where it actually lives.
 *
 * `admin-dev` showed this dialog grown to fit all nine limit rows with its own
 * header off the top of the screen, and then - after the cap was changed from
 * `vh` to `%` - collapsed to a 185px box. A fixture that mounted `PlanEditor`
 * alone at the document root passed both times. The cause was never in the
 * dialog: every screen wraps itself in `paneIn`, whose `animation-fill-mode:
 * both` left `transform: translateY(0)` on the pane for good, and a transform
 * makes its element the containing block for every `position: fixed`
 * descendant. The scrim was sized to the plans card. `vh` ignored that and
 * grew; `%` obeyed it and shrank.
 *
 * So this drives the real thing: `React.StrictMode`, the `Shell`, the `Plans`
 * screen loading its data, Edit clicked on a row. Only the network is replaced.
 * The first assertion is the one that would have caught it - the scrim is the
 * window - and the rest are the design's own description of the dialog: one
 * height for both tabs, Plan filling it with nothing to scroll, Limits showing
 * Storage through Members whole and Workspaces cut off at the fold.
 */
const PLAN = {
  id: 'agentdisk-free',
  name: 'AgentDisk Free',
  description: 'For trying it out.',
  amount_cents: 0,
  storage_bytes: 1073741824,
  max_file_bytes: 104857600,
  agents: 1,
  members: 1,
  workspaces: 1,
  api_keys: 2,
  file_count: -1,
  egress_bytes_period: -1,
  requests_period: -1,
  priority_support: 0,
  is_public: 1,
  is_default: 1,
  sort_order: 0,
  stripe_product_id: 'prod_harness',
  last_synced_at: '2026-09-18T00:00:00Z',
  last_synced_direction: 'inbound',
};

async function assertPlanEditor(page, label, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(consoleUrl);
  await page.click('button:has-text("Edit")');
  await page.waitForSelector('[role="dialog"]');

  const geometry = () =>
    page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const scrim = dialog.parentElement;
      const body = dialog.querySelector('[data-dialog-body]');
      const head = dialog.querySelector('header');
      const strip = dialog.querySelector('[role="tab"]').parentElement;
      const foot = dialog.querySelector('footer');
      const view = body.getBoundingClientRect();
      const rows = Array.from(body.querySelectorAll('[role="radiogroup"]')).map(group => ({
        name: group.getAttribute('aria-label').replace(/ mode$/, ''),
        rect: group.parentElement.getBoundingClientRect(),
      }));
      const whole = rows.filter(r => r.rect.top >= view.top - 1 && r.rect.bottom <= view.bottom + 1);
      const touched = rows.filter(r => r.rect.top < view.bottom - 1 && r.rect.bottom > view.top + 1);
      return {
        viewportHeight: window.innerHeight,
        scrimHeight: Math.round(scrim.getBoundingClientRect().height),
        dialogTop: Math.round(dialog.getBoundingClientRect().top),
        dialogBottom: Math.round(dialog.getBoundingClientRect().bottom),
        dialogHeight: Math.round(dialog.getBoundingClientRect().height),
        headTop: Math.round(head.getBoundingClientRect().top),
        stripTop: Math.round(strip.getBoundingClientRect().top),
        footBottom: Math.round(foot.getBoundingClientRect().bottom),
        bodyScroll: body.scrollHeight,
        bodyClient: body.clientHeight,
        whole: whole.map(r => r.name),
        touched: touched.map(r => r.name),
        tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
      };
    });

  // ---- The Plan tab, which the dialog opens on. --------------------------
  const plan = await geometry();

  check(
    `[plans ${label}] the scrim is the window, not the pane it opened from`,
    plan.scrimHeight === plan.viewportHeight,
    `scrim ${plan.scrimHeight} / viewport ${plan.viewportHeight}`
  );

  check(
    `[plans ${label}] the dialog is inside the window`,
    plan.dialogTop >= -1 && plan.dialogBottom <= plan.viewportHeight + 1,
    `${plan.dialogTop}–${plan.dialogBottom} / viewport ${plan.viewportHeight}`
  );

  check(
    `[plans ${label}] the header and tab strip are on screen`,
    plan.headTop >= -1 && plan.stripTop >= -1,
    `header ${plan.headTop}, tabs ${plan.stripTop}`
  );

  check(
    `[plans ${label}] the footer is on screen`,
    plan.footBottom <= plan.viewportHeight + 1,
    `footer bottom ${plan.footBottom} / viewport ${plan.viewportHeight}`
  );

  check(
    `[plans ${label}] the Plan tab does not scroll`,
    plan.tab === 'Plan' && plan.bodyScroll <= plan.bodyClient + 1,
    `content ${plan.bodyScroll} in visible ${plan.bodyClient}`
  );

  // ---- The Limits tab. ---------------------------------------------------
  await page.click('[role="tab"]:has-text("Limits")');
  const limits = await geometry();

  check(
    `[plans ${label}] switching tabs does not change the dialog's height`,
    limits.dialogHeight === plan.dialogHeight,
    `Plan ${plan.dialogHeight}, Limits ${limits.dialogHeight}`
  );

  check(
    `[plans ${label}] the Limits tab scrolls rather than the dialog growing`,
    limits.tab === 'Limits' && limits.bodyScroll > limits.bodyClient + 1,
    `content ${limits.bodyScroll} > visible ${limits.bodyClient}`
  );

  check(
    `[plans ${label}] Storage through Members are whole, Workspaces is cut at the fold`,
    limits.whole.join() === 'Storage,Max single file,Agent identities,Members' &&
      limits.touched.join() === 'Storage,Max single file,Agent identities,Members,Workspaces',
    `whole: ${limits.whole.join(' | ')}; touched: ${limits.touched.join(' | ')}`
  );

  // And the other four are reachable. The rows above are only right if
  // scrolling gets to the ninth; a body that clipped what it could not show
  // would pass everything above.
  const last = await page.evaluate(() => {
    const body = document.querySelector('[data-dialog-body]');
    body.scrollTop = body.scrollHeight;
    const groups = body.querySelectorAll('[role="radiogroup"]');
    const rect = groups[groups.length - 1].parentElement.getBoundingClientRect();
    const view = body.getBoundingClientRect();
    return {
      ok: rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1,
      name: groups[groups.length - 1].getAttribute('aria-label'),
    };
  });
  check(`[plans ${label}] scrolling reaches the last row`, last.ok, last.name);
}

async function assertFocus(page) {
  await page.setViewportSize(VIEWPORT);
  await page.reload();
  await page.waitForSelector('[role="dialog"]');

  const initiallyOnField = await page.evaluate(
    () => document.activeElement === document.querySelector('input[aria-label="Key name"]')
  );
  check('focus opens on the field, not the close button', initiallyOnField);

  await page.type('input[aria-label="Key name"]', 'deploy-bot');
  const stillOnField = await page.evaluate(() => ({
    focused: document.activeElement === document.querySelector('input[aria-label="Key name"]'),
    value: document.querySelector('input[aria-label="Key name"]').value,
  }));
  check(
    'focus does not jump to Close while typing',
    stillOnField.focused && stillOnField.value === 'deploy-bot',
    `value "${stillOnField.value}"`
  );
}

// No `plugins` here: createServer loads apps/admin/vite.config.js, which
// already supplies @vitejs/plugin-react. Passing it again injects the HMR
// preamble twice and the page fails to boot with a duplicate-declaration error.
const server = await createServer({
  root: adminRoot,
  server: { port: 0 },
  logLevel: 'error',
});
await server.listen();

const { port } = server.httpServer.address();
const url = `http://localhost:${port}/test/fixtures/overlay-harness.html`;
const consoleUrl = `http://localhost:${port}/test/fixtures/console-plans-harness.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });

// The console harness loads its data through the real `staffApi`, which
// would reach api-dev. Answer it here instead; nothing else is intercepted.
await page.route('**/v1/staff/**', route =>
  route.request().url().includes('/v1/staff/plans')
    ? route.fulfill({ json: { plans: [PLAN] } })
    : route.fulfill({ json: {} })
);

await page.goto(url);

try {
  await assertContract(page, '1366x768');
  await assertContract(page, 'short');
  await assertEnterSubmits(page);
  await assertFocus(page);
  // Tall and short. The tall one is the case admin-dev was broken in: a window
  // with room to grow is exactly where a content-sized dialog stops scrolling.
  await assertPlanEditor(page, 'tall', { width: 1512, height: 982 });
  await assertPlanEditor(page, '1366x768', VIEWPORT);
  await assertPlanEditor(page, 'short', SHORT);
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(result => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
