// In-process per-file mutex for read-modify-write cycles on the service's
// small JSON state files. One service process owns a state directory.

const locks = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(file, tail);
  void tail.then(() => {
    if (locks.get(file) === tail) locks.delete(file);
  });
  return next;
}
