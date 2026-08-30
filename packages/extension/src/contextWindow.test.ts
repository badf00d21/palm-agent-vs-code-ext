import { describe, expect, it } from "vitest";
import { createContextWindow, ollamaNativeOrigin, parseLoadedContextLength } from "./contextWindow";

describe("ollamaNativeOrigin", () => {
  it("strips a trailing /v1", () => {
    expect(ollamaNativeOrigin("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(ollamaNativeOrigin("http://localhost:11434/v1/")).toBe("http://localhost:11434");
  });
});

describe("parseLoadedContextLength", () => {
  const payload = {
    models: [{ name: "gemma4:12b", model: "gemma4:12b", context_length: 16384 }],
  };
  it("reads context_length for the configured model", () => {
    expect(parseLoadedContextLength(payload, "gemma4:12b")).toBe(16384);
  });
  it("returns null when the model is missing", () => {
    expect(parseLoadedContextLength(payload, "other")).toBeNull();
    expect(parseLoadedContextLength({ models: [] }, "gemma4:12b")).toBeNull();
    expect(parseLoadedContextLength({}, "gemma4:12b")).toBeNull();
  });
});

describe("createContextWindow", () => {
  it("attaches max from /api/ps and caches the second call", async () => {
    let calls = 0;
    const window = createContextWindow({
      baseUrl: () => "http://localhost:11434/v1",
      model: () => "gemma4:12b",
      fetchImpl: async (url) => {
        calls += 1;
        expect(String(url)).toBe("http://localhost:11434/api/ps");
        return new Response(
          JSON.stringify({ models: [{ name: "gemma4:12b", context_length: 16384 }] }),
          { status: 200 },
        );
      },
    });
    await expect(window.attachMax(4210)).resolves.toEqual({
      type: "context_usage",
      used: 4210,
      max: 16384,
    });
    await expect(window.attachMax(5000)).resolves.toEqual({
      type: "context_usage",
      used: 5000,
      max: 16384,
    });
    expect(calls).toBe(1);
  });

  it("returns max null when /api/ps fails", async () => {
    const window = createContextWindow({
      baseUrl: () => "http://localhost:11434/v1",
      model: () => "gemma4:12b",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    await expect(window.attachMax(12)).resolves.toEqual({
      type: "context_usage",
      used: 12,
      max: null,
    });
  });
});
