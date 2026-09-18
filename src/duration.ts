const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Parse "30s", "500ms", "2m", "1h" (or a bare number of ms) into milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid duration: ${value}`);
    return value;
  }
  const m = DURATION_RE.exec(value);
  if (!m) throw new Error(`Invalid duration "${value}" (expected e.g. 30s, 500ms, 2m, 1h)`);
  const amount = Number(m[1]);
  const unit = m[2] ?? "ms";
  return Math.round(amount * (UNIT_MS[unit] ?? 1));
}

export function isDuration(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  return typeof value === "string" && DURATION_RE.test(value);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
