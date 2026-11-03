export const authenticationFailed = (error: any) => error?.status === 401 || ["UNAUTHORIZED", "WRONG_CREDENTIAL", "OWNER_REQUIRED"].includes(error?.code);

/** One read budget per Host, shared by native subscriptions and every Client.
 * Writes remain available during read backoff and invalidate derived read caches. */
export class ReadCoordinator {
  private cache = new Map<string, { until: number; value: any }>();
  private pending = new Map<string, Promise<any>>();
  private generation = 0;
  private retryAt = 0;
  private failures = 0;
  private error: any;
  invalidate() { this.generation++; this.cache.clear(); this.pending.clear(); }
  reset() { this.invalidate(); this.retryAt = 0; this.failures = 0; this.error = undefined; }
  async read(path: string, fetch: () => Promise<any>) {
    if (Date.now() < this.retryAt) throw this.error;
    const cached = this.cache.get(path);
    if (cached && Date.now() < cached.until) return cached.value;
    const active = this.pending.get(path);
    if (active) return active;
    const generation = this.generation;
    const ttl = /^\/v1\/(info|templates)$/.test(path) ? 60000 : /^\/v1\/(tasks|runners)$/.test(path) ? 3000 : /^\/v1\/tasks\/[^/]+$/.test(path) ? 2000 : 0;
    const request = Promise.resolve().then(fetch).then(value => {
      if (generation === this.generation) {
        if (Date.now() >= this.retryAt) { this.failures = 0; this.retryAt = 0; }
        if (ttl) this.cache.set(path, { value, until: Date.now() + ttl });
      }
      return value;
    }).catch(error => {
      if (generation === this.generation && Date.now() >= this.retryAt) {
        const backoff = error?.status === 429 ? Math.max(60000, error.retryAfterMs ?? 0) : authenticationFailed(error) ? 30000 : Math.min(30000, 1000 * 2 ** this.failures++);
        this.retryAt = Date.now() + backoff;
        this.error = error;
      }
      throw error;
    }).finally(() => { if (this.pending.get(path) === request) this.pending.delete(path); });
    this.pending.set(path, request);
    return request;
  }
}
