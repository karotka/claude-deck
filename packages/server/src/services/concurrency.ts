/**
 * Like `Promise.all(items.map(fn))`, but with at most `limit` workers running
 * at a time. Results keep input order.
 *
 * Discovery reads every running container on each scan tick, and each read
 * spawns docker processes. Unbounded, two dozen containers become a burst of
 * spawns every few seconds, which is what pushes `posix_spawn` into EAGAIN when
 * the host is already busy.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker,
  );
  await Promise.all(workers);
  return results;
}
