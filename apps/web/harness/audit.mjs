// Responsive audit: opens every route at every viewport in a real Chrome,
// mocks the API, and reports horizontal overflow plus any element that pokes
// out of the viewport. Screenshots go to the scratchpad.
//
//   node harness/audit.mjs [outDir] [routeFilter] [widthFilter]
// playwright-core is not a dependency of the app: it drives the Chrome that
// is already installed (`channel: 'chrome'`), and it is resolved from
// wherever it was installed — `npm i playwright-core` in any directory and
// point PW_PATH at that copy, or install it here and leave PW_PATH unset.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PW_PATH ?? 'playwright-core');
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answer, WS } from './fixtures.mjs';

const OUT = process.argv[2] ?? 'harness-out';
const ROUTE_FILTER = process.argv[3] ?? '';
const WIDTH_FILTER = process.argv[4] ? Number(process.argv[4]) : null;
mkdirSync(OUT, { recursive: true });

const BASE = 'http://127.0.0.1:5199';
const W = `/w/${WS.slug}`;
export const ROUTES = [
  ['landing', '/'], ['pricing', '/pricing'], ['docs', '/docs'], ['login', '/login'], ['signup', '/signup'],
  ['forgot', '/forgot-password'], ['sandbox', '/sandbox'], ['claim', '/claim/tok_harness'],
  ['share', '/s/shr_harness'], ['404', '/nope'], ['500', '/500'], ['closed', '/account-closed'],
  ['overview', W], ['files', `${W}/files`], ['agents', `${W}/agents`],
  ['agent', `${W}/agents/agt_01HTXK6V7Q8R9S0T1U2V3W4X5A`], ['keys', `${W}/keys`], ['mcp', `${W}/mcp`],
  ['webhooks', `${W}/webhooks`], ['activity', `${W}/activity`], ['usage', `${W}/usage`],
  ['settings', `${W}/settings`], ['billing', `${W}/billing`], ['profile', `${W}/profile`], ['support', `${W}/support`],
];
export const VIEWPORTS = [
  [360, 800], [375, 812], [390, 844], [430, 932], [768, 1024], [820, 1180], [1024, 1366],
  [1280, 800], [1440, 900], [1920, 1080],
  // landscape phones / tablet
  [844, 390], [1180, 820],
];

const CHECK = `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const overflow = Math.max(de.scrollWidth, document.body.scrollWidth) - vw;
  const out = [];
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // Inside a horizontal scroller is fine.
    let p = el.parentElement, scrolls = false;
    while (p && p !== document.body) {
      const pc = getComputedStyle(p);
      if (/(auto|scroll)/.test(pc.overflowX) || pc.overflowX === 'hidden' || pc.overflow === 'hidden') { scrolls = true; break; }
      p = p.parentElement;
    }
    if (scrolls) continue;
    if (r.right > vw + 1 || r.left < -1) {
      const id = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '');
      out.push({ id, left: Math.round(r.left), right: Math.round(r.right), text: (el.textContent || '').trim().slice(0, 40) });
    }
    if (out.length > 12) break;
  }
  return { vw, overflow, out };
})()`;

export async function launch() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  return browser;
}

export async function newPage(browser, width, height, opts = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    hasTouch: width < 1024,
    isMobile: width < 1024 && !opts.desktop,
    colorScheme: opts.dark ? 'dark' : 'light',
  });
  await context.addInitScript(() => {
    try { localStorage.setItem('agentdisk.cookie-consent', JSON.stringify({ v: 1, at: new Date().toISOString(), analytics: false, marketing: false })); } catch {}
  });
  await context.route(/\/v1\//, async (route) => {
    const req = route.request();
    const body = answer(req.url(), req.method());
    if (body === null) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'harness: no fixture' } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  pageerror:', e.message));
  return page;
}

export async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(350);
}

async function main() {
  const browser = await launch();
  const report = [];
  for (const [w, h] of VIEWPORTS) {
    if (WIDTH_FILTER && w !== WIDTH_FILTER) continue;
    const page = await newPage(browser, w, h);
    for (const [name, path] of ROUTES) {
      if (ROUTE_FILTER && !name.includes(ROUTE_FILTER)) continue;
      await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const res = await page.evaluate(CHECK);
      const file = join(OUT, `${name}-${w}x${h}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const bad = res.overflow > 1 || res.out.length > 0;
      report.push({ name, w, h, overflow: res.overflow, out: res.out });
      console.log(`${bad ? 'FAIL' : 'ok  '} ${name.padEnd(9)} ${String(w).padStart(4)}x${String(h).padEnd(5)} overflow=${res.overflow} ${res.out.map(o => `${o.id}[${o.left},${o.right}]`).join(' ')}`);
    }
    await page.context().close();
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}

if (process.argv[1] && process.argv[1].endsWith('audit.mjs')) main().catch((e) => { console.error(e); process.exit(1); });
