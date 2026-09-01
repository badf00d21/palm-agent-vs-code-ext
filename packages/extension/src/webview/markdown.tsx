import { Component, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isSafeMarkdownUrl } from "../safeUrl";
import { LOCATION_SCHEME, linkifyLocations, parseLocationHref } from "./locations";

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
  onOpenLocation,
}: {
  text: string;
  onOpenUrl: (url: string) => void;
  onOpenLocation: (path: string, line: number) => void;
}) {
  return (
    <MarkdownBoundary fallback={text}>
      <div className="md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          // Our own scheme is not a real protocol, so the default sanitiser
          // strips it before the link renderer ever sees it. Let just that one
          // through; every other url keeps the library's sanitising.
          urlTransform={(url) =>
            url.startsWith(LOCATION_SCHEME) ? url : defaultUrlTransform(url)
          }
          components={{
            a: ({ href, children }) => {
              const location = href ? parseLocationHref(href) : null;
              if (location) {
                return (
                  <button
                    type="button"
                    className="location-link"
                    onClick={() => onOpenLocation(location.path, location.line)}
                  >
                    {children}
                  </button>
                );
              }
              if (!href || !isSafeMarkdownUrl(href)) {
                return <span>{children}</span>;
              }
              const url = href;
              return (
                <a
                  href={url}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenUrl(url);
                  }}
                >
                  {children}
                </a>
              );
            },
          }}
        >
          {linkifyLocations(text)}
        </ReactMarkdown>
      </div>
    </MarkdownBoundary>
  );
}
