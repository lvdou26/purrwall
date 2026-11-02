import { useEffect, useRef } from 'react';
import { useLang } from '../lib/i18n';
import { CHANGELOG } from '../changelog';
import { useModalFocus } from '../lib/useModalFocus';

/** Top-of-docs release notes; entry content is bilingual data, so one
 *  component serves both language blocks. Shows the newest eight entries. */
function WhatsNew() {
  const lang = useLang();
  return (
    <>
      <h3>{lang === 'zh' ? '更新记录' : "What's new"}</h3>
      <ul className="wn-list">
        {CHANGELOG.slice(0, 8).map((e) => (
          <li key={e.id}>
            <span className="wn-date">{e.id}</span> <b>{e[lang].title}</b> — {e[lang].body}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * In-app documentation: what exists today and what's on the roadmap.
 * Kept as two full language blocks — docs read better written whole than
 * stitched from translation keys.
 */
export function DocsModal({ onClose, marketCount }: { onClose: () => void; marketCount: number | null }) {
  const lang = useLang();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const n = marketCount ?? '700+';

  return (
    <div
      className="picker-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="docs"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={lang === 'zh' ? 'Purrwall 文档' : 'Purrwall docs'}
        tabIndex={-1}
      >
        <div className="docs-head">
          <span className="docs-title">{lang === 'zh' ? 'Purrwall 文档' : 'Purrwall docs'}</span>
          <button
            className="hint-close"
            onClick={onClose}
            title="×"
            aria-label={lang === 'zh' ? '关闭' : 'Close'}
          >
            ×
          </button>
        </div>
        {lang === 'zh' ? (
          <div className="docs-body">
            <WhatsNew />
            <h3>这是什么</h3>
            <p>
              一面免费的 Hyperliquid 全市场行情墙。打开即用：浏览器直连 Hyperliquid
              公共 API，数据与交易所完全一致、实时更新。
            </p>

            <h3>市场覆盖（{n} 个在线）</h3>
            <ul>
              <li>永续 — 全部原生永续合约</li>
              <li>现货 — 全部交易对，ticker 与 Hyperliquid 官方 App 完全一致</li>
              <li>HIP-3 — builder 部署市场：股票、黄金、原油、指数、外汇（dex 标签显示部署方）</li>
              <li>HIP-4 — 预测市场：体育赛事（每一边都是独立图表）、宏观数据、每日价格盘</li>
            </ul>

            <h3>墙的用法</h3>
            <ul>
              <li>左上角网格按钮选择行×列（最大 6×4）· 拖动格子标题栏互换位置</li>
              <li>点击市场名 ▾ 打开选择器——与 Hyperliquid 官方选择器相同的标签、列、排序和严选/全部过滤；新上市的市场上线即出现，无需刷新；严选会挡住的搜索照样列出匹配，并附一行说明；★ 自选置顶；↑↓ + Enter 键盘操作</li>
              <li>ƒx 公式——在格子的选择器里点 ƒx，然后用市场名写算式（HYPE/ETH、BTC-ETH、(BTC+ETH)/2），手机上从行里选市场、用 + − × ÷ ( ) 键拼出来；格子把结果画成 K 线，每根由各市场自己的 K 线算出；最多 4 个市场 · 再点市场名 ▾ 可修改</li>
              <li>顶栏周期行一键统一全部图表；每格自己的选择器可单独覆盖</li>
              <li>⌖ 全墙联动——悬停任一图，全墙在同一时刻画出十字线、各格显示自己那根 K 线的 O/H/L/C；缩放或平移任一图，全墙跟随同一时间窗（跨周期）；双击任意图表恢复默认视图</li>
              <li>布局… 菜单：预设墙（默认墙 · 主流币 · 传统金融 24/7 · Meme · 成交额 Top）+ 保存自己的命名布局</li>
              <li>⧉ 把任意图表弹出为独立小窗口，可跨屏幕摆放</li>
              <li>分享——URL 就是这面墙：复制地址栏（或点分享），对方打开即见你的布局；其本地布局不受影响</li>
              <li>🔔 价格提醒——每格标题栏的铃铛（手机上的小格子要在全屏 ⛶ 视图里找）：按价格或涨跌 % 设阈值，图上画出虚线；价格每次穿越都会提醒（页内提示 + 可选声音与系统通知），Purrwall 开着时生效</li>
              <li>浏览器标签页的标题显示实时价格——取墙上第一张图，或你正全屏打开的那张；把别的图拖到左上角即可换</li>
              <li>向左滚动自动加载历史，直到 Hyperliquid 的数据尽头（每周期最多约 5000 根，长周期更少；日线可回溯到 2020）</li>
              <li>周线沿用 Hyperliquid 的分桶方式，以 UTC 周四 00:00 为起点，与以周一为起点的周线会有差异</li>
              <li>顶栏时区下拉——图表时间轴跟随它，宽窗口下的顶栏时钟也一样 · 可通过浏览器安装为桌面应用</li>
            </ul>

            <h3>榜（全市场列表）</h3>
            <ul>
              <li>顶栏 墙/榜 切换——全部市场的实时列表：自选 / 永续 / 现货 / 传统金融 / 预测</li>
              <li>点任意一行全屏看图；「＋加入墙」把它放上你的墙</li>
              <li>可直达、可分享：purrwall.xyz/#list</li>
            </ul>

            <h3>数字怎么读</h3>
            <ul>
              <li><b>24h</b> — 过去 24 小时涨跌；全墙统一锚点，可跨格子直接对比</li>
              <li><b>Δ / V</b> — 当前可见 K 线区间的涨跌与美元成交额；随缩放、滚动、周期变化</li>
              <li><b>RV</b> — 相对成交量：可见窗口 vs 前一窗口。已归一化，任何市场的 3× 含义相同；≥2× 时琥珀色高亮，提示异常放量</li>
              <li><b>F</b> — 资金费率。Hyperliquid 每小时收取一次，所以这里显示的是小时费率，和 Hyperliquid 上的数字完全一致；悬停可看年化 · <b>OI</b> — 当前持仓量 · <b>MC</b> — 市值（现货）</li>
              <li>图内成交量柱为美元名义值</li>
            </ul>

            <h3>路线图</h3>
            <ul>
              <li>新闻格子——任意格子放实时加密快讯，自动按你墙上的市场过滤</li>
              <li>多墙标签页 · 全市场热力墙</li>
            </ul>

            <h3>数据</h3>
            <p>
              价格来自 Hyperliquid 公共 API；图表由 TradingView 开源 Lightweight Charts 渲染。源代码在{' '}
              <a href="https://github.com/lvdou26/purrwall" target="_blank" rel="noreferrer">
                GitHub
              </a>
              。
            </p>
            <p className="docs-notice">
              {/* lightweight-charts NOTICE attribution (Invariant 8) — keep verbatim */}
              TradingView Lightweight Charts™ · Copyright © 2025{' '}
              <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
                TradingView, Inc.
              </a>
            </p>
          </div>
        ) : (
          <div className="docs-body">
            <WhatsNew />
            <h3>What is this</h3>
            <p>
              A free multi-chart wall for every Hyperliquid market. Open it and it works: your
              browser talks directly to Hyperliquid's public API, so the data is exactly what the
              exchange serves, live.
            </p>

            <h3>Markets ({n} live)</h3>
            <ul>
              <li>Perps — all native perpetuals</li>
              <li>Spot — every pair, tickers identical to the Hyperliquid app</li>
              <li>HIP-3 — builder-deployed markets: stocks, gold, oil, indices, FX (dex pill shows the deployer)</li>
              <li>HIP-4 — prediction markets: sports fixtures (each side is its own chart), macro prints, daily price bets</li>
            </ul>

            <h3>The wall</h3>
            <ul>
              <li>Pick rows × columns with the grid button (up to 6×4) · drag a cell's header onto another to swap</li>
              <li>Click a market name ▾ to open the picker — same tabs, columns, sorting and Strict/All filter as Hyperliquid's own selector; new listings appear as they list, no reload needed; a search Strict would hide shows its matches anyway, under a one-line note; ★ favorites pin to the top; ↑↓ + Enter to navigate</li>
              <li>ƒx formulas — click ƒx in a cell's picker, then type an expression with market names (HYPE/ETH, BTC-ETH, (BTC+ETH)/2) or, on a phone, build it from the rows and the + − × ÷ ( ) keys; the cell charts it as candles, each bar computed from the markets' own bars; up to 4 markets · click the name ▾ again to edit</li>
              <li>The interval row in the topbar retimes every chart at once; each cell's own selector overrides it</li>
              <li>⌖ links the wall — hover any chart and every cell marks that moment with its own bar's O/H/L/C; zoom or pan one chart and the whole wall follows the same time window, across intervals; double-click any chart to reset the view</li>
              <li>walls… menu — curated presets (Default wall · Majors · Tradfi 24/7 · Meme · Top volume) and your saved walls</li>
              <li>⧉ opens a chart in its own small window; arrange them across monitors</li>
              <li>Share — the URL <em>is</em> the wall: copy the address bar (or hit share) and anyone opens your exact layout; their own saved wall stays untouched</li>
              <li>🔔 price alerts — the bell in each cell's header (on a phone's small cells, inside the fullscreen ⛶ view): set a threshold by price or % move, a dashed line marks it on the chart, and every crossing fires (an in-page toast, plus optional sound and system notifications) while Purrwall is open</li>
              <li>The browser tab's title carries a live price — the first chart on your wall, or the one you have open fullscreen; drag another chart into the top-left slot to change it</li>
              <li>Scroll left to page in history until Hyperliquid's depth ends (up to ~5000 bars per interval, fewer on the long ones; daily candles reach 2020)</li>
              <li>Weekly bars run Thursday→Wednesday (UTC), following Hyperliquid's own bucketing — so a week here may not line up with a Monday-anchored week elsewhere</li>
              <li>Timezone dropdown in the topbar — chart axes and, on wide windows, the topbar clock follow it · installable as a desktop app (browser's install button)</li>
            </ul>

            <h3>The list</h3>
            <ul>
              <li>Wall/List toggle in the topbar — every market as one live table: Favorites / Perps / Spot / Tradfi / Outcome</li>
              <li>Tap any row for a fullscreen chart; “+ add to wall” drops it onto your wall</li>
              <li>Direct, shareable link: purrwall.xyz/#list</li>
            </ul>

            <h3>Reading the numbers</h3>
            <ul>
              <li><b>24h</b> — change over the last 24 hours; the fixed anchor, comparable across cells</li>
              <li><b>Δ / V</b> — change and USD volume over the bars currently visible; they follow zoom, scroll and interval</li>
              <li><b>RV</b> — relative volume: the visible window vs the window before it. Normalized, so 3× means the same on every market; amber at ≥2× flags unusual activity</li>
              <li><b>F</b> — funding rate. Hyperliquid charges it every hour, so this is the hourly rate and it matches the number on Hyperliquid exactly; hover for annualized · <b>OI</b> — open interest now · <b>MC</b> — market cap (spot)</li>
              <li>Volume bars in the chart are USD notional</li>
            </ul>

            <h3>Roadmap</h3>
            <ul>
              <li>News cells — realtime crypto headlines in any grid slot, auto-filtered to your wall's markets</li>
              <li>Multi-wall tabs · all-market heat wall</li>
            </ul>

            <h3>Data</h3>
            <p>
              Prices come from Hyperliquid's public API. Charts render with TradingView's
              open-source Lightweight Charts. The source is on{' '}
              <a href="https://github.com/lvdou26/purrwall" target="_blank" rel="noreferrer">
                GitHub
              </a>
              .
            </p>
            <p className="docs-notice">
              {/* lightweight-charts NOTICE attribution (Invariant 8) — keep verbatim */}
              TradingView Lightweight Charts™ · Copyright © 2025{' '}
              <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
                TradingView, Inc.
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
