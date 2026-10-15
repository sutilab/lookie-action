import { type Client, createRun, type FetchLike, type Run, type Sleep } from "./api";
import { readInputs, resolvePrNumber, resolveRepo } from "./inputs";
import { pollRun } from "./poll";
import { countBySeverity, renderLog, renderMarkdown } from "./summary";

/** The slice of `@actions/core` the action uses, plus the job summary writer. */
export interface ActionCore {
  getInput(name: string): string;
  setSecret(secret: string): void;
  setOutput(name: string, value: string | number): void;
  info(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
  writeSummary(markdown: string): Promise<void>;
}

export interface Deps {
  core: ActionCore;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  sleep: Sleep;
  now: () => number;
  readFile: (path: string) => string;
}

/**
 * Triggers a Lookie review and, with `wait`, polls it to the end and reports it. Fails the step only
 * on bad input, API or transport errors, a timeout, or a run whose status is `failed`; findings never
 * fail it.
 */
export async function run(deps: Deps): Promise<void> {
  const { core } = deps;
  // Mask first, before anything can echo it.
  const rawToken = core.getInput("token");
  if (rawToken) core.setSecret(rawToken);

  try {
    const inputs = readInputs((name) => core.getInput(name));
    if (inputs.watcher === "ci") {
      core.warning(
        "The 'ci' watcher is not available yet; Lookie only runs 'review' for now. No run was requested.",
      );
      return;
    }

    const repo = resolveRepo(deps.env);
    const pr = resolvePrNumber(inputs.prNumber, deps.env, deps.readFile);
    const client: Client = {
      apiUrl: inputs.apiUrl,
      token: inputs.token,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      onRateLimited: (ms) =>
        core.warning(`Lookie rate limited the request; retrying once in ${Math.ceil(ms / 1000)} s.`),
    };

    const queued = await createRun(client, { repo, pr, watcher: "review" });
    core.setOutput("run-id", queued.id);
    core.setOutput("status", queued.status);
    core.info(`Queued Lookie review ${queued.id} for ${repo}#${pr} (${inputs.apiUrl}).`);
    if (!inputs.wait) {
      core.info("wait is false: not polling. The review will appear on the pull request when it is done.");
      return;
    }

    let lastStatus = queued.status;
    const finished = await pollRun(client, queued.id, {
      timeoutMs: inputs.timeoutMinutes * 60_000,
      now: deps.now,
      onPoll: (r) => {
        if (r.status !== lastStatus) core.info(`Run ${r.id}: ${r.status}`);
        lastStatus = r.status;
      },
      onTransientError: (err, attempt) =>
        core.warning(`Polling failed (attempt ${attempt}), retrying: ${err.message}`),
    });
    await report(deps, finished);
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

async function report(deps: Deps, run: Run): Promise<void> {
  const { core } = deps;
  const counts = countBySeverity(run.findings);
  core.setOutput("status", run.status);
  core.setOutput("errors", counts.errors);
  core.setOutput("warnings", counts.warnings);

  for (const line of renderLog(run)) core.info(line);
  try {
    await core.writeSummary(renderMarkdown(run));
  } catch (err) {
    core.warning(`Could not write the job summary: ${err instanceof Error ? err.message : String(err)}`);
  }

  switch (run.status) {
    case "failed":
      core.setFailed(`Lookie run ${run.id} failed: ${run.error ?? "no error message"}`);
      break;
    case "invalid_output":
      core.warning(
        `Lookie run ${run.id} produced output that did not validate, so no review was posted${run.error ? `: ${run.error}` : "."}`,
      );
      break;
    case "not_implemented":
      core.warning(`Lookie run ${run.id}: this watcher is not implemented yet; nothing was reviewed.`);
      break;
  }
}
