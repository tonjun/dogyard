import { computeProgress, formatStepLine, type RunProgress, type StepProgress } from "../progress.js";
import type { RunTrace } from "../trace.js";

export interface ProgressStream {
  write(s: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface ProgressDisplayOptions {
  /** Defaults to process.stderr. */
  stream?: ProgressStream;
  /** Redraw a live block (TTY) or print periodic lines; defaults to `stream.isTTY`. */
  tty?: boolean;
  /** Per-step median item time from earlier runs (see `historicalItemMedians`). */
  history?: Record<string, number>;
  /** Non-TTY: print a map's line every this many finished items (default 10)... */
  everyItems?: number;
  /** ...or after this long without one (default 30s). */
  everyMs?: number;
  /** Extra lines under the live block, or printed with the periodic lines on a non-TTY. */
  footer?: (progress: RunProgress, trace: RunTrace) => string[];
  now?: () => number;
}

const REDRAW_THROTTLE_MS = 100;
const TICK_MS = 1000;

/**
 * Owns stderr while a run is live. On a TTY it keeps one status line per
 * running step at the bottom of the terminal and writes logs and streamed
 * command stderr above it. On a non-TTY it prints a map's status line every N
 * items or every 30s, and once when the map ends.
 */
export class ProgressDisplay {
  private readonly stream: ProgressStream;
  private readonly tty: boolean;
  private readonly now: () => number;
  private trace: RunTrace | undefined;
  private drawn = 0;
  private partial = "";
  private redrawTimer: NodeJS.Timeout | undefined;
  private readonly tick: NodeJS.Timeout;
  /** Non-TTY bookkeeping per map step: finished items and time at the last printed line. */
  private readonly printed = new Map<string, { done: number; at: number }>();
  /** Steps whose final line has been printed. */
  private readonly finished = new Set<string>();
  private stopped = false;

  constructor(private readonly opts: ProgressDisplayOptions = {}) {
    this.stream = opts.stream ?? process.stderr;
    this.tty = opts.tty ?? Boolean(this.stream.isTTY);
    this.now = opts.now ?? Date.now;
    this.tick = setInterval(() => this.refresh(), TICK_MS);
    this.tick.unref();
  }

  /** Feed the latest trace (e.g. from `onProgress`, or a re-read trace file). */
  update(trace: RunTrace): void {
    if (this.stopped) return;
    this.trace = trace;
    this.printFinishedMaps();
    if (this.tty) this.scheduleRedraw();
    else this.printPeriodic();
  }

  /** Write a line above the live block. */
  log(message: string): void {
    this.write(`${message}\n`);
  }

  /** Write raw text (e.g. streamed command stderr) above the live block; partial lines are held until complete. */
  write(text: string): void {
    if (!this.tty || this.stopped) {
      this.stream.write(text);
      return;
    }
    const buf = this.partial + text;
    const cut = buf.lastIndexOf("\n");
    if (cut === -1) {
      this.partial = buf;
      return;
    }
    this.partial = buf.slice(cut + 1);
    this.clear();
    this.stream.write(buf.slice(0, cut + 1));
    this.draw();
  }

  /** Clear the live block, flush held output and stop the timers. Safe to call twice. */
  stop(): void {
    if (this.stopped) return;
    if (this.trace) this.printFinishedMaps();
    this.stopped = true;
    clearInterval(this.tick);
    if (this.redrawTimer) clearTimeout(this.redrawTimer);
    this.clear();
    if (this.partial) this.stream.write(`${this.partial}\n`);
    this.partial = "";
  }

  private refresh(): void {
    if (this.stopped || !this.trace) return;
    if (this.tty) this.scheduleRedraw();
    else this.printPeriodic();
  }

  private progress(): RunProgress {
    const o: Parameters<typeof computeProgress>[1] = { now: this.now() };
    if (this.opts.history) o.history = this.opts.history;
    return computeProgress(this.trace!, o);
  }

  // ---- TTY ----

  private scheduleRedraw(): void {
    if (this.redrawTimer) return;
    this.redrawTimer = setTimeout(() => {
      this.redrawTimer = undefined;
      if (this.stopped) return;
      this.clear();
      this.draw();
    }, REDRAW_THROTTLE_MS);
    this.redrawTimer.unref();
  }

  private clear(): void {
    if (!this.drawn) return;
    this.stream.write(`\r${this.drawn > 1 ? `\x1b[${this.drawn - 1}A` : ""}\x1b[J`);
    this.drawn = 0;
  }

  /** Draw the block; the cursor is left at the end of its last line. */
  private draw(): void {
    if (!this.trace || this.stopped) return;
    const p = this.progress();
    const running = p.steps.filter((s) => s.status === "running");
    const width = Math.max(0, ...running.map((s) => s.name.length));
    const lines = [...running.map((s) => formatStepLine(s, width)), ...(this.opts.footer?.(p, this.trace) ?? [])];
    if (!lines.length) return;
    const cols = this.stream.columns ?? 0;
    const fit = (l: string) => (cols > 1 && l.length >= cols ? `${l.slice(0, cols - 2)}…` : l);
    this.stream.write(lines.map(fit).join("\n"));
    this.drawn = lines.length;
  }

  // ---- non-TTY ----

  private printPeriodic(): void {
    if (!this.trace) return;
    const p = this.progress();
    const now = this.now();
    const due: StepProgress[] = [];
    for (const s of p.steps) {
      if (s.status !== "running" || !s.items) continue;
      const last = this.printed.get(s.name);
      const every = this.opts.everyItems ?? 10;
      if (!last || s.items.done - last.done >= every || now - last.at >= (this.opts.everyMs ?? 30_000)) {
        this.printed.set(s.name, { done: s.items.done, at: now });
        due.push(s);
      }
    }
    if (!due.length) return;
    for (const s of due) this.stream.write(`${formatStepLine(s)}\n`);
    for (const l of this.opts.footer?.(p, this.trace) ?? []) this.stream.write(`${l}\n`);
  }

  /** Print a map's final line once, when it leaves `running` after having started. */
  private printFinishedMaps(): void {
    const ended = this.progress().steps.filter((s) => s.items && s.status !== "running" && s.status !== "pending" && s.elapsed_ms !== undefined && !this.finished.has(s.name));
    if (!ended.length) return;
    for (const s of ended) this.finished.add(s.name);
    const text = ended.map((s) => `${formatStepLine(s)}\n`).join("");
    if (this.tty && !this.stopped) {
      this.clear();
      this.stream.write(text);
      this.draw();
    } else {
      this.stream.write(text);
    }
  }
}

/** Log one line per step status transition (the `run` command's classic progress output). */
export function stepTransitionLogger(log: (message: string) => void): (trace: RunTrace) => void {
  const seen = new Map<string, string>();
  return (trace: RunTrace) => {
    for (const s of trace.steps) {
      if (seen.get(s.name) === s.status) continue;
      seen.set(s.name, s.status);
      if (s.status === "pending") continue;
      const extra = s.status === "skipped" ? ` (${s.skip_reason})` : s.error && s.status !== "caught" ? ` (${s.error.type}: ${s.error.message})` : s.selected ? ` -> ${s.selected}` : s.cache?.hit ? " (cached)" : "";
      log(`[${s.status.padEnd(11)}] ${s.name}${extra}`);
    }
  };
}
