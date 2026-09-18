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
 * The plan editor, at the window it is actually used in.
 *
 * `admin-dev` showed the dialog grown to fit all nine limit rows, with its own
 * header and tab strip pushed off the top of the screen. Two separate things
 * have to hold for that not to come back, and neither is visible to jsdom:
 *
 *   - the dialog is bounded by the WINDOW. It was bounded by
 *     `calc(100vh - 24px)` while `:root` carries `zoom: 1.25`, and `vh` does not
 *     participate in zoom - so the cap was a quarter larger than the window and
 *     never bound anything.
 *   - the dialog is bounded by its own HEIGHT. Even a correct viewport cap only
 *     engages on a short window; on a tall one a content-sized dialog shows all
 *     nine rows, and then the first short window somebody opens it on loses the
 *     last four with no scrollbar to find them by.
 *
 * So this asserts the outcome rather than either mechanism: five rows above the
 * fold, a sixth partly visible, and the rest reachable by scrolling.
 */
async function assertPlanEditor(page, label, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(planEditorUrl);
  await page.waitForSelector('[role="dialog"]');
  await page.waitForFunction(
    () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === 'Limits'
  );

  const g = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const body = dialog.querySelector('[data-dialog-body]');
    const head = dialog.querySelector('header');
    const strip = dialog.querySelector('[role="tab"]').parentElement;
    const foot = dialog.querySelector('footer');
    const view = body.getBoundingClientRect();

    // A limit row is the element wrapping a mode radiogroup.
    const rows = Array.from(body.querySelectorAll('[role="radiogroup"]'))
      .map(group => group.parentElement.getBoundingClientRect());

    return {
      viewportHeight: window.innerHeight,
      dialogTop: Math.round(dialog.getBoundingClientRect().top),
      dialogBottom: Math.round(dialog.getBoundingClientRect().bottom),
      headTop: Math.round(head.getBoundingClientRect().top),
      stripTop: Math.round(strip.getBoundingClientRect().top),
      footBottom: Math.round(foot.getBoundingClientRect().bottom),
      totalRows: rows.length,
      // Fully inside the body's visible box, with a pixel of tolerance.
      rowsFullyVisible: rows.filter(r => r.top >= view.top - 1 && r.bottom <= view.bottom + 1).length,
      rowsPartlyVisible: rows.filter(r => r.top < view.bottom - 1 && r.bottom > view.top + 1).length,
      bodyScroll: body.scrollHeight,
      bodyClient: body.clientHeight,
    };
  });

  check(
    `[plans ${label}] the dialog is inside the window`,
    g.dialogTop >= -1 && g.dialogBottom <= g.viewportHeight + 1,
    `${g.dialogTop}–${g.dialogBottom} / viewport ${g.viewportHeight}`
  );

  check(
    `[plans ${label}] the header and tab strip are on screen`,
    g.headTop >= -1 && g.stripTop >= -1,
    `header ${g.headTop}, tabs ${g.stripTop}`
  );

  check(
    `[plans ${label}] the footer is on screen`,
    g.footBottom <= g.viewportHeight + 1,
    `footer bottom ${g.footBottom} / viewport ${g.viewportHeight}`
  );

  check(
    `[plans ${label}] the body scrolls rather than the dialog growing`,
    g.bodyScroll > g.bodyClient + 1,
    `content ${g.bodyScroll} > visible ${g.bodyClient}`
  );

  check(
    `[plans ${label}] five limit rows are above the fold`,
    g.rowsFullyVisible === 5,
    `${g.rowsFullyVisible} of ${g.totalRows} fully visible, ${g.rowsPartlyVisible} touched`
  );

  // And the other four are reachable. Five visible rows is only the right
  // answer if scrolling gets to the ninth; a body that clips what it cannot
  // show would pass every check above it.
  const lastRowReachable = await page.evaluate(() => {
    const body = document.querySelector('[data-dialog-body]');
    body.scrollTop = body.scrollHeight;
    const groups = body.querySelectorAll('[role="radiogroup"]');
    const last = groups[groups.length - 1].parentElement.getBoundingClientRect();
    const view = body.getBoundingClientRect();
    return {
      ok: last.top >= view.top - 1 && last.bottom <= view.bottom + 1,
      label: groups[groups.length - 1].getAttribute('aria-label'),
    };
  });
  check(
    `[plans ${label}] scrolling reaches the last row`,
    lastRowReachable.ok,
    lastRowReachable.label
  );
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
const planEditorUrl = `http://localhost:${port}/test/fixtures/plan-editor-harness.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });
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
