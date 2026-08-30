import { describe, expect, it } from "vitest";
import { contextRingRatio, formatContextTooltip } from "./contextMeter";

describe("formatContextTooltip", () => {
  it("formats thousands with a / max", () => {
    expect(formatContextTooltip(4210, 16384)).toBe("4.2k / 16k");
  });
  it("omits max when null", () => {
    expect(formatContextTooltip(4210, null)).toBe("4.2k");
  });
});

describe("contextRingRatio", () => {
  it("is 0 without a max and clamps above 1", () => {
    expect(contextRingRatio(4210, null)).toBe(0);
    expect(contextRingRatio(18000, 16384)).toBe(1);
    expect(contextRingRatio(8192, 16384)).toBe(0.5);
  });
});
