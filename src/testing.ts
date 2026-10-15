// Test helpers shared by the *.test.ts files; not bundled (nothing in main.ts imports it).
import type { FetchLike, Run } from "./api";

export interface Call {
  url: string;
  init: RequestInit;
}

export type Reply = Response | Error | (() => Response);

/** A fetch that answers from a queue and records each call. */
export function fakeFetch(replies: Reply[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetchImpl, calls };
}

/** A clock that only moves when `sleep` is awaited. */
export function fakeClock(start = 0) {
  const sleeps: number[] = [];
  let t = start;
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function runBody(overrides: Partial<Run> = {}): Run {
  return {
    id: "0199e2a0-0000-7000-8000-000000000001",
    status: "posted",
    pr_number: 7,
    head_sha: "c".repeat(40),
    output: { summary: "Looks good overall." },
    error: null,
    findings: [],
    model: "claude-sonnet",
    provider: "anthropic",
    tokens_in: 1200,
    tokens_out: 300,
    ...overrides,
  };
}
