# Architecture

How Purrwall is built, the rules the code depends on, and the Hyperliquid
(HL) API behaviour behind them. Code comments cite the numbered [Invariants](#invariants)
as "Invariant N"; that numbering is stable.

[How it works](#how-it-works) ·
[Module map](#module-map) ·
[Data layer](#data-layer) ·
[Invariants](#invariants) ·
[Hyperliquid API notes](#hyperliquid-api-notes) ·
[UI rules](#ui-rules) ·
[Testing and verification](#testing-and-verification) ·
[Running your own deployment](#running-your-own-deployment)

## What Purrwall is

A browser app that shows a wall of 1–24 live candlestick charts for any
Hyperliquid market: main-dex perps, spot pairs, HIP-3 builder-deployed perps
and HIP-4 outcome markets. A cell can also chart a formula over up to four
markets (`HYPE/ETH`, `(BTC+ETH)/2`). Around the wall: a market picker modelled
on Hyperliquid's own selector, a live list of every market, price alerts, an
address watch with a positions page, saved walls synced between devices by
pairing code, and the layout encoded in the URL. It is a static React app;
the browser talks to Hyperliquid's public API directly.

## How it works

```
 browser (src/)                             Hyperliquid
 ┌────────────────────────────────┐  REST   ┌────────────────────────────────┐
 │ lib/hl/info.ts  catalog,       ├────────►│ POST api.hyperliquid.xyz/info  │
 │                 candles, stats │         │                                │
 │ lib/hl/ws.ts    one WebSocket  ├────────►│ wss://api.hyperliquid.xyz/ws   │
 │ localStorage, URL hash         │   WS    └────────────────────────────────┘
 └───────────────┬────────────────┘
                 │ same origin: static assets + /api/*
 ┌───────────────▼────────────────┐  POST /api/sparks-ingest  ┌───────────────┐
 │ Cloudflare Worker (worker/)    │◄──────────────────────────┤ purrwall-data │
 │ KV: SYNC, FEEDBACK, SPARKS     │       (bearer token)      │ scheduled job │
 └────────────────────────────────┘                           └───────────────┘
```

- **Live market data comes straight from Hyperliquid.** REST serves the
  market catalog, candle backfill and the stats poll; one shared WebSocket
  carries live candles, mid prices and watched-address state. The only market
  data the Worker serves is the pre-built trend-glyph blob.
- **CSP.** The production build injects a `<meta>` Content-Security-Policy
  (`vite.config.ts`): `script-src 'self'`,
  `connect-src 'self' https://api.hyperliquid.xyz wss://api.hyperliquid.xyz`.
  A new network destination is a CSP change.
- **Worker.** Static assets (`dist/`, SPA fallback) are served before the
  Worker runs; only `/api/*` reaches it (`run_worker_first` in
  `wrangler.jsonc`).

  | Route | Does |
  |---|---|
  | `POST /api/sync` | creates a sync document; returns `{ code }` (8 chars, `[A-Z2-7]`) |
  | `GET /api/sync/<CODE>` | reads it |
  | `PUT /api/sync/<CODE>` | upserts it (a surviving device can revive an expired code) |
  | `POST /api/feedback` | stores `{ m, at }` (text ≤ 2000 chars, timestamp) under `fb:<at>:<random>` for 90 days, then forwards the text by email |
  | `GET /api/sparks` | the list view's 24h trend-glyph blob, from KV through the edge cache (`max-age=300`, CORS `*`); 404 when absent |
  | `POST /api/sparks-ingest` | bearer-token (`SPARKS_TOKEN`) write of that blob; a wrong token reads as 404 |

  - `sanitizeSyncDoc` rebuilds every sync document (saved-wall library plus
    watch address book): ≤ 100 walls, ≤ 24 cells, coin ids ≤ 96 chars,
    timestamps clamped to `[0, now]`. 60-day TTL, refreshed on every write.
  - Writes reject a foreign `Origin` (`originAllowed`: the site's origins and
    localhost; a missing header passes — this defends against hostile pages,
    it is not authentication) and pass per-IP throttles held in isolate
    memory. Sync creates, including a PUT to a missing code, share the
    scarce create budget (6/min, 30/day per IP); updates get 60/min and
    200/day; feedback has its own (3/min, 20/day). Every daily budget stays
    well under the account-wide KV write quota. Clients treat 429 as
    transient.
  - Feedback mail uses a `send_email` binding locked to one destination,
    sent with `ctx.waitUntil` after the KV write. `feedbackMime()`
    base64-encodes the body and RFC 2047-encodes the subject, so typed CR/LF
    cannot forge a header.
  - The sparks blob (coin → 2–26 closes, shape-validated, 7-day TTL) is built
    by a scheduled GitHub Actions job in
    [lvdou26/purrwall-data](https://github.com/lvdou26/purrwall-data). A dead
    pipeline turns into a 404, and the list renders without glyphs.
- **Updates.** Every build writes `/version.json` with the git sha, also
  compiled in as `__BUILD_SHA__`; `lib/updateCheck.ts` polls it and shows a
  "↻ new version" pill. The app never reloads on its own: every reload is a
  user action — the pill, a pull-to-refresh while a new build is live, or the
  crash screen's button.
- **State** is per-browser `localStorage` under `purrwall.*` keys (layout,
  saved walls, drafts, favorites, alerts, watch book, language, timezone,
  table state). The URL hash carries the current layout, so a link reproduces
  a wall.
- **Languages.** English and Chinese. Most strings live in the two
  dictionaries in `lib/i18n.tsx` (`useT()`; `fmt()` fills `{slot}`s); the docs
  modal is written as two whole-language blocks; the feedback modal and a few
  spots in App.tsx (first-visit hint, view label, language toggle) carry
  inline EN/ZH pairs; `src/changelog.ts`
  entries are bilingual. The first language follows `navigator.language`
  (`zh*` → zh); the toggle persists.

## Module map

Top level: `src/` (the app — React 19, TypeScript strict, Vite,
lightweight-charts v5), `worker/` (Cloudflare Worker + tests), `scripts/`
(canary, spot-list sync, perf, release check, feedback reader), `public/`
(static files), `brand/` (logo, social avatar and banner, README
screenshot), `.github/workflows/` (`ci.yml`,
`canary.yml`), `wrangler.jsonc` (Worker config).

### Entry and shell

- `src/main.tsx` — mounts `<App/>` under StrictMode inside
  `RootErrorBoundary`; starts the watch store once, at module scope.
- `src/App.tsx` — the shell: grid state (count, columns, drag-to-swap, ghost
  "+" tiles), persistence to localStorage and the URL hash, saved walls and
  drafts, the 60 s stats poll and catalog refresher, wall/list/positions
  routing, the topbar, `resolveMarket` / `fallbackMarket`, positions walls,
  alert toasts, `?mini=1` pop-out windows.
- `src/changelog.ts` — bilingual release notes, newest first; `CHANGELOG[0].id`
  drives the unread dot and toast.
- `src/App.css`, `src/index.css` — all styles; cells size their chrome with
  container queries.

### `src/lib/hl/` — Hyperliquid data layer

- `types.ts` — `Candle`, `Market`, `MarketKind`, `INTERVALS`
  (`1m 5m 15m 1h 4h 1d 1w`; the comment explains the missing `1M`),
  `INTERVAL_MS`, and `coinKindOf()`, the grammar of HL coin ids.
- `info.ts` — the only REST client ([REST discipline](#rest-discipline)).
- `ws.ts` — `hlSocket`, the only WebSocket ([The shared socket](#the-shared-socket)).
- `markets.ts` — builds the catalog (`meta`, `spotMeta`, `perpDexs` + each
  live HIP-3 dex's `meta`, `outcomeMeta`, `outcomeTemplates`,
  `perpCategories`, `perpConciseAnnotations`), spot names and Strict
  (`passesStrict`), HIP-4 parsing (`parseQuestionInfo`, `buildHip4`),
  `mergeCatalog`.
- `catalogSync.ts` — keeps the catalog current from the stats poll
  ([Live catalog](#live-catalog)).
- `stats.ts` — the stats poll (`metaAndAssetCtxs` per dex,
  `spotMetaAndAssetCtxs`, `allMids`; 30 s cache keyed by `hip3DexKey`),
  returning `{ stats, listing }`; the only funding (`fmtFunding`,
  `fundingApr`) and compact-dollar (`compactUsd`) formatters.
- `candleCache.ts` — session cache: bars banked on unmount, a revisit paints
  at once and fetches only the gap. Copies both ways, stores only clean
  snapshots, evicts on a failed gap fetch; LRU of 60.
- `sparklines.ts` — one `/api/sparks` fetch (10 min TTL; the Vite dev server
  reads the production blob, a production build stays same-origin); `null` →
  no glyphs.
- `formula.ts` — formula grammar, name resolver, canonical ids, printers,
  `compile`/eval, picker helpers ([Formula cells](#formula-cells)).
- `compose.ts` — formula bar math: the bar rule, `mergeLegs`, `LiveComposer`,
  `composeStats`, `precisionFor`.
- `formulaFeed.ts` — the facade ChartCell uses for all candle I/O
  (Invariant 11).
- `userState.ts` — DOM-free parsing of user-state pushes (positions, orders,
  balances, account), positions-wall ordering, `overlayLevels`.
- `spotOverrides.json`, `spotSelector.json` — generated mirrors of HL's spot
  lists; never edit by hand ([Spot names](#spot-names-and-the-selector-lists)).
- `fixtures/` — verbatim HIP-4 payloads pinning the parser.

### `src/lib/` — app services

- `renderQueue.ts` — `scheduleRender(key, task)`: one rAF flush, latest task
  per key (Invariant 1).
- `crosshairSync.ts` — the linked wall (⌖): crosshair and visible window
  shared across cells by time, so mixed intervals line up; echo recognition;
  touch vs mouse source rules; suspended under a single-chart focus view;
  hidden cells skipped and re-synced on re-entry.
- `shareUrl.ts` — layout ⇄ URL hash: writes `w=2;<cols>x<rows>;<cell>;…` (or
  `w=3;<cols>x<rows>;n=<name>;…` for a named wall), still reads v1
  `w=1;<count>;…`; a cell is `<encodeURIComponent(coin)>~<interval>`.
- `gridResize.ts` — a chart keeps its row and column across resizes; a shrink
  stashes displaced charts, a later grow returns them.
- `sync.ts` — opt-in pairing-code sync. `reconcile()` is the only movement:
  read, merge per wall (last write wins, tombstones for deletes; the watch
  book is one unit), write back if different. `capTombstones` respects the
  server's 100-wall cap; `SyncHealth` turns `'rejected'` only on a 400.
- `watch.ts` — address book (≤ 20, optional names), an active address (the
  Positions page) and per-entry overlay `show` flags with a master switch;
  subscribes {active} ∪ (overlay on ? shown : ∅). `show` and the switch are
  per-device; the book syncs.
- `alerts.ts` — the alert store: an alert is a level that fires on every
  crossing, either direction; a % alert becomes a price when created.
- `alertEngine.ts` — the trigger loop on WS `allMids` (so alerts fire for
  markets not on the wall and are never delayed by paint gating): toast,
  optional chirp and browser notification, tab-title badge.
- `pageTitle.ts` — the tab title as a live ticker; the only writer of
  `document.title` ([Tab title](#tab-title)).
- `updateCheck.ts` — version poll and pill; `isNewVersionLive()`.
- `pullToRefresh.ts`, `refreshBus.ts` — the narrow-wall pull gesture (top
  chrome only) and its wall-wide heal broadcast.
- `favorites.ts` — favorites as one module store for both table surfaces,
  converging across tabs via `storage` events.
- `marketSearch.ts` — search and Strict, DOM-free: Strict matches → the tab
  without Strict (with a hint) → other tabs (list view, formula mode) →
  full-name resolve (picker).
- `formulaBar.ts` — the pure decisions behind the picker's formula mode.
- `i18n.tsx`, `media.ts` (`useMediaQuery`, `IS_COARSE`),
  `useModalFocus.ts` / `usePopoverDismiss.ts` ([UI rules](#ui-rules)).
- `qr.ts` + vendored `qrcodegen.js` (MIT; re-vendor, don't edit) — the share
  popover's QR code, in its own chunk.

### `src/components/`

- `ChartCell.tsx` — one chart: backfill, live candles, scroll-left history,
  heals, visibility gating, the freshness check, header, stats bar, alert
  lines, watch overlay.
- `CellErrorBoundary.tsx` (per cell) and `RootErrorBoundary.tsx` (outside
  App: re-derives the language itself, inline styles, reload is a button).
- `MarketTable.tsx` — the table core: tabs, columns, sort, search, favorites,
  keyboard. Row order freezes between interaction boundaries while values
  update in place (live mids written imperatively). Mode `picker` mirrors HL's
  selector and hosts formula mode; mode `list` has five tabs, a scan-friendly
  column order and the trend-glyph column.
- `MarketPicker.tsx` — the modal around MarketTable.
- `ListView.tsx` — the list page plus a fullscreen chart card with its own
  market and interval (browsing never edits the wall); card paging follows
  the table order frozen at open and commits the shown market after 260 ms,
  so flicked-past markets never fetch.
- `PositionsView.tsx` — the active address laid out like HL's account panel
  (Positions, Balances, Open orders at exact precision), account overview,
  address book.
- `WatchOverlay.tsx` — entry, liquidation and resting-order lines, uPnL chip.
- `AlertLines.tsx`, `AlertPopover.tsx` — alert lines; the 🔔 popover.
- `Clock.tsx` (topbar clock in the charts' timezone), `DocsModal.tsx` (docs +
  "What's new"), `FeedbackModal.tsx`.

### `worker/`, `scripts/`, CI

- `worker/index.js` — the routes above; `routes.test.js` drives the real
  fetch handler, `hardening.test.js` / `sanitize.test.js` pin the helpers.
- `scripts/api-canary.mjs` — the API canary (Invariant 10);
  `api-snapshot.json` is its fallback baseline.
- `scripts/sync-spot-overrides.mjs` + `scripts/lib/hlBundleLists.mjs` —
  re-extract HL's spot lists from its frontend bundle; their headers document
  the anchors and guards.
- `scripts/perf-smoke.mjs` — `npm run perf`.
- `scripts/release-check.mjs` — fails `npm run build` when `dist/`,
  `README.md` or the brand images contain a home path, a private IP, an
  email address outside the allowlist or image metadata. An optional,
  git-ignored `.release-terms.local` adds terms of your own, and with it the
  build machine's username and hostname (skipped under `CI`).
- `scripts/feedback.mjs` — `npm run feedback`, maintainer-only: lists the
  production feedback namespace via wrangler (`--remote` is required).
- wrangler is an exact-pinned devDependency, so `npx wrangler …` (deploys
  included) runs the locked version.
- `ci.yml` runs lint, test and build on pushes to `main` and on pull
  requests. `canary.yml` runs
  twice a day: the canary, then the spot-list sync, which commits only when a
  list's content changed (every push to `main` deploys).

## Data layer

### REST discipline

- Every request goes through `info()`; every candle request through
  `fetchCandles()`, which caps concurrency at 6 and shares identical
  in-flight requests (`coin|interval|floor(start / 60 s)`).
- `info()` retries 429, 5xx and network errors twice with jittered backoff.
  Each attempt has a deadline (10 s, 20 s, 30 s) built from a plain
  `AbortController` — `AbortSignal.timeout`/`any` are missing on older
  Safari. A final-attempt timeout throws a plain `Error`, never `AbortError`,
  which callers read as "stale, discard".
- Budget: 1200 weight/min per IP, shared by every tab on it. A candleSnapshot
  costs ≈ 20 + 1 per 60 bars: ≈ 30 for a 600-bar backfill, ≈ 104 for a full
  5000-bar history.
- A cell starts with 600 bars; older history loads on scroll-left in
  2000-bar chunks (600 when the linked wall fans pagination out to every
  cell), divided by the leg count for formulas.

### The shared socket

- **Subscriptions** are ref-counted per key, so a market on two cells — or a
  formula leg that is also a plain cell — is one subscription. The socket
  closes 5 s after the last one goes, never at once (Invariant 2).
- **Reconnect**: 1 s, doubling to 15 s; the ladder resets only once the
  server actually sends something (an accept-then-drop server must not cause
  a 1 s storm). On open, `allMids` and user-state subscriptions replay first
  (they are always acked), candles last.
- **Liveness**:
  - a ping every 30 s, and a 10 s deadline on every dial;
  - a silence probe re-armed on `open` and on every message: 25 s without a
    server frame sends a ping with a 5 s deadline. It doubles as the
    keepalive (HL drops a socket it hasn't sent to for 60 s), and because it
    is re-armed from events rather than chained, it escapes Chrome's
    intensive throttling (chained timers in a tab hidden for 5+ minutes fire
    once a minute);
  - a 90 s no-message backstop;
  - an unanswered probe, the backstop and the page `freeze` event all call
    `writeOff()`: the socket is detached at once (`this.ws = null`), closed,
    status → `reconnecting`, and re-dialed (not on `freeze`). Its late
    `onclose` is ignored; silence never counts against a subscription;
  - `offline`: a close still hanging after 1 s is written off and nothing
    dials; `online` dials at once, never debounced, even in a hidden tab;
  - wake signals (visibility return, `pageshow`, `connection.change`) ping
    an open socket, even when hidden, and re-dial a socket waiting in backoff
    once visible, debounced 30 s; `online` and `resume` re-dial at once, even
    in a hidden tab.
- **`onReconnect`** fires on re-opens only, or on a first open more than 30 s
  after the first subscribe (bars that closed meanwhile can't come over WS).
  Cells answer it with a heal.
- **Unknown-id quarantine.** A candle subscription for an id HL doesn't know
  closes the whole socket ([Ids and unknown ids](#ids-and-unknown-ids)).
  Subscribes are logged per socket and ticked off by `subscriptionResponse`;
  when a socket that acked something closes within 2 s of an unacked
  subscribe, the earliest unacked entry is the culprit (HL processes frames in
  order). Two strikes within 60 s quarantine it: out of the replay set, an
  error overlay via the cell's `onRejected`, and only that cell's Retry
  (`clearCandleQuarantine`) tries again. A close with no ack at all is an
  outage, except that the first candle key moves to the back of the next
  replay (`replayLast`), so a bad id in cell 0 is caught one socket later.
  Earlier still, `fallbackMarket` resolves a saved string that `coinKindOf`
  rejects to `null`, never to a synthetic `Market`.

### Heals and visibility

- The candle channel never sends a snapshot or re-sends closed bars, so gaps
  are healed over REST: after `onReconnect`, on visibility return, on
  pull-to-refresh, after a freshness failure and when a cell resumes from
  `candleCache`. The cell fetches from its newest bar and merges (the first
  returned bar is the one at the last known `t`); its price stays dimmed
  until the heal lands.
- During a backfill, WS ticks are buffered and only `t ≥` the last snapshot
  bar is replayed (Invariant 6). `healRef` aliases the data effect's live bars
  array — read its comments before touching that effect. `epochRef` voids
  stale continuations (Invariant 3).
- A cell is **hidden** when it is offscreen (IntersectionObserver), under the
  list or positions view, or behind a fullscreen overlay. Hidden cells keep
  their subscriptions but bank ticks per bar offscreen, skip linked-wall
  paints and park heals; on re-entry they flush, heal and re-sync. The cell
  that owns the tab title never parks its heal.
- **Freshness.** A socket can answer pings while one subscription is dead,
  and a quiet market is silent too (candles push only on trades). A plain cell
  that is on screen or owns the title and has had no tick for 5 min spends one
  snapshot (at most once a minute) from the newest bar the socket delivered
  (`lastSeen` — not `bars`, which lags in a hidden tab where rAF doesn't run).
  Newer data → `hlSocket.resubscribeCandle()` (a real unsubscribe + subscribe;
  an effect re-run would be a ref-count no-op) plus a heal; the same bar → a
  quiet market, nothing changes; a tick during the round trip voids the check.
  Formula cells are not checked.

### Live catalog

- The first load is `loadMarkets()` (~17 requests, ~340 weight), shared by
  concurrent callers. `catalog.failed` lists the slices that failed (a single
  HIP-3 dex counts); it tells `resolveMarket` a saved coin is missing rather
  than delisted, so a partial failure must land there or those cells stay
  blank.
- The 60 s stats poll (visible tabs only) already downloads what the catalog
  is built from. `catalogDrift` compares the two; the `spotSeen` /
  `outcomeSeen` baselines include what the loaders deliberately drop, so the
  diff has no false positives. Perp, spot or HIP-3 drift → full reload (≥ 5
  min apart); outcome-only drift → `loadOutcomes` (3 requests, ≥ 5 min
  apart); a full reload every 30 min regardless (new HIP-3 dexs, annotations,
  templates). Ids still drifting after two refreshes wait for the next
  backstop. Refresh failures are silent.
- Every later update goes through `mergeCatalog`: an unchanged coin keeps its
  `Market` object, an unchanged catalog returns `prev` itself, a slice that
  failed to reload keeps the previous one, `failed` may shrink but never
  grow, and the three side lists keep their last good response.
- Consumers react by value (Invariant 12). `resolveMarket` is sticky for
  catalog-confirmed coins (a delisting or HIP-4 settlement mid-session keeps
  the chart; raw-id fallbacks are never pinned), and MarketTable adopts a new
  catalog only at the next interaction boundary.

### Formula cells

- **Grammar** (`formula.ts`): + − × ÷, parentheses, decimal constants, unary
  minus; at most 4 distinct legs; no HIP-4 legs. Names resolve against HL's
  own names (`HYPE` = the perp, `HYPE/USDC` = the spot pair, `TSLA` = the
  unique HIP-3 market or an ambiguity chip, `xyz:AVGO` explicit); search
  keywords never resolve.
- **Canonical id**: `=` + the expression over coin ids, ≤ 96 chars, with
  `[…]` around an id containing an operator character (`=[PURR/USDC]*2`);
  parsed without the catalog. A lone symbol canonicalizes to the plain coin.
  Headers print `compactText`; re-editing starts from `editText`.
- **Bars** (`compose.ts`): `o = f(opens)`, `c = f(closes)`,
  `h = max(o, c, f(highs), f(lows))`, `l = min(…)` — valid by construction
  (element-wise highs and lows are not). `mergeLegs` walks the union of
  timestamps, skips buckets before every leg exists, flat-fills a leg at its
  last close afterwards, and emits strictly increasing `t`; `LiveComposer`
  never emits below its last `t`.
- **Data** (`formulaFeed.ts`): plain coins pass straight through; `=` coins
  fan out to their legs under real ids and return ordinary candles at a fixed
  per-formula precision (a heal never changes the axis). A leg that returns
  `[]` is seeded from one 1d snapshot. History is as deep as the youngest leg.
- **Cell**: composed bars carry `v = '0'` (no volume histogram); no alerts,
  watch overlay or funding/OI/volume chips; the stats bar shows Δ (absolute
  when the window crosses zero) and one 24h chip per leg.
- **Picker**: formula mode is an explicit ƒx switch in the search box; Enter
  never places a formula (✓ or Ctrl/⌘+Enter does); a row inserts its
  typeable alias at the caret. `isFormulaTrigger` never fires on the Outcome
  tab, whose question names contain `/ ( ) -`.

### Address watch

- Per subscribed address: `clearinghouseState` and `openOrders` for the main
  dex (`''`) and every live HIP-3 dex, plus `spotState` for the active one.
  Pushes are full snapshots about every 5 s — no reconcile, no REST.
- Every overlay level draws a line; axis labels go only to entries,
  liquidations, triggers within a budget and the edges of a resting-order
  ladder, under a hard cap per device class (`overlayLevels`). The chart
  library spreads overlapping labels itself. To change labels, rebuild the
  lines: toggling `axisLabelVisible` through `applyOptions` leaves stale text
  that still widens the axis, and label backgrounds ignore alpha.
- A positions wall (`poswall:<addr>`) is rebuilt from current holdings each
  time it is applied and is never saved.

### Tab title

- `pageTitle.ts` writes `75,585 | BTC | Purrwall` (price first: tab strips
  cut from the right). Two slots by fixed precedence — `focus` (expanded cell
  or list chart card) over `wall` (the first cell whose coin resolves) —
  under the alert badge.
- Prices come from the WS callback and `applyCandle`, never from rAF-driven
  state: hidden tabs suspend rAF, and a hidden tab is when a title is read.
- A dimmed (cache-resumed) price is never published; after 2 s of a
  non-live socket the price leaves the title until fresh data lands; `freeze`
  clears every price in one synchronous write.
- Writes coalesce into one microtask; price-only changes are capped at 1 Hz.
  Nothing is written before a human signal (pointer, key, touch, blur,
  `visibilitychange`) or a background boot (`document.hidden`, `?mini=1`), so
  a crawler that renders JS indexes the static `<title>`, not a price.
  Automated browsers boot hidden and never show that gate.

### Layout and views

- `count` is the wall's real dimension; `cols` is a desktop view preference.
  Phones choose a count (4, 6, 9, 12, 16, 24) and keep a per-device column
  count; on desktop an unfilled last row shows ghost "+" tiles.
- A link to someone else's wall shows it without replacing yours until you
  edit (`viewingSharedRef`, cleared only by `editLayout()`); on a device with
  no saved wall the link is adopted.
- Views: wall, list (`#list`), positions (`#pos`). The wall stays mounted and
  hidden under the other two, so switching is instant and costs no REST.
  Routing: Invariant 9. `?mini=1` is a chromeless single-cell pop-out.

## Invariants

Each guards a bug that has been fixed once. Keep the numbering; add new ones
at the end.

1. **renderQueue keys are per bar** (`${cellKey}:${candle.t}`). Hidden tabs
   suspend rAF; a per-cell key keeps only the latest task and silently drops
   every bar that closed while hidden. (Idempotent snapshot streams such as
   the tables' mids may use a fixed key.)
2. **Never tear down the shared socket immediately on zero subscriptions.** A
   React commit runs every effect cleanup before the re-creates, so a refresh
   passes through a transient zero; the 5 s grace breaks a
   reconnect → refresh → reconnect loop that once got the whole IP
   rate-limited. `onReconnect` fires only on re-opens (`everOpened`), or on a
   first open delayed more than 30 s past the first subscribe.
3. **Epoch guard.** `epochRef` invalidates every async continuation (fetch
   `.then`, queued rAF tasks) when a cell's market, interval or refresh
   context changes.
4. **StrictMode runs effects twice.** One-shot skip flags burn on the double
   fire; use state that survives it, like `viewingSharedRef`, cleared only by
   real user edits through `editLayout()`.
5. **REST discipline.** Everything goes through `info.ts` (retry, concurrency
   cap, dedupe). Never fetch full history for every cell at cold start: 600
   bars, then lazy scroll-left pagination.
6. **lightweight-charts v5**: `chart.addSeries(CandlestickSeries, …)`,
   `autoSize` on. `series.update()` throws on a bar older than the last —
   buffer WS ticks during a backfill and replay only `t ≥` the last snapshot
   bar. renderQueue has no try/catch, so one throw drops every paint in that
   frame; that is why `LiveComposer` is monotonic.
7. **Keyboard handlers ignore IME composition**
   (`e.isComposing || e.keyCode === 229`); many users type through CJK IMEs.
8. **TradingView attribution is a license requirement.** Every surface that
   renders charts shows a link to TradingView. The topbar carries one at every
   width (the full block above 900px, the compact `.attribution-nw` link at
   ≤ 900px), so wall cells keep the canvas `attributionLogo` off; it is on
   wherever the topbar link isn't visible: `?mini=1` windows, an expanded wall
   cell (flipped via `applyOptions`, never a chart rebuild) and the list
   view's chart card. A new chrome-less mode must carry attribution one way or
   the other. The topbar has almost no slack: the 641–900px single row is
   `flex-wrap: nowrap` under `overflow-x: hidden`, so an overflow is invisible
   and pushes the link — the rightmost item — off screen, and the full row is
   tuned to zero slack at 1331px (`CONDENSED_MQ`). Before adding anything to
   the topbar, measure `.topbar` overflow at a 641px viewport in English (the
   binding case) and at the breakpoint you touch, and gate the new item on
   measured widths (see the clock's gates in App.tsx and the `.has-pill` shed
   in App.css).
9. **Wall/list/positions routing rules** live as a numbered comment block at
   App.tsx's `view` state. Boot precedence: `?mini=1`, `#wc`, `#w=` → wall;
   `#list` → list; `#pos` → positions. `pushState` only on wall →
   list/positions; list ↔ positions replaces the pushed entry, so one back
   always returns to the wall (back peels card → list → wall). A shared-wall
   hash is kept in the pushed views (it is the only copy of that wall); a hash
   identical to the current wall never re-classifies as shared; view switches
   never go through `editLayout`. A share link on a device with no persisted
   wall is adopted outright (`hasPersistedLayout()`). `#wc` is a legacy route
   kept so old links fall back to the visitor's own wall.
10. **The API canary guards these assumptions** (`scripts/api-canary.mjs`,
    `.github/workflows/canary.yml`, twice a day): payload shapes the data
    layer relies on, a census of every live coin id against `coinKindOf`, and
    two WebSocket probes — a valid candle subscribe must be acked (failure if
    not), an unknown id must still close the socket unacked (alert if not).
    Drift opens a deduplicated GitHub issue. If you change a data-layer
    assumption, update the canary in the same change. The run-to-run baseline
    lives in the Actions cache; the workflow commits only when a spot list's
    content changed, because every push to `main` deploys.
11. **A formula id (`=…`) never reaches Hyperliquid.** candleSnapshot answers
    it with HTTP 500 (which info.ts would retry — a silent weight leak), and a
    WS candle subscribe for it closes the shared socket. Every candle path
    goes through `formulaFeed.ts`; `formulaFeed.test.ts` pins never-forward
    across backfill, heal, loadOlder and subscribe. A new candle entry point
    in ChartCell imports from `formulaFeed`, not `info.ts`/`ws.ts`.
    `npm run perf` takes `PERF_HASH='#w=…'` to gate a formula wall.
12. **The catalog is live: never assign it raw, never key on its objects.**
    Every update after the first goes through `mergeCatalog`. A raw
    assignment re-runs every ChartCell's data effect (viewport reset, dimmed
    price, a gap fetch per cell and per formula leg) and re-sorts an open
    picker. React to the catalog by value (coin and kind, the HIP-3 dex-set
    string); a consumer that caches derived objects must reuse equal ones. A
    cell's `Market` may outlive its listing (sticky resolve) — intended.

## Hyperliquid API notes

The canary re-checks the load-bearing ones twice a day; each note names the
code that depends on it.

### Limits

- **REST** `POST https://api.hyperliquid.xyz/info`: CORS-open, 1200 weight/min
  per IP. Most info types weigh 20; `allMids`, `l2Book` and
  `clearinghouseState` weigh 2; candleSnapshot adds 1 per 60 candles
  returned. → `info.ts`, ChartCell's chunk sizes, the stats poll (~120 weight
  with four live HIP-3 dexs).
- **WebSocket** `wss://api.hyperliquid.xyz/ws`, per IP: 10 connections, 30 new
  connections/min, 1000 subscriptions, 2000 client messages/min. → one socket
  in `ws.ts`.
- **Watched addresses.** The docs list 10 unique users across user-specific
  subscriptions; in practice a subscription for a 16th distinct address gets
  `{"channel":"error","data":"Cannot track more than 15 total users."}` and the
  socket stays open. The watch overlay's subscribed set (`watch.ts`: the
  active address plus every shown one, from a book of ≤ 20) counts against
  it.
- The server closes a connection it hasn't **sent** to for 60 s; pongs and
  pushes both count. → the silence probe.

### Candles

- The `candle` channel pushes one object for the current candle per update;
  no snapshot on subscribe, closed bars never re-sent. → REST backfill and
  heals.
- candleSnapshot keeps the ~5000 most recent bars per interval (1d and longer
  reach back years). A window can come back `[]` for a thin market: buckets
  with no trades are omitted. → `formulaFeed.ts` seeds such legs.
- Buckets are `floor(t / duration)` from the Unix epoch on every interval and
  market class, REST and WS alike: `1w` bars open Thursday 00:00 UTC, and `1M`
  is a fixed 30-day bucket, not a calendar month — hence `1w` but no `1M`
  (comment on `INTERVALS` in `types.ts`). A calendar week or month has to be
  rebuilt from 1d bars, which is what HL's own chart does.

### Ids and unknown ids

- Coin ids: perp `BTC`; spot `PURR/USDC` or `@<index>`; HIP-3 `<dex>:<COIN>`
  (`xyz:TSLA`, names arrive prefixed); HIP-4 `#<10 × outcome + side>` (side 0
  = Yes). `coinKindOf()` encodes the grammar; the canary alerts on a new
  shape.
- A `candle` subscription for an id outside HL's universe — a typo, a
  lowercase `btc`, a removed id, `@99999`, a formula id, a **settled** `#`
  outcome — makes HL close the **whole** socket (1006, no error frame, a few
  hundred ms later); every other subscription dies with it. Subscribes are
  processed in order and each valid one is acked with a `subscriptionResponse`
  echoing it (user-state echoes spell the main dex `dex: ''`; `allMids`
  echoes omit it); nothing after the bad one is processed, and an unsubscribe
  sent right after doesn't save the socket. → `ws.ts` quarantine,
  `fallbackMarket`, Invariant 11.
- Acked and harmless: a delisted coin, an unknown `allMids` dex, any
  well-formed address (empty state). A malformed interval (`7m`) gets
  `{"channel":"error",…}` and the socket lives on.
- REST differs: a bogus coin's candleSnapshot is HTTP 500 `null` (retried,
  then the cell's error overlay); a delisted coin's is `200 []`.

### Catalog payloads

- `metaAndAssetCtxs[0]` equals `meta` (per dex too) and
  `spotMetaAndAssetCtxs[0]` equals `spotMeta`, so the stats poll sees new
  listings for free (→ `catalogSync.ts`). `allPerpMetas` returns every dex's
  meta in one request; it is unused because it gives up per-dex failure
  isolation.
- Spot ctxs are indexed by spot **asset** index, not universe position (HIP-4
  outcome tokens share the index space): key by `ctx.coin`, never zip
  `universe[i]` with `ctxs[i]`. Spot ctxs and `allMids` also carry orphan `@N`
  pairs pruned from the universe (placeholder price, zero volume) — a ctx coin
  is not a listing. The spot universe is neither dense nor append-only.
- `spotMetaAndAssetCtxs` includes every HIP-4 outcome token (`#…`) with
  `prevDayPx` and volume; `allMids` only fills gaps for them.
- Filter `isDelisted` everywhere; some HIP-3 dexs are entirely dead. OI in
  USD = `openInterest × markPx`.
- `perpCategories` is a static catalog that includes dead markets: intersect
  it with live, non-delisted ctxs before sizing anything on it.
  `perpConciseAnnotations` supplies display-name overrides (validated
  `/^[a-zA-Z0-9][\x20-\x7E]*$/`, no `:`) and search keywords.
- `allMids`: the default subscription covers main-dex perps, spot and HIP-4;
  each HIP-3 dex needs its own (`{type: 'allMids', dex}`; keys arrive
  prefixed). Pushes are idempotent full snapshots every few seconds, safe to
  coalesce to the latest.
- `outcomeMetaUpdates` is a WS channel pushing outcome/question created and
  settled events (unused; a zero-REST alternative to the poll diff).

### Spot names and the selector lists

- HL hardcodes three spot lists in its frontend bundle, none behind an API:
  the display-name map (`UBTC` → `BTC`, `USDT0` → `USDT`, …), the Strict
  allowlist (base-token `tokenId`s; every pair on a listed base passes) and
  the hidden base and quote tokens (matched against the displayed name,
  upper-cased).
- `scripts/sync-spot-overrides.mjs` re-extracts them into
  `spotOverrides.json` and `spotSelector.json`, validates every entry against
  live `spotMeta`, and refuses a list that changes too much at once (a wrong
  list is worse than a stale one); anchors and guards are documented in
  `scripts/lib/hlBundleLists.mjs`. Never hand-edit the JSON or add a parallel
  map. A token missing from HL's map shows its raw name, as on HL.
- A new listing is usually not on the Strict list, so Strict hides it on HL
  too; `marketSearch.ts` shows the matches anyway when Strict would hide all
  of them.

### HIP-4 outcome markets

- A question's category sits in its description's trailing
  `metadata=category:…|subCategory:…`.
- Questions named "Recurring" are templates
  (`class:priceBucket|underlying:BTC|priceThresholds:a,b|period:1d`); their
  outcome labels are synthesized exactly as
  `"{underlying} above {targetPrice} on {localDate}?"` /
  `"{underlying} price range on {localDate}?"`, numbers verbatim, buckets
  `"Below {a}"` / `"{a} to {b}"` / `"Above {b}"`.
- Template markets are named `template:<id>` with a `k:v|k:v` keyword bag as
  description (sorted; a segment without `:` voids the bag); standalone side
  names are `template:<sideName>`; the fallback is `template fallback` /
  `other`. The display text lives in `{"type": "outcomeTemplates"}`
  (`{id, role, name, description, keywords}` with `{kw}` slots), interpolated
  the way HL's client does (anchors above `parseQuestionInfo`: "at {date}" →
  "on {date}", local dates in names, UTC in descriptions, en-US grouping).
  Category comes from the template's `metadata=category:` (`price` → crypto
  for main-dex underlyings, the perp's `perpCategories` category for HIP-3,
  else economics or sports). An unknown template or malformed bag renders a
  derived label, never the raw id.
- Rows: orphan outcomes (no question) are real rows — standalone template
  markets and recurring binaries; fallback outcomes never are;
  `settledNamedOutcomes` are parsed but not shown; orphan "Recurring"
  outcomes with unparsable templates are dropped. Outcome sub-tabs mirror
  HL's: all / crypto / economics / tradfi / sports.
- Outcomes churn fast (short binaries roll every 15–30 minutes, dailies at
  06:00 UTC) and a settled id closes the socket like an unknown one. → the
  outcome-only refresh, and MarketTable never selects a settled row.
- `src/lib/hl/fixtures/` holds verbatim payloads that pin this via
  `buildHip4`.

### Funding

- HL charges funding every hour on every perp, HIP-3 included. `ctx.funding`
  is the hourly rate, already scaled by the dex's multiplier
  (`perpDexs.assetToFundingMultiplier`).
- HL's market selector shows `8h Funding` (`8 × funding × 100`); its trade
  header shows the hourly `funding × 100` at 4 dp with an annualized hover
  (`× 24 × 365`). Purrwall shows the hourly value everywhere, through
  `fmtFunding` / `fundingApr` in `hl/stats.ts` only (pinned in
  `stats.test.ts`). Many perps sit exactly on their dex's interest floor, so
  the same hourly value repeats across that dex (it annualizes identically
  too); the annualized hover is HL's own secondary figure.
- For a countdown: `predictedFundings`' `HlPerp.nextFundingTime` is the last
  settlement, not the next (it rolls about a minute after the hour posts);
  the next charge is `nextFundingTime + 3600e3`. The CEX entries beside it
  are correct.

### User state

- `{type: 'clearinghouseState' | 'openOrders', user, dex?}` and
  `{type: 'spotState', user}` (balances with `entryNtl` cost basis; no `dex`):
  address-only, no authentication, a full snapshot on subscribe and a full
  re-push about every 5 s.
- Per dex, like `allMids`: the default feed misses HIP-3 positions. REST
  `clearinghouseState` / `frontendOpenOrders` take the same `dex`.
- `openOrders` arrives in the frontend shape (`isTrigger`, `triggerPx`,
  `reduceOnly`); spot orders carry the coin in `spotMeta`'s pair-name form,
  identical to `Market.coin`. `liquidationPx` is `null` on cross positions
  with deep collateral. Numbers are strings.
- `webData2` is gone (`webData3` is a small digest).
  `allDexsClearinghouseState` (every dex in one subscription) exists, unused.

## UI rules

- **Displayed data never visibly truncates** — a cut-off price reads as
  wrong. Shed lower-priority chrome instead (formula names wrap at operators;
  narrow columns use `compactUsd`).
- **The picker mirrors Hyperliquid's own selector**: tabs, column order,
  formats, naming. Deliberate deviations are listed in MarketTable's header.
- Chart axes run at monitoring precision; the Positions page shows exact
  ledger numbers.
- **Dialogs** (picker, docs, walls manager, feedback, list chart card):
  `role="dialog"`, `aria-modal`, `aria-label`, `tabIndex={-1}`,
  `useModalFocus` (focus in, Tab cycles inside, focus back to the opener).
  The expanded wall cell is a view, not a dialog. **Popovers** (grid, share,
  ⋯, bell) are disclosures: `usePopoverDismiss` (outside mousedown, Escape).
- Never put a `transform`, `filter` or `contain` on an ancestor of a
  `position: fixed` popover: it becomes the containing block and the popover
  opens clipped inside it. (iOS ≤ 18.3 WebKit applies layout containment for
  `container-type: inline-size`, so a fixed popover inside `.cell` still
  anchors to the cell there; only a portal would fix that.)
- An Enter handler that closes a surface calls `preventDefault()`: focus
  returns to the opener during the keydown, and the key's default action
  would otherwise activate that button and reopen the surface.
- Icon-only controls carry a bilingual `aria-label`; a glyph inside a native
  `<button>` is `aria-hidden`, never `role="button"`.
- Breakpoints: ≤ 640px narrow wall (two-row topbar, count chips), ≤ 900px
  tight topbar (`TIGHT_MQ`), ≤ 1330px condensed topbar (`CONDENSED_MQ`),
  ≤ 1650px decoration shed while a pill is up, 700/480px table column tiers,
  `pointer: coarse` for touch; container queries inside cells. The live
  badge in the topbar's top-right corner is absolutely positioned so it costs
  no topbar width.
- Touch: on coarse pointers the linked wall's source is the last chart-body
  touch, on fine pointers `:hover` — never both, or two sources echo.
  Pull-to-refresh starts from the top chrome only and calls
  `preventDefault()` from the first cancelable `touchmove` (iOS ignores later
  ones).

## Testing and verification

### Automated

- `npm test` — vitest in Node; no DOM, no network. Covers `src/**/*.test.ts`,
  `worker/**/*.test.js`, `scripts/**/*.test.mjs`: codecs, caches, parsers
  (incl. the HIP-4 fixtures), formula grammar and bar math, the facade's
  never-forward rule, the socket's ladder, probes and quarantine over a fake
  WebSocket, the catalog refresher, the title controller, sync merging,
  alerts, grid resize, search, the formula bar, i18n, the Worker's routes,
  throttles, sanitizers and MIME encoding, the bundle-list extractors.
- `npm run lint` — oxlint; CI fails on errors, not warnings.
- `npm run build` — `tsc -b`, the Vite build, the release check. (`tsc -p .`
  checks nothing here: the root tsconfig only holds references.)
- `npm run perf` — after a build: `vite preview` + a fresh headless Chrome
  profile. Budget: first chart ≤ 2.5 s, all 9 cells ≤ 6 s, zero console
  errors. Each run makes ~9 real candleSnapshot requests; wait a minute
  between runs. `PERF_HASH='#w=…'` gates a specific 9-cell wall (formula-wall
  recipe in the script header); `CHROME_PATH` locates Chrome.
- CI runs lint, test and build on pushes to `main` and on pull requests.

### In a browser

`npm run dev`, then http://localhost:5173.

- **Standard pass**: console clean at warning level, every cell reaches live
  (no stuck overlay), then the change's own checks.
- **Performance-sensitive changes**: 16 cells at 1m for several minutes —
  zero long tasks, a heap that saw-tooths around flat troughs, no 429s, one
  candleSnapshot and one subscription per distinct market or formula leg.
- **Hidden tabs**: embedded and automated browsers often report
  `document.hidden = true`, which pauses the stats poll (blank badges) and
  suspends rAF (paints freeze). Make the tab visible or force a frame before
  trusting a repro.
- **Stale socket**: wrap `window.WebSocket` in a subclass that intercepts
  `onmessage` and swallows frames — all of them for a black-holed upstream, or
  only `channel: 'candle'` frames with `data.s === coin` for one dead feed.
  Dispatch `offline` then `online` so the app reconnects through the wrapper,
  then watch `.cell-price`'s class, `document.title` and the socket list.
  `document.dispatchEvent(new Event('freeze'))` / `'resume'` exercise the page
  lifecycle.
- **Network drops**: offline emulation doesn't reproduce a real drop (the
  socket stays CLOSING for the whole outage); toggle the real interface (on
  macOS `networksetup -setairportpower en0 off` / `on`) with a page-side
  logger.
- **Keyboard**: a dispatched `KeyboardEvent` has no default action, so
  default-action bugs only show with a real key press; log `keydown`,
  `keypress`, `click` and `focusin` in the capture phase to see the chain.
- **Touch**: use a phone or the iOS Simulator; desktop touch emulation misses
  iOS's gesture rules.
- **Quarantine, live**: a cell only gets a bogus `Market` under a partial
  catalog failure — temporarily throw in `info.ts` for `meta` with
  `dex: 'xyz'`.
- **Attribution**: after touching the topbar or a fullscreen surface, check
  that a TradingView link is visible at 641, 901 and 1331px and in every
  chrome-less mode (Invariant 8).

## Running your own deployment

- `npm run build` produces a static `dist/` that runs on any host; the Worker
  is only needed for sync, feedback and trend glyphs.
- `wrangler.jsonc` holds the custom-domain routes, three KV namespaces
  (`SYNC`, `SPARKS`, `FEEDBACK`), the `MAIL` send-email binding with its
  locked destination and `FEEDBACK_TO`. A fork needs its own routes and
  namespaces, its own mail destination (or none: mail is skipped when `MAIL`
  or `FEEDBACK_TO` is missing) and its own `SPARKS_TOKEN` secret and pipeline
  (or none — the list then shows no glyphs).
- In `worker/index.js`: `originAllowed()` admits only the site's own origins
  and localhost, so a fork on another domain adds its origin there, or sync
  and feedback writes get 403; `MAIL_FROM` and the `Message-ID` domain name
  the sending zone.
- In `index.html`: the canonical and Open Graph URLs; in `DocsModal.tsx`,
  the `purrwall.xyz/#list` link.
- `src/lib/hl/sparklines.ts` reads the production sparks blob under the Vite
  dev server.
- `scripts/feedback.mjs`: set `NAMESPACE_ID` to your FEEDBACK namespace.
- `.github/workflows/canary.yml` runs only for the upstream owner
  (`github.repository_owner_id`). A fork that deploys sets its own id there
  (the job commits to `main` and opens issues) or runs
  `node scripts/sync-spot-overrides.mjs` itself; otherwise its spot names and
  Strict list stay as forked.
- `/version.json` stamps the git HEAD at build time: build after committing,
  or the update pill never fires for that deploy.
