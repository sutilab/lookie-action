import { describe, expect, it } from "vitest";
import { parseApiUrl, readInputs, resolvePrNumber, resolveRepo } from "./inputs";

const reader = (values: Record<string, string>) => (name: string) => values[name] ?? "";

describe("readInputs", () => {
  it("applies defaults", () => {
    expect(readInputs(reader({ token: "t", "api-url": "https://api.example.com" }))).toEqual({
      apiUrl: "https://api.example.com",
      token: "t",
      watcher: "review",
      prNumber: undefined,
      wait: true,
      timeoutMinutes: 10,
    });
  });

  it("parses explicit values", () => {
    const inputs = readInputs(
      reader({
        token: "t",
        "api-url": "http://localhost:3000/",
        watcher: "ci",
        "pr-number": "42",
        wait: "false",
        "timeout-minutes": "2.5",
      }),
    );
    expect(inputs).toMatchObject({
      apiUrl: "http://localhost:3000",
      watcher: "ci",
      prNumber: 42,
      wait: false,
      timeoutMinutes: 2.5,
    });
  });

  it("requires a token", () => {
    expect(() => readInputs(reader({}))).toThrow(/token/);
  });

  it("rejects an unknown watcher", () => {
    expect(() =>
      readInputs(reader({ token: "t", "api-url": "https://api.example.com", watcher: "deploy" })),
    ).toThrow(/watcher/);
  });

  it("rejects a non-numeric PR number", () => {
    expect(() => readInputs(reader({ token: "t", "pr-number": "abc" }))).toThrow(/pr-number/);
  });

  it("rejects a bad timeout and a non-http API URL", () => {
    expect(() => readInputs(reader({ token: "t", "timeout-minutes": "0" }))).toThrow(/timeout-minutes/);
    expect(() => readInputs(reader({ token: "t", "timeout-minutes": "soon" }))).toThrow(/timeout-minutes/);
    expect(() => readInputs(reader({ token: "t", "api-url": "api.example.com" }))).toThrow(/api-url/);
  });
});

describe("resolveRepo", () => {
  it("reads GITHUB_REPOSITORY", () => {
    expect(resolveRepo({ GITHUB_REPOSITORY: "acme/api" })).toBe("acme/api");
    expect(() => resolveRepo({})).toThrow(/GITHUB_REPOSITORY/);
    expect(() => resolveRepo({ GITHUB_REPOSITORY: "acme" })).toThrow(/owner\/name/);
  });
});

describe("resolvePrNumber", () => {
  const files = (contents: Record<string, string>) => (path: string) => {
    const c = contents[path];
    if (c === undefined) throw new Error(`ENOENT: ${path}`);
    return c;
  };
  const env = { GITHUB_EVENT_PATH: "/event.json", GITHUB_EVENT_NAME: "pull_request" };

  it("prefers the input", () => {
    expect(resolvePrNumber(5, env, files({}))).toBe(5);
  });

  it("reads pull_request.number from the event payload", () => {
    const read = files({ "/event.json": JSON.stringify({ action: "opened", pull_request: { number: 17 } }) });
    expect(resolvePrNumber(undefined, env, read)).toBe(17);
  });

  it("reads issue.number for a comment on a pull request", () => {
    const read = files({
      "/event.json": JSON.stringify({ issue: { number: 23, pull_request: { url: "x" } }, comment: {} }),
    });
    expect(resolvePrNumber(undefined, { ...env, GITHUB_EVENT_NAME: "issue_comment" }, read)).toBe(23);
  });

  it("refuses a plain issue comment and a push", () => {
    const issue = files({ "/event.json": JSON.stringify({ issue: { number: 23 } }) });
    expect(() => resolvePrNumber(undefined, { ...env, GITHUB_EVENT_NAME: "issue_comment" }, issue)).toThrow(
      /'issue_comment' event has no pull request.*pr-number/,
    );
    const push = files({ "/event.json": JSON.stringify({ ref: "refs/heads/main" }) });
    expect(() => resolvePrNumber(undefined, { ...env, GITHUB_EVENT_NAME: "push" }, push)).toThrow(
      /'push' event/,
    );
  });

  it("explains a missing or unreadable payload", () => {
    expect(() => resolvePrNumber(undefined, {}, files({}))).toThrow(/GITHUB_EVENT_PATH is not set/);
    expect(() => resolvePrNumber(undefined, env, files({}))).toThrow(/Could not read the event payload/);
    expect(() => resolvePrNumber(undefined, env, files({ "/event.json": "{not json" }))).toThrow(
      /Could not read the event payload/,
    );
  });
});

describe("parseApiUrl", () => {
  it("is required, since the token goes there", () => {
    expect(() => parseApiUrl("")).toThrow(/required/);
  });

  it("accepts https, and plain http to this machine only", () => {
    expect(parseApiUrl("https://api.example.com/")).toBe("https://api.example.com");
    expect(parseApiUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    for (const bad of ["http://api.example.com", "ftp://api.example.com", "api.example.com", "javascript:alert(1)"]) {
      expect(() => parseApiUrl(bad), bad).toThrow(/api-url/);
    }
  });

  it("refuses credentials, queries and fragments", () => {
    for (const bad of ["https://user:pw@api.example.com", "https://api.example.com/?x=1", "https://api.example.com/#x"]) {
      expect(() => parseApiUrl(bad), bad).toThrow(/api-url/);
    }
  });
});
