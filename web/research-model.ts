import type { UTCTimestamp } from 'lightweight-charts';

export type ResearchPeriod = '1h' | '4h' | '1d';
export type Dataset = 'perpetual' | 'spot' | 'bitcoin' | 'ratio' | 'interest' | 'funding' | 'reference';
export interface Bar {
  time: UTCTimestamp; endTime: number; open: number; high: number; low: number; close: number;
  volume: number; takerBuy: number;
}
export interface Point { time: number; value: number; notional?: number; rateType?: string }
export interface ResearchSeries {
  dataset: Dataset; source: string; market: string; symbol: string; interval: string; unit: string;
  nature: string; requestedStart: number; fetchedAt: number; sourceTime: number; sourceTimeKind: string;
  bars: Bar[]; points: Point[]; reference?: { mark: number; index: number; rate: number; nextFundingTime: number };
  cached: boolean; warning?: string;
}
export interface ValuePoint { time: UTCTimestamp; value: number }
export interface Anchor { mode: '7' | '30' | 'manual'; date: string }
export const DAY = 86400;
export const seconds: Record<ResearchPeriod, number> = { '1h': 3600, '4h': 14400, '1d': DAY };
export const utcDate = (time = Date.now() / 1000) => new Date(time * 1000).toISOString().slice(0, 10);
export const utcTime = (time: number) => new Date(time * 1000).toISOString().slice(0, 16).replace('T', ' ');
export function anchorTime(anchor: Anchor) {
  return anchor.mode === 'manual' ? Date.parse(`${anchor.date}T00:00:00Z`) / 1000 : Math.floor(Date.now() / 1000 / DAY) * DAY - Number(anchor.mode) * DAY;
}
export function closed(series?: ResearchSeries): Bar[] {
  // A cached live candle must not become a closed candle merely as wall time advances.
  return series?.bars.filter(b => b.endTime < series.fetchedAt) ?? [];
}
export function anchoredFlow(series: ResearchSeries | undefined, anchor: number, step: number) {
  const rows = closed(series).filter(b => b.time >= anchor);
  const values: ValuePoint[] = [];
  let buy = 0, sell = 0, gap = false;
  for (const bar of rows) {
    if (values.length && bar.time - values.at(-1)!.time !== step) { gap = true; break; }
    buy += bar.takerBuy;
    sell += bar.volume - bar.takerBuy;
    values.push({ time: bar.time, value: buy - sell });
  }
  return {
    values, buy: values.length ? buy : undefined, sell: values.length ? sell : undefined,
    share: buy + sell > 0 ? buy / (buy + sell) * 100 : undefined,
    ratio: sell > 0 ? buy / sell : undefined, gap,
    partial: !!rows.length && rows[0].time > anchor,
    start: rows[0]?.time, end: values.at(-1)?.time,
  };
}
export function relativeReturns(eth: ResearchSeries | undefined, btc: ResearchSeries | undefined, anchor: number) {
  const btcByTime = new Map(closed(btc).map(b => [b.time, b]));
  const pairs = closed(eth).filter(b => b.time >= anchor && btcByTime.has(b.time));
  const first = pairs[0];
  if (!first) return { eth: [], btc: [], start: undefined, partial: false };
  const btcBase = btcByTime.get(first.time)!.open;
  return {
    eth: pairs.map(b => ({ time: b.time, value: (b.close / first.open - 1) * 100 })),
    btc: pairs.map(b => ({ time: b.time, value: (btcByTime.get(b.time)!.close / btcBase - 1) * 100 })),
    start: first.time, partial: first.time > anchor,
  };
}
export function atr14(series?: ResearchSeries): ValuePoint[] {
  const bars = closed(series);
  const values: ValuePoint[] = [];
  let ranges: number[] = [], average: number | undefined;
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i], prev = bars[i - 1];
    if (bar.time - prev.time !== DAY) { ranges = []; average = undefined; continue; }
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close));
    ranges.push(tr);
    if (ranges.length < 14) continue;
    average = average == null ? ranges.slice(-14).reduce((a, b) => a + b, 0) / 14 : (average * 13 + tr) / 14;
    values.push({ time: bar.time, value: average });
  }
  return values;
}
export function fundingTotal(series: ResearchSeries | undefined, days: number) {
  if (!series) return { value: undefined, count: 0, partial: true };
  const end = series.fetchedAt, start = end - days * DAY;
  const rows = series.points.filter(p => p.time > start && p.time <= end);
  const regular = series.points.filter(p => !p.rateType || p.rateType === 'Regular');
  const window = regular.filter(p => p.time >= start - DAY && p.time <= end);
  const gap = window.some((p, i) => i > 0 && p.time - window[i - 1].time > 12 * 3600);
  const partial = !rows.length || series.points[0]?.time > start || gap || end - (regular.at(-1)?.time ?? 0) > 12 * 3600;
  return { value: rows.length ? rows.reduce((sum, p) => sum + p.value * 100, 0) : undefined, count: rows.length, partial };
}
export function stale(series: ResearchSeries | undefined) {
  if (!series) return true;
  const ttl = ['interest', 'funding'].includes(series.dataset) || series.interval === '1d' ? 600 : 180;
  const now = Date.now() / 1000;
  const step = seconds[series.interval as ResearchPeriod];
  const sourceLag = series.dataset === 'funding' ? 12 * 3600 : series.dataset === 'reference' ? 180 : step ? step + 600 : Infinity;
  return series.cached || now - series.fetchedAt > ttl || now - series.sourceTime > sourceLag;
}

export type SummaryID = 'ratio' | 'interest' | 'funding' | 'flow' | 'risk';
export const summaryIDs: SummaryID[] = ['ratio', 'interest', 'funding', 'flow', 'risk'];
export const summaryRequests: Record<SummaryID, [Dataset, ResearchPeriod][]> = {
  ratio: [['ratio', '1h']], interest: [['interest', '1h']], funding: [['funding', '1h']],
  flow: [['spot', '1h'], ['perpetual', '1h']], risk: [['perpetual', '1d']],
};
export interface SummaryMetric {
  id: SummaryID; value?: number; secondary?: number; change?: number; absoluteChange?: number;
  start?: number; end?: number; fetchedAt?: number; incomplete: boolean; stale: boolean;
  sources: ResearchSeries[];
}

/** Fixed summary windows never inherit the chart period or the campaign anchor. */
export function summarize(id: SummaryID, data: (dataset: Dataset, period: ResearchPeriod) => ResearchSeries | undefined): SummaryMetric {
  const inputs = summaryRequests[id].map(([dataset, period]) => data(dataset, period));
  const sources = inputs.filter((s): s is ResearchSeries => !!s);
  const result: SummaryMetric = { id, incomplete: true, stale: sources.some(stale), sources,
    fetchedAt: sources.length ? Math.min(...sources.map(s => s.fetchedAt)) : undefined };
  if (id === 'flow') {
    if (result.fetchedAt == null) return result;
    // Available markets use the same 24 complete hours, as of the older fetch.
    const end = Math.floor(result.fetchedAt / 3600) * 3600, start = end - DAY;
    const share = (series?: ResearchSeries) => {
      const bars = closed(series).filter(b => b.time >= start && b.time < end);
      if (bars.length !== 24 || bars.some((b, i) => b.time !== start + i * 3600)) return undefined;
      const volume = bars.reduce((sum, b) => sum + b.volume, 0);
      return volume > 0 ? bars.reduce((sum, b) => sum + b.takerBuy, 0) / volume * 100 : undefined;
    };
    result.start = start; result.end = end; result.value = share(inputs[0]); result.secondary = share(inputs[1]);
    result.incomplete = result.value == null || result.secondary == null;
    return result;
  }
  const first = inputs[0];
  if (!first) return result;
  if (id === 'ratio') {
    const bars = closed(first), last = bars.at(-1);
    if (!last) return result;
    const previous = bars.find(b => b.time === last.time - 7 * DAY);
    result.value = last.close; result.start = last.time + 3600 - 7 * DAY; result.end = last.time + 3600;
    result.change = previous ? (last.close / previous.close - 1) * 100 : undefined;
    result.incomplete = !previous;
  } else if (id === 'interest') {
    const last = first.points.at(-1);
    if (!last) return result;
    const previous = first.points.find(p => p.time === last.time - DAY);
    result.value = last.value; result.start = last.time - DAY; result.end = last.time;
    result.absoluteChange = previous ? last.value - previous.value : undefined;
    result.change = previous && previous.value > 0 ? (last.value / previous.value - 1) * 100 : undefined;
    result.incomplete = result.change == null;
  } else if (id === 'funding') {
    const total = fundingTotal(first, 7);
    result.value = total.value; result.secondary = total.count;
    result.start = first.fetchedAt - 7 * DAY; result.end = first.fetchedAt; result.incomplete = total.partial;
  } else {
    const bars = closed(first), last = bars.at(-1), previous = bars.at(-2);
    const atr = new Map(atr14(first).map(p => [p.time, p.value]));
    const current = last && atr.get(last.time), prior = previous && atr.get(previous.time);
    result.value = current != null && last ? current / last.close * 100 : undefined;
    result.secondary = current; result.start = last?.time; result.end = last ? last.time + DAY : undefined;
    result.change = result.value != null && prior != null && previous && last!.time - previous.time === DAY ? result.value - prior / previous.close * 100 : undefined;
    result.incomplete = result.value == null || result.change == null;
  }
  if ((id === 'ratio' || id === 'risk') && result.end != null) {
    const step = id === 'risk' ? DAY : 3600;
    result.stale ||= result.end < Math.floor(first.fetchedAt / step) * step;
  }
  return result;
}
