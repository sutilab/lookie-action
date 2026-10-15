import { describe, expect, it } from "vitest";
import type { Finding } from "./api";
import {
  countBySeverity,
  escapeCell,
  escapeCode,
  MAX_TABLE_ROWS,
  renderLog,
  renderMarkdown,
} from "./summary";
import { runBody } from "./testing";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  path: "src/app.ts",
  line: 12,
  severity: "warning",
  title: "Title",
  body: "Body",
  instruction_ref: null,
  ...overrides,
});

describe("countBySeverity", () => {
  it("counts errors, warnings, and the rest as info", () => {
    expect(
      countBySeverity([
        finding({ severity: "error" }),
        finding({ severity: "warning" }),
        finding({ severity: "warning" }),
        finding({ severity: "info" }),
      ]),
    ).toEqual({ errors: 1, warnings: 2, info: 1 });
  });
});

describe("escaping", () => {
  it("escapes pipes, backticks, markdown and HTML in table cells", () => {
    expect(escapeCell("a | b `c` *d* <img src=x>")).toBe("a \\| b \\`c\\` \\*d\\* &lt;img src=x&gt;");
    expect(escapeCell("line one\nline two")).toBe("line one line two");
  });

  it("keeps code cells literal but stops pipes from splitting the row", () => {
    expect(escapeCode("weird|name`.ts:3")).toBe("weird&#124;name`.ts:3");
  });
});

describe("renderMarkdown", () => {
  it("renders heading, status, counts, findings table and summary", () => {
    const md = renderMarkdown(
      runBody({
        findings: [
          finding({ severity: "error", title: "Use `a | b` safely", path: "src/x|y.ts", line: 3 }),
          finding({ severity: "info", title: "Nit", line: null }),
        ],
        output: { summary: "**Two** things to look at." },
      }),
    );
    expect(md).toContain("## Lookie review");
    expect(md).toContain("**Status:** posted: the review is on the pull request");
    expect(md).toContain("**PR:** #7");
    expect(md).toContain("<code>ccccccc</code>");
    expect(md).toContain("| Errors | Warnings | Info |\n| ---: | ---: | ---: |\n| 1 | 0 | 1 |");
    expect(md).toContain("| <code>src/x&#124;y.ts:3</code> | error | Use \\`a \\| b\\` safely |");
    expect(md).toContain("| <code>src/app.ts</code> | info | Nit |");
    expect(md).toContain("### Summary\n\n**Two** things to look at.");
    expect(md).toContain("anthropic/claude-sonnet · 1200 input / 300 output tokens");
    // Each table row has exactly four unescaped pipes.
    for (const row of md.split("\n").filter((l) => l.startsWith("| <code>"))) {
      expect(row.replace(/\\\|/g, "").split("|")).toHaveLength(5);
    }
  });

  it("shows the error and omits the findings table when there are none", () => {
    const md = renderMarkdown(runBody({ status: "failed", error: "model timed out", output: null }));
    expect(md).toContain("**Status:** failed");
    expect(md).toContain("> **Error:** model timed out");
    expect(md).not.toContain("### Findings");
    expect(md).not.toContain("### Summary");
  });

  it("caps the findings table", () => {
    const findings = Array.from({ length: MAX_TABLE_ROWS + 5 }, (_, i) => finding({ line: i + 1 }));
    const md = renderMarkdown(runBody({ findings }));
    expect(md.split("\n").filter((l) => l.startsWith("| <code>"))).toHaveLength(MAX_TABLE_ROWS);
    expect(md).toContain("…and 5 more");
  });
});

describe("renderLog", () => {
  it("prints status, counts, one line per finding and the summary", () => {
    const lines = renderLog(
      runBody({
        findings: [finding({ severity: "error", title: "Bad\nthing" }), finding()],
        output: { summary: "Summary text" },
      }),
    );
    expect(lines[0]).toMatch(/^Lookie run .*: posted/);
    expect(lines).toContain("Findings: 1 error, 1 warning, 0 info");
    expect(lines).toContain("  error   src/app.ts:12  Bad thing");
    expect(lines.slice(-2)).toEqual(["Summary:", "Summary text"]);
  });
});
