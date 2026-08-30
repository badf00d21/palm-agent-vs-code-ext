import { describe, expect, it } from "vitest";
import { planFileSuggestions, SUGGEST_EXCLUDE, SUGGEST_LIMIT } from "../../src/workspace/suggest.js";

describe("planFileSuggestions", () => {
  it("skips an empty query", () => {
    expect(planFileSuggestions("")).toEqual({ action: "empty" });
    expect(planFileSuggestions("   ")).toEqual({ action: "empty" });
  });

  it("strips glob metacharacters and builds a prefix glob", () => {
    expect(planFileSuggestions("ab*c")).toEqual({
      action: "search",
      glob: "**/*abc*",
      exclude: SUGGEST_EXCLUDE,
      max: SUGGEST_LIMIT,
    });
  });

  it("treats a query that sanitizes to empty as empty", () => {
    expect(planFileSuggestions("***")).toEqual({ action: "empty" });
  });
});
