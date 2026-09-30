// Interaction pass: opens menus, drawers and dialogs at phone and tablet
// widths, checks each stays inside the viewport, and screenshots the viewport
// (not the full page) so the state is what a person would see.
//
//   node harness/interact.mjs [outDir] [width]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, newPage, settle, ROUTES } from './audit.mjs';
import { WS } from './fixtures.mjs';

const OUT = process.argv[2] ?? 'harness-out';
const ONLY = process.argv[3] ? Number(process.argv[3]) : null;
const STEP = process.argv[4] ?? '';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:5199';
const W = `/w/${WS.slug}`;

const INSIDE = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  return { found: true, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), vw, vh,
    ok: r.left >= -1 && r.right <= vw + 1 && r.width > 0 };
};

const STEPS = [
  { name: 'nav-open', path: '/', run: async (p) => { await p.click('.mk__burger'); }, check: '.mk__navlinks' },
  { name: 'nav-support', path: '/', run: async (p) => { await p.click('.mk__burger'); await p.click('text=Support'); }, check: '.modal' },
  { name: 'cookie', path: '/pricing', consent: false, check: '.ckb' },
  { name: 'cookie-prefs', path: '/pricing', consent: false, run: async (p) => { await p.click('.ckb button:has-text("Manage")').catch(() => p.click('.ckb button:has-text("Preferences")')); }, check: '.modal' },
  { name: 'docs-toc', path: '/docs', run: async (p) => { await p.click('.doc__mtocsum').catch(() => {}); }, check: '.doc__mtoc' },
  { name: 'ws-menu', path: W, run: async (p) => { await p.click('.shell__wsbtn'); }, check: '.wsx__menu' },
  { name: 'account-menu', path: W, run: async (p) => { await p.click('.shell__user'); }, check: '.wsx__menu' },
  { name: 'new-workspace', path: W, run: async (p) => { await p.click('.shell__wsbtn'); await p.click('text=New workspace'); }, check: '.modal' },
  { name: 'file-drawer', path: `${W}/files`, run: async (p) => { await p.click('text=report.pdf'); }, check: '.dw__panel' },
  { name: 'file-share', path: `${W}/files`, run: async (p) => { await p.click('text=report.pdf'); await p.click('.dw__foot button:has-text("Share")'); }, check: '.modal' },
  { name: 'file-delete', path: `${W}/files`, run: async (p) => { await p.click('text=report.pdf'); await p.click('.dw__foot button:has-text("Delete")'); }, check: '.modal' },
  { name: 'new-folder', path: `${W}/files`, run: async (p) => { await p.click('button:has-text("New folder")'); }, check: '.modal' },
  { name: 'bulk-select', path: `${W}/files`, run: async (p) => { await p.click('thead .check'); }, check: '.bulkbar' },
  { name: 'create-agent', path: `${W}/agents`, run: async (p) => { await p.click('button:has-text("New agent"), button:has-text("Add agent"), button:has-text("Create agent")'); }, check: '.modal' },
  { name: 'agent-menu', path: `${W}/agents`, run: async (p) => { await p.click('[aria-label^="Actions for"] >> nth=0', { timeout: 5000 }).catch(() => {}); }, check: '.menu, .ds__acard' },
  { name: 'create-key', path: `${W}/keys`, run: async (p) => { await p.click('button:has-text("Create key")'); }, check: '.modal' },
  // Scroll the table first: the pill closes its menu on any scroll, and
  // Playwright's own scroll-into-view lands after the click.
  { name: 'key-state', path: `${W}/keys`, run: async (p) => { await p.evaluate(() => { document.querySelector('.tbl-scroll').scrollLeft = 4000; }); await p.waitForTimeout(400); await p.click('button.kst >> nth=0', { force: true }); }, check: '.kst__menu' },
  { name: 'key-view', path: `${W}/keys`, run: async (p) => { await p.click('[aria-label^="Show "] >> nth=0'); }, check: '.modal' },
  { name: 'mcp-select', path: `${W}/mcp`, check: '.select__el' },
  { name: 'webhook-add', path: `${W}/webhooks`, run: async (p) => { await p.click('button:has-text("Add endpoint") >> nth=0'); }, check: '.modal' },
  { name: 'activity-expand', path: `${W}/activity`, run: async (p) => { await p.click('.actrow >> nth=0'); }, check: '.dl' },
  { name: 'settings-members', path: `${W}/settings`, run: async (p) => { await p.click('[role=tab]:has-text("Members")'); }, check: '.tbl' },
  { name: 'settings-invite', path: `${W}/settings`, run: async (p) => { await p.click('[role=tab]:has-text("Members")'); await p.click('button:has-text("Add member")', { timeout: 5000 }).catch(() => {}); }, check: '.modal, .tbl' },
  { name: 'settings-security', path: `${W}/settings`, run: async (p) => { await p.click('[role=tab]:has-text("Security")'); }, check: '.panel' },
  { name: 'settings-delete', path: `${W}/settings`, run: async (p) => { await p.click('button:has-text("Delete workspace")'); }, check: '.modal' },
  { name: 'billing-cancel', path: `${W}/billing`, run: async (p) => { await p.click('button:has-text("Cancel subscription")'); }, check: '.modal' },
  { name: 'billing-yearly', path: `${W}/billing`, run: async (p) => { await p.click('button:has-text("Yearly")'); }, check: '.plan--picker' },
  { name: 'profile-edit', path: `${W}/profile`, run: async (p) => { await p.click('.acctrow__edit >> nth=0'); }, check: '.acctrow--editing' },
  { name: 'profile-delete', path: `${W}/profile`, run: async (p) => { await p.click('button:has-text("Delete account")'); }, check: '.modal' },
  { name: 'agent-disable', path: `${W}/agents/agt_01HTXK6V7Q8R9S0T1U2V3W4X5A`, run: async (p) => { await p.click('.switch'); }, check: '.modal' },
  { name: 'agent-keys-tab', path: `${W}/agents/agt_01HTXK6V7Q8R9S0T1U2V3W4X5A`, run: async (p) => { await p.click('[role=tab]:has-text("Keys")'); }, check: '.tbl, .panel' },
  { name: 'support-form', path: `${W}/support`, check: '.sup__topics' },
  { name: 'signup', path: '/signup', run: async (p) => { await p.fill('input[type=password] >> nth=0', 'abc'); }, check: '.auth__card' },
  { name: 'claim-signed', path: '/claim/tok_harness', check: '.auth__card, .claim, main' },
];

const WIDTHS = ONLY ? [[ONLY, ONLY === 844 ? 390 : ONLY < 500 ? 800 : 1024]] : [[360, 800], [390, 844], [768, 1024], [844, 390]];

async function main() {
  const browser = await launch();
  for (const [w, h] of WIDTHS) {
    for (const step of STEPS) {
      if (STEP && !step.name.includes(STEP)) continue;
      const page = await newPage(browser, w, h, { consent: step.consent });
      if (step.consent === false) {
        await page.context().addInitScript(() => { try { localStorage.removeItem('agentdisk.cookie-consent'); } catch {} });
      }
      let note = '';
      try {
        await page.goto(BASE + step.path, { waitUntil: 'domcontentloaded' });
        await settle(page);
        if (step.consent === false) { await page.evaluate(() => { try { localStorage.removeItem('agentdisk.cookie-consent'); } catch {} }); await page.reload(); await settle(page); }
        if (step.run) await step.run(page);
        await page.waitForTimeout(400);
        const res = await page.evaluate(INSIDE, step.check);
        const de = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth);
        note = !res.found ? 'NOT FOUND' : `${res.ok ? 'ok  ' : 'OUT '} [${res.left},${res.right}] h=${res.bottom - res.top} overflow=${de}`;
      } catch (e) {
        note = 'ERR ' + e.message.split('\n')[0].slice(0, 90);
      }
      await page.screenshot({ path: join(OUT, `${step.name}-${w}x${h}.png`) }).catch(() => {});
      console.log(`${note.startsWith('ok') ? 'ok  ' : 'FAIL'} ${step.name.padEnd(17)} ${w}x${h} ${note}`);
      await page.context().close();
    }
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
