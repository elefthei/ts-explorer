/**
 * Settles with `promise`, or rejects once `timeout` milliseconds elapse. Every wait a test performs
 * on a server, a subprocess or a browser is bounded here so a hang reports which wait stalled
 * instead of killing the whole run on the runner's own deadline.
 *
 * The bound is a required argument: an inherited default silently re-times waits that were tuned
 * for a slower operation, so each call site states the budget it actually expects.
 */
export function withBound<Value>(
  promise: Promise<Value>,
  timeout: number,
  description: string,
): Promise<Value> {
  const bounded = Promise.withResolvers<Value>();
  const timer = setTimeout(
    () => bounded.reject(new Error(`timed out after ${timeout}ms: ${description}`)),
    timeout,
  );
  void promise.then(
    (value) => {
      clearTimeout(timer);
      bounded.resolve(value);
    },
    (error: unknown) => {
      clearTimeout(timer);
      bounded.reject(error);
    },
  );
  return bounded.promise;
}
