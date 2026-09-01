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
  function render(text: string): string {
    return renderToStaticMarkup(
      createElement(AssistantMarkdown, {
        text,
        onOpenUrl: () => undefined,
        onOpenLocation: () => undefined,
      }),
    );
  }

  it("renders bold and a fenced code block", () => {
    const html = render("**x**\n\n```\ncode\n```");
    expect(html).toContain("<strong>x</strong>");
    expect(html).toContain("<pre>");
    expect(html).toContain("code");
  });

  it("renders a mentioned location as a clickable button", () => {
    const html = render("the call is at src/controller.rs:18 today");
    expect(html).toContain('class="location-link"');
    expect(html).toContain("src/controller.rs:18");
  });

  it("does not linkify a path inside a code fence", () => {
    const html = render("```\nsrc/controller.rs:18\n```");
    expect(html).not.toContain("location-link");
  });
});
