import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, AreaSeries,
  ColorType, CrosshairMode, type UTCTimestamp, type Time, type MouseEventParams,
} from 'lightweight-charts';
import './style.css';
import { ResearchView } from './research';
import './research.css';

type AssetID = 'btc' | 'eth' | 'us10y' | 'us30y' | 'gold';
type Interval = '1m' | '15m' | '1h' | '6h' | '1d' | '1w';
const intervalLabels: Record<Interval, string> = { '1m': '1 分', '15m': '15 分', '1h': '1 小时', '6h': '6 小时', '1d': '日线', '1w': '周线' };
const tradingViewIntervals: Record<Interval, string> = { '1m': '1', '15m': '15', '1h': '60', '6h': '360', '1d': 'D', '1w': 'W' };
interface Quote {
  asset: AssetID; price: number; change?: number; changePercent?: number;
  high?: number; low?: number; volume?: number; timestamp: number; fetchedAt: number; cached: boolean;
}
interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume?: number }
interface History { asset: AssetID; interval: Interval; candles: Candle[]; fetchedAt: number; cached: boolean }
interface Snapshot { quotes: Quote[]; errors: Record<string, string> }
interface Preferences { menuAssets: AssetID[]; pinned: boolean }
interface LoginItemState { status: 'enabled' | 'notRegistered' | 'requiresApproval' | 'notFound' | 'unavailable'; error?: string }
interface Asset { id: AssetID; name: string; short: string; symbol: string; detail: string; kind: 'crypto' | 'yield' | 'gold'; color: string; icon: string }

const icons: Record<string, string> = {
  pulse: '<path d="M2 12h4l3-7 5 14 3-7h5"/>',
  pin: '<path d="m8 3 8 0-1 6 4 4v2H5v-2l4-4-1-6ZM12 15v7"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17"/>',
  reset: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path d="M8 12h8m-4-4v8"/>',
  candles: '<path d="M7 2v4m0 10v6M17 2v8m0 9v3"/><rect x="4" y="6" width="6" height="10" rx="1"/><rect x="14" y="10" width="6" height="9" rx="1"/>',
  area: '<path d="m3 17 5-6 5 3 8-9M3 21h18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  gold: '<path d="m7 7-4 11h18L17 7H7Z"/><path d="m7 7 3 4h7m-7 0-2 7"/>',
  eth: '<path d="m12 2-6 10 6 3 6-3-6-10Zm-6 12 6 8 6-8-6 4-6-4Z"/>',
  bond: '<path d="M5 21V9m7 12V3m7 18V6M2 21h20"/>',
  arrow: '<path d="m7 17 10-10M7 7h10v10"/>',
};
const svg = (name: string, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
const assets: Asset[] = [
  { id: 'btc', name: '比特币', short: 'Bitcoin', symbol: 'BTC / USD', detail: 'Coinbase 现货', kind: 'crypto', color: '#f1ba70', icon: '₿' },
  { id: 'eth', name: '以太坊', short: 'Ethereum', symbol: 'ETH / USD', detail: 'Coinbase 现货', kind: 'crypto', color: '#a5b5ff', icon: 'eth' },
  { id: 'us10y', name: '10 年期美债', short: '美国国债', symbol: 'US 10Y', detail: 'Cboe 收益率指数', kind: 'yield', color: '#80bafa', icon: 'bond' },
  { id: 'us30y', name: '30 年期美债', short: '美国国债', symbol: 'US 30Y', detail: 'Cboe 收益率指数', kind: 'yield', color: '#90cacf', icon: 'bond' },
  { id: 'gold', name: '黄金期货', short: 'COMEX', symbol: 'GOLD', detail: 'COMEX 黄金连续期货', kind: 'gold', color: '#dec690', icon: 'gold' },
];
const read = <T>(key: string, fallback: T): T => {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};
const persist = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional. */ } };
const savedAsset = read<AssetID>('asset', 'btc');
let page: 'market' | 'research' = 'market';
let selected: AssetID = assets.some(a => a.id === savedAsset) ? savedAsset : 'btc';
let interval: Interval = read<Interval>('interval', '1h');
if (!(interval in intervalLabels)) interval = '1h';
if (assets.find(a => a.id === selected)?.kind === 'yield' && !['1d', '1w'].includes(interval)) interval = '1d';
let snapshot: Snapshot = { quotes: [], errors: {} };
let preferences: Preferences = { menuAssets: ['btc', 'eth'], pinned: false };
let loginItem: LoginItemState | undefined;
let loginItemBusy = false;
let history: History | undefined;
let visible = true;
let historyRequest = 0;
let lastHistoryRequestAt = 0;
let tradingViewSymbols: Partial<Record<AssetID, string>> = {};
let inspectedTime: UTCTimestamp | undefined;
let pinnedCandle = false;
let tooltipPoint: { x: number; y: number } | undefined;
let loading = false;
let isRefreshing = false;
let sma20 = read<boolean>('sma20', true);
let sma50 = read<boolean>('sma50', false);
let showVolume = read<boolean>('volume', true);
let chartStyle: 'candles' | 'area' = 'candles';
let historyError: string | undefined;
let bridgeReady = false;
const observing = () => page === 'research';
const asset = () => assets.find(a => a.id === selected)!;
const quote = () => snapshot.quotes.find(q => q.asset === selected);
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (value: number | undefined, yieldValue = false) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: yieldValue ? 3 : 2, maximumFractionDigits: yieldValue ? 3 : 2 });
const signed = (value: number, digits = 2) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;
const dateFmt = (seconds: number, full = false) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', ...(full ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(new Date(seconds * 1000));
const historyDate = (seconds: number) => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(seconds * 1000));
const iconFor = (a: Asset) => `<span class="asset-icon ${a.id}">${a.id === 'btc' ? '₿' : svg(a.icon, 21)}</span>`;
const changeText = (q: Quote | undefined, a: Asset) => !q || q.change == null ? '—' : a.kind === 'yield' ? `${signed(q.change * 100, 1)} bp` : q.changePercent == null ? '—' : `${signed(q.changePercent)}%`;
const direction = (q: Quote | undefined) => q?.change == null ? '' : q.change >= 0 ? 'positive' : 'negative';

declare global {
  interface Window {
    webkit?: { messageHandlers: { native: { postMessage: (value: unknown) => void } } };
    receiveNative: (message: string) => void;
  }
}
let sequence = 0;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function native<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!window.webkit?.messageHandlers.native) { reject(new Error('请打开 macOS 应用以连接行情。')); return; }
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('行情请求超时，请重试。')); }, action === 'research' ? 90000 : 25000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    window.webkit.messageHandlers.native.postMessage({ id, action, ...args });
  });
}
window.receiveNative = (message: string) => {
  const value = JSON.parse(message);
  if (value.id && pending.has(value.id)) {
    const request = pending.get(value.id)!;
    clearTimeout(request.timer);
    pending.delete(value.id);
    value.error ? request.reject(new Error(value.error)) : request.resolve(value.payload);
  } else if (value.type === 'quotes') {
    snapshot = value.payload;
    renderQuotes();
  } else if (value.type === 'loginItem') {
    loginItem = value.payload;
    renderLoginItem();
  } else if (value.type === 'escape') {
    handleEscape();
  } else if (value.type === 'visibility') {
    const wasVisible = visible;
    visible = value.visible;
    if (visible && !wasVisible) { if (observing()) research.tick(true); else void loadHistory(false, true); }
  } else if (value.type === 'wake' && visible) {
    if (observing()) research.tick(true); else void loadHistory(false, true);
  }
};

byId('app').innerHTML = `
  <div class="shell">
    <header class="app-header">
      <div class="brand"><button id="research-back" class="research-back" title="返回行情（Esc）" hidden>← 返回行情</button><span class="brand-mark">${svg('pulse', 22)}</span><strong>Crypto Monitor</strong><span id="page-caption" class="brand-caption">市场一览</span></div>
      <div class="header-actions"><span id="connection" class="connection"><i></i>正在连接</span>
        <button id="pin" class="icon-button" aria-label="保持弹窗打开" title="保持弹窗打开" aria-pressed="false">${svg('pin')}</button>
        <button id="settings-open" class="icon-button" aria-label="设置" title="设置">${svg('settings')}</button>
        <button id="close" class="icon-button" aria-label="关闭弹窗" title="关闭（Esc）">${svg('close')}</button>
      </div>
    </header>
    <nav class="watchlist" aria-label="自选行情">${assets.map(a => `
      <button class="watch-item" data-asset="${a.id}" aria-label="查看${a.name}" aria-pressed="${a.id === selected}">
        <span class="watch-title">${iconFor(a)}<span>${a.kind === 'yield' ? a.symbol : a.name}</span><span class="watch-tag">${a.kind === 'yield' ? '收益率' : a.id === 'gold' ? '期货' : a.id.toUpperCase()}</span></span>
        <span class="watch-values"><strong id="watch-price-${a.id}">—</strong><span id="watch-change-${a.id}" class="watch-change">—</span></span>
      </button>`).join('')}</nav>
    <main id="market-workspace" class="workspace">
      <section class="instrument" aria-label="当前行情">
        <div class="instrument-primary"><div class="instrument-title"><h1 id="asset-name"></h1><span id="asset-symbol"></span><span class="session-badge" id="session"></span></div>
          <div class="price-line"><strong id="price" class="price">—</strong><span id="price-unit" class="price-unit"></span><span id="change" class="price-change">—</span></div>
          <div id="price-caption" class="price-caption"></div>
        </div>
        <div class="day-range"><div class="range-labels"><span id="range-label">24h 区间</span><span id="range-unit">USD</span></div>
          <div class="range-values"><span id="day-low">—</span><span id="day-high">—</span></div>
          <div class="range-track"><span id="range-marker"></span></div><div class="range-caption">低点<span>高点</span></div>
        </div>
      </section>
      <section class="chart-toolbar" aria-label="图表工具">
        <div class="intervals" role="group" aria-label="K 线周期">${(Object.keys(intervalLabels) as Interval[]).map(i => `<button data-interval="${i}" aria-pressed="false">${intervalLabels[i]}</button>`).join('')}</div>
        <div class="chart-controls"><button id="open-research" class="open-research" title="进入 ETH 合约观察二级页面" hidden>ETH 合约观察 →</button><button id="sma20" class="indicator-button" aria-pressed="true"><i class="ma20-dot"></i>MA 20</button><button id="sma50" class="indicator-button" aria-pressed="false"><i class="ma50-dot"></i>MA 50</button>
          <span class="tool-divider"></span><button id="style-candles" class="icon-button" aria-label="K 线图" title="K 线图" aria-pressed="true">${svg('candles', 16)}</button><button id="style-area" class="icon-button" aria-label="面积图" title="面积图" aria-pressed="false">${svg('area', 16)}</button>
          <button id="reset" class="icon-button" aria-label="重置图表缩放" title="重置图表缩放">${svg('reset', 16)}</button>
        </div>
      </section>
      <div class="ohlc" id="ohlc" aria-live="off"><span>正在获取 K 线</span></div>
      <div class="chart-region"><div id="chart" aria-label="可交互行情图表，拖动平移，滚轮或触控板缩放"></div>
        <div id="chart-state" class="chart-state"><span class="spinner"></span><strong>正在连接市场</strong><span>获取真实历史行情</span></div>
        <div id="chart-watermark" class="chart-watermark" aria-hidden="true"></div>
        <div id="chart-tooltip" class="chart-tooltip" role="tooltip" aria-label="K 线详情" hidden></div>
      </div>
      <div class="chart-bottom"><div><button id="volume" class="volume-toggle" aria-pressed="true"><span class="check-box">${svg('check', 10)}</span>成交量</button><span id="history-range" class="history-range"></span></div><span class="interaction-hint">悬停查看 · 点击固定 · 拖动平移 · 滚轮缩放</span></div>
      <div id="notice" class="notice" role="status" hidden></div>
    </main>
    <main id="research-workspace" class="workspace research-workspace" hidden></main>
    <footer class="app-footer"><div class="source"><span id="source-dot" class="source-dot"></span><span id="source-name"></span><span id="quote-time"></span></div><div class="footer-actions"><button id="refresh" class="refresh-button" title="刷新行情（R）">${svg('refresh', 13)}刷新</button><a id="tradingview-link" title="在 TradingView 查看当前品种">TradingView ${svg('arrow', 11)}</a></div></footer>
  </div>
  <dialog id="settings" aria-labelledby="settings-title"><div class="dialog-heading"><div><h2 id="settings-title">让行情，留在视线里</h2><p>选择 macOS 菜单栏显示的品种</p></div><button id="settings-close" class="icon-button" aria-label="关闭设置">${svg('close')}</button></div>
    <div class="settings-assets">${assets.map(a => `<label class="setting-row">${iconFor(a)}<span><strong>${a.name}</strong><small>${a.symbol}</small></span><input type="checkbox" value="${a.id}" name="menu-asset" /></label>`).join('')}</div>
    <p id="settings-feedback" class="settings-feedback" role="status">至少保留一个品种。选得越少，菜单栏越简洁。</p>
    <section class="startup-setting" aria-label="启动设置">
      <label class="startup-row" for="launch-at-login"><span><strong>登录时启动</strong><small>登录 macOS 后，自动显示菜单栏行情</small></span><input id="launch-at-login" type="checkbox" role="switch" aria-describedby="startup-status" disabled /></label>
      <p id="startup-status" class="startup-status" role="status">正在读取系统登录项…</p>
      <button id="login-system-settings" class="system-settings-button" hidden>打开系统登录项 ${svg('arrow', 12)}</button>
    </section>
    <div class="settings-info"><strong>关于行情</strong><p>菜单栏 BTC / ETH 为 Coinbase 美元现货，涨跌为滚动 24h。美债为收益率指数，变动单位为 bp；黄金为 COMEX 连续期货，均显示延时报价。</p><p>每 30 秒检查更新。网络异常时显示缓存和原始报价时间。行情页按本机时区；ETH 观察页使用 Binance 市场参考与 UTC 时间，独立显示数据来源。</p><p>TradingView Lightweight Charts™<br>Copyright (с) 2025 TradingView, Inc.</p></div>
    <div class="dialog-footer"><span>Crypto Monitor <small>0.1.0</small></span><button id="quit" class="text-button">退出应用</button></div>
  </dialog>`;

const chart = createChart(byId('chart'), {
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: '#142335' }, textColor: '#9fb1c5', fontSize: 10, fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', attributionLogo: true,
    panes: { separatorColor: '#223449', separatorHoverColor: '#365475', enableResize: true } },
  grid: { vertLines: { visible: false }, horzLines: { color: '#203146', style: 1 } },
  crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#7e96af', labelBackgroundColor: '#365475', style: 2, width: 1 }, horzLine: { color: '#7e96af', labelBackgroundColor: '#365475', style: 2, width: 1 } },
  rightPriceScale: { borderVisible: false, minimumWidth: 78, scaleMargins: { top: 0.12, bottom: 0.1 } },
  timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 7, barSpacing: 7, minBarSpacing: 2,
    tickMarkFormatter: (time: Time, type: number) => {
      if (typeof time !== 'number') return null;
      const date = new Date(time * 1000);
      if (type === 0) return String(date.getFullYear());
      if (type === 1) return `${date.getMonth() + 1}月`;
      if (type === 2) return `${date.getMonth() + 1}/${date.getDate()}`;
      return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    },
  },
  localization: { locale: 'zh-CN', timeFormatter: (time: Time) => typeof time === 'number' ? dateFmt(time, interval !== '1d' && interval !== '1w') : String(time) },
});
const candles = chart.addSeries(CandlestickSeries, { upColor: '#65d6bd', downColor: '#ff8e99', borderVisible: false, wickUpColor: '#65d6bd', wickDownColor: '#ff8e99' });
const area = chart.addSeries(AreaSeries, { visible: false, lineColor: '#7eb3ff', topColor: '#7eb3ff28', bottomColor: '#7eb3ff00', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
const ma20 = chart.addSeries(LineSeries, { color: '#e2bf78', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
const ma50 = chart.addSeries(LineSeries, { color: '#a99ae8', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1);
volume.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });

const research = new ResearchView(byId('research-workspace'), native, (source, time, stale, period) => {
  if (!observing()) return;
  byId('source-name').textContent = source;
  byId('quote-time').textContent = time;
  byId('source-dot').classList.toggle('is-stale', stale);
  const link = byId<HTMLAnchorElement>('tradingview-link');
  link.href = `https://www.tradingview.com/chart/?symbol=BINANCE%3AETHUSDT.P&interval=${{ '1h': '60', '4h': '240', '1d': 'D' }[period]}`;
  link.title = '在 TradingView 查看 Binance ETHUSDT 永续';
  link.setAttribute('aria-label', link.title);
});

function renderView() {
  document.body.classList.toggle('research-page', observing());
  byId('page-caption').textContent = observing() ? 'ETH 合约观察' : '市场一览';
  byId('research-back').hidden = !observing();
  byId('open-research').hidden = selected !== 'eth';
  byId('market-workspace').hidden = observing();
  research.setActive(observing() && bridgeReady);
}
byId('open-research').addEventListener('click', () => {
  page = 'research'; clearInspection(); renderView(); byId('research-back').focus();
});
function returnToMarket() {
  page = 'market'; renderSelection(); byId('open-research').focus();
  void loadHistory(false, true);
}
byId('research-back').addEventListener('click', returnToMarket);

function renderSelection() {
  const a = asset();
  byId('asset-name').textContent = a.name;
  byId('asset-symbol').textContent = a.symbol;
  byId('chart-watermark').textContent = a.kind === 'crypto' ? a.id.toUpperCase() : a.kind === 'yield' ? a.symbol : 'GOLD';
  byId('price-unit').textContent = a.kind === 'yield' ? '%' : 'USD';
  byId('session').textContent = a.kind === 'crypto' ? '24 / 7' : '延时报价';
  byId('range-label').textContent = a.kind === 'crypto' ? '24h 区间' : '当日区间';
  byId('range-unit').textContent = a.kind === 'yield' ? '%' : 'USD';
  byId('source-name').textContent = a.kind === 'crypto' ? 'Coinbase' : 'Yahoo Finance';
  const tradingViewLink = byId<HTMLAnchorElement>('tradingview-link');
  const symbol = tradingViewSymbols[selected];
  if (symbol) {
    const destination = new URL('https://www.tradingview.com/chart/');
    destination.searchParams.set('symbol', symbol);
    destination.searchParams.set('interval', tradingViewIntervals[interval]);
    tradingViewLink.href = destination.toString();
  }
  tradingViewLink.title = `在 TradingView 查看${a.name}（${intervalLabels[interval]}）`;
  tradingViewLink.setAttribute('aria-label', tradingViewLink.title);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-asset]')) button.setAttribute('aria-pressed', String(button.dataset.asset === selected));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-interval]')) {
    button.setAttribute('aria-pressed', String(button.dataset.interval === interval));
    button.disabled = a.kind === 'yield' && !['1d', '1w'].includes(button.dataset.interval!);
    button.title = button.disabled ? '美债收益率提供日线和周线' : '';
  }
  const priceFormat = { type: 'custom' as const, minMove: a.kind === 'yield' ? 0.001 : 0.01, formatter: (value: number) => fmt(value, a.kind === 'yield') + (a.kind === 'yield' ? '%' : '') };
  [candles, area, ma20, ma50].forEach(series => series.applyOptions({ priceFormat }));
  chart.applyOptions({ timeScale: { timeVisible: !['1d', '1w'].includes(interval) } });
  renderQuotes();
  updateIndicators();
  renderView();
}

function renderQuotes() {
  for (const a of assets) {
    const q = snapshot.quotes.find(q => q.asset === a.id);
    byId(`watch-price-${a.id}`).textContent = q ? fmt(q.price, a.kind === 'yield') + (a.kind === 'yield' ? '%' : '') : '—';
    const change = byId(`watch-change-${a.id}`);
    change.textContent = q?.cached ? '缓存' : changeText(q, a);
    change.className = `watch-change ${q?.cached ? 'cached' : direction(q)}`;
    const button = document.querySelector<HTMLButtonElement>(`[data-asset="${a.id}"]`)!;
    button.title = snapshot.errors[a.id] ?? (q ? `报价时间 ${dateFmt(q.timestamp, true)}` : '等待行情');
  }
  const a = asset(), q = quote();
  byId('price').textContent = fmt(q?.price, a.kind === 'yield');
  const change = byId('change');
  change.className = `price-change ${direction(q)}`;
  change.textContent = changeText(q, a);
  byId('price-caption').textContent = `${a.detail}${a.kind === 'gold' ? ' · 美元 / 金衡盎司' : ''}　${a.kind === 'crypto' ? '较 24 小时前' : '较上一交易日收盘'}`;
  byId('day-low').textContent = fmt(q?.low, a.kind === 'yield');
  byId('day-high').textContent = fmt(q?.high, a.kind === 'yield');
  const fraction = q && q.high != null && q.low != null && q.high > q.low ? (q.price - q.low) / (q.high - q.low) : 0.5;
  byId('range-marker').style.left = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  const stale = snapshot.quotes.some(q => q.cached) || Object.keys(snapshot.errors).length > 0;
  byId('connection').innerHTML = `<i></i>${!snapshot.quotes.length ? '等待行情' : stale ? '部分报价未更新' : '行情已连接'}`;
  byId('connection').classList.toggle('is-stale', stale);
  if (!observing()) {
    byId('quote-time').textContent = q ? `${q.cached ? '缓存 · ' : ''}${dateFmt(q.timestamp, true)} 报价` : '尚无报价';
    byId('source-dot').classList.toggle('is-stale', !!q?.cached || !q);
  }
  renderNotice();
}

function renderNotice() {
  const parts: string[] = [];
  if (snapshot.errors[selected]) parts.push(snapshot.errors[selected]);
  if (quote()?.cached) parts.push('当前报价为缓存，请留意原始报价时间。');
  if (historyError) parts.push(historyError);
  else if (history?.cached) parts.push(`历史图表为缓存（${dateFmt(history.fetchedAt, true)} 获取）。`);
  const notice = byId('notice');
  notice.hidden = !parts.length;
  notice.textContent = parts.join(' ');
}

function movingAverage(rows: Candle[], period: number) {
  let sum = 0;
  return rows.flatMap((row, i) => {
    sum += row.close;
    if (i >= period) sum -= rows[i - period].close;
    return i >= period - 1 ? [{ time: row.time, value: sum / period }] : [];
  });
}

function updateIndicators() {
  byId('sma20').setAttribute('aria-pressed', String(sma20));
  byId('sma50').setAttribute('aria-pressed', String(sma50));
  for (const [id, period, series, enabled] of [
    ['sma20', 20, ma20, sma20], ['sma50', 50, ma50, sma50],
  ] as const) {
    const enough = (history?.candles.length ?? 0) >= period;
    byId<HTMLButtonElement>(id).disabled = !enough;
    byId(id).title = enough ? `${period} 周期简单移动平均线` : `至少需要 ${period} 根 K 线`;
    series.applyOptions({ visible: enabled && enough });
  }
  const available = asset().kind !== 'yield' && !!history?.candles.some(c => c.volume != null && c.volume > 0);
  byId<HTMLButtonElement>('volume').disabled = !available;
  byId('volume').title = available ? '显示或隐藏成交量' : '这个品种没有可用的成交量';
  byId('volume').setAttribute('aria-pressed', String(showVolume && available));
  volume.applyOptions({ visible: showVolume && available });
  volume.moveToPane(showVolume && available ? 1 : 0);
  if (showVolume && available) chart.panes()[1]?.setHeight(64);
}

function renderOHLC(candle?: Candle) {
  if (!candle) { byId('ohlc').innerHTML = '<span>将光标移到 K 线上，查看开高低收</span>'; return; }
  const isYield = asset().kind === 'yield';
  byId('ohlc').innerHTML = `<time>${dateFmt(candle.time, !['1d', '1w'].includes(interval))}</time>${(['open', 'high', 'low', 'close'] as const).map((key, i) => `<span>${['开', '高', '低', '收'][i]} <b class="${key === 'close' ? candle.close >= candle.open ? 'positive' : 'negative' : ''}">${fmt(candle[key], isYield)}</b></span>`).join('')}<span class="ohlc-volume">${candle.volume != null ? `量 <b>${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(candle.volume)}</b>` : ''}</span>`;
}

function clearInspection() {
  inspectedTime = undefined;
  pinnedCandle = false;
  tooltipPoint = undefined;
  byId('chart-tooltip').hidden = true;
}

function renderInspection() {
  const row = history?.candles.find(c => c.time === inspectedTime);
  if (!row) {
    clearInspection();
    renderOHLC(history?.candles.at(-1));
    return;
  }
  renderOHLC(row);
  const tooltip = byId('chart-tooltip');
  const chartElement = byId('chart');
  const x = pinnedCandle ? chart.timeScale().timeToCoordinate(row.time) : tooltipPoint?.x;
  const y = pinnedCandle ? candles.priceToCoordinate(row.close) : tooltipPoint?.y;
  if (x == null || y == null || x < 0 || x > chart.paneSize(0).width) { tooltip.hidden = true; return; }
  const isYield = asset().kind === 'yield';
  const up = row.close >= row.open;
  const change = isYield ? `${signed((row.close - row.open) * 100, 1)} bp` : `${signed((row.close / row.open - 1) * 100)}%`;
  const time = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(!['1d', '1w'].includes(interval) ? { hour: '2-digit' as const, minute: '2-digit' as const, hour12: false } : {}),
  }).format(new Date(row.time * 1000));
  const unit = isYield ? '%' : 'USD';
  tooltip.innerHTML = `<div class="tooltip-heading"><strong>${asset().symbol}</strong><span>${intervalLabels[interval]}</span></div>
    <time>${time}</time><dl>${(['open', 'high', 'low', 'close'] as const).map((key, i) =>
      `<dt>${['开盘价', '最高价', '最低价', '收盘价'][i]}</dt><dd class="${key === 'close' ? up ? 'positive' : 'negative' : ''}">${fmt(row[key], isYield)} <small>${unit}</small></dd>`).join('')}
      <dt>本根涨跌</dt><dd class="${up ? 'positive' : 'negative'}">${change}</dd>
      ${row.volume != null ? `<dt>成交量</dt><dd>${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(row.volume)} <small>${asset().kind === 'crypto' ? selected.toUpperCase() : '手'}</small></dd>` : ''}</dl>
    <div class="tooltip-hint">${pinnedCandle ? `${svg('pin', 11)} 已固定 · Esc 取消` : '点击固定这根 K 线'}</div>`;
  tooltip.classList.toggle('is-pinned', pinnedCandle);
  tooltip.hidden = false;
  const gap = 18, padding = 8;
  let left = x + gap, top = y + gap;
  if (left + tooltip.offsetWidth > chartElement.clientWidth - padding) left = x - tooltip.offsetWidth - gap;
  if (top + tooltip.offsetHeight > chartElement.clientHeight - padding) top = y - tooltip.offsetHeight - gap;
  tooltip.style.left = `${Math.max(padding, Math.min(left, chartElement.clientWidth - tooltip.offsetWidth - padding))}px`;
  tooltip.style.top = `${Math.max(padding, Math.min(top, chartElement.clientHeight - tooltip.offsetHeight - padding))}px`;
}

function inspectCandle(param: MouseEventParams, pin: boolean) {
  const point = param.point;
  if (!point || param.time == null || point.x < 0 || point.y < 0) {
    clearInspection();
    renderOHLC(history?.candles.at(-1));
    return;
  }
  const row = history?.candles.find(c => c.time === param.time);
  if (!row) { clearInspection(); renderOHLC(history?.candles.at(-1)); return; }
  const wasPinned = pinnedCandle && inspectedTime === row.time;
  inspectedTime = row.time;
  pinnedCandle = pin && !wasPinned;
  // Use the price pane's coordinate when inspecting the volume pane.
  tooltipPoint = { x: point.x, y: param.paneIndex ? candles.priceToCoordinate(row.close) ?? point.y : point.y };
  renderInspection();
}

function clearChart() {
  clearInspection();
  [candles, area, ma20, ma50, volume].forEach(series => series.setData([]));
  byId('history-range').textContent = '';
  renderOHLC();
}

function chartState(message?: string, error = false) {
  const state = byId('chart-state');
  state.hidden = !message;
  if (!message) return;
  state.innerHTML = error
    ? `<span class="state-symbol">${svg('pulse', 28)}</span><strong></strong><button class="retry-button">重新获取</button>`
    : '<span class="spinner"></span><strong></strong><span>获取真实历史行情</span>';
  state.querySelector('strong')!.textContent = message;
  state.querySelector('button')?.addEventListener('click', () => { void loadHistory(true); });
}

async function loadHistory(force = false, quiet = false) {
  if (observing()) return;
  const request = ++historyRequest;
  lastHistoryRequestAt = Date.now();
  const targetAsset = selected, targetInterval = interval;
  loading = true;
  const preserving = quiet && history?.asset === selected && history?.interval === interval;
  if (!preserving) {
    history = undefined;
    clearChart();
    chartState('正在获取历史行情');
  }
  historyError = undefined;
  renderNotice();
  try {
    const result = await native<History>('history', { asset: targetAsset, interval: targetInterval, force });
    if (request !== historyRequest) return;
    history = result;
    const range = preserving ? chart.timeScale().getVisibleLogicalRange() : null;
    candles.setData(result.candles);
    area.setData(result.candles.map(c => ({ time: c.time, value: c.close })));
    ma20.setData(movingAverage(result.candles, 20));
    ma50.setData(movingAverage(result.candles, 50));
    volume.setData(result.candles.filter(c => c.volume != null).map(c => ({ time: c.time, value: c.volume!, color: c.close >= c.open ? '#65d6bd50' : '#ff8e9950' })));
    updateIndicators();
    chartState();
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    else resetView();
    renderInspection();
    byId('history-range').textContent = `${historyDate(result.candles[0].time)} — ${historyDate(result.candles.at(-1)!.time)} · ${result.candles.length} 根${result.cached ? ' · 缓存' : ''}`;
  } catch (error) {
    if (request !== historyRequest) return;
    const message = error instanceof Error ? error.message : '无法获取行情，请重试。';
    if (preserving) historyError = message + ' 当前保留上次图表。';
    else chartState(message, true);
  } finally {
    if (request === historyRequest) { loading = false; renderNotice(); }
  }
}

function resetView() {
  if (!history) return;
  const length = history.candles.length;
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(-1, length - 95), to: length + 5 });
  chart.priceScale('right').applyOptions({ autoScale: true });
}

chart.subscribeCrosshairMove(param => {
  if (!pinnedCandle) inspectCandle(param, false);
});
chart.subscribeClick(param => inspectCandle(param, true));
chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
  if (pinnedCandle) renderInspection();
});
byId('chart').addEventListener('pointerleave', () => {
  if (!pinnedCandle) { clearInspection(); renderOHLC(history?.candles.at(-1)); }
});

function selectAsset(id: AssetID) {
  if (observing()) return;
  if (selected === id) return;
  selected = id;
  if (asset().kind === 'yield' && !['1d', '1w'].includes(interval)) interval = '1d';
  persist('asset', selected);
  persist('interval', interval);
  renderSelection();
  void loadHistory();
}
document.querySelectorAll<HTMLButtonElement>('[data-asset]').forEach(button => button.addEventListener('click', () => selectAsset(button.dataset.asset as AssetID)));
document.querySelectorAll<HTMLButtonElement>('[data-interval]').forEach(button => button.addEventListener('click', () => {
  if (interval === button.dataset.interval) return;
  interval = button.dataset.interval as Interval;
  persist('interval', interval);
  renderSelection();
  void loadHistory();
}));
byId('sma20').addEventListener('click', () => { sma20 = !sma20; persist('sma20', sma20); updateIndicators(); });
byId('sma50').addEventListener('click', () => { sma50 = !sma50; persist('sma50', sma50); updateIndicators(); });
byId('volume').addEventListener('click', () => { showVolume = !showVolume; persist('volume', showVolume); updateIndicators(); });
byId('reset').addEventListener('click', resetView);
for (const style of ['candles', 'area'] as const) byId(`style-${style}`).addEventListener('click', () => {
  chartStyle = style;
  candles.applyOptions({ visible: chartStyle === 'candles' });
  area.applyOptions({ visible: chartStyle === 'area', lastValueVisible: chartStyle === 'area', priceLineVisible: chartStyle === 'area' });
  byId('style-candles').setAttribute('aria-pressed', String(chartStyle === 'candles'));
  byId('style-area').setAttribute('aria-pressed', String(chartStyle === 'area'));
});

async function refresh() {
  if (isRefreshing) return;
  isRefreshing = true;
  byId('refresh').classList.add('refreshing');
  byId<HTMLButtonElement>('refresh').disabled = true;
  await Promise.allSettled([
    native<Snapshot>('refresh').then(value => { snapshot = value; renderQuotes(); }).catch(error => { historyError = error.message; renderNotice(); }),
    observing() ? research.refresh(true) : loadHistory(true, true),
  ]);
  byId('refresh').classList.remove('refreshing');
  byId<HTMLButtonElement>('refresh').disabled = false;
  isRefreshing = false;
}
byId('refresh').addEventListener('click', () => { void refresh(); });
byId('close').addEventListener('click', () => { void native('close').catch(() => {}); });
byId('pin').addEventListener('click', async () => {
  try {
    preferences = await native<Preferences>('preferences', { pinned: !preferences.pinned });
    byId('pin').setAttribute('aria-pressed', String(preferences.pinned));
    byId('pin').title = preferences.pinned ? '取消保持弹窗' : '保持弹窗打开';
  } catch (error) { historyError = String(error); renderNotice(); }
});
const settings = byId<HTMLDialogElement>('settings');
function renderLoginItem() {
  const toggle = byId<HTMLInputElement>('launch-at-login');
  toggle.disabled = loginItemBusy || !loginItem || loginItem.status === 'unavailable';
  toggle.checked = loginItem?.status === 'enabled' || loginItem?.status === 'requiresApproval';
  const labels: Record<LoginItemState['status'], string> = {
    enabled: '已开启。下次登录后常驻菜单栏，行情弹窗保持关闭。',
    notRegistered: '未开启。启用后由 macOS 管理，可随时关闭。',
    requiresApproval: '等待系统允许。请在“登录项与扩展”中允许 Crypto Monitor。',
    notFound: '系统未找到登录项。请将应用放入“应用程序”后重新打开，再开启。',
    unavailable: '暂时无法读取系统登录项，请稍后重试。',
  };
  byId('startup-status').textContent = loginItemBusy ? '正在更新系统登录项…' : loginItem?.error ?? (loginItem ? labels[loginItem.status] : '正在读取系统登录项…');
  byId('startup-status').classList.toggle('has-error', !!loginItem?.error || loginItem?.status === 'requiresApproval');
  byId('login-system-settings').hidden = !loginItem || (!loginItem.error && !['enabled', 'requiresApproval', 'notFound'].includes(loginItem.status));
}
async function refreshLoginItem() {
  if (loginItemBusy) return;
  try {
    loginItem = await native<LoginItemState>('loginItemStatus');
  } catch {
    loginItem = { status: 'unavailable', error: '无法读取系统登录项，请重新打开设置。' };
  }
  renderLoginItem();
}
byId('launch-at-login').addEventListener('change', async () => {
  if (loginItemBusy) return;
  const enabled = byId<HTMLInputElement>('launch-at-login').checked;
  loginItemBusy = true;
  renderLoginItem();
  try {
    loginItem = await native<LoginItemState>('setLaunchAtLogin', { enabled });
  } catch {
    loginItem = { status: 'unavailable', error: '登录项更新结果暂未确认，请重新打开设置查看。' };
  } finally {
    loginItemBusy = false;
    renderLoginItem();
  }
});
byId('login-system-settings').addEventListener('click', () => {
  void native('openLoginItemSettings').catch(() => {
    byId('startup-status').textContent = '请手动打开“系统设置 → 通用 → 登录项与扩展”。';
  });
});
byId('settings-open').addEventListener('click', () => {
  document.querySelectorAll<HTMLInputElement>('[name="menu-asset"]').forEach(input => { input.checked = preferences.menuAssets.includes(input.value as AssetID); });
  settings.showModal();
  renderLoginItem();
  void refreshLoginItem();
});
byId('settings-close').addEventListener('click', () => settings.close());
settings.addEventListener('click', event => { if (event.target === settings) settings.close(); });
document.querySelectorAll<HTMLInputElement>('[name="menu-asset"]').forEach(input => input.addEventListener('change', async () => {
  const inputs = [...document.querySelectorAll<HTMLInputElement>('[name="menu-asset"]')];
  const menuAssets = inputs.filter(item => item.checked).map(item => item.value);
  if (!menuAssets.length) { input.checked = true; byId('settings-feedback').textContent = '请至少保留一个菜单栏品种。'; return; }
  inputs.forEach(item => { item.disabled = true; });
  try {
    preferences = await native<Preferences>('preferences', { menuAssets });
    byId('settings-feedback').textContent = '已保存，菜单栏已更新。';
  } catch {
    inputs.forEach(item => { item.checked = preferences.menuAssets.includes(item.value as AssetID); });
    byId('settings-feedback').textContent = '保存失败，请重试。';
  } finally { inputs.forEach(item => { item.disabled = false; }); }
}));
byId('quit').addEventListener('click', () => { void native('quit').catch(() => {}); });
function handleEscape() {
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
  if (dialog) { dialog.close(); return; }
  const input = document.activeElement as HTMLElement | null;
  if (input?.matches('input, select, textarea')) { input.blur(); return; }
  if (observing()) {
    if (!research.clearInspection()) returnToMarket();
  } else if (pinnedCandle) { clearInspection(); renderOHLC(history?.candles.at(-1)); }
  else void native('close').catch(() => {});
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); handleEscape(); return; }
  if (settings.open || research.hasDialog() || (event.target as HTMLElement).matches('input, select, textarea')) return;
  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    if ('12345'.includes(event.key) && event.key.length === 1) selectAsset(assets[Number(event.key) - 1].id);
    if (event.key.toLowerCase() === 'r') void refresh();
  }
});

renderSelection();
void native<{ snapshot: Snapshot; preferences: Preferences; visible: boolean; tradingViewSymbols: Record<AssetID, string>; loginItem: LoginItemState }>('ready').then(value => {
  bridgeReady = true;
  snapshot = value.snapshot;
  preferences = value.preferences;
  visible = value.visible;
  tradingViewSymbols = value.tradingViewSymbols;
  loginItem = value.loginItem;
  renderLoginItem();
  renderSelection();
  return loadHistory();
}).catch(error => { chartState(error.message, true); byId('connection').innerHTML = '<i></i>等待原生应用'; });
setInterval(() => {
  if (visible && observing()) { research.tick(); return; }
  const refreshEvery = interval === '1m' ? 15000 : 60000;
  if (visible && !loading && Date.now() - lastHistoryRequestAt >= refreshEvery) void loadHistory(false, true);
}, 15000);
