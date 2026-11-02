import { useEffect, useRef } from 'react';
import { IS_COARSE } from './media';

/**
 * Custom pull-to-refresh for the narrow wall. Native PTR is globally
 * suppressed (index.css: overflow:hidden root + overscroll-behavior: none),
 * so the gesture is reimplemented — and it starts ONLY from the top chrome
 * (.topbar / .hint-bar), never from the charts: swiping the wall must stay
 * pure scrolling, and pulling the chrome always works regardless of the
 * grid's scroll position. Indicator style deliberately: nothing translates
 * but the paw — a grid transform would make it the containing block for the
 * fixed expanded cell.
 *
 * The app never reloads itself (updateCheck.ts header). A pull is
 * user-initiated — the same gesture class as clicking the ↻ pill — so the
 * caller MAY reload from onRefresh when a new build is live.
 */

const ENGAGE_PX = 8; // finger travel before the gesture claims the touch
/** Where a pull may start: the top chrome only. Charts/grid never engage. */
const START_ZONE = '.topbar, .hint-bar';
const THRESHOLD = 64; // post-resistance px that arm the refresh
const MAX_PULL = 96; // indicator travel cap
const RESIST = 0.4; // finger px → indicator px
const HOLD_PX = 51; // where the indicator parks while spinning (~0.8×threshold)
/** A wall-wide heal costs ~20 weight × cells; the cooldown keeps a
 *  pull-happy thumb from stacking real fetch rounds (WS is live and the
 *  version poll runs every minute anyway). Cooled-down pulls still get the
 *  pop acknowledgment — everything they would FETCH is already fresh. A
 *  pending UPDATE bypasses this entirely (see updatePending): a reload
 *  costs zero HL weight, and swallowing it would break the promise that a
 *  pull applies a waiting update. */
const COOLDOWN_MS = 30_000;
const SETTLE_MS = 230; // let the release transition land before the spin owns transform
const SPIN_MIN_MS = 700; // sub-perceptual spins read as fake — hold a beat
const DONE_MS = 400; // pop-and-fade before the indicator resets

export function usePullToRefresh(opts: {
  gridRef: { current: HTMLElement | null };
  indicatorRef: { current: HTMLElement | null };
  enabled: boolean;
  /** Refresh work; resolve when settled (a reload path never resolves). */
  onRefresh: () => Promise<void>;
  /** True when a new build is already known to be waiting (the ↻ pill).
   *  Checked synchronously at release to bypass the cooldown. */
  updatePending?: () => boolean;
  /** Data-heal pacing; callers scale it with wall size (default 30s). */
  cooldownMs?: number;
}) {
  const { gridRef, indicatorRef, enabled } = opts;
  // Listeners are mount-stable; the freshest callbacks are read through refs.
  const onRefreshRef = useRef(opts.onRefresh);
  onRefreshRef.current = opts.onRefresh;
  const updatePendingRef = useRef(opts.updatePending);
  updatePendingRef.current = opts.updatePending;
  const lastRunRef = useRef(0);
  const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;

  useEffect(() => {
    const grid = gridRef.current;
    const ind = indicatorRef.current;
    if (!enabled || !IS_COARSE || !grid || !ind) return;

    // idle → watch (touch at rest) → pull (engaged) / off (scroll or chart pan)
    let mode: 'idle' | 'watch' | 'pull' | 'off' = 'idle';
    let busy = false; // release sequence running — new touches are ignored
    let disposed = false; // effect torn down — orphaned async must not touch ind
    let startX = 0;
    let startY = 0;
    let armed = false;
    let doneTimer = 0;
    let spinTimer = 0;

    const setInd = (pull: number, immediate: boolean) => {
      ind.style.transition = immediate ? 'none' : '';
      ind.style.opacity = pull <= 0 ? '0' : String(Math.min(1, pull / THRESHOLD));
      // rotation scrubs with the pull — the release spin continues the motion
      ind.style.transform = `translate(-50%, ${pull}px) rotate(${pull * 2.5}deg)`;
    };

    const disarm = () => {
      armed = false;
      ind.classList.remove('armed');
    };

    const onStart = (e: TouchEvent) => {
      if (busy || e.touches.length !== 1) return;
      // top-chrome starts only: a touch beginning on the charts/grid is
      // scrolling or chart interaction, never a pull
      const t = e.target;
      if (!(t instanceof Element) || !t.closest(START_ZONE)) return;
      // ...but never from inside a popover: they are topbar CHILDREN in the
      // DOM (outside-tap close needs contains()) while rendering as panels
      // over the wall — the fixed ⊞ wall panel especially invites drags,
      // and a swipe-down on it would otherwise reach the reload/heal path
      if (t.closest('.grid-pop, .share-pop, .more-pop')) return;
      // park just under wherever the grid's top edge currently is (the
      // topbar is 1 or 2 rows depending on width)
      ind.style.top = `${grid.getBoundingClientRect().top + 6}px`;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      mode = 'watch';
    };

    const onMove = (e: TouchEvent) => {
      // an upstream owner (the cell-drag session's document-capture blocker)
      // already claimed this touch — stand down for the rest of the gesture
      if (e.defaultPrevented && mode !== 'pull') {
        mode = 'off';
        return;
      }
      if (mode === 'idle' || mode === 'off') return;
      if (e.touches.length !== 1) {
        // second finger = chart pinch — hand the gesture back entirely
        disarm();
        setInd(0, false);
        mode = 'off';
        return;
      }
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (mode === 'watch') {
        if (dy < 0 || Math.abs(dx) > Math.abs(dy) + 4) {
          // upward or sideways on the chrome — not a pull; let it go
          mode = 'off';
          return;
        }
        // Downward-or-ambiguous on the chrome: own the native action from
        // the VERY FIRST move — iOS ignores preventDefault once its own
        // handling starts, so deciding after a travel threshold is always
        // too late. The chrome has nothing to scroll, so nothing is lost.
        e.preventDefault();
        if (dy <= ENGAGE_PX) return; // not yet decisive — keep suppressing
        mode = 'pull';
      }
      // engaged: the gesture owns the touch — no native scroll under it
      e.preventDefault();
      const pull = Math.min(MAX_PULL, Math.max(0, dy - ENGAGE_PX) * RESIST);
      const nowArmed = pull >= THRESHOLD;
      if (nowArmed !== armed) {
        armed = nowArmed;
        ind.classList.toggle('armed', armed);
        if (armed) navigator.vibrate?.(10);
      }
      setInd(pull, true);
    };

    /** Pop-and-fade, then reset. One visual for both "healed" and "already
     *  fresh" — either way the wall is now provably current. */
    const finishDone = () => {
      ind.style.transition = '';
      ind.style.transform = `translate(-50%, ${HOLD_PX}px) scale(1.3)`;
      ind.style.opacity = '0';
      doneTimer = window.setTimeout(() => {
        if (!disposed) setInd(0, true);
        busy = false;
      }, DONE_MS);
    };

    const onEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        // a finger REMAINS — this was a secondary finger's tap-lift, not the
        // pull's release (a tap emits no touchmove, so the onMove multi-touch
        // abort never saw it). Hand the gesture back.
        if (mode === 'pull') {
          disarm();
          setInd(0, false);
        }
        mode = 'off';
        return;
      }
      if (mode !== 'pull') {
        mode = 'idle';
        return;
      }
      mode = 'idle';
      if (!armed) {
        setInd(0, false); // released short of the threshold — retract
        return;
      }
      disarm();
      busy = true;
      const now = Date.now();
      // a known-waiting update bypasses the cooldown: reloads cost zero HL
      // weight, and the pull-again-to-apply habit is the feature's promise
      const bypass = updatePendingRef.current?.() === true;
      if (!navigator.onLine || (!bypass && now - lastRunRef.current < cooldownMs)) {
        finishDone();
        return;
      }
      lastRunRef.current = now;
      setInd(HOLD_PX, false); // settle onto the hold spot…
      // …and only then hand transform to the spin keyframes — starting the
      // animation immediately would snap position/rotation to the keyframes'
      // fixed values mid-transition.
      spinTimer = window.setTimeout(() => ind.classList.add('spin'), SETTLE_MS);
      const started = now;
      onRefreshRef
        .current()
        .catch(() => {
          /* refresh work reports its own failures (error overlays) */
        })
        .then(() => {
          if (disposed) return; // torn down mid-refresh — nothing owns ind now
          doneTimer = window.setTimeout(
            () => {
              window.clearTimeout(spinTimer);
              ind.classList.remove('spin');
              finishDone();
            },
            Math.max(0, SPIN_MIN_MS - (Date.now() - started)),
          );
        });
    };

    const onCancel = () => {
      // the SYSTEM took the touch (call, OS gesture, tab switch): abort —
      // an armed-but-cancelled pull must neither refresh nor consume the
      // cooldown (platform convention: touchcancel is never a commitment)
      if (mode === 'pull') {
        disarm();
        setInd(0, false);
      }
      mode = 'idle';
    };

    // DOCUMENT capture: the start zone (.topbar/.hint-bar) lives outside the
    // grid, and once a pull engages the moves must keep flowing wherever the
    // finger wanders. onStart's zone gate keeps every grid/chart touch out.
    document.addEventListener('touchstart', onStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onMove, { passive: false, capture: true });
    document.addEventListener('touchend', onEnd, { passive: true, capture: true });
    document.addEventListener('touchcancel', onCancel, { passive: true, capture: true });
    return () => {
      disposed = true;
      document.removeEventListener('touchstart', onStart, { capture: true });
      document.removeEventListener('touchmove', onMove, { capture: true });
      document.removeEventListener('touchend', onEnd, { capture: true });
      document.removeEventListener('touchcancel', onCancel, { capture: true });
      window.clearTimeout(doneTimer);
      window.clearTimeout(spinTimer);
      ind.classList.remove('spin', 'armed');
      setInd(0, true);
    };
  }, [enabled, gridRef, indicatorRef, cooldownMs]);
}
