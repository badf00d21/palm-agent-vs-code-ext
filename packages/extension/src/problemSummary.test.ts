import { describe, expect, it } from "vitest";
import {
  PROBLEM_ROW_LIMIT,
  buildProblemReport,
  summarise,
  type Problem,
} from "./problemSummary";

function problem(overrides: Partial<Problem> = {}): Problem {
  return {
    path: "src/view.rs",
    line: 12,
    severity: "error",
    message: "expected &str, found String",
    ...overrides,
  };
}

describe("summarise", () => {
  it("names both kinds when both are present", () => {
    expect(summarise(2, 1, 1)).toBe("2 errors, 1 warning in the file you kept");
  });

  it("uses the singular for one", () => {
    expect(summarise(1, 0, 1)).toBe("1 error in the file you kept");
  });

  it("leaves out the kind that has none", () => {
    expect(summarise(0, 3, 1)).toBe("3 warnings in the file you kept");
  });

  it("counts the files when more than one is affected", () => {
    expect(summarise(4, 0, 2)).toBe("4 errors in 2 files you kept");
  });
});

describe("buildProblemReport", () => {
  it("says nothing when the kept files are clean", () => {
    // Silence is the point: a status line after every apply would be noise.
    expect(buildProblemReport([])).toBeNull();
  });

  it("summarises and lists each problem as somewhere to go", () => {
    const report = buildProblemReport([
      problem({ source: "rust-analyzer" }),
      problem({ line: 20, severity: "warning", message: "unused import" }),
    ]);
    expect(report?.summary).toBe("1 error, 1 warning in the file you kept");
    expect(report?.locations).toEqual([
      {
        path: "src/view.rs",
        line: 12,
        text: "error: [rust-analyzer] expected &str, found String",
      },
      { path: "src/view.rs", line: 20, text: "warning: unused import" },
    ]);
  });

  it("carries whichever extension published the diagnostic", () => {
    const report = buildProblemReport([problem({ source: "eslint", message: "no-unused-vars" })]);
    expect(report?.locations[0]?.text).toContain("[eslint]");
  });

  it("flattens a multi-line diagnostic message onto one row", () => {
    const report = buildProblemReport([problem({ message: "expected this\n  found that" })]);
    expect(report?.locations[0]?.text).toBe("error: expected this found that");
  });

  it("counts every problem but only lists the first rows", () => {
    const many = Array.from({ length: PROBLEM_ROW_LIMIT + 5 }, (_, i) => problem({ line: i + 1 }));
    const report = buildProblemReport(many);
    expect(report?.locations).toHaveLength(PROBLEM_ROW_LIMIT);
    expect(report?.summary).toBe(`${PROBLEM_ROW_LIMIT + 5} errors in the file you kept`);
  });

  it("counts distinct files", () => {
    const report = buildProblemReport([
      problem({ path: "a.rs" }),
      problem({ path: "b.rs" }),
      problem({ path: "b.rs", line: 30 }),
    ]);
    expect(report?.summary).toBe("3 errors in 2 files you kept");
  });
});
