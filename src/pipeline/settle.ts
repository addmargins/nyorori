/**
 * Like Promise.all, but waits for every task before rejecting. Callers clean
 * up a shared directory afterwards; with Promise.all a sibling task could keep
 * writing into it after the cleanup ran.
 */
export async function allSettledOrThrow<T extends readonly unknown[]>(
  tasks: readonly [...{ [K in keyof T]: Promise<T[K]> }],
): Promise<T> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as unknown as T;
}
