import { useState, type ReactNode } from "react";

function textFromNode(node: ReactNode): string {
  if (node == null || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textFromNode).join("");
  }
  if (typeof node === "object" && "props" in node) {
    return textFromNode((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Fenced code: syntax classes come from rehype-highlight on the inner `code`. */
export function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = textFromNode(children).replace(/\n$/, "");

  return (
    <div className="code-block">
      <button
        type="button"
        className="code-block-copy btn btn-ghost"
        onClick={() => {
          void copyText(text).then((ok) => {
            if (!ok) {
              return;
            }
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}
