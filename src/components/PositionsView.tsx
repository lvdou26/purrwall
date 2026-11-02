import { useMemo, useState, useSyncExternalStore } from 'react';
import type { Market } from '../lib/hl/types';
import type { MarketStats } from '../lib/hl/stats';
import {
  getWatchAccount,
  getWatchAddr,
  getWatchBalances,
  getWatchBook,
  getWatchCounts,
  getWatchOrderMap,
  getWatchPositions,
  getWatchVersion,
  removeWatch,
  renameWatch,
  setActiveWatch,
  setEntryShow,
  subscribeWatch,
  upsertWatch,
  WATCH_NAME_MAX,
  watchLabel,
} from '../lib/watch';
import { availOf } from '../lib/hl/userState';
import { compactUsd } from '../lib/hl/stats';
import { useT } from '../lib/i18n';

/**
 * The Positions view: the third top-level surface beside wall and list.
 * Follows Hyperliquid's own account panel closely — the same three tables:
 *   Positions  coin · side · size · position value · entry · mark ·
 *              liq price · PnL (ROE %) · margin · funding
 *   Balances   coin · total · available · USDC value · PnL (ROE %)
 *   Open orders time · type · coin · direction · size · original size ·
 *              order value · price · trigger
 * plus an account overview (total equity = perp + spot, withdrawable,
 * margin used) and the address BOOK (several saved addresses, named,
 * switchable, one active).
 *
 * Read-only like everything watch. Numbers here are EXACT (entry averages
 * included) — this is the ledger surface; chart axes stay at monitor
 * precision by design. Spot holdings are priced through their /USDC pair's
 * stats (Market.spotBase joins the raw token name); a token with no live
 * USDC pair shows '—' rather than a guess.
 */

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Exact price text: the parsed number verbatim, no rounding, no locale. */
const px = (v: number | null): string => (v === null ? '—' : String(v));
const usd = (v: number) => (Math.abs(v) >= 1000 ? compactUsd(Math.abs(v)) : `$${Math.abs(v).toFixed(2)}`);
const signedUsd = (v: number) => `${v >= 0 ? '+' : '−'}${usd(v)}`;
/** Same sign glyphs as signedUsd — the two compose into ONE cell and a mixed
 *  '+$44 (-2.4%)' with two different minus glyphs read as broken. */
const pct = (frac: number) => `${frac >= 0 ? '+' : '−'}${Math.abs(frac * 100).toFixed(1)}%`;
const two = (n: number) => String(n).padStart(2, '0');

type PvTab = 'positions' | 'balances' | 'orders';

export function PositionsView({
  markets,
  stats,
  tzOffsetSec,
  onCreateWall,
}: {
  markets: Market[] | null;
  stats: Map<string, MarketStats> | null;
  /** the chart-axis timezone shift — order times must tell the same story
   *  as the axis and the topbar clock */
  tzOffsetSec: number;
  onCreateWall: () => void;
}) {
  // Order times in the CHART timezone (same shift recipe as ChartCell's
  // toBar: UTC getters over t + offset). Year appears only when it differs
  // from the current one — resting orders survive year boundaries on HL.
  const fmtTime = (t: number) => {
    if (!t) return '—';
    const d = new Date(t + tzOffsetSec * 1000);
    const nowY = new Date(Date.now() + tzOffsetSec * 1000).getUTCFullYear();
    const md = `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
    const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
    return d.getUTCFullYear() === nowY ? `${md} ${hm}` : `${d.getUTCFullYear()}-${md}`;
  };
  const tr = useT();
  useSyncExternalStore(subscribeWatch, getWatchVersion);
  const book = getWatchBook();
  const active = getWatchAddr();
  const counts = getWatchCounts();
  const account = getWatchAccount();
  const rawBalances = getWatchBalances();

  const [tab, setTab] = useState<PvTab>('positions');
  const [adding, setAdding] = useState(false);
  const [addrIn, setAddrIn] = useState('');
  const [nameIn, setNameIn] = useState('');
  const [addErr, setAddErr] = useState<'bad' | 'full' | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameIn, setRenameIn] = useState('');

  // one map per catalog, not a linear find per row (a busy account has
  // hundreds of resting orders)
  const displayMap = useMemo(
    () => new Map((markets ?? []).map((m) => [m.coin, m.display])),
    [markets],
  );
  const displayOf = (coin: string): string => displayMap.get(coin) ?? coin;
  /** raw base token name → its /USDC pair (for pricing + display name) */
  const spotPairs = useMemo(() => {
    const m = new Map<string, { pairCoin: string; base: string }>();
    for (const mk of markets ?? []) {
      if (mk.kind === 'spot' && mk.spotBase && mk.display.endsWith('/USDC')) {
        m.set(mk.spotBase, { pairCoin: mk.coin, base: mk.display.slice(0, -5) });
      }
    }
    return m;
  }, [markets]);

  const balances = useMemo(() => {
    return rawBalances
      .map((b) => {
        const pair = b.coin === 'USDC' ? null : spotPairs.get(b.coin);
        const price = b.coin === 'USDC' ? 1 : pair ? (stats?.get(pair.pairCoin)?.last ?? null) : null;
        const value = price !== null ? b.total * price : null;
        const pnl = value !== null && b.entryNtl > 0 ? value - b.entryNtl : null;
        return {
          ...b,
          display: b.coin === 'USDC' ? 'USDC' : (pair?.base ?? b.coin),
          value,
          pnl,
          roe: pnl !== null && b.entryNtl > 0 ? pnl / b.entryNtl : null,
        };
      })
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  }, [rawBalances, spotPairs, stats]);
  const spotValue = balances.reduce((a, b) => a + (b.value ?? 0), 0);
  // A holding we cannot price makes every figure that sums it a guess — and
  // this surface degrades to '—', never a confident wrong number.
  const spotUnpriced = balances.some((b) => b.value === null);

  const submitAdd = () => {
    // blank name field = "keep the existing name" (re-adding a saved address
    // must not wipe its label) — only a non-empty name renames
    const r = upsertWatch(addrIn.trim(), nameIn.trim() ? nameIn : undefined);
    if (r !== 'ok') {
      setAddErr(r);
      return;
    }
    setAddErr(null);
    setAddrIn('');
    setNameIn('');
    setAdding(false);
  };

  const addForm = (
    <form
      className="pv-add"
      onSubmit={(e) => {
        e.preventDefault();
        submitAdd();
      }}
    >
      <input
        className="wm-input"
        value={addrIn}
        onChange={(e) => setAddrIn(e.target.value)}
        placeholder={tr('watch_addr_ph')}
        maxLength={42}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <input
        className="wm-input"
        value={nameIn}
        onChange={(e) => setNameIn(e.target.value)}
        placeholder={tr('pv_name_ph')}
        maxLength={WATCH_NAME_MAX}
      />
      <button className="share-btn" type="submit">
        {tr('watch_set')}
      </button>
      {addErr && (
        <p className="wm-note sync-err">
          {tr(addErr === 'full' ? 'pv_full' : 'watch_err_format')}
        </p>
      )}
    </form>
  );

  if (book.length === 0) {
    return (
      <main className="pos-view">
        <div className="pv-intro">
          <div className="wm-title">{tr('watch_title')}</div>
          <p className="wm-note">{tr('watch_hint')}</p>
          {addForm}
        </div>
      </main>
    );
  }

  const positions = [...getWatchPositions()].sort((a, b) => b.value - a.value);
  const orders = [...getWatchOrderMap().values()].flat().sort((a, b) => b.t - a.t);
  const totalEquity = account.value + spotValue;

  return (
    <main className="pos-view">
      {/* address book: one chip per entry, the active one highlighted.
          role=group, not tablist — the chips are toggles, not ARIA tabs */}
      <div className="pv-book" role="group" aria-label={tr('view_pos')}>
        {book.map((e) =>
          renaming === e.addr ? (
            <form
              key={e.addr}
              className="pv-chip pv-chip-edit"
              onSubmit={(ev) => {
                ev.preventDefault();
                renameWatch(e.addr, renameIn);
                setRenaming(null);
              }}
            >
              <input
                className="wm-input"
                autoFocus
                value={renameIn}
                maxLength={WATCH_NAME_MAX}
                onChange={(ev) => setRenameIn(ev.target.value)}
                onBlur={() => {
                  renameWatch(e.addr, renameIn);
                  setRenaming(null);
                }}
              />
            </form>
          ) : (
            <span key={e.addr} className={`pv-chip${e.addr === active ? ' active' : ''}`}>
              <button
                className="pv-chip-name"
                onClick={() => setActiveWatch(e.addr)}
                title={e.addr}
                aria-pressed={e.addr === active}
              >
                {e.name || short(e.addr)}
              </button>
              <button
                className={`pv-chip-act pv-chip-eye${e.show ? ' on' : ''}`}
                title={tr('ov_chip')}
                aria-label={tr('ov_chip')}
                aria-pressed={e.show}
                onClick={() => setEntryShow(e.addr, !e.show)}
              >
                👁
              </button>
              <button
                className="pv-chip-act"
                title={tr('wm_rename')}
                aria-label={tr('wm_rename')}
                onClick={() => {
                  setRenameIn(e.name);
                  setRenaming(e.addr);
                }}
              >
                ✎
              </button>
              <button
                className="pv-chip-act"
                title={tr('pv_remove')}
                aria-label={tr('pv_remove')}
                onClick={() => removeWatch(e.addr)}
              >
                ×
              </button>
            </span>
          ),
        )}
        <button
          className={`pv-chip pv-chip-add${adding ? ' active' : ''}`}
          onClick={() => {
            setAdding((a) => !a);
            setAddErr(null);
          }}
        >
          + {tr('pv_add')}
        </button>
        {active && (
          <button className="pv-chip pv-chip-off" onClick={() => setActiveWatch(null)}>
            {tr('watch_off')}
          </button>
        )}
      </div>
      {adding && addForm}

      {active === null ? (
        <p className="wm-note pv-note">{tr('pv_pick_hint')}</p>
      ) : (
        <>
          {/* account overview — total equity is perp + spot, HL-style */}
          <div className="pv-summary">
            <span className="pv-addr" title={active}>
              {watchLabel(active)} · <span className="pv-addr-raw">{short(active)}</span>
            </span>
            <span>
              {tr('pv_equity')} <b>{spotUnpriced ? '—' : usd(totalEquity)}</b>
            </span>
            <span>
              {tr('pv_perp_eq')} <b>{usd(account.value)}</b>
            </span>
            <span>
              {tr('pv_spot_eq')} <b>{spotUnpriced ? '—' : usd(spotValue)}</b>
            </span>
            <span className={account.uPnl >= 0 ? 'up' : 'down'}>
              {tr('pv_upnl')} <b>{signedUsd(account.uPnl)}</b>
            </span>
            <span>
              {tr('pv_margin')} <b>{usd(account.marginUsed)}</b>
            </span>
            <span>
              {tr('pv_withdrawable')} <b>{usd(account.withdrawable)}</b>
            </span>
            <button
              className="share-btn"
              disabled={counts.positions + counts.orders === 0}
              onClick={onCreateWall}
            >
              {tr('watch_poswall')}
            </button>
          </div>

          {/* the three HL account tables, one sub-tab each */}
          <div className="pv-tabs" role="tablist">
            {(
              [
                ['positions', tr('pv_positions'), positions.length],
                ['balances', tr('pv_balances'), balances.length],
                ['orders', tr('pv_orders'), orders.length],
              ] as Array<[PvTab, string, number]>
            ).map(([key, label, n]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className={`pv-tab${tab === key ? ' active' : ''}`}
                onClick={() => setTab(key)}
              >
                {label} <span className="pv-tab-n">{n}</span>
              </button>
            ))}
          </div>

          {tab === 'positions' &&
            (positions.length === 0 ? (
              <p className="wm-note pv-note">{tr('watch_none_yet')}</p>
            ) : (
              <div className="pv-table pv-positions">
                <div className="pv-row pv-head">
                  <span>{tr('pv_market')}</span>
                  <span>{tr('pv_side')}</span>
                  <span className="num">{tr('pv_size')}</span>
                  <span className="num">{tr('pv_value')}</span>
                  <span className="num">{tr('pv_entry')}</span>
                  <span className="num">{tr('pv_mark')}</span>
                  <span className="num">{tr('pv_liq')}</span>
                  <span className="num">{tr('pv_pnl_roe')}</span>
                  <span className="num">{tr('pv_margin_col')}</span>
                  <span className="num">{tr('pv_funding')}</span>
                </div>
                {positions.map((p) => {
                  const mark = Math.abs(p.szi) > 0 ? p.value / Math.abs(p.szi) : null;
                  const markDp = Math.max(2, String(p.entryPx).split('.')[1]?.length ?? 2);
                  // cumFunding.sinceOpen is funding PAID — HL's column shows
                  // the cash flow, so the sign flips (received = green)
                  const fundingCash = -p.fundingSinceOpen;
                  return (
                    <div className="pv-row" key={p.coin}>
                      <span className="pv-coin">{displayOf(p.coin)}</span>
                      <span className={p.szi > 0 ? 'up' : 'down'}>
                        {tr(p.szi > 0 ? 'w_long' : 'w_short')}
                        {p.leverage ? ` ${p.leverage}x` : ''}
                      </span>
                      <span className="num">{Math.abs(p.szi)}</span>
                      <span className="num">{usd(p.value)}</span>
                      <span className="num">{px(p.entryPx)}</span>
                      <span className="num">{mark === null ? '—' : mark.toFixed(markDp)}</span>
                      <span className="num">{px(p.liqPx)}</span>
                      <span className={`num ${p.uPnl >= 0 ? 'up' : 'down'}`}>
                        {signedUsd(p.uPnl)} ({pct(p.roe)})
                      </span>
                      <span className="num">{usd(p.marginUsed)}</span>
                      <span className={`num ${fundingCash >= 0 ? 'up' : 'down'}`}>
                        {signedUsd(fundingCash)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}

          {tab === 'balances' &&
            (balances.length === 0 ? (
              <p className="wm-note pv-note">{tr('pv_no_balances')}</p>
            ) : (
              <div className="pv-table pv-balances">
                <div className="pv-row pv-head">
                  <span>{tr('pv_token')}</span>
                  <span className="num">{tr('pv_total_bal')}</span>
                  <span className="num">{tr('pv_avail_bal')}</span>
                  <span className="num">{tr('pv_usdc_value')}</span>
                  <span className="num">{tr('pv_pnl_roe')}</span>
                </div>
                {balances.map((b) => (
                  <div className="pv-row" key={b.coin}>
                    <span className="pv-coin" title={b.coin}>
                      {b.display}
                    </span>
                    <span className="num">{b.total}</span>
                    <span className="num">{availOf(b.total, b.hold)}</span>
                    <span className="num">{b.value === null ? '—' : usd(b.value)}</span>
                    <span
                      className={`num ${b.pnl === null ? '' : b.pnl >= 0 ? 'up' : 'down'}`}
                    >
                      {b.pnl === null || b.roe === null
                        ? '—'
                        : `${signedUsd(b.pnl)} (${pct(b.roe)})`}
                    </span>
                  </div>
                ))}
              </div>
            ))}

          {tab === 'orders' &&
            (orders.length === 0 ? (
              <p className="wm-note pv-note">{tr('pv_no_orders')}</p>
            ) : (
              <div className="pv-table pv-orders">
                <div className="pv-row pv-head">
                  <span>{tr('pv_time')}</span>
                  <span>{tr('pv_type')}</span>
                  <span>{tr('pv_market')}</span>
                  <span>{tr('pv_side')}</span>
                  <span className="num">{tr('pv_size')}</span>
                  <span className="num">{tr('pv_orig_size')}</span>
                  <span className="num">{tr('pv_order_value')}</span>
                  <span className="num">{tr('pv_price')}</span>
                  <span>{tr('pv_trigger_cond')}</span>
                </div>
                {orders.map((o, i) => (
                  <div className="pv-row" key={`${o.coin}:${o.t}:${o.px}:${i}`}>
                    <span>{fmtTime(o.t)}</span>
                    <span>
                      {o.type}
                      {o.reduceOnly ? ` · ${tr('pv_ro')}` : ''}
                    </span>
                    <span className="pv-coin">{displayOf(o.coin)}</span>
                    <span className={o.side === 'B' ? 'up' : 'down'}>
                      {tr(o.side === 'B' ? 'pv_buy' : 'pv_sell')}
                    </span>
                    <span className="num">{o.sz}</span>
                    <span className="num">{o.origSz}</span>
                    <span className="num">{usd(o.px * o.sz)}</span>
                    <span className="num">{px(o.px)}</span>
                    <span>{o.cond || '—'}</span>
                  </div>
                ))}
              </div>
            ))}
        </>
      )}
    </main>
  );
}
