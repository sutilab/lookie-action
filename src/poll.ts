import { type Client, getRun, LookieApiError, type Run } from "./api";

/** Run statuses after which a run does not change. `not_implemented` is a watcher with no runner yet. */
export const TERMINAL_STATUSES: readonly string[] = [
  "posted",
  "skipped",
  "failed",
  "invalid_output",
  "not_implemented",
];

export interface PollOptions {
  timeoutMs: number;
  now: () => number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Consecutive transient errors (network, 5xx) tolerated before giving up. */
  maxTransientErrors?: number;
  onPoll?: (run: Run) => void;
  onTransientError?: (err: LookieApiError, attempt: number) => void;
}

export class PollTimeoutError extends Error {
  readonly runId: string;
  readonly lastStatus: string;

  constructor(runId: string, lastStatus: string, timeoutMs: number) {
    super(
      `Timed out after ${formatDuration(timeoutMs)} waiting for Lookie run ${runId} (last status: ${lastStatus}). Raise 'timeout-minutes' or set 'wait: false'.`,
    );
    this.name = "PollTimeoutError";
    this.runId = runId;
    this.lastStatus = lastStatus;
  }
}

/**
 * Polls `GET /api/v1/runs/{id}` until the run reaches a terminal status. Waits before each poll,
 * starting at 3 s and doubling up to 15 s; the last wait is cut short at the deadline.
 */
export async function pollRun(client: Client, id: string, opts: PollOptions): Promise<Run> {
  const max = opts.maxDelayMs ?? 15_000;
  const maxTransient = opts.maxTransientErrors ?? 2;
  const deadline = opts.now() + opts.timeoutMs;
  let delay = opts.initialDelayMs ?? 3_000;
  let lastStatus = "queued";
  let transientErrors = 0;

  for (;;) {
    const remaining = deadline - opts.now();
    if (remaining <= 0) throw new PollTimeoutError(id, lastStatus, opts.timeoutMs);
    await client.sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, max);

    let run: Run;
    try {
      run = await getRun(client, id);
    } catch (err) {
      if (err instanceof LookieApiError && err.transient && transientErrors < maxTransient) {
        transientErrors += 1;
        opts.onTransientError?.(err, transientErrors);
        continue;
      }
      throw err;
    }
    transientErrors = 0;
    lastStatus = run.status;
    opts.onPoll?.(run);
    if (TERMINAL_STATUSES.includes(run.status)) return run;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
