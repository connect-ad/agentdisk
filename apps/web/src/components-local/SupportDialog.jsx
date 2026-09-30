import React from 'react';
import { Button, Icon, Modal } from '../components/index.js';

/**
 * "Talk to a person": one message and one address, opened from more than one
 * place.
 *
 * ── Why it is its own component ───────────────────────────────────────────
 * It started inside `CookieNotice.jsx` and is now also the marketing nav's
 * Support item. Two copies of a support address is the kind of duplication
 * that goes unnoticed precisely because nothing breaks when they disagree —
 * one of them just quietly sends mail to somewhere nobody reads. So the
 * address and the words live here once, and both call sites mount this.
 *
 * ── Why the address and not a form ────────────────────────────────────────
 * There is no support endpoint in this product. `routes/Support.jsx` draws
 * the design's ticket form with its submit visibly disabled and says why,
 * because a button that looks live and discards what somebody typed is worse
 * than no button. A mailto has no such failure mode: it hands the message to
 * software the person already trusts, and `connect@agentdisk.io` is a real
 * mailbox somebody reads — the same address `backlog/003` points the Google
 * consent screen at.
 *
 * It is deliberately reachable before sign-in. `routes/Support.jsx` sits
 * behind auth, so without this a stranger who cannot get in has no way to say
 * so.
 */

/** The one place this address is written. */
export const SUPPORT_EMAIL = 'connect@agentdisk.io';

export function SupportDialog({ onClose }) {
  return (
    <Modal
      title="Talk to a person"
      mark={<Icon name="info" size={16} />}
      onClose={onClose}
      footer={
        <>
          {/* Not "Close": the header's own dismiss carries that label, and two
              buttons reading Close in one dialog is what a screen reader
              announces as a choice between identical things. */}
          <Button variant="secondary" onClick={onClose}>Not now</Button>
          <Button
            variant="primary"
            as="a"
            href={`mailto:${SUPPORT_EMAIL}?subject=AgentDisk`}
            onClick={onClose}
          >
            Email {SUPPORT_EMAIL}
          </Button>
        </>
      }
    >
      <p className="spd__body">
        Anything at all — a key that stopped working, an agent taking a 403 at
        three in the morning, a question about what we store. There is no
        ticket queue to disappear into: mail reaches the people who built this.
      </p>
      <p className="spd__body">
        Write to <span className="spd__addr">{SUPPORT_EMAIL}</span> and include
        your workspace ID if you have one, so we can read the same logs you
        can. We answer in working hours, in the order it arrives, and we will
        tell you honestly if something is not built yet.
      </p>
    </Modal>
  );
}
