import { describe, expect, it } from "vitest";
import { type ActionCore, run } from "./run";
import { fakeClock, fakeFetch, json, type Reply, runBody } from "./testing";

const TOKEN = "fake-token";

function harness(inputs: Record<string, string>, replies: Reply[], opts: { failSummary?: boolean } = {}) {
  const { fetchImpl, calls } = fakeFetch(replies);
  const clock = fakeClock();
  const outputs: Record<string, string | number> = {};
  const logs: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const secrets: string[] = [];
  const summaries: string[] = [];
  const core: ActionCore = {
    getInput: (name) => inputs[name] ?? "",
    setSecret: (s) => secrets.push(s),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    info: (m) => logs.push(m),
    warning: (m) => warnings.push(m),
    setFailed: (m) => failures.push(m),
    writeSummary: async (md) => {
      if (opts.failSummary) throw new Error("GITHUB_STEP_SUMMARY is not set");
      summaries.push(md);
    },
  };
  const exec = () =>
    run({
      core,
      env: {
        GITHUB_REPOSITORY: "acme/api",
        GITHUB_EVENT_PATH: "/event.json",
        GITHUB_EVENT_NAME: "pull_request",
      },
      fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
      readFile: () => JSON.stringify({ pull_request: { number: 7 } }),
    });
  const everything = () => [...logs, ...warnings, ...failures, ...summaries].join("\n");
  return { exec, calls, clock, outputs, logs, warnings, failures, secrets, summaries, everything };
}

const queued = () => json(202, { id: "run-1", status: "queued" });
const base = { token: TOKEN, "api-url": "https://lookie.test" };
const findings = [
  { path: "a.ts", line: 1, severity: "error", title: "E", body: "", instruction_ref: null },
  { path: "b.ts", line: 2, severity: "warning", title: "W1", body: "", instruction_ref: null },
  { path: "c.ts", line: 3, severity: "warning", title: "W2", body: "", instruction_ref: null },
];

describe("run", () => {
  it("triggers, polls, reports and sets outputs; findings do not fail the step", async () => {
    const h = harness(base, [
      queued(),
      json(200, runBody({ id: "run-1", status: "running" })),
      json(200, runBody({ id: "run-1", status: "posted", findings })),
    ]);
    await h.exec();

    expect(h.secrets).toEqual([TOKEN]);
    expect(JSON.parse(h.calls[0].init.body as string)).toEqual({
      repo: "acme/api",
      pr: 7,
      watcher: "review",
    });
    expect(h.calls.map((c) => c.url)).toEqual([
      "https://lookie.test/api/v1/runs",
      "https://lookie.test/api/v1/runs/run-1",
      "https://lookie.test/api/v1/runs/run-1",
    ]);
    expect(h.outputs).toEqual({ "run-id": "run-1", status: "posted", errors: 1, warnings: 2 });
    expect(h.failures).toEqual([]);
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0]).toContain("| 1 | 2 | 0 |");
    expect(h.logs).toContain("Findings: 1 error, 2 warnings, 0 info");
    expect(h.everything()).not.toContain(TOKEN);
  });

  it("uses the pr-number input over the event", async () => {
    const h = harness({ ...base, "pr-number": "99", wait: "false" }, [queued()]);
    await h.exec();
    expect(JSON.parse(h.calls[0].init.body as string).pr).toBe(99);
  });

  it("does not poll when wait is false", async () => {
    const h = harness({ ...base, wait: "false" }, [queued()]);
    await h.exec();
    expect(h.calls).toHaveLength(1);
    expect(h.outputs).toEqual({ "run-id": "run-1", status: "queued" });
    expect(h.failures).toEqual([]);
    expect(h.summaries).toEqual([]);
  });

  it("fails the step when the run failed", async () => {
    const h = harness(base, [
      queued(),
      json(200, runBody({ id: "run-1", status: "failed", error: "provider down" })),
    ]);
    await h.exec();
    expect(h.outputs.status).toBe("failed");
    expect(h.failures).toEqual(["Lookie run run-1 failed: provider down"]);
    expect(h.summaries).toHaveLength(1);
  });

  it.each(["skipped", "invalid_output", "not_implemented"])("succeeds on %s", async (status) => {
    const h = harness(base, [queued(), json(200, runBody({ id: "run-1", status, output: null }))]);
    await h.exec();
    expect(h.failures).toEqual([]);
    expect(h.outputs).toMatchObject({ status, errors: 0, warnings: 0 });
    if (status !== "skipped") expect(h.warnings).toHaveLength(1);
  });

  it("fails with a clear message on a refused token", async () => {
    const h = harness(base, [json(401, { error: "invalid_credentials" })]);
    await h.exec();
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatch(/the token was refused — create an org API token in Lookie → Settings/);
    expect(h.outputs).toEqual({});
    expect(h.everything()).not.toContain(TOKEN);
  });

  it("fails on timeout with the run id already set", async () => {
    const replies = Array.from({ length: 20 }, () => json(200, runBody({ id: "run-1", status: "running" })));
    const h = harness({ ...base, "timeout-minutes": "1" }, [queued(), ...replies]);
    await h.exec();
    expect(h.outputs).toEqual({ "run-id": "run-1", status: "queued" });
    expect(h.failures[0]).toMatch(/Timed out after 1 min/);
    expect(h.clock.now()).toBe(60_000);
  });

  it("warns and skips for the ci watcher", async () => {
    const h = harness({ ...base, watcher: "ci" }, []);
    await h.exec();
    expect(h.calls).toHaveLength(0);
    expect(h.failures).toEqual([]);
    expect(h.warnings[0]).toMatch(/'ci' watcher is not available yet/);
  });

  it("fails on invalid input but still masks the token first", async () => {
    const h = harness({ ...base, "pr-number": "abc" }, []);
    await h.exec();
    expect(h.secrets).toEqual([TOKEN]);
    expect(h.failures[0]).toMatch(/pr-number/);
  });

  it("only warns when the job summary cannot be written", async () => {
    const h = harness(base, [queued(), json(200, runBody({ id: "run-1", status: "posted" }))], {
      failSummary: true,
    });
    await h.exec();
    expect(h.failures).toEqual([]);
    expect(h.warnings[0]).toMatch(/Could not write the job summary/);
  });
});
