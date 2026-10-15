import type { Finding, Run } from "./api";

export interface Counts {
  errors: number;
  warnings: number;
  info: number;
}

/** Rows shown in the job summary table; the rest are counted, not listed. */
export const MAX_TABLE_ROWS = 100;

const STATUS_TEXT: Record<string, string> = {
  posted: "posted: the review is on the pull request",
  skipped: "skipped: nothing to review",
  failed: "failed",
  invalid_output: "invalid output: the model's answer did not validate, so nothing was posted",
  not_implemented: "not implemented: this watcher has no runner yet",
};

export function countBySeverity(findings: readonly Finding[]): Counts {
  const counts: Counts = { errors: 0, warnings: 0, info: 0 };
  for (const f of findings) {
    if (f.severity === "error") counts.errors += 1;
    else if (f.severity === "warning") counts.warnings += 1;
    else counts.info += 1;
  }
  return counts;
}

/** The review summary markdown from `output.summary`, if any. */
export function summaryText(run: Run): string {
  const summary = run.output?.summary;
  return typeof summary === "string" ? summary.trim() : "";
}

/** Plain-text lines for the step log. */
export function renderLog(run: Run): string[] {
  const counts = countBySeverity(run.findings);
  const lines = [`Lookie run ${run.id}: ${STATUS_TEXT[run.status] ?? run.status}`];
  const at = [
    run.pr_number !== null ? `PR #${run.pr_number}` : "",
    run.head_sha ? `head ${run.head_sha.slice(0, 7)}` : "",
    run.model ? `model ${run.provider ? `${run.provider}/` : ""}${run.model}` : "",
    run.tokens_in || run.tokens_out ? `${run.tokens_in} in / ${run.tokens_out} out tokens` : "",
  ].filter(Boolean);
  if (at.length) lines.push(at.join(", "));
  if (run.error) lines.push(`Error: ${run.error}`);
  lines.push(`Findings: ${formatCounts(counts)}`);
  for (const f of run.findings) {
    lines.push(`  ${f.severity.padEnd(7)} ${location(f)}  ${oneLine(f.title)}`);
  }
  const summary = summaryText(run);
  if (summary) lines.push("", "Summary:", summary);
  return lines;
}

/** Markdown for the job summary (`core.summary`). */
export function renderMarkdown(run: Run): string {
  const counts = countBySeverity(run.findings);
  const out: string[] = ["## Lookie review", ""];

  const meta = [`**Status:** ${escapeCell(STATUS_TEXT[run.status] ?? run.status)}`];
  if (run.pr_number !== null) meta.push(`**PR:** #${run.pr_number}`);
  if (run.head_sha) meta.push(`**Head:** <code>${escapeCode(run.head_sha.slice(0, 7))}</code>`);
  meta.push(`**Run:** <code>${escapeCode(run.id)}</code>`);
  out.push(meta.join(" · "), "");

  if (run.error) out.push(`> **Error:** ${escapeCell(run.error)}`, "");

  out.push(
    "| Errors | Warnings | Info |",
    "| ---: | ---: | ---: |",
    `| ${counts.errors} | ${counts.warnings} | ${counts.info} |`,
    "",
  );

  if (run.findings.length > 0) {
    out.push("### Findings", "", "| Location | Severity | Title |", "| --- | --- | --- |");
    for (const f of run.findings.slice(0, MAX_TABLE_ROWS)) {
      out.push(
        `| <code>${escapeCode(location(f))}</code> | ${escapeCell(f.severity)} | ${escapeCell(f.title)} |`,
      );
    }
    if (run.findings.length > MAX_TABLE_ROWS) {
      out.push("", `…and ${run.findings.length - MAX_TABLE_ROWS} more; see the pull request.`);
    }
    out.push("");
  }

  const summary = summaryText(run);
  if (summary) out.push("### Summary", "", summary, "");

  if (run.model) {
    const model = `${run.provider ? `${run.provider}/` : ""}${run.model}`;
    out.push(
      `<sub>${escapeCell(model)} · ${run.tokens_in} input / ${run.tokens_out} output tokens</sub>`,
      "",
    );
  }
  return out.join("\n");
}

function formatCounts(c: Counts): string {
  return `${c.errors} ${plural(c.errors, "error")}, ${c.warnings} ${plural(c.warnings, "warning")}, ${c.info} info`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function location(f: Finding): string {
  return f.line !== null ? `${f.path}:${f.line}` : f.path;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/**
 * Escapes text for a markdown table cell: HTML is inert, `|` cannot split the cell, and backticks,
 * emphasis and link brackets render literally.
 */
export function escapeCell(text: string): string {
  return oneLine(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]|])/g, "\\$1");
}

/** Escapes text inside a `<code>` element in a table cell, where markdown does not apply but `|` still splits. */
export function escapeCode(text: string): string {
  return oneLine(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;");
}
