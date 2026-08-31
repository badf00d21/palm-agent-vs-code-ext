import { describe, expect, it } from "vitest";
import { parseToolCallsFromContent } from "../../src/model/completion-parse.js";

describe("completion-parse module", () => {
  it("parses a name+arguments object from the new module path", () => {
    const calls = parseToolCallsFromContent('{"name": "get_context", "arguments": {}}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function?.name).toBe("get_context");
  });
});
