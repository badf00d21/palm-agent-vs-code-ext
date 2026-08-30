import { describe, expect, it } from "vitest";
import { isForbiddenModelName } from "../../src/model/config.js";

describe("isForbiddenModelName", () => {
  it("allows gemma4:12b", () => {
    expect(isForbiddenModelName("gemma4:12b")).toBe(false);
  });

  it("rejects gpt-4", () => {
    expect(isForbiddenModelName("gpt-4")).toBe(true);
  });

  it("rejects o3-mini", () => {
    expect(isForbiddenModelName("o3-mini")).toBe(true);
  });
});
