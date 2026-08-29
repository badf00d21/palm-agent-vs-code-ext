import { describe, expect, it } from "vitest";
import { handleUserMessage } from "./echo.js";

describe("handleUserMessage", () => {
  it("echoes trimmed text as assistant_delta then done", () => {
    expect(handleUserMessage("  hello  ")).toEqual([
      { type: "assistant_delta", text: "hello" },
      { type: "done" },
    ]);
  });

  it("returns error for empty or whitespace-only text", () => {
    expect(handleUserMessage("   ")).toEqual([
      { type: "error", message: "Empty message" },
    ]);
  });
});
