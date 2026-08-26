// Bounded TTL cache that keeps expired entries as fallback material.
//
// Two different callers want two different things from the same store: the
// an ambient context hook wants "fresh enough to inject", and the failure path
// wants "the last thing Passport actually said" so an unreachable backend
// degrades to slightly stale context instead of pretending the owner has no
// memory. So get() reports freshness rather than hiding a miss.
export function createTtlCache({ ttlMs, maxEntries = 32, now = () => Date.now() } = {}) {
  const entries = new Map();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return { hit: false, fresh: false, value: null };
      return { hit: true, fresh: entry.expiresAt > now(), value: entry.value };
    },
    set(key, value) {
      // Re-insert so the eviction order is last-write, not first-write.
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
