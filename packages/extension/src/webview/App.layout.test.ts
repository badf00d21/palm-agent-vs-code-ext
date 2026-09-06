import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const statusOrb = readFileSync(new URL("./StatusOrb.tsx", import.meta.url), "utf8");

function rule(selector: string): string {
  const match = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]+)\\}`,
  ).exec(css);
  if (!match?.[1]) {
    throw new Error(`Missing CSS rule: ${selector}`);
  }
  return match[1];
}

describe("review dock layout", () => {
  it("scrolls cards inside a fixed dock while keeping the summary outside the scroller", () => {
    expect(rule(".review-dock")).toContain("display: flex");
    expect(rule(".review-dock")).toContain("flex-direction: column");
    expect(rule(".review-dock")).not.toContain("overflow: auto");
    expect(rule(".review-dock-body")).toContain("overflow: auto");
    expect(rule(".review-dock-summary")).toContain("flex: 0 0 auto");
  });

  it("links the summary disclosure to the dock body", () => {
    expect(app).toContain('id="review-dock-body"');
    expect(app).toContain('aria-controls="review-dock-body"');
  });
});

describe("status orb layout", () => {
  it("uses a scaled inner wrapper and a layout-sized outer footprint", () => {
    expect(rule(".status-orb")).toContain("width: calc(100px * var(--size))");
    expect(rule(".status-orb")).toContain("height: calc(100px * var(--size))");
    expect(rule(".status-orb")).not.toContain("transform: scale");
    expect(rule(".status-orb-inner")).toContain("transform: scale(var(--size))");
    expect(rule(".status-orb-inner")).toContain("transform-origin: top left");
    expect(statusOrb).toContain('className="status-orb-inner"');
  });

  it("uses a unique mask id per instance and supports a hover title", () => {
    expect(statusOrb).toContain("useId");
    expect(statusOrb).toContain("status-orb-clip-");
    expect(statusOrb).toContain("title?: string");
    expect(statusOrb).toContain("title={title}");
    expect(statusOrb).toContain("status-orb-mask");
  });

  it("lays out research worker orbs in a row", () => {
    expect(rule(".status-orb-row")).toContain("display: inline-flex");
    expect(app).toContain("showResearchOrbs");
    expect(app).toContain("researchWorkers.map");
    expect(app).toContain("title={worker.question}");
  });
});
