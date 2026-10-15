import { describe, expect, it } from "vitest";
import { type Client, createRun, getRun, LookieApiError, retryAfterMs } from "./api";
import { fakeClock, fakeFetch, json, type Reply, runBody } from "./testing";

const TOKEN = "fake-token";
const body = { repo: "acme/api", pr: 7, watcher: "review" as const };

function client(replies: Reply[]) {
  const { fetchImpl, calls } = fakeFetch(replies);
  const clock = fakeClock();
  const rateLimited: number[] = [];
  const c: Client = {
    apiUrl: "https://lookie.test",
    token: TOKEN,
    fetchImpl,
    sleep: clock.sleep,
    onRateLimited: (ms) => rateLimited.push(ms),
  };
  return { client: c, calls, clock, rateLimited };
}

async function failure(p: Promise<unknown>): Promise<LookieApiError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LookieApiError);
  return err as LookieApiError;
}

describe("createRun", () => {
  it("posts the trigger body with bearer auth and JSON headers", async () => {
    const t = client([json(202, { id: "run-1", status: "queued" })]);
    await expect(createRun(t.client, body)).resolves.toEqual({ id: "run-1", status: "queued" });

    expect(t.calls).toHaveLength(1);
    const [{ url, init }] = t.calls;
    expect(url).toBe("https://lookie.test/api/v1/runs");
    expect(init.method).toBe("POST");
    expect(init.redirect, "a redirect could carry the token to another host").toBe("error");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.accept).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ repo: "acme/api", pr: 7, watcher: "review" });
  });

  it.each([401, 403])("maps %i to a token message without echoing the token", async (status) => {
    const t = client([json(status, { error: "invalid_credentials", message: "unknown token" })]);
    const err = await failure(createRun(t.client, body));
    expect(err.status).toBe(status);
    expect(err.message).toMatch(/the token was refused/);
    expect(err.message).toMatch(/Lookie → Settings/);
    expect(err.message).toMatch(/unknown token \(invalid_credentials\)/);
    expect(err.message).not.toContain(TOKEN);
    expect(err.transient).toBe(false);
  });

  it("maps 404 to a repo/PR message", async () => {
    const t = client([json(404, { error: "not_found", message: null })]);
    const err = await failure(createRun(t.client, body));
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/acme\/api or PR #7/);
    expect(err.message).toMatch(/GitHub App is installed/);
  });

  it("maps 400 with the server message", async () => {
    const t = client([json(400, { error: "bad_request", message: "unknown watcher" })]);
    const err = await failure(createRun(t.client, body));
    expect(err.message).toMatch(/HTTP 400.*unknown watcher/);
  });

  it("honours Retry-After once on 429, then succeeds", async () => {
    const t = client([
      json(429, { error: "rate_limited" }, { "retry-after": "7" }),
      json(202, { id: "run-1", status: "queued" }),
    ]);
    await expect(createRun(t.client, body)).resolves.toMatchObject({ id: "run-1" });
    expect(t.clock.sleeps).toEqual([7000]);
    expect(t.rateLimited).toEqual([7000]);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].init.body).toBe(t.calls[0].init.body);
  });

  it("fails on a second 429", async () => {
    const t = client([
      json(429, {}, { "retry-after": "2" }),
      json(429, { error: "rate_limited", message: "slow down" }, { "retry-after": "2" }),
    ]);
    const err = await failure(createRun(t.client, body));
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/rate limited.*again.*slow down/);
    expect(t.calls).toHaveLength(2);
    expect(t.clock.sleeps).toEqual([2000]);
  });

  it("maps 500 to a transient API error", async () => {
    const t = client([new Response("upstream exploded", { status: 500 })]);
    const err = await failure(createRun(t.client, body));
    expect(err.status).toBe(500);
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/HTTP 500.*upstream exploded/);
  });

  it("maps a network error to a transient transport error", async () => {
    const t = client([new TypeError("fetch failed")]);
    const err = await failure(createRun(t.client, body));
    expect(err.status).toBeUndefined();
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/Could not reach Lookie at https:\/\/lookie\.test.*fetch failed/);
  });

  it("rejects a 2xx body without an id", async () => {
    const t = client([json(202, { status: "queued" })]);
    const err = await failure(createRun(t.client, body));
    expect(err.message).toMatch(/unexpected body/);
  });
});

describe("getRun", () => {
  it("gets the run with bearer auth and no body", async () => {
    const run = runBody({
      findings: [{ path: "a.ts", line: 3, severity: "error", title: "T", body: "B", instruction_ref: null }],
    });
    const t = client([json(200, { ...run, tool_calls: [], notes: [] })]);
    await expect(getRun(t.client, run.id)).resolves.toEqual(run);
    const [{ url, init }] = t.calls;
    expect(url).toBe(`https://lookie.test/api/v1/runs/${run.id}`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("maps 404 to a run-not-found message", async () => {
    const t = client([json(404, { error: "not_found" })]);
    const err = await failure(getRun(t.client, "run-9"));
    expect(err.message).toMatch(/run run-9 was not found/);
  });

  it("defaults missing optional fields", async () => {
    const t = client([json(200, { id: "r", status: "queued" })]);
    await expect(getRun(t.client, "r")).resolves.toMatchObject({
      findings: [],
      output: null,
      error: null,
      tokens_in: 0,
    });
  });
});

describe("retryAfterMs", () => {
  it("reads seconds, HTTP dates, and caps", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("3600")).toBe(60_000);
    expect(retryAfterMs(null)).toBe(5000);
    expect(retryAfterMs("soon")).toBe(5000);
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(retryAfterMs("Thu, 15 Oct 2026 12:00:10 GMT", () => now)).toBe(10_000);
    expect(retryAfterMs("Thu, 15 Oct 2026 11:00:00 GMT", () => now)).toBe(0);
  });
});
