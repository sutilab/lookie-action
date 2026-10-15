import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import { run } from "./run";

// Entry point: wires the real runtime (Actions toolkit, fetch, timers, env) into `run`.
run({
  core: {
    getInput: (name) => core.getInput(name),
    setSecret: (secret) => core.setSecret(secret),
    setOutput: (name, value) => core.setOutput(name, value),
    info: (message) => core.info(message),
    warning: (message) => core.warning(message),
    setFailed: (message) => core.setFailed(message),
    writeSummary: async (markdown) => {
      await core.summary.addRaw(markdown, true).write();
    },
  },
  env: process.env,
  fetchImpl: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  readFile: (path) => readFileSync(path, "utf8"),
}).catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
