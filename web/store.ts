// A value shared by every cell in the window, read as a React hook.
import { useSyncExternalStore } from "react";

/** `load` runs on the first read, unless a value was set before. */
export function store<T>(initial: T, load?: () => void) {
  let value = initial;
  let started = !load;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    if (!started) {
      started = true;
      load?.();
    }
    listeners.add(l);
    return () => void listeners.delete(l);
  };
  return {
    get: () => value,
    set(next: T) {
      started = true;
      if (Object.is(next, value)) return;
      value = next;
      for (const l of listeners) l();
    },
    use: () => useSyncExternalStore(subscribe, () => value),
  };
}
