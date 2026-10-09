import { createChart, CandlestickSeries, LineSeries, HistogramSeries, ColorType, CrosshairMode,
  type IChartApi, type ISeriesApi, type SeriesType, type Time, type UTCTimestamp, type MouseEventParams } from 'lightweight-charts';
import { type ResearchPeriod, type Dataset, type Anchor, type ValuePoint,
  DAY, seconds, utcDate, utcTime, anchorTime, closed, anchoredFlow, relativeReturns, atr14, fundingTotal, stale,
  type SummaryID, summaryRequests } from './research-model';
import { ResearchStore, researchKey, type Native } from './research-store';
import { metricDetailHTML } from './market-summary';

type Tab = 'trend' | 'leverage' | 'flow' | 'risk';
const titles: Record<Tab, string> = { trend: '趋势与强弱', leverage: '杠杆与费率', flow: '主动成交', risk: '波动风险' };
const names: Record<Dataset, string> = { perpetual: 'ETH 永续 K 线', spot: 'ETH 现货成交', bitcoin: 'BTC 现货 K 线', ratio: 'ETH/BTC 现货', interest: 'ETH 永续 OI', funding: 'ETH 永续资金费', reference: '标记价 / 指数价' };
const periods: Record<ResearchPeriod, string> = { '1h': '1 小时', '4h': '4 小时', '1d': '日线' };
const n = (value?: number, digits = 2) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const compact = (value?: number) => value == null ? '—' : Math.abs(value) >= 1e6 ? `${n(value / 1e6, 2)}M` : Math.abs(value) >= 1e3 ? `${n(value / 1e3, 1)}K` : n(value, 1);
const signed = (value?: number, digits = 2) => value == null ? '—' : `${value >= 0 ? '+' : '−'}${n(Math.abs(value), digits)}`;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const save = (key: string, value: unknown) => { try { localStorage.setItem(`research-${key}`, JSON.stringify(value)); } catch { /* Preferences are optional. */ } };
function read<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(`research-${key}`) || 'null') ?? fallback; } catch { return fallback; } }

export class ResearchView {
  private chart: IChartApi;
  private price: ISeriesApi<'Candlestick'>;
  private auxiliary: ISeriesApi<SeriesType>[] = [];
  private inspected = new Map<string, Map<number, number>>();
  private get errors() { return this.store.errors; }
  private get pending() { return this.store.pending; }
  private focusedMetric?: SummaryID;
  private updateFrame = 0;
  private active = false;
  private displayed = '';
  private tab: Tab = read('tab', 'trend');
  private period: ResearchPeriod = read('period', '4h');
  private anchor: Anchor = read('anchor', { mode: '30', date: '' });
  private flowMode: 'cvd' | 'volume' = 'cvd';
  private pinnedTime?: UTCTimestamp;
  private lastTick = 0;
  private renderFrame = 0;
  private rendering = false;

  constructor(private root: HTMLElement, private native: Native, private store: ResearchStore, private status: (text: string, time: string, stale: boolean, period: ResearchPeriod) => void) {
    if (!(this.tab in titles)) this.tab = 'trend';
    if (!(this.period in periods)) this.period = '4h';
    if (!['7', '30', 'manual'].includes(this.anchor.mode) || (this.anchor.mode === 'manual' && !this.validDate(this.anchor.date))) this.anchor = { mode: '30', date: '' };
    this.root.innerHTML = `
      <section class="research-heading"><div><div class="research-eyebrow">ETH OBSERVATORY <span>趋势观察</span></div><div class="research-price"><strong data-r="price">—</strong><span>USDT</span><small>Binance · ETHUSDT 永续成交价</small></div></div><div class="research-reference" data-r="reference">标记价 —<br>指数价 —</div></section>
      <div class="research-navigation"><div class="research-tabs" role="group" aria-label="观察指标">${Object.entries(titles).map(([key, title]) => `<button data-tab="${key}">${title}</button>`).join('')}</div><div class="intervals" role="group" aria-label="观察周期">${Object.entries(periods).map(([key, title]) => `<button data-period="${key}">${title}</button>`).join('')}</div></div>
      <div class="research-anchor"><span>本轮观察起点</span><div class="anchor-presets" role="group" aria-label="观察起点"><button data-anchor="7">近 7 天</button><button data-anchor="30">近 30 天</button><button data-anchor="manual">手动日期</button></div><input data-r="date" type="date" aria-label="手动观察起点，UTC 日期" hidden><span data-r="anchor-caption" class="anchor-caption"></span><button data-r="reset" class="research-text-button" title="回到观察窗口">重置视图</button></div>
      <div class="research-stats" data-r="stats" aria-live="polite"></div>
      <div class="research-focus" data-r="focus" hidden aria-live="polite"></div>
      <div class="research-chart-head"><span data-r="ohlc">ETHUSDT · 永续成交 K 线</span><button data-r="flow-mode" class="research-text-button" hidden>改看主动买卖量</button><button data-r="scenario" class="research-text-button" hidden>资金费情景 ↗</button></div>
      <div class="research-chart-region"><div class="research-chart" data-r="chart" aria-label="ETH 价格与联动指标图，拖动平移、滚轮缩放"></div><div class="research-pane-labels" data-r="pane-labels" aria-hidden="true"></div><div class="chart-state" data-r="state"><span class="spinner"></span><strong>正在读取观察数据</strong></div><div class="chart-tooltip research-tooltip" data-r="tooltip" hidden></div></div>
      <div class="research-caption"><span data-r="interpretation"></span><button data-r="details" class="research-text-button">数据口径 ↗</button><button data-r="distributions" class="research-text-button">三类分布 ↗</button></div>
      <div class="research-coverage" data-r="coverage" role="status"></div>
      <dialog class="research-dialog" data-r="dialog"><div class="dialog-heading"><div><h2 data-r="dialog-title"></h2><p>市场参考 · 不代表你的账户仓位</p></div><button data-r="dialog-close" class="icon-button" aria-label="关闭详情">✕</button></div><div data-r="dialog-content"></div></dialog>`;
    this.chart = createChart(this.el('chart'), {
      autoSize: true, layout: { background: { type: ColorType.Solid, color: '#142335' }, textColor: '#9fb1c5', fontSize: 10, attributionLogo: true,
        panes: { separatorColor: '#344960', separatorHoverColor: '#7eb3ff', enableResize: true } },
      grid: { vertLines: { visible: false }, horzLines: { color: '#203146', style: 1 } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#7e96af', style: 2 }, horzLine: { color: '#7e96af', style: 2 } },
      rightPriceScale: { borderVisible: false, minimumWidth: 82, scaleMargins: { top: .15, bottom: .12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3, minBarSpacing: .4 },
      localization: { locale: 'zh-CN', timeFormatter: (time: Time) => typeof time === 'number' ? `${utcTime(time)} UTC` : String(time) },
    });
    this.price = this.chart.addSeries(CandlestickSeries, { upColor: '#65d6bd', downColor: '#ff8e99', borderVisible: false, wickUpColor: '#65d6bd', wickDownColor: '#ff8e99' });
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.onclick = () => {
      this.focusedMetric = undefined; this.tab = button.dataset.tab as Tab; save('tab', this.tab); this.clearInspection(); this.render(); void this.refresh();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-period]').forEach(button => button.onclick = () => {
      if (this.period === button.dataset.period) return;
      this.period = button.dataset.period as ResearchPeriod; save('period', this.period); this.displayed = ''; this.clearInspection();
      this.context(); this.render(); void this.refresh();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-anchor]').forEach(button => button.onclick = () => {
      const previousStart = utcDate(anchorTime(this.anchor));
      this.anchor.mode = button.dataset.anchor as Anchor['mode'];
      if (this.anchor.mode === 'manual' && !this.validDate(this.anchor.date)) this.anchor.date = previousStart;
      save('anchor', this.anchor); this.clearInspection(); this.render(); this.reset();
      if (this.anchor.mode === 'manual') this.el<HTMLInputElement>('date').focus();
    });
    this.el<HTMLInputElement>('date').onchange = () => {
      const input = this.el<HTMLInputElement>('date');
      if (!this.validDate(input.value)) { input.setCustomValidity('请选择不晚于今天的有效日期。'); input.reportValidity(); return; }
      input.setCustomValidity(''); this.anchor = { mode: 'manual', date: input.value }; save('anchor', this.anchor); this.clearInspection(); this.render(); this.reset();
    };
    this.el('reset').onclick = () => this.reset();
    this.el('flow-mode').onclick = () => { this.flowMode = this.flowMode === 'cvd' ? 'volume' : 'cvd'; this.clearInspection(); this.render(); };
    this.el('details').onclick = () => this.showDetails();
    this.el('distributions').onclick = () => this.showDistributions();
    this.el('scenario').onclick = () => this.showScenario();
    this.el('dialog-close').onclick = () => this.el<HTMLDialogElement>('dialog').close();
    this.el('dialog').onclick = event => { if (event.target === this.el('dialog')) this.el<HTMLDialogElement>('dialog').close(); };
    this.chart.subscribeCrosshairMove(param => { if (!this.pinnedTime) this.inspect(param); });
    this.chart.subscribeClick(param => {
      if (typeof param.time !== 'number') return;
      if (this.pinnedTime === param.time) { this.clearInspection(); return; }
      this.pinnedTime = param.time; this.inspect(param);
    });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (!this.rendering) this.clearInspection(); });
    this.chart.timeScale().subscribeSizeChange(() => requestAnimationFrame(() => this.positionLabels()));
    this.el('chart').onpointerleave = () => { if (!this.pinnedTime) this.clearInspection(); };
    this.el('chart').addEventListener('pointermove', event => { if (event.buttons) this.positionLabels(); });
    new ResizeObserver(() => this.positionLabels()).observe(this.el('chart'));
    this.store.subscribe(key => {
      if (!this.active) return;
      if (this.needed().some(([d, p]) => this.key(d, p) === key)) {
        cancelAnimationFrame(this.updateFrame);
        this.updateFrame = requestAnimationFrame(() => this.render());
      } else this.renderFocus();
    });
  }

  private el<T extends HTMLElement = HTMLElement>(name: string) { return this.root.querySelector(`[data-r="${name}"]`) as T; }
  private validDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && utcDate(Date.parse(value) / 1000) === value && value <= utcDate(); }
  private key(dataset: Dataset, period = this.period) { return researchKey(dataset, period); }
  private data(dataset: Dataset, period = this.period) { return this.store.data(dataset, period); }
  private needed(): [Dataset, ResearchPeriod][] {
    const items: [Dataset, ResearchPeriod][] = [['perpetual', this.period], ['perpetual', '1d'], ['reference', this.period]];
    if (this.tab === 'trend') items.push(['spot', this.period], ['bitcoin', this.period], ['ratio', this.period]);
    if (this.tab === 'leverage') items.push(['interest', this.period], ['funding', this.period]);
    if (this.tab === 'flow') items.push(['spot', this.period]);
    return items.filter(([d, p], i) => items.findIndex(([other, period]) => this.key(d, p) === this.key(other, period)) === i);
  }
  private context() { if (this.active) void this.native('researchContext', { active: true, interval: this.period }).catch(() => {}); }
  openMetric(id?: SummaryID) {
    this.focusedMetric = id;
    if (id) {
      this.tab = ({ ratio: 'trend', interest: 'leverage', funding: 'leverage', flow: 'flow', risk: 'risk' } as const)[id];
      save('tab', this.tab);
      if (id === 'flow') this.flowMode = 'volume';
    }
  }
  private renderFocus() {
    const focus = this.el('focus');
    focus.hidden = !this.focusedMetric; this.el('stats').hidden = !!this.focusedMetric;
    if (!this.focusedMetric) return;
    const restoreFocus = focus.contains(document.activeElement);
    focus.innerHTML = metricDetailHTML(this.store, this.focusedMetric);
    const button = focus.querySelector<HTMLButtonElement>('[data-clear-focus]')!;
    if (restoreFocus) button.focus();
    button.onclick = () => {
      this.focusedMetric = undefined; this.render();
      this.root.querySelector<HTMLButtonElement>(`[data-tab="${this.tab}"]`)?.focus();
    };
  }
  private requests() {
    const items = [...this.needed(), ...(this.focusedMetric ? summaryRequests[this.focusedMetric] : [])];
    return items.filter(([d, p], i) => items.findIndex(([other, period]) => this.key(d, p) === this.key(other, period)) === i);
  }
  setActive(active: boolean) {
    const changed = this.active !== active;
    this.active = active; this.root.hidden = !active;
    if (active) { this.context(); this.render(); if (changed) void this.refresh(); }
    else if (changed) { this.clearInspection(); this.el<HTMLDialogElement>('dialog').close(); void this.native('researchContext', { active: false }).catch(() => {}); }
  }
  tick(force = false) {
    if (this.active && (force || Date.now() - this.lastTick >= 60000)) { this.lastTick = Date.now(); void this.refresh(); }
  }
  async refresh(force = false) {
    if (!this.active) return;
    await this.store.ensure(this.requests(), force);
    if (this.active) this.render();
  }
  private stat(label: string, value: string, hint: string, accent = '') { return `<div><span>${label}</span><strong class="${accent}">${value}</strong><small>${hint}</small></div>`; }

  private render() {
    if (!this.active) return;
    cancelAnimationFrame(this.renderFrame);
    this.rendering = true;
    const anchor = anchorTime(this.anchor), step = seconds[this.period];
    const price = this.data('perpetual'), last = price?.bars.at(-1), reference = this.data('reference');
    this.el('price').textContent = n(last?.close);
    this.el('reference').innerHTML = `标记价 <b>${n(reference?.reference?.mark)}</b><br>指数价 <b>${n(reference?.reference?.index)}</b>${stale(reference) ? '<span>参考快照未更新</span>' : ''}`;
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === this.tab)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-period]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.period === this.period)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-anchor]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.anchor === this.anchor.mode)));
    const date = this.el<HTMLInputElement>('date');
    date.hidden = this.anchor.mode !== 'manual'; date.max = utcDate(); date.value = this.anchor.date;
    this.el('anchor-caption').textContent = `${utcDate(anchor)} UTC · ${this.anchor.mode === 'manual' ? '固定起点' : '每日滚动'}`;
    this.el('flow-mode').hidden = this.tab !== 'flow';
    this.el('flow-mode').textContent = this.flowMode === 'cvd' ? '改看主动买卖量' : '改看累计 CVD';
    this.el('scenario').hidden = this.tab !== 'leverage';
    const atr = atr14(this.data('perpetual', '1d')), atrLast = atr.at(-1), dayLast = closed(this.data('perpetual', '1d')).at(-1);
    const atrCurrent = atrLast?.time === dayLast?.time ? atrLast?.value : undefined;
    const atrPercent = atrCurrent != null && dayLast ? atrCurrent / dayLast.close * 100 : undefined;
    const issues: string[] = [];
    const needed = this.needed();
    for (const [dataset, period] of needed) {
      const series = this.data(dataset, period), key = this.key(dataset, period);
      if (this.errors.has(key)) issues.push(`${names[dataset]}：${this.errors.get(key)}`);
      else if (series?.warning) issues.push(`${names[dataset]}：${series.warning}`);
      else if (series && stale(series)) issues.push(`${names[dataset]} 为缓存，获取于 ${utcTime(series.fetchedAt)} UTC`);
    }
    const range = this.chart.timeScale().getVisibleRange();
    const identity = `${this.period}:${anchor}`;
    const preserve = identity === this.displayed;
    this.clearAuxiliary();
    this.price.setData(price?.bars ?? []);
    this.chart.applyOptions({ timeScale: { timeVisible: this.period !== '1d' } });
    const labels: string[] = ['ETHUSDT 永续 · 成交价格 / USDT'];
    let stats = '', interpretation = '';
    if (this.tab === 'trend') {
      const relative = relativeReturns(this.data('spot'), this.data('bitcoin'), anchor);
      const ratio = closed(this.data('ratio'));
      this.line(1, 'ETH/BTC · BTC', ratio.map(b => ({ time: b.time, value: b.close })), '#adbbff', 6);
      this.line(2, 'ETH 现货涨幅 %', relative.eth, '#65d6bd', 2);
      this.line(2, 'BTC 现货涨幅 %', relative.btc, '#edbb76', 2);
      labels.push('ETH/BTC 现货 · BTC / ETH', '本轮现货涨幅 · ETH 青 / BTC 金 · %');
      stats = this.stat('ETH/BTC', n(ratio.at(-1)?.close, 5), '直接现货交易对', 'lavender')
        + this.stat('本轮 ETH / BTC 涨幅', `${signed(relative.eth.at(-1)?.value)} / ${signed(relative.btc.at(-1)?.value)}%`, '相同起点 · 各自现货开盘价为基准')
        + this.stat('日线 ATR 14', `${n(atrCurrent)} USDT`, `占收盘价 ${n(atrPercent)}%`);
      interpretation = 'ETH/BTC 上行表示 ETH 相对走强；涨幅比较只使用双方都有的已收盘周期。';
      if (relative.partial) issues.push(`相对涨幅仅从 ${utcDate(relative.start!)} 开始，早于此日的数据未覆盖。`);
    } else if (this.tab === 'leverage') {
      const oi = this.data('interest'), points = oi?.points ?? [], oiLast = points.at(-1), prev = points.at(-2);
      const delta = oiLast && prev && Math.abs(oiLast.time - prev.time - step) < 2 ? oiLast.value - prev.value : undefined;
      this.line(1, 'OI · ETH', points.map(p => ({ time: Math.floor(p.time) as UTCTimestamp, value: p.value })), '#a5b5ff', 0, step);
      const funding = this.data('funding');
      const buckets = new Map<number, number>();
      for (const point of funding?.points ?? []) { const time = Math.floor(point.time / step) * step; buckets.set(time, (buckets.get(time) ?? 0) + point.value * 100); }
      this.histogram(2, '已结算费率合计 %', [...buckets].map(([time, value]) => ({ time: time as UTCTimestamp, value })), '#65d6bd', '#ff8e99', 4);
      labels.push('未平仓量 OI · ETH · 期末存量', `已结算资金费率 · ${periods[this.period]}内合计 / %`);
      const seven = fundingTotal(funding, 7), thirty = fundingTotal(funding, 30);
      stats = this.stat('OI / 较上期', `${compact(oiLast?.value)} ETH`, `${signed(delta, 0)} ETH · 增加不代表净多头`)
        + this.stat('7 天 / 30 天已结算', `${signed(seven.value, 3)} / ${signed(thirty.value, 3)}%`, `${seven.count} / ${thirty.count} 次记录${seven.partial || thirty.partial ? ' · 覆盖不足' : ' · 固定名义本金口径'}`)
        + this.stat('8 小时等效费率', `${signed(seven.partial || seven.value == null ? undefined : seven.value / 21, 4)}%`, '7 天实际合计 ÷ 21 · 非下一期预测');
      interpretation = `下一期参考 ${signed(reference?.reference ? reference.reference.rate * 100 : undefined, 4)}%（未结算） · 正费率通常由多头支付。`;
      if (points.length && points[0].time > anchor) issues.push(`OI 起于 ${utcDate(points[0].time)}，所选起点之前无法回补；已积累的本地历史会保留。`);
      if (points.some((p, i) => i > 0 && p.time - points[i - 1].time > step + 2)) issues.push('OI 历史存在缺口；图上断开，缺失不视为零。');
      if (seven.partial || thirty.partial) issues.push('资金费累计仅为已返回记录之和，部分窗口覆盖不足或存在可疑间隔，详见数据口径。');
    } else if (this.tab === 'flow') {
      const spot = anchoredFlow(this.data('spot'), anchor, step), perp = anchoredFlow(price, anchor, step);
      for (const [pane, data, flow, color, name] of [[1, this.data('spot'), spot, '#7eb3ff', '现货'], [2, price, perp, '#a5b5ff', '永续']] as const) {
        if (this.flowMode === 'cvd') this.line(pane, `${name} CVD · ETH`, flow.values, color, 0);
        else {
          const bars = closed(data).filter(b => b.time >= anchor);
          this.histogram(pane, `${name}主动买入 · ETH`, bars.map(b => ({ time: b.time, value: b.takerBuy })), '#65d6bd80', '#65d6bd80');
          this.histogram(pane, `${name}主动卖出 · ETH`, bars.map(b => ({ time: b.time, value: -(b.volume - b.takerBuy) })), '#ff8e9980', '#ff8e9980');
        }
        labels.push(`${name} ETHUSDT · ${this.flowMode === 'cvd' ? '累计 CVD' : '主动买 ↑ / 主动卖 ↓'} · ETH`);
        if (flow.partial) issues.push(`${name} CVD 只能从 ${utcDate(flow.start!)} 累计；早期历史未覆盖。`);
        if (flow.gap) issues.push(`${name} CVD 在 ${utcTime(flow.end!)} 后遇到缺口，累计已停止。`);
      }
      stats = this.stat('本轮现货主动买入占比', `${n(spot.share)}%`, `买卖比 ${n(spot.ratio, 3)} · 量 ${compact(spot.buy)} / ${compact(spot.sell)} ETH`, 'blue')
        + this.stat('本轮永续主动买入占比', `${n(perp.share)}%`, `买卖比 ${n(perp.ratio, 3)} · 量 ${compact(perp.buy)} / ${compact(perp.sell)} ETH`, 'lavender')
        + this.stat('本轮 CVD · 现货 / 永续', `${compact(spot.values.at(-1)?.value)} / ${compact(perp.values.at(-1)?.value)}`, 'ETH · 主动买入 − 主动卖出');
      interpretation = '现货与永续各自累计；来自主动成交方向，与盘口挂单及 K 线涨跌颜色无关。';
    } else {
      this.line(1, '日线 ATR 14 · USDT', atr, '#edbb76', 2, DAY);
      labels.push('日线 ATR 14 · Wilder 平滑 · USDT');
      const previous = atr.at(-2);
      stats = this.stat('日线 ATR 14', `${n(atrCurrent)} USDT`, dayLast ? `截至 ${utcDate(dayLast.time)} 已收盘日线` : '等待日线数据', 'gold')
        + this.stat('ATR / 收盘价', `${n(atrPercent)}%`, '波动幅度相对当前价格')
        + this.stat('较上一日 ATR', `${signed(atrCurrent != null && previous && atrLast!.time - previous.time === DAY ? atrCurrent - previous.value : undefined)} USDT`, '波动扩大或收缩 · 不表示方向');
      interpretation = 'ATR 衡量已发生的日线波动，不是止损建议，也不表示未来最大亏损。';
    }
    this.el('stats').innerHTML = stats;
    this.renderFocus();
    this.el('interpretation').textContent = interpretation;
    const focusedPanes = this.focusedMetric === 'flow' ? [1, 2] : this.focusedMetric === 'funding' ? [2] : this.focusedMetric ? [1] : [];
    this.el('pane-labels').innerHTML = labels.map((label, i) => `<span class="${focusedPanes.includes(i) ? 'is-focused' : ''}">${focusedPanes.includes(i) ? '当前关注 · ' : ''}${label}</span>`).join('');
    this.chart.panes().forEach((pane, i) => pane.setStretchFactor(i === 0 ? (this.tab === 'risk' ? 3 : 2.7) : 1));
    this.el('state').hidden = !!last;
    if (!last) {
      const reason = this.errors.get(this.key('perpetual'));
      this.el('state').innerHTML = reason ? `<strong>${escape(reason)}</strong><button class="retry-button">重新获取</button>` : '<span class="spinner"></span><strong>正在读取 ETH 永续历史</strong>';
      this.el('state').querySelector('button')?.addEventListener('click', () => { void this.refresh(true); });
    }
    this.renderFrame = requestAnimationFrame(() => {
      if (preserve && range && last) this.chart.timeScale().setVisibleRange(range);
      else if (last) { this.displayed = identity; this.reset(); }
      requestAnimationFrame(() => { this.positionLabels(); this.rendering = false; });
    });
    const loading = needed.some(([d, p]) => this.pending.has(this.key(d, p)));
    const absent = needed.filter(([d, p]) => !this.data(d, p)).map(([d]) => names[d]);
    const coverage = price?.bars.length ? `价格历史 ${utcDate(price.bars[0].time)} — ${utcDate(last!.time)}` : '尚无可用价格历史';
    const noClosed = !closed(price).some(b => b.time >= anchor);
    if (noClosed && price) issues.push('所选起点之后尚无已收盘 K 线，累计指标暂不显示。');
    this.el('coverage').textContent = `${loading ? '更新中 · ' : ''}${issues.length ? issues.join(' ') : absent.length ? `等待：${absent.join('、')}` : `${coverage} · UTC · 累计指标仅用已收盘数据`}`;
    this.el('coverage').classList.toggle('has-warning', issues.length > 0);
    this.el('coverage').title = this.el('coverage').textContent ?? '';
    const staleData = needed.some(([d, p]) => stale(this.data(d, p)) || this.errors.has(this.key(d, p)));
    this.status('Binance · ETHUSDT 永续参考', price ? `${staleData ? '部分未更新 · ' : ''}${utcTime(price.fetchedAt).slice(11)} UTC 获取` : '等待数据', staleData, this.period);
    this.el('ohlc').textContent = last ? `${utcTime(last.time)} UTC　开 ${n(last.open)}　高 ${n(last.high)}　低 ${n(last.low)}　收 ${n(last.close)}${last.endTime >= price!.fetchedAt ? ' · 未收盘' : ''}` : 'ETHUSDT · 永续成交 K 线';
  }

  private clearAuxiliary() {
    for (const series of this.auxiliary.reverse()) this.chart.removeSeries(series);
    this.auxiliary = []; this.inspected.clear();
  }
  private line(pane: number, name: string, values: ValuePoint[], color: string, digits: number, step = seconds[this.period]) {
    // Lightweight Charts connects line-series whitespace; separate segments keep gaps visible.
    const segments: ValuePoint[][] = [[]];
    values.forEach((value, i) => {
      if (i > 0 && value.time - values[i - 1].time > step + 2) segments.push([]);
      segments.at(-1)!.push(value);
    });
    for (const segment of segments) {
      const series = this.chart.addSeries(LineSeries, { color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: segment.length === 1,
        priceFormat: { type: 'custom', minMove: Math.pow(10, -digits), formatter: (value: number) => digits === 0 ? compact(value) : n(value, digits) } }, pane);
      series.setData(segment); this.auxiliary.push(series);
    }
    this.inspected.set(name, new Map(values.map(v => [v.time, v.value])));
  }
  private histogram(pane: number, name: string, values: ValuePoint[], positive: string, negative: string, digits = 0) {
    const series = this.chart.addSeries(HistogramSeries, { lastValueVisible: false, priceLineVisible: false,
      priceFormat: { type: 'custom', minMove: Math.pow(10, -digits), formatter: (value: number) => digits ? `${n(value, digits)}%` : compact(value) } }, pane);
    series.setData(values.map(v => ({ ...v, color: v.value >= 0 ? positive : negative })));
    this.auxiliary.push(series); this.inspected.set(name, new Map(values.map(v => [v.time, v.value])));
  }
  private positionLabels() {
    let top = 8;
    const labels = this.el('pane-labels').children;
    this.chart.panes().forEach((pane, index) => { if (labels[index]) (labels[index] as HTMLElement).style.top = `${top}px`; top += pane.getHeight(); });
  }
  private reset() {
    const bars = this.data('perpetual')?.bars;
    if (!bars?.length) return;
    const start = Math.max(anchorTime(this.anchor), bars[0].time), end = bars.at(-1)!.time;
    this.chart.timeScale().setVisibleRange({ from: Math.min(start, end - seconds[this.period]) as UTCTimestamp, to: (end + seconds[this.period] * 2) as UTCTimestamp });
    this.chart.panes().forEach(pane => pane.priceScale('right').applyOptions({ autoScale: true }));
  }
  clearInspection() { const had = this.pinnedTime != null; this.pinnedTime = undefined; this.el('tooltip').hidden = true; return had; }
  hasDialog() { return this.el<HTMLDialogElement>('dialog').open; }
  private inspect(param: MouseEventParams) {
    if (typeof param.time !== 'number' || !param.point) { this.el('tooltip').hidden = true; return; }
    const bar = this.data('perpetual')?.bars.find(b => b.time === param.time);
    if (!bar) { this.el('tooltip').hidden = true; return; }
    const rows: [string, string][] = [['开 / 收', `${n(bar.open)} / ${n(bar.close)}`], ['高 / 低', `${n(bar.high)} / ${n(bar.low)}`], ['成交量 ETH', compact(bar.volume)]];
    for (const [name, values] of this.inspected) { const value = values.get(param.time); rows.push([name, value == null ? '—' : name.includes('%') ? `${n(value, 4)}%` : name.includes('BTC ·') ? n(value, 6) : n(name.includes('主动卖出') ? Math.abs(value) : value)]); }
    const tooltip = this.el('tooltip');
    tooltip.innerHTML = `<div class="tooltip-heading"><strong>ETHUSDT 永续</strong><span>${this.pinnedTime ? '已固定' : '点击固定'}</span></div><time>${utcTime(param.time)} UTC</time><dl>${rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl><small>副图值属于各自平台统计周期；— 表示此时无样本。</small>`;
    tooltip.hidden = false; tooltip.classList.toggle('is-pinned', !!this.pinnedTime);
    const width = this.el('chart').clientWidth, height = this.el('chart').clientHeight;
    tooltip.style.left = `${Math.max(8, Math.min(param.point.x + 20, width - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(param.point.y + 15, height - tooltip.offsetHeight - 8))}px`;
  }

  private dialog(title: string, content: string) { this.el('dialog-title').textContent = title; this.el('dialog-content').innerHTML = content; this.el<HTMLDialogElement>('dialog').showModal(); }
  private showDetails() {
    const entries = this.requests().map(([dataset, period]) => {
      const data = this.data(dataset, period);
      if (!data) return `<section><h3>${names[dataset]} · ${periods[period]}</h3><p>${escape(this.errors.get(this.key(dataset, period)) ?? '尚未返回数据')}</p></section>`;
      const first = data.bars[0]?.time ?? data.points[0]?.time ?? data.sourceTime;
      return `<section><h3>${names[dataset]} <span>${stale(data) ? '缓存 / 待更新' : '已获取'}</span></h3><p>${escape(data.source)} · ${data.symbol} · ${data.market}<br>周期 ${data.interval} · 单位 ${data.unit} · ${data.nature}<br>覆盖 ${utcTime(first)} — ${utcTime(data.sourceTime)} UTC<br>${data.sourceTimeKind} ${utcTime(data.sourceTime)} UTC<br>获取时间 ${utcTime(data.fetchedAt)} UTC${data.warning ? `<br>${escape(data.warning)}` : ''}</p></section>`;
    }).join('');
    this.dialog('数据来源与计算口径', `<div class="research-definitions"><p>本轮起点：${utcDate(anchorTime(this.anchor))} 00:00 UTC（${this.anchor.mode === 'manual' ? '固定日期' : '滚动窗口'}）。图表日期按 UTC；菜单栏仍是 Coinbase USD 现货。</p>${entries}<section><h3>本地计算 · 不代表全市场</h3><p>相对涨幅以起点后双方第一根共同 K 线的开盘价为基准。CVD = Σ(2 × taker buy base volume − base volume)，起点之前记为基线，不冒充零成交；在缺口处停止累计。主动买卖比 = 买量 / 卖量，主动买入占比 = 买量 / 总量，成交量单位 ETH。累计量与 ATR 只用已收盘 K 线。</p><p>OI 为 ETH 数量，美元名义金额单独保存；OI 增加不表示多头净增加。OI 时点为统计期末，价格 K 线标在周期起点。资金费副图把逐次实际结算记录按当前 K 线周期求和，无结算时留空；累计费率不等于你的账单。8h 等效 = 过去 7 天累计费率 ÷ 21，不假设历史始终 8h 结算。</p><p>ATR 14 使用日线真实波幅和 Wilder 平滑，占比 = ATR / 同日收盘价。资金费未来情景为固定名义本金下的假设，不预测费率、价格或盈亏。</p><p>初次价格回补：日线约 2 年、4 小时约 6 个月、1 小时约 60 天；OI 先取约 29 天安全窗口，之后保留本地样本；资金费先取 90 天记录。缺失不补零。休眠超过源的回补窗口会留下缺口。</p></section></div>`);
  }
  private showDistributions() {
    this.dialog('分布数据 · 尚未接入', `<div class="research-definitions"><p>这三类图尚未取得本地重绘所需的数据权限。目前可查看供应商页面，登录与订阅要求由供应商决定。</p><section><h3>合约清算价分布 <span>模型估算</span></h3><p>CoinGlass 热力图估算潜在清算密集区，并非交易所完整仓位账本；区域不代表价格必然到达。本地重绘需要其 Professional / Enterprise API 权限，网页会员不等于 API 权限。下方链接已选择 ETH。</p><button data-external="liquidation">查看 CoinGlass ETH 清算热力图 ↗</button></section><section><h3>合约入场价分布 <span>模型 / 样本</span></h3><p>Hyblock 仓位分布为供应商推断。CoinGlass 的 Hyperliquid 仓位接口包含入场价、清算价与数量，但需要 API 权限，且未确认覆盖平台全量地址；不能称为全市场当前持仓。</p><button data-external="positions">查看 Hyblock（选择 ETH）↗</button></section><section><h3>链上现货成本分布 <span>链上模型</span></h3><p>Glassnode ETH Cost Basis Distribution 基于链上转移与模型推断，不等于真实买入成本，也不含交易所内每笔成交。尚未核实 CoinGlass 提供这一指标。Volume Profile 仅是历史成交分布，不能替代成本或未平仓仓位分布。</p><button data-external="cost">查看 Glassnode（选择 ETH CBD）↗</button></section></div>`);
    this.root.querySelectorAll<HTMLButtonElement>('[data-external]').forEach(button => button.onclick = () => {
      void this.native<boolean>('openResearchLink', { destination: button.dataset.external }).then(opened => { if (!opened) button.textContent = '无法打开浏览器，请稍后再试'; }).catch(() => { button.textContent = '无法打开浏览器，请稍后再试'; });
    });
  }
  private showScenario() {
    const data = this.data('funding'), daily = fundingTotal(data, 1);
    this.dialog('固定名义本金 · 资金费情景', `<div class="research-definitions"><p>假设未来每天的费率合计等于最近 24 小时已返回的实际结算费率 ${signed(daily.value, 4)}%。每天重复这个水平，名义本金保持不变；未使用杠杆倍数或你的账户信息。</p><label class="scenario-input">假设名义本金 <input data-r="notional" type="number" min="1" max="1000000000" step="100" value="10000"> USDT</label><div data-r="scenario-result"></div><p>正值表示多头支付、空头收取；负值反向。不含价格盈亏、手续费与调仓影响，不是未来预测。下一期未结算参考费率不混入历史累计。</p></div>`);
    const render = () => {
      const notional = Number(this.el<HTMLInputElement>('notional').value);
      const valid = notional > 0 && notional <= 1e9 && Number.isFinite(notional) && !daily.partial && daily.value != null && !stale(data);
      this.el('scenario-result').innerHTML = valid ? `<div class="scenario-values"><div>未来 7 天 <strong>${signed(notional * daily.value! / 100 * 7)} USDT</strong></div><div>未来 30 天 <strong>${signed(notional * daily.value! / 100 * 30)} USDT</strong></div></div>` : '<p class="cached">数据过期、覆盖不足或本金无效，暂不计算情景。</p>';
    };
    this.el('notional').oninput = render; render();
  }
}
