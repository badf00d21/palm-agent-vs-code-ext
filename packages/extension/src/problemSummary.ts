import type { ToolLocation } from "@palm-agent/shared";

/** A glance at what broke, not a problems panel. */
export const PROBLEM_ROW_LIMIT = 20;

/** One diagnostic, already stripped of anything editor-specific. */
export interface Problem {
  path: string;
  /** 1-based. */
  line: number;
  severity: "error" | "warning";
  /** Whichever extension published it: rust-analyzer, ts, eslint. */
  source?: string;
  message: string;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function summarise(errors: number, warnings: number, fileCount: number): string {
  const parts: string[] = [];
  if (errors > 0) {
    parts.push(plural(errors, "error"));
  }
  if (warnings > 0) {
    parts.push(plural(warnings, "warning"));
  }
  const where = fileCount === 1 ? "the file you kept" : `${fileCount} files you kept`;
  return `${parts.join(", ")} in ${where}`;
}

/**
 * Turns the diagnostics for the files just kept into a line the human can read
 * and rows they can click. Returns null when everything is clean: a status line
 * after every apply would be noise, and this exists to catch a kept edit that
 * broke something.
 */
export function buildProblemReport(
  problems: Problem[],
): { summary: string; locations: ToolLocation[] } | null {
  if (problems.length === 0) {
    return null;
  }
  const errors = problems.filter((p) => p.severity === "error").length;
  const files = new Set(problems.map((p) => p.path));
  const locations = problems.slice(0, PROBLEM_ROW_LIMIT).map((problem) => ({
    path: problem.path,
    line: problem.line,
    text: `${problem.severity}: ${problem.source ? `[${problem.source}] ` : ""}${problem.message}`
      .replace(/\s+/g, " ")
      .slice(0, 200),
  }));
  return {
    summary: summarise(errors, problems.length - errors, files.size),
    locations,
  };
}
