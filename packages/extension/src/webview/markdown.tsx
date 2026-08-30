import { Component, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isSafeMarkdownUrl } from "../safeUrl";

export { isSafeMarkdownUrl };

export function isPlainErrorText(text: string): boolean {
  return text.startsWith("Error: ");
}

class MarkdownBoundary extends Component<{ fallback: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <p>{this.props.fallback}</p>;
    }
    return this.props.children;
  }
}

export function AssistantMarkdown({
  text,
  onOpenUrl,
}: {
  text: string;
  onOpenUrl: (url: string) => void;
}) {
  return (
    <MarkdownBoundary fallback={text}>
      <div className="md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              if (!isSafeMarkdownUrl(href)) {
                return <span>{children}</span>;
              }
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenUrl(href);
                  }}
                >
                  {children}
                </a>
              );
            },
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </MarkdownBoundary>
  );
}
