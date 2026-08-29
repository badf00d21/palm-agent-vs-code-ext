import { describe, expect, it } from "vitest";
import { isForbiddenModelName } from "./config.js";

describe("isForbiddenModelName", () => {
  it("allows deepseek-v4-pro (qwen coder alias)", () => {
    expect(isForbiddenModelName("deepseek-v4-pro")).toBe(false);
  });

  it("rejects gpt-4", () => {
    expect(isForbiddenModelName("gpt-4")).toBe(true);
  });

  it("rejects o3-mini", () => {
    expect(isForbiddenModelName("o3-mini")).toBe(true);
  });
});
