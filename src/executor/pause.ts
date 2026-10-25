/**
 * Drain-pause for a run: while paused the executor starts no new steps or map
 * items, but lets the ones already running finish. Read-only for the executor;
 * whoever owns the run (the CLI, polling a `pause` file) flips it.
 */
export interface PauseGate {
  readonly paused: boolean;
  /** Resolves once the gate is open (immediately if it is), or when `signal` aborts. */
  wait(signal?: AbortSignal): Promise<void>;
  /** Called on every pause/continue transition; returns an unsubscribe function. */
  onChange(listener: (paused: boolean) => void): () => void;
}

/**
 * A gate the caller flips. Waiting on it holds no event-loop handle, so a
 * process whose run is fully paused must keep itself alive (the CLI refs its
 * control-file poll timer while paused).
 */
export class PauseController implements PauseGate {
  private state = false;
  private readonly listeners = new Set<(paused: boolean) => void>();
  private waiters: Array<() => void> = [];

  get paused(): boolean {
    return this.state;
  }

  pause(): void {
    this.set(true);
  }

  continue(): void {
    this.set(false);
  }

  set(paused: boolean): void {
    if (paused === this.state) return;
    this.state = paused;
    if (!paused) {
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
    for (const l of this.listeners) l(paused);
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (!this.state || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      this.waiters.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  onChange(listener: (paused: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
