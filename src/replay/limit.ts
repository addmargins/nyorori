// Minimal concurrency limiter (no dependency): at most `concurrency` tasks run
// at once, the rest wait in FIFO order.

export type Limit = <T>(task: () => Promise<T>) => Promise<T>;

export function pLimit(concurrency: number): Limit {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`concurrency must be a positive integer (got ${concurrency})`);
  const queue: Array<() => void> = [];
  let active = 0;
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(release);
      };
      if (active < concurrency) start();
      else queue.push(start);
    });
}
