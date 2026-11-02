import { useEffect, useMemo, useRef } from 'react';
import type { Market } from '../lib/hl/types';
import type { OutcomeQuestion } from '../lib/hl/markets';
import type { MarketStats } from '../lib/hl/stats';
import { editText, parseCanonical, type NameIndex } from '../lib/hl/formula';
import { MarketTable } from './MarketTable';
import { useT } from '../lib/i18n';
import { IS_COARSE } from '../lib/media';
import { useModalFocus } from '../lib/useModalFocus';

/**
 * The modal market selector: a thin wrapper around the shared MarketTable
 * core (mode 'picker' — an intentional clone of app.hyperliquid.xyz's
 * selector, see MarketTable's header). The wrapper owns the modal chrome:
 * backdrop, panel, × close, Escape, footer hints. Arrows/Enter live inside
 * MarketTable, container-scoped.
 *
 * Formula cells: with a `nameIndex` the table's search box is also the
 * formula bar; a `current` formula cell reopens on its typeable form,
 * already in formula mode, and placing the same formula again is a plain
 * close (no 'market' event, no re-backfill).
 */

interface Props {
  markets: Market[];
  outcomeQuestions: OutcomeQuestion[];
  stats: Map<string, MarketStats> | null;
  /** WS reconnecting — the table's live prices are frozen and must dim. */
  stale: boolean;
  /** The catalog's name index — enables formula mode. */
  nameIndex?: NameIndex | null;
  /** The market the cell being edited holds (null for an empty cell). */
  current?: Market | null;
  onSelect: (market: Market) => void;
  onClose: () => void;
}

export function MarketPicker({
  markets,
  outcomeQuestions,
  stats,
  stale,
  nameIndex,
  current,
  onSelect,
  onClose,
}: Props) {
  const tr = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // IME composition (Chinese/Japanese input): Escape cancels the
      // candidate word, it must not also close the panel.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const editing = current?.kind === 'formula' && nameIndex ? current : null;
  const initialQuery = useMemo(() => {
    if (!editing || !nameIndex) return undefined;
    const p = parseCanonical(editing.coin);
    return p ? editText(p.ast, (c) => nameIndex.aliasFor(c)) : undefined;
  }, [editing, nameIndex]);
  const pick = (m: Market) => {
    if (editing && m.coin === editing.coin) onClose();
    else onSelect(m);
  };

  return (
    // mousedown + target check: releasing a text-selection drag that started
    // inside the panel over the backdrop must not close the picker
    <div
      className="picker-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="picker"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={tr('a_picker')}
        tabIndex={-1}
      >
        <MarketTable
          mode="picker"
          markets={markets}
          outcomeQuestions={outcomeQuestions}
          stats={stats}
          stale={stale}
          onSelect={pick}
          autoFocusSearch={!IS_COARSE}
          nameIndex={nameIndex ?? null}
          initialQuery={initialQuery}
          initialFormula={initialQuery !== undefined}
          topRight={
            <button className="pk-close" onClick={onClose} title={tr('k_close')} aria-label={tr('k_close')}>
              ×
            </button>
          }
          footer={
            <div className="pk-foot">
              <span className="pk-hint"><b>↑↓</b> {tr('k_nav')}</span>
              <span className="pk-hint"><b>Enter</b> {tr('k_select')}</span>
              <span className="pk-hint"><b>Esc</b> {tr('k_close')}</span>
              {!stats && <span className="pk-loading">{tr('loading_stats')}</span>}
            </div>
          }
        />
      </div>
    </div>
  );
}
