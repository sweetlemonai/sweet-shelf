/**
 * Trailing-edge debounce. Calls to the returned function reset the timer;
 * `fn` runs once after `delayMs` of quiet. `flush()` runs any pending call
 * immediately. `cancel()` drops the pending call without running it.
 *
 * Used by the shelf store to coalesce rapid state changes into a single
 * write.
 */
export interface Debounced<Args extends readonly unknown[]> {
  (...args: Args): void;
  flush(): void;
  cancel(): void;
}

export function debounce<Args extends readonly unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
): Debounced<Args> {
  let timer: NodeJS.Timeout | undefined;
  let pendingArgs: Args | undefined;

  const run = (): void => {
    timer = undefined;
    if (pendingArgs) {
      const args = pendingArgs;
      pendingArgs = undefined;
      fn(...args);
    }
  };

  const debounced = ((...args: Args): void => {
    pendingArgs = args;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(run, delayMs);
  }) as Debounced<Args>;

  debounced.flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };

  debounced.cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    pendingArgs = undefined;
  };

  return debounced;
}
