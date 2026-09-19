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
      // What the window allows the dialog to be: the scrim's box less its
      // padding, in the dialog's own coordinate space (:root is zoomed).
      const scrimStyle = getComputedStyle(scrim);
      const scrimInner =
        scrim.clientHeight - parseFloat(scrimStyle.paddingTop) - parseFloat(scrimStyle.paddingBottom);
      return {
        viewportHeight: window.innerHeight,
        scrimHeight: Math.round(scrim.getBoundingClientRect().height),
        // True when the dialog is shorter than the room it was given, i.e. it
        // took its own height rather than the window's.
        atDesignHeight: dialog.clientHeight < scrimInner - 1,
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

  // The design's height holds the whole Plan tab with nothing to scroll. On a
  // window too short for that height the dialog is clamped to the window and
  // Plan scrolls inside it - which is the contract, not a failure; the check
  // is that it did clamp rather than grow.
  if (plan.atDesignHeight) {
    check(
      `[plans ${label}] the Plan tab does not scroll`,
      plan.tab === 'Plan' && plan.bodyScroll <= plan.bodyClient + 1,
      `content ${plan.bodyScroll} in visible ${plan.bodyClient}`
    );
  } else {
    check(
      `[plans ${label}] the window is shorter than the design height, and the Plan tab scrolls inside it`,
      plan.tab === 'Plan' && plan.bodyScroll > plan.bodyClient + 1,
      `content ${plan.bodyScroll} > visible ${plan.bodyClient}`
    );
  }

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

/**
 * A shell with one line in it must not scroll.
 *
 * `:root` carries `zoom: 1.25` and `vh` ignores zoom, so `min-height: 100vh`
 * laid out one window tall and painted 1.25 windows tall. Every screen in the
 * console carried a permanent scrollbar with no content in it. The check is
 * run at several window heights because the overflow is a *proportion* of the
 * window -- a single viewport could be passed by a shell that is wrong by a
 * fixed number of pixels instead.
 */
async function assertShellFitsWindow(page, shellUrl, viewport) {
  const label = `${viewport.width}x${viewport.height}`;
  await page.setViewportSize(viewport);
  await page.goto(shellUrl);
  await page.waitForSelector('[data-fixture-content]');

  const geometry = await page.evaluate(() => {
    const shell = document.getElementById('root').firstElementChild;
    // Ask the engine to scroll rather than comparing heights: this is the one
    // question the user asked, and scrollHeight reports it inconsistently
    // under zoom -- documentElement said 900 while the page scrolled 225.
    const start = window.scrollY;
    window.scrollTo(0, 99999);
    const maxScroll = window.scrollY;
    window.scrollTo(0, start);
    return { maxScroll, painted: Math.round(shell.getBoundingClientRect().height), window: window.innerHeight };
  });

  check(
    `[shell ${label}] a nearly empty console does not scroll`,
    geometry.maxScroll === 0,
    `scrolls ${geometry.maxScroll}px`
  );
  check(
    `[shell ${label}] the shell paints exactly one window tall`,
    Math.abs(geometry.painted - geometry.window) <= 1,
    `painted ${geometry.painted} / window ${geometry.window}`
  );
}

/**
 * The other half of the contract: WHICH box scrolls when there is too much.
 *
 * The content pane scrolls. The sidebar and the top bar do not move, because
 * they are how you leave the screen you are on -- a console that scrolls its
 * own navigation out of reach makes you scroll back up to go anywhere, and the
 * longer the table the further back up. The sidebar keeps its own scrollbar
 * for when the nav itself is taller than the window; that is a separate
 * scroller, not this one.
 *
 * Checked by scrolling and then reading positions, rather than by reading
 * declarations. `overflow-y: auto` was on this pane throughout the phantom
 * scrollbar bug and never engaged once, because the pane had no bounded height
 * to overflow.
 */
async function assertOnlyThePaneScrolls(page, shellUrl) {
  await page.setViewportSize(VIEWPORT);
  await page.goto(shellUrl);
  await page.waitForSelector('[data-fixture-content]');

  const geometry = await page.evaluate(async () => {
    const probe = document.createElement('div');
    probe.style.cssText = 'height:2400px';
    probe.innerHTML = '<div id="probe-end" style="height:20px">end</div>';
    document.querySelector('[data-fixture-content]').appendChild(probe);
    await new Promise(requestAnimationFrame);

    const pane = document.querySelector('main');
    const nav = document.querySelector('nav[aria-label="Console sections"]');
    const bar = document.querySelector('header');
    const before = { nav: nav.getBoundingClientRect().top, bar: bar.getBoundingClientRect().top };

    // Drive the pane to its bottom, the way a person with a wheel would.
    pane.scrollTop = pane.scrollHeight;
    window.scrollTo(0, 99999);
    const windowScrolled = window.scrollY;
    await new Promise(requestAnimationFrame);

    const end = document.getElementById('probe-end');
    return {
      paneScrolled: pane.scrollTop,
      paneCanScroll: pane.scrollHeight > pane.clientHeight + 1,
      windowScrolled,
      navMoved: Math.abs(nav.getBoundingClientRect().top - before.nav),
      barMoved: Math.abs(bar.getBoundingClientRect().top - before.bar),
      navVisible: nav.getBoundingClientRect().bottom > 0,
      endReached: end.getBoundingClientRect().bottom <= window.innerHeight + 2,
    };
  });

  check(
    '[shell] the content pane is the thing that scrolls',
    geometry.paneCanScroll && geometry.paneScrolled > 0,
    `pane scrolled ${Math.round(geometry.paneScrolled)}px`
  );
  check(
    '[shell] the window itself does not scroll, however much content there is',
    geometry.windowScrolled === 0,
    `window scrolled ${geometry.windowScrolled}px`
  );
  check(
    '[shell] the sidebar stays where it is',
    geometry.navMoved <= 1 && geometry.navVisible,
    `sidebar moved ${Math.round(geometry.navMoved)}px`
  );
  check(
    '[shell] the top bar stays where it is',
    geometry.barMoved <= 1,
    `top bar moved ${Math.round(geometry.barMoved)}px`
  );
  check('[shell] the last row is still reachable', geometry.endReached);
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
const shellUrl = `http://localhost:${port}/test/fixtures/shell-harness.html`;

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
  // Three heights, because the phantom scroll was a proportion of the window.
  await assertShellFitsWindow(page, shellUrl, { width: 1512, height: 982 });
  await assertShellFitsWindow(page, shellUrl, VIEWPORT);
  await assertShellFitsWindow(page, shellUrl, { width: 1366, height: 620 });
  await assertOnlyThePaneScrolls(page, shellUrl);
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(result => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
