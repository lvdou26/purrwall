import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { Market } from '../lib/hl/types';
import {
  addAlert,
  fmtAlertPrice,
  getAlertPrefs,
  MAX_ALERTS,
  pctTarget,
  removeAlert,
  setAlertPrefs,
  useAlertPrefs,
  useAlerts,
  type AlertMode,
} from '../lib/alerts';
import { previewPing, primeAudio, requestNotifyPermission } from '../lib/alertEngine';
import { useT } from '../lib/i18n';
import { IS_COARSE, useMediaQuery } from '../lib/media';

const POP_W = 236;

/**
 * The 🔔 popover: create price / percentage alerts for this cell's market,
 * see and delete existing ones (including alerts on markets no longer on
 * any wall — this popover is the only management surface, so orphans must
 * stay reachable from every cell), and the two output prefs.
 *
 * A disclosure, not a dialog (usePopoverDismiss is wired by ChartCell,
 * whose ref wraps the bell AND this popover). position:fixed because .cell
 * is overflow:hidden — an absolute child would clip; the anchor rect is
 * measured once per open, and any outside scroll closes the popover rather
 * than letting it drift away from its cell (the grid is the scroller on
 * narrow walls).
 */
export function AlertPopover({
  market,
  currentPrice,
  anchorRef,
  onClose,
}: {
  market: Market;
  currentPrice: number | null;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const tr = useT();
  const alerts = useAlerts();
  const prefs = useAlertPrefs();
  const isNarrow = useMediaQuery('(max-width: 640px)');
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [mode, setMode] = useState<AlertMode>('price');
  const [val, setVal] = useState(() => (currentPrice != null ? String(currentPrice) : ''));
  const notifySupported = typeof Notification !== 'undefined';
  const [notifyDenied, setNotifyDenied] = useState(
    () => notifySupported && Notification.permission === 'denied',
  );

  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    const vh = window.innerHeight;
    // Bottom-row cells: open upward instead of clipping below the viewport.
    const openUp = r.bottom > vh * 0.6;
    const vert: CSSProperties = openUp
      ? { bottom: vh - r.top + 6, maxHeight: Math.max(160, r.top - 18) }
      : { top: r.bottom + 6, maxHeight: Math.max(160, vh - r.bottom - 18) };
    if (isNarrow) {
      setStyle({ ...vert, left: 12, right: 12 });
    } else {
      const left = Math.max(8, Math.min(r.right - POP_W, window.innerWidth - POP_W - 8));
      setStyle({ ...vert, left, width: POP_W });
    }
  }, [anchorRef, isNarrow]);

  // The grid scrolls under a fixed popover — close instead of drifting.
  // Scrolls INSIDE the popover (the alert list) must not self-close it.
  useLayoutEffect(() => {
    const onScroll = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      onCloseRef.current();
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, []);

  // Type-straight-away on desktop; on touch the keyboard would cover the
  // popover before the user even decides between creating and deleting.
  useLayoutEffect(() => {
    if (!IS_COARSE) {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }
  }, []);

  const mine = alerts.filter((a) => a.coin === market.coin);
  const others = alerts.filter((a) => a.coin !== market.coin);
  const atCap = alerts.length >= MAX_ALERTS;

  const parsed = parseFloat(val.replace(/,/g, ''));
  const target =
    mode === 'pct' && Number.isFinite(parsed) && parsed !== 0 && currentPrice != null
      ? pctTarget(currentPrice, parsed)
      : null;
  const canAdd =
    mode === 'price' ? Number.isFinite(parsed) && parsed > 0 : target != null && target > 0;

  const switchMode = (m: AlertMode) => {
    if (m === mode) return;
    setMode(m);
    setVal(m === 'price' && currentPrice != null ? String(currentPrice) : '');
    inputRef.current?.focus({ preventScroll: true });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    const added =
      mode === 'price'
        ? addAlert({ coin: market.coin, label: market.display, price: parsed, mode })
        : addAlert({
            coin: market.coin,
            label: market.display,
            price: target as number,
            mode,
            pct: parsed,
            base: currentPrice as number,
          });
    if (!added) return; // cap reached in another tab since render
    // We are inside a user gesture — the cheapest moment to unlock audio.
    if (getAlertPrefs().sound) primeAudio();
    setVal(mode === 'price' && currentPrice != null ? String(currentPrice) : '');
  };

  const row = (a: (typeof alerts)[number], withLabel: boolean) => (
    <li key={a.id}>
      <span className="alert-row-main">
        {withLabel && <span className="alert-row-coin">{a.label}</span>}
        {fmtAlertPrice(a.price)}
        {a.pct != null && (
          <span className="alert-row-pct">
            {a.pct > 0 ? '+' : ''}
            {a.pct}%
          </span>
        )}
      </span>
      <button
        className="alert-del"
        onClick={() => removeAlert(a.id)}
        title={tr('alert_delete')}
        aria-label={tr('alert_delete')}
      >
        ×
      </button>
    </li>
  );

  return (
    <div className="alert-pop" ref={popRef} style={style ?? undefined}>
      <div className="alert-pop-head">
        <span className="alert-pop-title">{tr('alert_bell')}</span>
        <span className="alert-pop-market">{market.display}</span>
      </div>
      <div className="alert-modes">
        <button
          className={mode === 'price' ? 'active' : ''}
          onClick={() => switchMode('price')}
          aria-pressed={mode === 'price'}
        >
          {tr('alert_tab_price')}
        </button>
        <button
          className={mode === 'pct' ? 'active' : ''}
          onClick={() => switchMode('pct')}
          aria-pressed={mode === 'pct'}
        >
          {tr('alert_tab_pct')}
        </button>
      </div>
      {atCap ? (
        <div className="alert-hint">{tr('alert_full')}</div>
      ) : (
        <form className="alert-form" onSubmit={submit}>
          <input
            ref={inputRef}
            className="alert-input"
            type="text"
            inputMode="decimal"
            value={val}
            placeholder={mode === 'pct' ? tr('alert_pct_ph') : ''}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              // Invariant 7: Enter/Escape during IME composition belong to
              // the IME. Swallow Enter; stop Escape short of the window
              // listener that would close the whole popover.
              if (e.nativeEvent.isComposing || e.keyCode === 229) {
                if (e.key === 'Enter') e.preventDefault();
                if (e.key === 'Escape') e.stopPropagation();
              }
            }}
            aria-label={mode === 'price' ? tr('alert_tab_price') : tr('alert_tab_pct')}
          />
          <button type="submit" className="alert-addbtn" disabled={!canAdd}>
            {tr('alert_add')}
          </button>
        </form>
      )}
      {mode === 'pct' && target != null && (
        <div className="alert-target">
          → {tr('alert_target')} {fmtAlertPrice(target)}
        </div>
      )}
      {mine.length > 0 && <ul className="alert-list">{mine.map((a) => row(a, false))}</ul>}
      {others.length > 0 && (
        <>
          <div className="alert-others-label">{tr('alert_others')}</div>
          <ul className="alert-list alert-list-dim">{others.map((a) => row(a, true))}</ul>
        </>
      )}
      <div className="alert-prefs">
        <label className="alert-pref">
          <input
            type="checkbox"
            checked={prefs.sound}
            onChange={(e) => {
              const on = e.target.checked;
              setAlertPrefs({ sound: on });
              if (on) previewPing();
            }}
          />
          {tr('alert_sound')}
        </label>
        {notifySupported && (
          <label className="alert-pref">
            <input
              type="checkbox"
              checked={prefs.notify && !notifyDenied}
              onChange={(e) => {
                const on = e.target.checked;
                if (!on) {
                  setAlertPrefs({ notify: false });
                  return;
                }
                void requestNotifyPermission().then((perm) => {
                  setAlertPrefs({ notify: perm === 'granted' });
                  setNotifyDenied(perm !== 'granted');
                });
              }}
            />
            {tr('alert_notify')}
          </label>
        )}
      </div>
      {notifyDenied && <div className="alert-denied">{tr('alert_notify_denied')}</div>}
      <div className="alert-hint">{tr('alert_hint')}</div>
    </div>
  );
}
