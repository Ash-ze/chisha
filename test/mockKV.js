// 内存版 KV，模拟 Cloudflare KV 的 get / put(expirationTtl, metadata) / list(prefix, cursor) / delete
export class MockKV {
  constructor({ now = () => Date.now() } = {}) {
    this.store = new Map();
    this.now = now;
    this.puts = [];
  }
  _alive(key) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt && e.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return e;
  }
  async get(key, opts) {
    const e = this._alive(key);
    if (!e) return null;
    const type = typeof opts === 'string' ? opts : opts?.type;
    return type === 'json' ? JSON.parse(e.value) : e.value;
  }
  async put(key, value, opts = {}) {
    if (opts.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error('expirationTtl must be >= 60');
    if (opts.metadata && JSON.stringify(opts.metadata).length > 1024) throw new Error('metadata too large');
    this.puts.push({ key, opts });
    this.store.set(key, {
      value: String(value),
      metadata: opts.metadata ?? null,
      expiresAt: opts.expirationTtl ? this.now() + opts.expirationTtl * 1000 : null,
    });
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const names = [...this.store.keys()].filter((k) => k.startsWith(prefix) && this._alive(k)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = names.slice(start, start + limit);
    const done = start + limit >= names.length;
    return {
      keys: slice.map((name) => {
        const e = this.store.get(name);
        return { name, metadata: e.metadata ?? undefined, expiration: e.expiresAt ? Math.floor(e.expiresAt / 1000) : undefined };
      }),
      list_complete: done,
      cursor: done ? undefined : String(start + limit),
    };
  }
}
