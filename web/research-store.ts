import { type Dataset, type ResearchPeriod, type ResearchSeries } from './research-model';

export type Native = <T>(action: string, args?: Record<string, unknown>) => Promise<T>;
export type Request = [Dataset, ResearchPeriod];
export const researchKey = (dataset: Dataset, period: ResearchPeriod) => `${dataset}:${['funding', 'reference'].includes(dataset) ? 'all' : period}`;

/** One in-memory view of the native cache, shared by summaries and charts. */
export class ResearchStore {
  readonly series = new Map<string, ResearchSeries>();
  readonly errors = new Map<string, string>();
  readonly pending = new Map<string, Promise<void>>();
  private hydrated = new Set<string>();
  private attempted = new Map<string, number>();
  private listeners = new Set<(key: string) => void>();
  constructor(private native: Native) {}
  data(dataset: Dataset, period: ResearchPeriod) { return this.series.get(researchKey(dataset, period)); }
  subscribe(listener: (key: string) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(key: string) { this.listeners.forEach(listener => listener(key)); }
  async ensure(items: Request[], force = false) {
    await Promise.allSettled(items.map(([dataset, period]) => this.fetch(dataset, period, force)));
  }
  private fetch(dataset: Dataset, period: ResearchPeriod, force: boolean): Promise<void> {
    const key = researchKey(dataset, period), pending = this.pending.get(key);
    if (pending) return pending;
    const ttl = dataset === 'funding' || dataset === 'interest' || period === '1d' ? 300 : 60;
    const fresh = () => {
      const value = this.series.get(key);
      return value && !value.cached && !this.errors.has(key) && Date.now() / 1000 - value.fetchedAt < ttl;
    };
    if (!force && (fresh() || Date.now() - (this.attempted.get(key) ?? 0) < 60000)) return Promise.resolve();
    // Defer the work until pending is installed, including cache-only completions.
    const request = Promise.resolve().then(async () => {
      if (!this.hydrated.has(key)) {
        try {
          const cached = await this.native<ResearchSeries | null>('researchCached', { dataset, interval: period });
          if (cached) { this.series.set(key, cached); this.notify(key); }
        } catch { /* A cache miss must not prevent a live request. */ }
        this.hydrated.add(key);
      }
      if (!force && fresh()) return;
      this.attempted.set(key, Date.now());
      const value = await this.native<ResearchSeries>('research', { dataset, interval: period, force });
      this.series.set(key, value); this.errors.delete(key);
    }).catch(error => {
      this.errors.set(key, error instanceof Error ? error.message : '暂时无法读取数据');
    }).finally(() => { this.pending.delete(key); this.notify(key); });
    this.pending.set(key, request); this.notify(key);
    return request;
  }
}
