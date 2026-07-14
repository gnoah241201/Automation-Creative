import { useEffect, useRef } from 'react';

interface JobPollingOptions<T, R> {
  items: T[];
  isActive(item: T): boolean;
  getKey(item: T): string | undefined;
  poll(key: string, signal: AbortSignal): Promise<R>;
  onResult(item: T, result: R): void;
  onError(item: T, error: unknown): void;
  intervalMs?: number;
}

/** One lifecycle-safe polling loop shared by Resize and Hook Composer queues. */
export function useJobPolling<T, R>(options: JobPollingOptions<T, R>) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const tick = async () => {
      if (polling || controller.signal.aborted) return;
      const current = latest.current;
      const active = current.items.filter(current.isActive);
      if (active.length === 0) return;
      polling = true;
      await Promise.all(active.map(async (item) => {
        const key = current.getKey(item);
        if (!key) return;
        try {
          const result = await current.poll(key, controller.signal);
          if (!controller.signal.aborted) latest.current.onResult(item, result);
        } catch (error) {
          if (!controller.signal.aborted) latest.current.onError(item, error);
        }
      }));
      polling = false;
    };
    const timer = window.setInterval(() => void tick(), options.intervalMs ?? 1_000);
    void tick();
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [options.intervalMs]);
}
