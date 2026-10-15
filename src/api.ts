/** Lookie REST client for the action: `POST /api/v1/runs` and `GET /api/v1/runs/{id}`. */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export interface Client {
  apiUrl: string;
  token: string;
  fetchImpl: FetchLike;
  sleep: Sleep;
  /** Called once when a 429 is retried, with the wait in milliseconds. */
  onRateLimited?: (waitMs: number) => void;
}

export type Severity = "error" | "warning" | "info";

export interface Finding {
  path: string;
  line: number | null;
  severity: Severity | string;
  title: string;
  body: string;
  instruction_ref?: string | null;
}

export interface Run {
  id: string;
  status: string;
  pr_number: number | null;
  head_sha: string | null;
  output: { summary?: unknown; [key: string]: unknown } | null;
  error: string | null;
  findings: Finding[];
  model: string | null;
  provider: string | null;
  tokens_in: number;
  tokens_out: number;
}

export interface Queued {
  id: string;
  status: string;
}

export interface TriggerBody {
  repo: string;
  pr: number;
  watcher: "review";
}

/** A failed API call. `transient` marks errors worth retrying while polling (network, 5xx). */
export class LookieApiError extends Error {
  readonly status: number | undefined;
  readonly transient: boolean;

  constructor(message: string, status?: number, transient = false) {
    super(message);
    this.name = "LookieApiError";
    this.status = status;
    this.transient = transient;
  }
}

/** One 429 is retried after Retry-After (capped); a second one fails. */
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_HINT =
  "the token was refused — create an org API token in Lookie → Settings and pass it as the 'token' input (from a repository secret)";

/** Queues a review run. The API answers 202 `{ id, status: "queued" }`. */
export async function createRun(client: Client, body: TriggerBody): Promise<Queued> {
  const json = await request(client, "POST", "/api/v1/runs", body, {
    notFound: `Lookie does not know ${body.repo} or PR #${body.pr} under this token's org: check that the Lookie GitHub App is installed on the repository and that the token belongs to the org that owns it`,
  });
  if (!isObject(json) || typeof json.id !== "string" || typeof json.status !== "string") {
    throw new LookieApiError("Lookie answered POST /api/v1/runs with an unexpected body (no run id).");
  }
  return { id: json.id, status: json.status };
}

/** Reads one run with its findings. */
export async function getRun(client: Client, id: string): Promise<Run> {
  const path = `/api/v1/runs/${encodeURIComponent(id)}`;
  const json = await request(client, "GET", path, undefined, {
    notFound: `Lookie run ${id} was not found for this token's org`,
  });
  if (!isObject(json) || typeof json.id !== "string" || typeof json.status !== "string") {
    throw new LookieApiError(`Lookie answered GET ${path} with an unexpected body.`);
  }
  return normalizeRun(json);
}

interface RequestContext {
  notFound: string;
}

async function request(
  client: Client,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  ctx: RequestContext,
): Promise<unknown> {
  const url = `${client.apiUrl}${path}`;
  let rateLimited = false;
  for (;;) {
    const res = await send(client, method, url, body);
    if (res.ok) return readJson(res, method, path);

    if (res.status === 429 && !rateLimited) {
      rateLimited = true;
      const waitMs = retryAfterMs(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => {});
      client.onRateLimited?.(waitMs);
      await client.sleep(waitMs);
      continue;
    }
    throw await errorFor(res, method, path, ctx);
  }
}

async function send(client: Client, method: string, url: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${client.token}`,
    accept: "application/json",
    "user-agent": "lookie-action",
  };
  // Never follow a redirect: it could carry the token to another host.
  const init: RequestInit = {
    method,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    return await client.fetchImpl(url, init);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new LookieApiError(
      `Could not reach Lookie at ${client.apiUrl} (${method}): ${reason}`,
      undefined,
      true,
    );
  }
}

async function readJson(res: Response, method: string, path: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new LookieApiError(`Lookie answered ${method} ${path} with a body that is not JSON.`, res.status);
  }
}

async function errorFor(res: Response, method: string, path: string, ctx: RequestContext) {
  const detail = await serverMessage(res);
  const suffix = detail ? ` Server said: ${detail}` : "";
  const status = res.status;
  switch (status) {
    case 401:
    case 403:
      return new LookieApiError(`Lookie answered HTTP ${status}: ${TOKEN_HINT}.${suffix}`, status);
    case 404:
      return new LookieApiError(`${ctx.notFound} (HTTP 404).${suffix}`, status);
    case 429:
      return new LookieApiError(
        `Lookie rate limited ${method} ${path} again after waiting for Retry-After (HTTP 429); try again later.${suffix}`,
        status,
      );
    case 400:
      return new LookieApiError(`Lookie rejected ${method} ${path} (HTTP 400).${suffix}`, status);
    default:
      return new LookieApiError(
        `Lookie API error on ${method} ${path} (HTTP ${status}).${suffix}`,
        status,
        status >= 500,
      );
  }
}

/** The API's `{ error, message }` body as one line; other bodies trimmed to 200 characters. */
async function serverMessage(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return "";
  }
  try {
    const json: unknown = JSON.parse(text);
    if (isObject(json)) {
      const code = typeof json.error === "string" ? json.error : "";
      const message = typeof json.message === "string" ? json.message : "";
      if (code && message) return `${message} (${code})`;
      return message || code;
    }
  } catch {
    // Not JSON: fall through to the trimmed text.
  }
  return text.trim().slice(0, 200);
}

/** Retry-After as delta-seconds or an HTTP date, capped at 60 s; 5 s when absent or unparsable. */
export function retryAfterMs(header: string | null, now: () => number = Date.now): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const trimmed = header.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return DEFAULT_RETRY_AFTER_MS;
    ms = at - now();
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

function normalizeRun(json: Record<string, unknown>): Run {
  const findings = Array.isArray(json.findings) ? json.findings.filter(isObject).map(normalizeFinding) : [];
  return {
    id: json.id as string,
    status: json.status as string,
    pr_number: typeof json.pr_number === "number" ? json.pr_number : null,
    head_sha: typeof json.head_sha === "string" ? json.head_sha : null,
    output: isObject(json.output) ? json.output : null,
    error: typeof json.error === "string" ? json.error : null,
    findings,
    model: typeof json.model === "string" ? json.model : null,
    provider: typeof json.provider === "string" ? json.provider : null,
    tokens_in: typeof json.tokens_in === "number" ? json.tokens_in : 0,
    tokens_out: typeof json.tokens_out === "number" ? json.tokens_out : 0,
  };
}

function normalizeFinding(f: Record<string, unknown>): Finding {
  return {
    path: typeof f.path === "string" ? f.path : "",
    line: typeof f.line === "number" ? f.line : null,
    severity: typeof f.severity === "string" ? f.severity : "info",
    title: typeof f.title === "string" ? f.title : "",
    body: typeof f.body === "string" ? f.body : "",
    instruction_ref: typeof f.instruction_ref === "string" ? f.instruction_ref : null,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
