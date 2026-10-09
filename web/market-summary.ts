import { type SummaryID, type SummaryMetric, summarize, summaryIDs, summaryRequests, utcTime } from './research-model';
import { ResearchStore, researchKey } from './research-store';
import './market-summary.css';

const number = (value?: number, digits = 2) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value?: number, digits = 2) => value == null ? '—' : `${value >= 0 ? '+' : '−'}${number(Math.abs(value), digits)}`;
const unit = (value: number | undefined, suffix: string, digits = 2) => value == null ? '—' : `${number(value, digits)}${suffix}`;
const delta = (value: number | undefined, suffix: string, digits = 2) => value == null ? '—' : `${signed(value, digits)}${suffix}`;
export const escapeText = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const labels: Record<SummaryID, string> = { ratio: 'ETH / BTC', interest: '未平仓量 OI', funding: '已结算资金费', flow: '主动买入占比', risk: '日线波动 ATR' };
const definitions: Record<SummaryID, string> = {
  ratio: 'ETHBTC 现货 · 最新已收盘 1h 价格；7 天变化与恰好 168 小时前的收盘价比较。',
  interest: 'ETHUSDT 永续 · 1h 期末 OI 数量；24h 变化不含价格造成的名义金额变化，增加不表示净多头增加。',
  funding: 'ETHUSDT 永续 · 最近 7 天实际结算记录相加，正值通常由多头支付；非未来预测或你的调仓账单。覆盖按记录边界与间隔检查。',
  flow: 'ETHUSDT 现货 / 永续 · 相同 24 个已收盘小时，Σ主动买量 ÷ Σ总成交量；缺小时或总量为零时留空。',
  risk: 'ETHUSDT 永续 · Wilder 日线 ATR14 ÷ 同日收盘价；较前日变化用百分点表示，波动不表示方向。',
};
export function metricPresentation(metric: SummaryMetric) {
  const { id, value, secondary, change } = metric;
  let main = '', hint = '';
  if (id === 'ratio') { main = number(value, 5); hint = `7 天 ${delta(change, '%')}`; }
  if (id === 'interest') {
    main = value == null ? '—' : `${number(value / 1e6, 2)}M ETH`;
    hint = `24h ${delta(change, '%')}`;
  }
  if (id === 'funding') { main = delta(value, '%', 3); hint = `近 7 天 · ${secondary ?? '—'} 次结算`; }
  if (id === 'flow') { main = `${unit(value, '%', 1)} / ${unit(secondary, '%', 1)}`; hint = '24h · 现货 / 永续'; }
  if (id === 'risk') { main = unit(value, '%'); hint = `较前日 ${delta(change, ' pp')}`; }
  return { label: labels[id], main, hint, definition: definitions[id] };
}
export function metricState(store: ResearchStore, id: SummaryID) {
  const metric = summarize(id, (d, p) => store.data(d, p));
  const keys = summaryRequests[id].map(([d, p]) => researchKey(d, p));
  const errors = keys.map(k => store.errors.get(k)).filter((s): s is string => !!s);
  const loading = keys.some(k => store.pending.has(k));
  const missing = metric.sources.length < summaryRequests[id].length;
  const statuses: string[] = [];
  if (missing) statuses.push(loading ? '加载中' : '暂无数据');
  else if (metric.incomplete) statuses.push('覆盖不足');
  if (metric.stale || errors.length) statuses.push(metric.sources.length ? '待更新' : '获取失败');
  if (loading && !missing) statuses.push('更新中');
  const asOf = metric.end == null ? '' : `${utcTime(metric.end).slice(5)} UTC`;
  return { metric, loading, statuses, asOf, errors, ...metricPresentation(metric) };
}

export function metricDetailHTML(store: ResearchStore, id: SummaryID) {
  const state = metricState(store, id), m = state.metric;
  const window = m.start != null && m.end != null ? `${utcTime(m.start)} — ${utcTime(m.end)} UTC` : '统计窗口尚未取得';
  const extra = id === 'interest' ? ` · 数量变化 ${delta(m.absoluteChange, ' ETH', 0)}` : id === 'risk' ? ` · ATR ${unit(m.secondary, ' USDT')}` : '';
  return `<div class="focus-reading"><span>首页摘要 · ${state.label}</span><strong>${state.main}</strong><small>${state.hint}${extra}</small></div><div class="focus-context"><p>${state.definition}</p><small>${window} · ${state.statuses.join(' / ') || '已获取'}${m.fetchedAt ? ` · 获取 ${utcTime(m.fetchedAt)} UTC` : ''}</small><small>图表周期与本轮观察起点独立设置；此处摘要与首页使用同一份数据。</small>${state.errors.length ? `<small class="summary-warning">${escapeText(state.errors.join('；'))}</small>` : ''}</div><button data-clear-focus class="research-text-button">本轮读数 →</button>`;
}

export class MarketSummary {
  private active = false;
  private frame = 0;
  constructor(private root: HTMLElement, private store: ResearchStore, open: (id: SummaryID) => void) {
    root.className = 'market-summary';
    root.innerHTML = `<div class="summary-caption"><span>ETH 核心观察 <small>Binance 市场参考 · 固定统计窗口</small></span><span>点选查看联动图 →</span></div><div class="summary-metrics">${summaryIDs.map(id => `<button class="summary-metric" data-summary="${id}"><span class="summary-label">${labels[id]} <i>↗</i></span><strong></strong><span class="summary-hint"></span><small class="summary-time"></small></button>`).join('')}</div>`;
    root.querySelectorAll<HTMLButtonElement>('[data-summary]').forEach(button => button.onclick = () => open(button.dataset.summary as SummaryID));
    store.subscribe(() => {
      if (!this.active) return;
      cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => this.render());
    });
    this.render();
  }
  setActive(active: boolean) {
    const changed = this.active !== active; this.active = active;
    if (active) { this.render(); if (changed) void this.refresh(); }
  }
  async refresh(force = false) {
    if (!this.active) return;
    await this.store.ensure(summaryIDs.flatMap(id => summaryRequests[id]), force);
    if (this.active) this.render();
  }
  tick() { if (this.active) { this.render(); void this.refresh(); } }
  focus(id: SummaryID) { this.root.querySelector<HTMLButtonElement>(`[data-summary="${id}"]`)?.focus(); }
  private render() {
    for (const id of summaryIDs) {
      const state = metricState(this.store, id), button = this.root.querySelector<HTMLButtonElement>(`[data-summary="${id}"]`)!;
      button.querySelector('strong')!.textContent = state.main;
      button.querySelector('.summary-hint')!.textContent = state.hint;
      const status = state.statuses.join(' / ');
      button.querySelector('.summary-time')!.textContent = status || state.asOf || '等待数据';
      button.classList.toggle('summary-warning', state.metric.stale || state.errors.length > 0 || (state.metric.incomplete && state.metric.sources.length > 0));
      button.setAttribute('aria-busy', String(state.loading));
      button.setAttribute('aria-label', `${state.label}，${state.main}，${state.hint}，${status || state.asOf}，查看详情`);
      button.title = `${state.definition}\n截至 ${state.asOf || '—'}${state.metric.fetchedAt ? `；获取 ${utcTime(state.metric.fetchedAt)} UTC` : ''}${status ? `；${status}` : ''}\n${state.errors.join('；')}`;
    }
  }
}
