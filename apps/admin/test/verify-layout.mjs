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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });
await page.goto(url);

try {
  await assertContract(page, '1366x768');
  await assertContract(page, 'short');
  await assertEnterSubmits(page);
  await assertFocus(page);
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(result => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
