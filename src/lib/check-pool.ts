/**
 * Bounded-concurrency runner + per-key mutex — Phase B (speed).
 *
 * The screening engine historically ran every (source × term) check sequentially
 * on one shared page (~12 min for a company + UBO). These primitives let the
 * engine run checks CONCURRENTLY across sources while a per-source mutex keeps any
 * single source from being hit by two requests at once (respects each source's
 * rate limit and avoids stateful-site session collisions, e.g. OFAC ASP.NET).
 *
 * Wall-clock collapses toward the slowest single source's own sequential chain,
 * not the sum of all checks. Tunable via CHECK_CONCURRENCY (default 4; 1 = legacy
 * sequential). See DR-20260921.
 */

/** Run `tasks` with at most `limit` in flight. `onEach` fires after every task settles
 *  (used for progress accounting); it runs single-threaded so a plain counter is safe.
 *  Individual task rejections are swallowed here — each task is responsible for its own
 *  error persistence (an error row), exactly as the sequential loop was. */
export async function runPool(
  tasks: Array<() => Promise<void>>,
  limit: number,
  onEach?: () => Promise<void> | void,
): Promise<void> {
  const cap = Math.max(1, limit | 0);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const idx = cursor++;
      try {
        await tasks[idx]();
      } catch {
        // task persists its own error row; never let one check abort the pool
      }
      if (onEach) await onEach();
    }
  }
  const workers = Array.from({ length: Math.min(cap, tasks.length) }, () => worker());
  await Promise.all(workers);
}

/** Serialise calls that share a key (e.g. one source id) while allowing different
 *  keys to run in parallel. Returns a function that chains promises per key. */
export function createKeyedMutex() {
  const chains = new Map<string, Promise<unknown>>();
  return function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run fn regardless of prior outcome
    // keep the chain alive but don't retain rejections
    chains.set(key, next.then(() => undefined, () => undefined));
    return next;
  };
}
