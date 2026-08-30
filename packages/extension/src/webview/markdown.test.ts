import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMarkdown, isPlainErrorText, isSafeMarkdownUrl } from "./markdown";

describe("isSafeMarkdownUrl", () => {
  it("allows http(s) and mailto only", () => {
    expect(isSafeMarkdownUrl("https://example.com")).toBe(true);
    expect(isSafeMarkdownUrl("http://localhost")).toBe(true);
    expect(isSafeMarkdownUrl("mailto:a@b.c")).toBe(true);
    expect(isSafeMarkdownUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeMarkdownUrl("vscode://file")).toBe(false);
  });
});

describe("isPlainErrorText", () => {
  it("detects Error: prefix", () => {
    expect(isPlainErrorText("Error: boom")).toBe(true);
    expect(isPlainErrorText("**ok**")).toBe(false);
  });
});

describe("AssistantMarkdown", () => {
  it("renders bold and a fenced code block", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        text: "**x**\n\n```\ncode\n```",
        onOpenUrl: () => undefined,
      }),
    );
    expect(html).toContain("<strong>x</strong>");
    expect(html).toContain("<pre>");
    expect(html).toContain("code");
  });
});
