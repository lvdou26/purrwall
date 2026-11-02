import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog focus management: on open move focus INTO the container (an
 * already-focused descendant — e.g. the picker's autofocused search — wins;
 * else the container itself, which therefore needs tabIndex={-1}), keep Tab
 * cycling inside it, and hand focus back to the opener on close. Escape
 * handling stays with each modal (IME-guarded there). No styling here —
 * focus outlines follow the stylesheet.
 *
 * Not used on the expanded WALL cell: that overlay deliberately keeps the
 * wall interactive behind it (arrow-key paging, chip strip) — it is a view,
 * not a dialog.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, active: boolean): void {
  // The opener must be captured at the RENDER where the dialog appears —
  // child effects (the picker's search autofocus) run before this hook's own
  // effect, so by effect time the dialog may already hold focus and the
  // opener would be lost.
  const openerRef = useRef<HTMLElement | null>(null);
  const prevActiveRef = useRef(false);
  if (active && !prevActiveRef.current) {
    const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Skip an opener that lives inside ANOTHER dialog being torn down in this
    // same commit (the loading-shell → picker handoff: at render time the
    // shell div is still focused but unmounts moments later, and restoring to
    // a disconnected node silently drops focus to <body>). Leave the opener
    // null so the outgoing shell's own restore (to the real trigger) stands.
    openerRef.current = el && el.closest('[role="dialog"]') && !ref.current?.contains(el) ? null : el;
  }
  prevActiveRef.current = active;

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const opener = openerRef.current;
    // Child effects run first: an inner autofocus has already claimed focus
    // by now — don't steal it back.
    if (!container.contains(document.activeElement)) container.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        // offsetParent null = display:none subtree (hidden tab panes etc.)
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = container.contains(document.activeElement);
      // The container itself (tabIndex=-1) is the initial focus for dialogs
      // with no autofocused child, and it is NOT in `items` — so a Shift+Tab
      // from it must be caught here, else the browser walks to the background
      // control before the dialog and one keystroke escapes the trap.
      const atContainer = document.activeElement === container;
      if (e.shiftKey && (!inside || atContainer || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || atContainer || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    // capture: wins over container-scoped key handling without touching it
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Restore only when the dialog still owns focus (or dropped it to
      // body) — if the user already clicked elsewhere, leave them be.
      if (
        opener?.isConnected &&
        (container.contains(document.activeElement) || document.activeElement === document.body)
      ) {
        opener.focus();
      }
    };
  }, [ref, active]);
}
