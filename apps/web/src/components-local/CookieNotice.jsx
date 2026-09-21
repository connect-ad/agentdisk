import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Modal, Switch } from '../components/index.js';
import { SupportDialog } from './SupportDialog.jsx';
import { readConsent, saveConsent } from '../lib/consent.js';

/**
 * The consent notice, from `AgentDisk Site.dc.html` § COOKIE BAR and § COOKIE
 * PREFERENCES MODAL, plus a fourth action the design does not draw: Support.
 *
 * ── The copy is not the design's, and that is deliberate ──────────────────
 * The design writes "Essential cookies keep you signed in" and offers three
 * categories with live toggles. Two of those statements are not true of the
 * built product, and the precedence rule in CLAUDE.md says the code wins:
 *
 *   - This product sets no HTTP cookies at all. `Set-Cookie` appears nowhere
 *     in `apps/api`; sign-in is Firebase in browser storage and the API is
 *     bearer tokens. So "essential" here is browser storage, and the notice
 *     says storage where it means storage.
 *   - Nothing collects analytics or attribution today. `routes/Legal.jsx` §9
 *     is the authoritative text and states that plainly, so the notice cannot
 *     imply otherwise by offering to switch off something that is not running.
 *
 * The two optional toggles are still real: they write a decision, and
 * `lib/consent.js` is the gate anything future has to pass. Recording the
 * answer before there is a question to answer is the whole point — the policy
 * promises to ask *before* collecting, and that promise is only keepable if
 * the answer already exists.
 *
 * ── Why the title names the host you are on ───────────────────────────────
 * The record lives in this origin's localStorage, so a choice made on
 * `app-dev.agentdisk.io` is not the one `agentdisk.io` reads. Naming the host
 * is therefore the true statement; the design's hardcoded `agentdisk.dev` is
 * its canvas placeholder and was never this product's domain.
 *
 * ── Layering ──────────────────────────────────────────────────────────────
 * The bar sits on the `--z-nav` rung (docs/ui-layering.md §1): it is sticky
 * chrome, and it must fall behind a drawer and a dialog, both of which ask a
 * question that has to be answered first. Its two dialogs are rendered as
 * siblings of the bar from `main.jsx`, outside `<App>` — never inside another
 * overlay's subtree, which is the trap §1 of that document describes.
 *
 * ── Why the Support action is here at all ─────────────────────────────────
 * Asked for directly. It is also the one moment a first-time visitor is being
 * asked to make a decision about their data before they have any way to reach
 * anybody, and `routes/Support.jsx` is behind sign-in. The dialog itself is
 * `SupportDialog.jsx`, shared with the marketing nav's Support item so the
 * address and the message cannot come to differ between the two.
 */

/**
 * What each category covers, in the terms of what this product really does.
 * `locked` is essential: it has no toggle rather than a disabled one, because
 * a switch you cannot move is an invitation to try, and because Modal moves
 * focus to the first focusable thing in its body — which should be a control
 * that works.
 */
const CATEGORIES = [
  {
    key: 'essential',
    title: 'Essential',
    tag: 'ALWAYS ON',
    locked: true,
    body: 'Your sign-in session, the workspace you last had open, and your theme. Kept in this browser — this product sets no cookies of its own.',
  },
  {
    key: 'analytics',
    title: 'Product analytics',
    tag: 'NOT IN USE',
    body: 'Which dashboard features get used, aggregated and never file contents. Nothing collects this today.',
  },
  {
    key: 'marketing',
    title: 'Attribution',
    tag: 'NOT IN USE',
    body: 'Which page or link sent you here. No third-party ad networks, and nothing collects this today.',
  },
];

function hostLabel() {
  try {
    return window.location.hostname || 'agentdisk.io';
  } catch {
    return 'agentdisk.io';
  }
}

export default function CookieNotice() {
  // Read once, on mount. A decision made in another tab is not worth a storage
  // listener here: the bar is dismissed by answering it, and the next load in
  // this tab reads the record anyway.
  const [decided, setDecided] = useState(() => readConsent() !== null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);

  // The modal's working copy, seeded from any stored record. Optional
  // categories default off, which is what "no decision" has to mean.
  const [draft, setDraft] = useState(() => {
    const stored = readConsent();
    return {
      analytics: !!stored && stored.analytics,
      marketing: !!stored && stored.marketing,
    };
  });

  function decide(choice) {
    saveConsent(choice);
    setDraft({ analytics: choice.analytics, marketing: choice.marketing });
    setPrefsOpen(false);
    setDecided(true);
  }

  // Support outlives the bar: once a decision is made the bar goes, but a
  // dialog that is open must not vanish from under the person reading it.
  const bar = decided ? null : (
    <div className="ckb" role="region" aria-label="Cookie consent">
      <div className="ckb__inner">
        <div className="ckb__copy">
          <p className="ckb__title">Cookies on {hostLabel()}</p>
          <p className="ckb__body">
            Sign-in and workspace state are kept in this browser; that part is
            essential and always on. Analytics and attribution collect nothing
            today — your choice here is what we will honour before anything
            starts.
          </p>
        </div>
        <div className="ckb__actions">
          <Button variant="ghost" onClick={() => setSupportOpen(true)}>Support</Button>
          <Button variant="ghost" onClick={() => setPrefsOpen(true)}>Manage preferences</Button>
          <Button variant="secondary" onClick={() => decide({ analytics: false, marketing: false })}>
            Reject non-essential
          </Button>
          <Button variant="primary" onClick={() => decide({ analytics: true, marketing: true })}>
            Accept all
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {bar}

      {prefsOpen ? (
        <Modal
          title="Cookie preferences"
          description="Saved for 12 months on this device, then asked again."
          onClose={() => setPrefsOpen(false)}
          onSubmit={() => decide(draft)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setPrefsOpen(false)}>Cancel</Button>
              <Button variant="primary" type="submit">Save choices</Button>
            </>
          }
        >
          <div className="ckb__cats">
            {CATEGORIES.map(c => (
              <div key={c.key} className="ckb__cat">
                {c.locked ? (
                  <span className="ckb__lockedswitch" aria-hidden="true" />
                ) : (
                  <Switch
                    checked={draft[c.key]}
                    aria-label={c.title}
                    onChange={e => setDraft(d => ({ ...d, [c.key]: e.target.checked }))}
                  />
                )}
                <div className="ckb__cattext">
                  <div className="ckb__catline">
                    <span className="ckb__cattitle">{c.title}</span>
                    <span className="ckb__cattag">{c.tag}</span>
                  </div>
                  <p className="ckb__catbody">{c.body}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="ckb__foot">
            Neither optional category is running, so there is nothing to switch
            off yet. Your answer is stored and is what the product has to check
            first. The full detail is in the{' '}
            <Link to="/privacy" onClick={() => setPrefsOpen(false)}>privacy policy</Link>.
          </p>
        </Modal>
      ) : null}

      {supportOpen ? <SupportDialog onClose={() => setSupportOpen(false)} /> : null}
    </>
  );
}
