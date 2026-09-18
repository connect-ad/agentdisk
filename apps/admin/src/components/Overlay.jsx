import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * The staff console's own dialog primitives.
 *
 * Written here rather than imported from `apps/web`, per docs/ui-layering.md §3
 * and coordination/DEFERRED.md X-02: the console does not take the customer
 * design system, because looking different is how a support engineer knows
 * which app they are in. The *ladder* and the *contract* are shared; the
 * components are not.
 *
 * Three known bugs from the customer app are fixed here by construction rather
 * than avoided by care, because "be careful" is not a mechanism:
 *
 * **1. The footer must never fall below the fold.** At 684px tall the customer
 * app's Create API key modal puts its footer off-screen with no internal scroll
 * and no keyboard submit, which makes creating a key impossible — step 1 of the
 * product's own Quick start. The fix is not `overflow-y`, which was already
 * there. In a flex column a child's default `min-height: auto` refuses to
 * shrink below its content, so the body never gets smaller than its contents,
 * `overflow-y` never engages, and the column grows past its cap instead —
 * pushing the footer out. **`minHeight: 0` on the scrollable child is the fix**,
 * paired with `flex: none` on the head and foot so the browser cannot resolve
 * the overflow by compressing the two parts that must never move.
 *
 * **2. Focus moves once, when the dialog opens.** `Modal` and `Drawer` in the
 * customer app had `onClose` in the dependency array of the effect that focuses
 * a field. Every call site passes an inline arrow and the parent re-renders on
 * each keystroke, so the effect re-ran per character and re-focused the first
 * focusable element — the header's close button. Typing one character into any
 * dialog threw focus onto Close and the next character went nowhere. The
 * handler lives in a ref here; it is needed *current*, not as a dependency.
 *
 * **3. "First focusable" is the wrong target anyway.** It opens every dialog
 * with "dismiss" selected. Focus goes to the first form control, and the close
 * button is explicitly excluded from ever being the initial target.
 */

const Z = {
  modal: 'var(--z-modal)',
  toast: 'var(--z-toast)',
};

/** Everything focusable inside the dialog, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Theme tokens, not literals.
 *
 * These were hardcoded light values - `#111` on `#fff` - written before the
 * console had a theme at all. The result was a white dialog opening in the
 * middle of a dark console: legible, but plainly not part of the same
 * application, and the one surface where somebody confirms a destructive action
 * is the worst place to look like a different program.
 *
 * Every value now resolves through `app.css`, so the dialog follows the theme
 * toggle with nothing here having to know it happened.
 */
const palette = {
  ink: 'var(--tx)',
  muted: 'var(--tx2)',
  faint: 'var(--tx3)',
  surface: 'var(--surf)',
  surfaceAlt: 'var(--surf2)',
  line: 'var(--bd)',
  hairline: 'var(--bd)',
  field: 'var(--surf2)',
  fieldLine: 'var(--bd2)',
  accent: 'var(--acc)',
  accentInk: 'var(--accInk)',
  disabled: 'var(--surf3)',
  danger: 'var(--dngr)',
  dangerSoft: 'var(--dngrSoft)',
  dangerLine: 'var(--dngrBd)',
};

/**
 * Hold a value in a ref that is always current.
 *
 * The whole point of bug 2 above: a callback an effect must *call* is not a
 * callback the effect must *depend on*.
 */
function useLatest(value) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * A dialog.
 *
 * `children` is the body. `footer` is rendered in the fixed footer beside the
 * primary action, so a caller can add a secondary control without reaching into
 * the layout.
 *
 * The dialog is itself the `<form>`, which is what makes point 4 of the contract
 * work: Enter from any text field inside it submits, because that is what a form
 * does. Building the form *inside* the body instead would leave the footer's
 * submit button outside it, and Enter would do nothing.
 */
export function Modal({
  open,
  title,
  description,
  children,
  onClose,
  onSubmit,
  submitLabel = 'Save',
  submitDisabled = false,
  destructive = false,
  busy = false,
  footer = null,
  /**
   * A strip between the header and the body, for tabs.
   *
   * Outside the scrolling body on purpose: tabs inside it scroll away with the
   * content, so the way back to the other tab disappears exactly when somebody
   * has scrolled far enough to want it.
   */
  tabs = null,
  width = 520,
  /**
   * The height the dialog takes when the window allows it.
   *
   * Opt-in, and the mechanism that makes the body scroll rather than the dialog
   * grow. Without it the column is as tall as its content, so on an ordinary
   * window a nine-row form simply becomes a nine-row dialog and `overflowY`
   * never engages — which is the whole failure this component exists to
   * prevent, arriving by a different route than the customer app's.
   *
   * `min(<this>, 100%)` so it can never beat the cap below and push the footer
   * under the fold on a short window. A two-line confirmation passes nothing
   * and stays two lines tall rather than becoming an empty box.
   */
  height = null,
}) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();

  // Current, never a dependency. See bug 2.
  const onCloseRef = useLatest(onClose);

  /**
   * Focus once, on open, and put it somewhere useful.
   *
   * `[open]` is the entire dependency list on purpose. Adding anything that
   * changes while the dialog is in use — a handler, a disabled flag, a value —
   * reintroduces the per-keystroke refocus this is written to prevent.
   */
  useEffect(() => {
    if (!open) return undefined;

    const previous = document.activeElement;
    const node = dialogRef.current;
    if (node) {
      const candidates = Array.from(node.querySelectorAll(FOCUSABLE));
      // The close button is never the initial target: a dialog that opens with
      // "dismiss" selected teaches people to dismiss it.
      const target =
        candidates.find(el => el.dataset.dialogClose === undefined && el.tagName !== 'BUTTON') ??
        candidates.find(el => el.dataset.dialogClose === undefined) ??
        node;
      target.focus();
    }

    return () => {
      // Put focus back where it came from, so closing a dialog does not dump
      // the caret at the top of the document.
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
    };
  }, [open]);

  /** Escape closes. Tab cycles within the dialog rather than escaping behind it. */
  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;

      const node = dialogRef.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll(FOCUSABLE)).filter(
        el => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onCloseRef]);

  const submit = useCallback(
    event => {
      event.preventDefault();
      if (submitDisabled || busy) return;
      onSubmit?.(event);
    },
    [onSubmit, submitDisabled, busy]
  );

  if (!open) return null;

  return (
    <div
      // The scrim. `display: grid` with padding is what bounds the dialog: the
      // child can be at most the viewport minus this padding, which is contract
      // point 1 and needs no max-height arithmetic.
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: Z.modal,
        // Flex, not grid, and matching the design file.
        //
        // As a grid item the dialog would not respect its own max-height: the
        // computed value read 876px while the box measured 975 and the body
        // grew to 776 with almost nothing in it. A flex item with
        // `align-items: center` does not stretch and does clamp.
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // 12, not 24. On a short window every pixel here is one the body does
        // not get, and the scrim only has to read as a margin rather than a
        // comfortable one. Contract point 1 still holds: the dialog cannot
        // exceed the viewport minus this.
        padding: 12,
        background: 'var(--scrim)',
      }}
      onMouseDown={event => {
        // Only a press that both starts and ends on the scrim dismisses. A drag
        // that began inside the dialog and released out here is a text
        // selection, not a decision to discard what was typed.
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onSubmit={submit}
        onMouseDown={event => event.stopPropagation()}
        style={{
          width: `min(${width}px, 100%)`,
          // A percentage of the scrim, NOT a vh calc.
          //
          // `app.css` puts `zoom: 1.25` on :root, and `vh` does not participate
          // in zoom: `100vh` still evaluates to the window's height, and that
          // number is then laid out inside a coordinate space scaled by 1.25.
          // `calc(100vh - 24px)` therefore permitted a dialog about a quarter
          // taller than the window it was meant to fit inside, so the column
          // never reached its cap, the body never overflowed, `overflowY` never
          // engaged, and the dialog grew past the screen - centred, so the
          // header and the tab strip went off the top where they cannot be
          // reached.
          //
          // The scrim is `position: fixed; inset: 0` and so is itself measured
          // in the zoomed space; `box-sizing: border-box` and its 12px padding
          // mean 100% of its content box is exactly the window minus the inset.
          // The bound is correct under any zoom without knowing the factor.
          maxHeight: '100%',
          ...(height === null ? {} : { height: `min(${height}px, 100%)` }),
          display: 'flex',
          flexDirection: 'column',
          // Belt and braces with maxHeight: a flex item's default min-height is
          // auto here too, and the scrim is a grid whose child would otherwise
          // refuse to shrink.
          minHeight: 0,
          background: palette.surface,
          // The design's frame: the brighter border, the larger radius and the
          // deeper shadow. It is the one surface that sits on top of everything
          // else, and the frame is what says so.
          border: `1px solid ${palette.fieldLine}`,
          borderRadius: 14,
          boxShadow: `0 28px 70px var(--shadow)`,
          font: '14px/1.5 var(--font)',
          color: palette.ink,
          animation: 'adminDialogIn .14s ease both',
        }}
      >
        {/* flex: none — the head must never be what the browser compresses. */}
        <header
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 14,
            // The design's header, measured from the file rather than from a
            // screenshot: it was 12/16/10 with a 15px title in the body face,
            // and read as a smaller, tighter dialog than the one it was drawn
            // from.
            padding: '20px 22px 16px',
            borderBottom: `1px solid ${palette.hairline}`,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              id={titleId}
              style={{
                margin: '0 0 5px',
                font: '600 19px/1.25 var(--fontHead)',
                letterSpacing: '-0.02em',
              }}
            >
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: palette.muted }}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            // Marks this out so the focus effect can refuse to land on it.
            data-dialog-close=""
            onClick={onClose}
            aria-label="Close"
            style={{
              flex: 'none',
              width: 28,
              height: 28,
              border: `1px solid ${palette.line}`,
              borderRadius: 7,
              background: palette.surfaceAlt,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              font: 'inherit',
              fontSize: 15,
              lineHeight: 1,
              color: palette.muted,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ×
          </button>
        </header>

        {tabs === null ? null : (
          <div
            style={{
              flex: 'none',
              display: 'flex',
              gap: 2,
              padding: '0 22px',
              borderBottom: `1px solid ${palette.line}`,
              background: palette.surfaceAlt,
            }}
          >
            {tabs}
          </div>
        )}

        {/*
          The scrollable middle. `minHeight: 0` is the fix; `overflowY` alone
          was already present in the customer app and did nothing without it.
        */}
        <div
          data-dialog-body=""
          style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '20px 22px' }}
        >
          {children}
        </div>

        {/* flex: none again — the footer is the part that went missing. */}
        <footer
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '15px 22px',
            borderTop: `1px solid ${palette.hairline}`,
            background: palette.surfaceAlt,
            borderRadius: '0 0 14px 14px',
          }}
        >
          {footer}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 9 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                height: 38,
                padding: '0 14px',
                // The brighter border, not the hairline one. Cancel sits beside
                // a filled primary and beside a red Retire; on the surf2 footer
                // the faint border made it read as disabled rather than as the
                // ordinary way out.
                border: `1px solid ${palette.fieldLine}`,
                borderRadius: 9,
                background: 'transparent',
                color: palette.ink,
                font: 'inherit',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              // The primary action is the form's submit, which is what makes
              // Enter work from any field above. A click handler on a
              // type="button" here would look identical and break the keyboard.
              type="submit"
              disabled={submitDisabled || busy}
              style={{
                height: 38,
                padding: '0 16px',
                border: 0,
                borderRadius: 9,
                background: submitDisabled || busy ? palette.disabled : destructive ? palette.danger : palette.accent,
                // Not white. The accent is a pale lilac in dark mode and a deep
                // violet in light mode, so the readable ink differs between
                // them - `--accInk` is the token that already knows which.
                color: submitDisabled || busy ? palette.faint : destructive ? '#fff' : palette.accentInk,
                font: 'inherit',
                fontSize: 13,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                cursor: submitDisabled || busy ? 'not-allowed' : 'pointer',
              }}
            >
              {busy ? 'Working…' : submitLabel}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

/**
 * A confirmation for something that cannot be taken back.
 *
 * `destructive` defaults to **true**, matching the customer app's `ConfirmModal`
 * and for the same reason: dressing an additive action in the danger treatment
 * is how people learn to click through the red dialogs that matter. An additive
 * confirmation passes `destructive={false}`.
 *
 * `confirmText` implements the type-the-name gate doc 32 §7 requires of workspace
 * and account deletion. When set, the primary action stays disabled until the
 * typed value matches exactly — no trimming, no case folding. A gate that
 * accepts an approximation is a gate that only slows down the careful.
 *
 * `requireReason` is the other half. Staff actions that reach into a customer's
 * account take a mandatory reason, because the audit row is worth little without
 * one.
 */
export function ConfirmModal({
  open,
  title,
  description,
  blastRadius = null,
  confirmText = null,
  requireReason = false,
  confirmLabel = 'Confirm',
  destructive = true,
  busy = false,
  onCancel,
  onConfirm,
}) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');

  // Cleared on open, not on close: leaving it to close means a dialog that is
  // dismissed by unmounting keeps the old value for the next thing it confirms.
  useEffect(() => {
    if (open) {
      setTyped('');
      setReason('');
    }
  }, [open]);

  const nameOk = confirmText === null || typed === confirmText;
  const reasonOk = !requireReason || reason.trim().length > 0;
  const ready = nameOk && reasonOk;

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      onSubmit={() => onConfirm(reason.trim())}
      submitLabel={confirmLabel}
      submitDisabled={!ready}
      destructive={destructive}
      busy={busy}
      width={480}
    >
      {blastRadius ? (
        <div
          style={{
            background: destructive ? palette.dangerSoft : palette.surfaceAlt,
            border: `1px solid ${destructive ? palette.dangerLine : palette.line}`,
            borderRadius: 6,
            padding: 12,
            marginBottom: 14,
            fontSize: 13,
          }}
        >
          {blastRadius}
        </div>
      ) : null}

      {confirmText !== null ? (
        <label style={{ display: 'block', marginBottom: 14 }}>
          <span style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
            Type <strong>{confirmText}</strong> to confirm
          </span>
          <input
            value={typed}
            onChange={event => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${confirmText} to confirm`}
            style={{
              width: '100%',
              padding: '8px 10px',
              border: `1px solid ${typed && !nameOk ? palette.dangerLine : palette.fieldLine}`,
              borderRadius: 6,
              font: 'inherit',
            }}
          />
        </label>
      ) : null}

      {requireReason ? (
        <label style={{ display: 'block' }}>
          <span style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
            Reason <span style={{ color: palette.muted }}>(recorded in the audit log)</span>
          </span>
          <textarea
            value={reason}
            onChange={event => setReason(event.target.value)}
            rows={3}
            style={{
              width: '100%',
              padding: '8px 10px',
              border: `1px solid ${palette.fieldLine}`,
              borderRadius: 6,
              background: palette.field,
              color: palette.ink,
              font: 'inherit',
              resize: 'vertical',
            }}
          />
        </label>
      ) : null}
    </Modal>
  );
}

/**
 * The toast dock.
 *
 * One element carrying `--z-toast`, rather than the inline `zIndex: 90` repeated
 * across eight route files in the customer app — a set of copies nothing keeps
 * in step. ui-layering.md asks both tracks not to add a ninth.
 */
export function ToastDock({ toasts = [], onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: Z.toast,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {toasts.map(toast => (
        <div
          key={toast.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            maxWidth: 380,
            padding: '10px 12px',
            borderRadius: 8,
            background: toast.tone === 'error' ? palette.dangerSoft : palette.surface,
            border: `1px solid ${toast.tone === 'error' ? palette.dangerLine : palette.line}`,
            color: toast.tone === 'error' ? 'var(--dngrTx)' : palette.ink,
            font: '13px/1.45 var(--font)',
            boxShadow: `0 8px 24px var(--shadow)`,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{toast.message}</span>
          <button
            type="button"
            onClick={() => onDismiss?.(toast.id)}
            aria-label="Dismiss"
            style={{
              flex: 'none',
              border: 0,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
