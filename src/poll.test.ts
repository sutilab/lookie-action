import { describe, expect, it } from "vitest";
import { type Client, LookieApiError } from "./api";
import { PollTimeoutError, pollRun } from "./poll";
import { fakeClock, fakeFetch, json, type Reply, runBody } from "./testing";

function setup(replies: Reply[]) {
  const { fetchImpl, calls } = fakeFetch(replies);
  const clock = fakeClock(1_000_000);
  const client: Client = { apiUrl: "https://lookie.test", token: "t", fetchImpl, sleep: clock.sleep };
  return { client, calls, clock };
}

const ID = runBody().id;
const status = (s: string) => json(200, runBody({ status: s }));

describe("pollRun", () => {
  it("polls with doubling backoff capped at 15 s until a terminal status", async () => {
    const t = setup([
      status("queued"),
      status("running"),
      status("running"),
      status("running"),
      status("running"),
      status("posted"),
    ]);
    const seen: string[] = [];
    const run = await pollRun(t.client, ID, {
      timeoutMs: 10 * 60_000,
      now: t.clock.now,
      onPoll: (r) => seen.push(r.status),
    });
    expect(run.status).toBe("posted");
    expect(t.clock.sleeps).toEqual([3000, 6000, 12000, 15000, 15000, 15000]);
    expect(seen).toEqual(["queued", "running", "running", "running", "running", "posted"]);
    expect(t.calls.every((c) => c.url === `https://lookie.test/api/v1/runs/${ID}`)).toBe(true);
  });

  it.each(["posted", "skipped", "failed", "invalid_output", "not_implemented"])(
    "stops at %s",
    async (terminal) => {
      const t = setup([status(terminal)]);
      await expect(pollRun(t.client, ID, { timeoutMs: 60_000, now: t.clock.now })).resolves.toMatchObject({
        status: terminal,
      });
      expect(t.calls).toHaveLength(1);
    },
  );

  it("times out at the deadline, cutting the last wait short", async () => {
    const t = setup(Array.from({ length: 10 }, () => status("running")));
    const err = await pollRun(t.client, ID, { timeoutMs: 30_000, now: t.clock.now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect((err as PollTimeoutError).lastStatus).toBe("running");
    expect((err as Error).message).toMatch(/Timed out after 30 s.*last status: running.*timeout-minutes/);
    // 3 + 6 + 12 = 21 s, then 9 s to the deadline, then no more polls.
    expect(t.clock.sleeps).toEqual([3000, 6000, 12000, 9000]);
    expect(t.calls).toHaveLength(4);
  });

  it("tolerates a couple of transient errors in a row", async () => {
    const t = setup([
      new TypeError("socket hang up"),
      new Response("bad gateway", { status: 502 }),
      status("posted"),
    ]);
    const attempts: number[] = [];
    const run = await pollRun(t.client, ID, {
      timeoutMs: 60_000,
      now: t.clock.now,
      onTransientError: (_e, n) => attempts.push(n),
    });
    expect(run.status).toBe("posted");
    expect(attempts).toEqual([1, 2]);
  });

  it("gives up after too many transient errors", async () => {
    const t = setup([
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    ]);
    const err = await pollRun(t.client, ID, { timeoutMs: 60_000, now: t.clock.now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookieApiError);
    expect((err as LookieApiError).status).toBe(503);
  });

  it("fails at once on auth errors", async () => {
    const t = setup([json(401, { error: "invalid_credentials" })]);
    const err = await pollRun(t.client, ID, { timeoutMs: 60_000, now: t.clock.now }).catch((e: unknown) => e);
    expect((err as LookieApiError).status).toBe(401);
    expect(t.calls).toHaveLength(1);
  });
});
