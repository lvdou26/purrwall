// What's-new release notes, shipped inside the bundle so notes and the
// release they describe deploy together. Newest first — CHANGELOG[0].id is
// the high-water mark compared against localStorage for the unread dot and
// toast. Convention: only user-visible features get an entry; silent
// deploys (fixes, refactors, copy) add nothing. If two entries
// land on one date, suffix the id ('2026-07-08b') — ids must stay unique and
// newest-first in array order.

export type ChangelogEntry = {
  id: string; // release date 'YYYY-MM-DD'
  en: { title: string; body: string };
  zh: { title: string; body: string };
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-09-24',
    en: {
      title: 'New listings show up by themselves, and Strict matches Hyperliquid',
      body: 'A wall left open now keeps up with Hyperliquid: a newly listed spot token, perp or outcome market appears in the picker within minutes, no reload. Strict now uses Hyperliquid\'s own list of spot tokens instead of a volume cut-off, so both selectors show the same pairs — and when Strict would hide every match of what you type, the matches show anyway under a one-line note.',
    },
    zh: {
      title: '新上市自动出现，严选与 Hyperliquid 一致',
      body: '墙一直开着也能跟上 Hyperliquid：新上线的现货、合约或预测市场，几分钟内就出现在选择器里，无需刷新。严选改用 Hyperliquid 自己的现货代币名单，不再按成交额筛选，两边选择器显示的交易对一致；当你输入的名字被严选全部挡住时，照样列出匹配结果，并附一行说明。',
    },
  },
  {
    id: '2026-09-16',
    en: {
      title: 'A live price in the tab, and a legible order ladder',
      body: 'The browser tab now reads like Hyperliquid\'s — "75,585 | BTC | Purrwall" — with the first chart on your wall, or the one you have open fullscreen, ticking in the title even while you are on another tab. And when a watched wallet rests many orders on one market, the price axis labels the entry, liquidation, the nearest stop/take-profit levels and the edges of the order ladder — the next order to fill on each side — while every other order keeps its line, so the axis numbers stay readable.',
    },
    zh: {
      title: '标签页里的实时价格，和看得清的挂单梯',
      body: '浏览器标签页现在像 Hyperliquid 一样显示 "75,585 | BTC | Purrwall"——取墙上第一张图（或你正全屏打开的那张）的实时价格，切到别的标签页也在跳动。关注的钱包在一个市场上挂了很多单时，坐标轴只标注开仓价、强平价、最近的止损止盈价和挂单梯的两端——每侧下一张将成交的挂单——其余挂单只保留线，轴上的刻度数字重新可读。',
    },
  },
  {
    id: '2026-09-10',
    en: {
      title: 'Formulas: chart any market against any other',
      body: 'Any cell can now chart an expression instead of a single market — HYPE/ETH, TSLA-NVDA, (BTC+ETH)/2, up to 4 markets — as live candles on every interval, each bar computed from the markets\' own bars. Click ƒx in the cell\'s picker, then type it — or, on a phone, build it from the rows and the + − × ÷ ( ) keys; tap the cell\'s name to edit it later.',
    },
    zh: {
      title: '公式：任意市场之间的算式',
      body: '任何格子现在都可以画一条算式，而不只是单个市场——HYPE/ETH、TSLA-NVDA、(BTC+ETH)/2，最多四个市场——结果是实时 K 线，所有周期都支持，每根 K 线由各市场自己的 K 线算出。在格子的选择器里点 ƒx 后直接输入；手机上则从行里选市场、用 + − × ÷ ( ) 键拼出来；之后点格子的市场名即可修改。',
    },
  },
  {
    id: '2026-08-27b',
    en: {
      title: 'Choose which wallets show on your charts',
      body: 'The watch dialog and the Positions page now carry a switch and a wallet list: pick exactly which saved addresses draw their positions and orders on the charts — one, several, or none — and flip them all off with one tap. The PnL chip sums every shown wallet and breaks the number down per wallet on hover. And the realtime signal is now a proper ● LIVE badge in the top-right corner.',
    },
    zh: {
      title: '自己选哪些钱包画在图上',
      body: '关注对话框和仓位页新增开关与钱包清单：精确选择哪些已存地址把持仓和挂单画到图上——一个、几个或全关，一键切换。盈亏角标汇总所有显示中的钱包，悬停可见逐钱包拆分。右上角的实时信号也升级为 ● 实时 徽标。',
    },
  },
  {
    id: '2026-08-27',
    en: {
      title: 'A Positions page, an address book, and a live dot',
      body: 'Watching an address now comes with a third tab beside Wall and List: Positions — the account laid out the way the exchange itself does it: total equity (perp + spot), positions with entry/mark/liq/ROE/margin/funding, spot balances with USDC values and cost-basis PnL, and every resting order — exact numbers throughout. An address book lets you save several addresses, name them, and switch with one tap. The walls menu gains its own live category: one positions wall per saved address, rebuilt from current holdings every time you pick it (never cluttering your saved views). And the green dot in the top-right corner breathes whenever data is streaming live — wall, list and positions alike.',
    },
    zh: {
      title: '仓位页、地址簿和实时小绿点',
      body: '关注地址现在有了独立的第三个页面：在「墙」「榜」旁边的「仓位」——按交易所本身的方式展示账户：总权益（合约 + 现货）、带开仓/标记/强平/回报率/保证金/资金费的仓位表、带 USDC 价值与成本盈亏的现货余额表、每一张挂单，全部精确数字。地址簿可保存多个地址、起名字、一键切换。布局菜单新增独立的实时分类：每个已存地址一面「持仓墙」，每次选中都按当前持仓重建（不占用已存视图）。右上角的小绿点常驻呼吸：墙、榜、仓位的数据都在实时流入。',
    },
  },
  {
    id: '2026-08-26',
    en: {
      title: 'Watch any address on the wall',
      body: 'Walls menu → "watch address…": paste any Hyperliquid address and every chart overlays its live account — entry price (solid line), liquidation (amber dotted), resting orders (dashed), plus a PnL chip in the stats bar. One tap builds a wall from its open positions.',
    },
    zh: {
      title: '把任意地址放上墙',
      body: '布局菜单 →「关注地址…」：粘贴任意 Hyperliquid 地址，每张图会叠加它的实时账户——开仓价（实线）、强平价（琥珀色点线）、挂单（虚线），统计栏多出盈亏角标。还能一键用它的持仓建一面墙。',
    },
  },
  {
    id: '2026-08-05b',
    en: {
      title: 'Price alerts, on every chart',
      body: 'Each cell now has a 🔔 in its header. Set a level by price or by % move — a dashed line marks it on the chart — and every time the price crosses it you get an in-page notice, with optional sound and system notifications (ask for them in the bell menu). Alerts fire on every crossing, in both directions, while Purrwall is open in a tab.',
    },
    zh: {
      title: '每张图都能设价格提醒',
      body: '每个格子的标题栏多了一个 🔔。按价格或涨跌 % 设定水位——图上会画出虚线——之后价格每次穿越都会在页内提醒你，还可以在铃铛菜单里打开声音和系统通知。提醒双向都触发，Purrwall 在任一标签页开着时生效。',
    },
  },
  {
    id: '2026-08-05',
    en: {
      title: 'A clock on the wall',
      body: 'The top bar now shows the current time, to the second, in the same timezone your charts use — switch the timezone dropdown and the clock follows. Useful when something is scheduled: a data release, a market open, the top-of-the-hour funding charge. It appears when the window is wide enough to carry it; tighter bars keep their space for the controls.',
    },
    zh: {
      title: '墙上有钟了',
      body: '顶栏现在显示当前时间，精确到秒，时区与图表时间轴一致——在时区下拉框里切换，时钟同步跟随。等一个有时间点的事件时很有用：数据公布、开盘、整点资金费。窗口足够宽时显示；较窄的顶栏空间留给控件。',
    },
  },
];

const SEEN_KEY = 'purrwall.lastSeenRelease';

// Missing key counts as unseen (a first visit shows the dot; the toast is
// additionally gated on the first-visit hint in App). If localStorage is
// unavailable (private mode) report seen — never nag on every load.
export function hasUnseen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== CHANGELOG[0].id;
  } catch {
    return false;
  }
}

export function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, CHANGELOG[0].id);
  } catch {
    /* non-fatal */
  }
}
