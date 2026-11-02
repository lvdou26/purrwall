import { useCallback, useEffect, useRef, useState } from 'react';
import { useModalFocus } from '../lib/useModalFocus';
import type { Interval, Market } from '../lib/hl/types';
import type { OutcomeQuestion } from '../lib/hl/markets';
import type { MarketStats } from '../lib/hl/stats';
import { MarketTable } from './MarketTable';
import { ChartCell } from './ChartCell';
import { CellErrorBoundary } from './CellErrorBoundary';
import { useT } from '../lib/i18n';

/**
 * The list view: the market table as a first-class page. Tapping a row
 * opens a fullscreen chart CARD owned by this view (its own market+interval
 * state) — browsing the list never mutates the wall. The card pushes one
 * history entry so the mobile back gesture peels card → list → wall; ✕ and
 * Escape go through history.back() so the stack stays honest.
 */

interface Props {
  markets: Market[] | null;
  outcomeQuestions: OutcomeQuestion[];
  stats: Map<string, MarketStats> | null;
  marketError: string | null;
  onRetry: () => void;
  stale: boolean;
  tzOffsetSec: number;
  /** Drop a market into the wall: first empty cell, else grow one row, else full. */
  onAddToWall: (coin: string, interval: Interval) => 'added' | 'grown' | 'full';
  onPopOut: (cell: { coin: string | null; interval: Interval }) => void;
}

export function ListView({
  markets,
  outcomeQuestions,
  stats,
  marketError,
  onRetry,
  stale,
  tzOffsetSec,
  onAddToWall,
  onPopOut,
}: Props) {
  const tr = useT();
  const [card, setCard] = useState<Market | null>(null);
  // The card keeps its own interval (session-scoped) — the last horizon you
  // inspected at is almost always the one you want for the next market.
  const [cardIv, setCardIv] = useState<Interval>('1h');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);
  const cardPanelRef = useRef<HTMLDivElement>(null);
  useModalFocus(cardPanelRef, card !== null);

  // ── Card paging: flick prev/next through the table's CURRENT
  // sorted+filtered row order. MarketTable pushes that order here on every
  // change; it FREEZES into orderRef the moment a card opens (extends the
  // "row order freezes between interaction boundaries" contract — the table
  // is covered by the card, so nothing reorders under the user anyway).
  const visibleRowsRef = useRef<Market[]>([]);
  const onVisibleRowsChange = useCallback((rows: Market[]) => {
    visibleRowsRef.current = rows;
  }, []);
  const orderRef = useRef<Market[]>([]); // frozen order for the open card
  const idxRef = useRef(-1); // synchronous position, source of truth for paging math
  const [cardIdx, setCardIdx] = useState(-1); // mirror for rendering ‹ › + peek
  // Switch THROTTLE (Invariant 5): a flick moves the index instantly (buttons +
  // peek label react at once) but the displayed market — the only thing that
  // triggers a candleSnapshot — commits after a quiet gap, so markets flicked
  // straight past never fetch. The session candle cache makes any revisit ~20
  // weight. Side effects (timer, setState) live in the handler body, NOT a
  // setState updater — an updater is double-invoked under StrictMode and would
  // schedule the commit twice from a stale base.
  const commitTimer = useRef(0);
  const pageCard = useCallback((dir: 1 | -1) => {
    const order = orderRef.current;
    const cur = idxRef.current;
    if (cur < 0 || order.length < 2) return;
    const next = Math.min(Math.max(cur + dir, 0), order.length - 1);
    if (next === cur) return;
    idxRef.current = next;
    setCardIdx(next);
    const target = order[next];
    window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      setCard(target);
      lastCardRef.current = target;
    }, 260);
  }, []);

  // Freeze the current table order and locate a market in it — the paging
  // baseline for the card now showing m. A market not in the current rows
  // (outcome tab → rows are []) yields idx -1: the card works, just without
  // paging. Search-fallback rows (cross-tab / outside Strict) ARE the rows.
  // Called on open AND on a forward-nav restore, so a restored card is
  // pageable too (re-snapshots against whatever order the list holds now).
  const freezeOrderFor = useCallback((m: Market) => {
    const order = visibleRowsRef.current;
    const idx = order.findIndex((x) => x.coin === m.coin);
    orderRef.current = idx >= 0 ? order : [];
    idxRef.current = idx;
    setCardIdx(idx);
  }, []);

  // Back peels the card: landing on any entry that isn't a card entry closes
  // it; forward-landing BACK ON the card entry restores the card it hosted
  // (otherwise the entry is a zombie and the next toggle's back() eats a
  // click). The view-level popstate lives in App; this one only owns the card.
  const cardRef = useRef(card);
  cardRef.current = card;
  const lastCardRef = useRef<Market | null>(null);
  // closeCard is async (popstate lands later) — guard against double-fire
  // (Escape auto-repeat, ✕ mashing) walking the stack past the list.
  const closingRef = useRef(false);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      closingRef.current = false;
      if ((e.state as { pw?: string } | null)?.pw === 'card') {
        if (!cardRef.current && lastCardRef.current) {
          freezeOrderFor(lastCardRef.current); // restore paging, not just the card
          setCard(lastCardRef.current);
        }
      } else {
        setCard(null);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [freezeOrderFor]);

  const openCard = (m: Market) => {
    // same URL, marked entry: back closes the card without touching the hash
    history.pushState({ pw: 'card' }, '', window.location.href);
    lastCardRef.current = m;
    closingRef.current = false;
    freezeOrderFor(m);
    setCard(m);
  };
  const closeCard = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    window.clearTimeout(commitTimer.current); // don't let a pending page revive a closing card
    history.back();
  };

  // Card closed by any path (Escape, back gesture, view switch): cancel a
  // pending page commit (else it would re-open the card) and reset paging.
  useEffect(() => {
    if (card) return;
    window.clearTimeout(commitTimer.current);
    orderRef.current = [];
    idxRef.current = -1;
    setCardIdx(-1);
  }, [card]);

  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.repeat) return;
      if (e.key === 'Escape') {
        closeCard();
        return;
      }
      // ← → page markets (same as the wall's expanded pager). Ignore while a
      // form control owns the keyboard (the interval select).
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
      e.preventDefault();
      pageCard(e.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, pageCard]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };

  const addToWall = () => {
    if (!card) return;
    const res = onAddToWall(card.coin, cardIv);
    showToast(res === 'full' ? tr('wall_full') : `${tr('added_wall')} · ${card.display}`);
  };

  return (
    <main className="list-view">
      {markets ? (
        <MarketTable
          mode="list"
          markets={markets}
          outcomeQuestions={outcomeQuestions}
          stats={stats}
          stale={stale}
          onSelect={openCard}
          onVisibleRowsChange={onVisibleRowsChange}
        />
      ) : (
        <div className="list-shell">
          {marketError ? (
            <>
              {tr('offline')}{' '}
              <button className="retry-btn" onClick={onRetry}>
                {tr('retry')}
              </button>
            </>
          ) : (
            tr('loading_markets')
          )}
        </div>
      )}

      {card && (
        <div
          className="cell-slot expanded list-card"
          ref={cardPanelRef}
          role="dialog"
          aria-modal="true"
          aria-label={card.display}
          tabIndex={-1}
        >
          <CellErrorBoundary>
            <ChartCell
              market={card}
              interval={cardIv}
              marketStats={stats?.get(card.coin) ?? null}
              catalogPending={false}
              stale={stale}
              cellIndex={-1}
              // Invariant 8: the fixed fullscreen card COVERS the topbar
              // (and its attribution link) at every width, so the card
              // brings its own canvas logo (mini precedent)
              attributionLogo={true}
              paused={false}
              // the card is THE market on screen — it takes the tab title over
              // the wall's first cell (lib/pageTitle.ts precedence)
              titleSlot="focus"
              tzOffsetSec={tzOffsetSec}
              onIntervalChange={setCardIv}
              // the list IS the selector — the market-name ▾ returns to it
              onPickMarket={closeCard}
              onClear={closeCard}
              onPopOut={() => onPopOut({ coin: card.coin, interval: cardIv })}
              onDragStart={() => {}}
              onDragEnd={() => {}}
              expanded
              onToggleExpand={closeCard}
              // header horizontal-swipe pages markets (touch); ‹ › below are
              // the primary, discoverable affordance. Undefined when the open
              // market isn't in a pageable order (an Outcome row, or a
              // one-row result).
              onPage={cardIdx >= 0 && orderRef.current.length > 1 ? pageCard : undefined}
            />
          </CellErrorBoundary>
          {cardIdx > 0 && (
            <button
              className="pager-btn prev"
              onClick={() => pageCard(-1)}
              title={tr('t_prev_chart')}
              aria-label={tr('t_prev_chart')}
            >
              ‹
            </button>
          )}
          {cardIdx >= 0 && cardIdx < orderRef.current.length - 1 && (
            <button
              className="pager-btn next"
              onClick={() => pageCard(1)}
              title={tr('t_next_chart')}
              aria-label={tr('t_next_chart')}
            >
              ›
            </button>
          )}
          {/* Instant feedback while the chart catches up to a flick: the target
              market's name, shown only when the paged position is ahead of the
              committed card (the 260ms throttle window). */}
          {cardIdx >= 0 &&
            orderRef.current[cardIdx] &&
            orderRef.current[cardIdx].coin !== card.coin && (
              <div className="card-peek">{orderRef.current[cardIdx].display}</div>
            )}
          <div className="card-actions">
            <button className="card-add" onClick={addToWall}>
              {tr('add_wall')}
            </button>
          </div>
          {/* Inside the card (position:fixed → no visual change) and a live
              region: aria-modal on the card marks every sibling inert, so an
              add-to-wall confirmation rendered OUTSIDE it would be hidden from
              AT — and it is this dialog's own button that produces it. */}
          {toast && (
            <div className="list-toast" role="status">
              {toast}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
