/** Raised when a BookOrbit request outlives its budget. */
export class BookOrbitTimeoutError extends Error {
  constructor(ms: number) {
    super(`BookOrbit request timed out after ${ms} ms`);
    this.name = 'BookOrbitTimeoutError';
  }
}

/**
 * Run a request with a time budget.
 *
 * The signal asks the HTTP client to abandon the request, and the race makes
 * sure the caller moves on even if the client ignores it: a request that never
 * settles (network switch, Doze) must not block everything queued behind it.
 */
export const withTimeout = async <T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new BookOrbitTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
};
