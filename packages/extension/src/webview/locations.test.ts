import { describe, expect, it } from "vitest";
import { LOCATION_SCHEME, linkifyLocations, parseLocationHref } from "./locations";

describe("linkifyLocations", () => {
  it("turns a path:line mention into a link", () => {
    expect(linkifyLocations("see src/controller.rs:18 for the call")).toBe(
      `see [src/controller.rs:18](${LOCATION_SCHEME}src/controller.rs:18) for the call`,
    );
  });

  it("keeps a column in the label but not in the target", () => {
    expect(linkifyLocations("at a.ts:12:4")).toBe(
      `at [a.ts:12:4](${LOCATION_SCHEME}a.ts:12)`,
    );
  });

  it("links every mention in a list", () => {
    const out = linkifyLocations("- view.rs:3\n- controller.rs:18");
    expect(out).toContain(`[view.rs:3](${LOCATION_SCHEME}view.rs:3)`);
    expect(out).toContain(`[controller.rs:18](${LOCATION_SCHEME}controller.rs:18)`);
  });

  it("leaves fenced code alone, where a path is an example not a destination", () => {
    const md = "before a.ts:1\n```rust\nlet p = \"b.rs:22\";\n```\nafter c.ts:3";
    const out = linkifyLocations(md);
    expect(out).toContain('let p = "b.rs:22";');
    expect(out).not.toContain(`${LOCATION_SCHEME}b.rs:22`);
    expect(out).toContain(`${LOCATION_SCHEME}a.ts:1`);
    expect(out).toContain(`${LOCATION_SCHEME}c.ts:3`);
  });

  it("leaves inline code alone", () => {
    expect(linkifyLocations("run `main.rs:7` please")).toBe("run `main.rs:7` please");
  });

  it("does not corrupt an existing markdown link", () => {
    const md = "[docs](https://example.com/a.html:5)";
    expect(linkifyLocations(md)).toBe(md);
  });

  it("ignores a url with a port", () => {
    const md = "open http://localhost:11434 now";
    expect(linkifyLocations(md)).toBe(md);
  });

  it("ignores prose that merely contains a colon and digits", () => {
    expect(linkifyLocations("the ratio is 3:2 overall")).toBe("the ratio is 3:2 overall");
    expect(linkifyLocations("meet at 10:30")).toBe("meet at 10:30");
  });

  it("leaves an unterminated fence untouched to the end", () => {
    const md = "text a.ts:1\n```\nb.rs:2";
    const out = linkifyLocations(md);
    expect(out).toContain(`${LOCATION_SCHEME}a.ts:1`);
    expect(out).not.toContain(`${LOCATION_SCHEME}b.rs:2`);
  });
});

describe("parseLocationHref", () => {
  it("reads path and line back out", () => {
    expect(parseLocationHref(`${LOCATION_SCHEME}src/a.ts:42`)).toEqual({
      path: "src/a.ts",
      line: 42,
    });
  });

  it("returns null for a normal url", () => {
    expect(parseLocationHref("https://example.com")).toBeNull();
  });

  it("returns null for a malformed line number", () => {
    expect(parseLocationHref(`${LOCATION_SCHEME}a.ts:0`)).toBeNull();
    expect(parseLocationHref(`${LOCATION_SCHEME}a.ts:abc`)).toBeNull();
  });
});
