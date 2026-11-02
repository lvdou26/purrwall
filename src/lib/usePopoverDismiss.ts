import { useEffect, useRef, type RefObject } from 'react';

/**
 * The popover half of the a11y convention (the dialog half is useModalFocus).
 * Popovers (grid, share, ⋯, 🔔) are DISCLOSURE patterns, not dialogs: no
 * focus trap, no aria-modal, just outside-click and Escape. Every popover uses
 * this hook rather than its own copy of the effect.
 *
 * Deliberately: mousedown on `document` (not click — a popover must close
 * before the next control receives its press) and keydown on `window`. No IME
 * guard here: the one popover with a text field, the 🔔 AlertPopover, stops a
 * composing Escape itself (Invariant 7).
 *
 * `onDismiss` rides a ref so callers can pass an inline closure without
 * re-subscribing the listeners on every render — and without the effect
 * holding a stale one from whenever `open` last flipped.
 */
export function usePopoverDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) dismissRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissRef.current();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, ref]);
}
