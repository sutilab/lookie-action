export type Watcher = "review" | "ci";

export interface Inputs {
  apiUrl: string;
  token: string;
  watcher: Watcher;
  prNumber: number | undefined;
  wait: boolean;
  timeoutMinutes: number;
}

export type InputReader = (name: string) => string;

/** Parses and validates the action inputs declared in action.yml. Throws on invalid input. */
export function readInputs(get: InputReader): Inputs {
  const token = get("token");
  if (!token) throw new Error("Input 'token' is required: an org API token from the Lookie dashboard.");

  const watcher = get("watcher") || "review";
  if (watcher !== "review" && watcher !== "ci") {
    throw new Error(`Input 'watcher' must be 'review' or 'ci', got '${watcher}'.`);
  }

  const rawPr = get("pr-number");
  let prNumber: number | undefined;
  if (rawPr) {
    prNumber = parsePrNumber(rawPr);
    if (prNumber === undefined) {
      throw new Error(`Input 'pr-number' must be a positive integer, got '${rawPr}'.`);
    }
  }

  const rawTimeout = get("timeout-minutes") || "10";
  const timeoutMinutes = Number(rawTimeout);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error(`Input 'timeout-minutes' must be a positive number, got '${rawTimeout}'.`);
  }

  const apiUrl = parseApiUrl(get("api-url"));

  return {
    apiUrl,
    token,
    watcher,
    prNumber,
    wait: (get("wait") || "true").toLowerCase() !== "false",
    timeoutMinutes,
  };
}

/**
 * The Lookie API base URL. Required: the token is sent to it, so there is no default to fall back
 * on. HTTPS only, except plain HTTP to this machine for local testing.
 */
export function parseApiUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) throw new Error("Input 'api-url' is required: the Lookie API URL from Lookie → Settings.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Input 'api-url' must be a URL, got '${value}'.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`Input 'api-url' must use https (plain http only for localhost), got '${value}'.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Input 'api-url' must not carry credentials, a query or a fragment.");
  }
  return value;
}

function parsePrNumber(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** `owner/name` from `GITHUB_REPOSITORY`. */
export function resolveRepo(env: Record<string, string | undefined>): string {
  const repo = env.GITHUB_REPOSITORY ?? "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(
      `GITHUB_REPOSITORY is '${repo}', expected 'owner/name'. The action must run inside GitHub Actions.`,
    );
  }
  return repo;
}

/**
 * The pull request to review: the `pr-number` input, else the triggering event's
 * `pull_request.number` (or `issue.number` for a comment on a pull request), read from the JSON
 * file at `GITHUB_EVENT_PATH`.
 */
export function resolvePrNumber(
  input: number | undefined,
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): number {
  if (input !== undefined) return input;
  const event = env.GITHUB_EVENT_NAME || "this event";
  const hint = `The '${event}' event has no pull request; set the 'pr-number' input or trigger on 'pull_request'.`;
  const path = env.GITHUB_EVENT_PATH;
  if (!path) throw new Error(`GITHUB_EVENT_PATH is not set. ${hint}`);

  let payload: unknown;
  try {
    payload = JSON.parse(readFile(path));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read the event payload at ${path}: ${reason}`);
  }
  if (typeof payload === "object" && payload !== null) {
    const p = payload as {
      pull_request?: { number?: unknown };
      issue?: { number?: unknown; pull_request?: unknown };
    };
    const fromPr = p.pull_request?.number;
    if (typeof fromPr === "number" && Number.isInteger(fromPr) && fromPr > 0) return fromPr;
    const fromIssue = p.issue?.number;
    if (
      p.issue?.pull_request &&
      typeof fromIssue === "number" &&
      Number.isInteger(fromIssue) &&
      fromIssue > 0
    ) {
      return fromIssue;
    }
  }
  throw new Error(hint);
}
