/** Marks a rewritten location so the link renderer can tell it from a real URL. */
export const LOCATION_SCHEME = "palm-loc:";

export interface ParsedLocation {
  path: string;
  line: number;
}

/**
 * `src/controller.rs:18`, optionally with a column. The extension must look like
 * an extension (letters, 1-8 of them) so prose such as "ratio 3:2" is left alone.
 */
const LOCATION_SOURCE = "([\\w.\\-/\\\\]*[\\w-]+\\.[A-Za-z][A-Za-z0-9]{0,7}):(\\d+)(?::\\d+)?";
const LOCATION_RE = new RegExp(LOCATION_SOURCE, "g");
/**
 * An inline span holding nothing but a location, like `src/view.rs:3`. Wrapping
 * a citation in backticks is the natural way to write one, so this stays a
 * destination — unlike a fenced block, which is a code sample.
 */
const INLINE_LOCATION_RE = new RegExp(`^\`\\s*${LOCATION_SOURCE}\\s*\`$`);

/** `http://host:8080` and `C:\dir` end in the same shape; neither is a location. */
function looksLikeUrlOrDrive(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 3), index);
  return before.endsWith("//") || before.endsWith(":");
}

export function parseLocationHref(href: string): ParsedLocation | null {
  if (!href.startsWith(LOCATION_SCHEME)) {
    return null;
  }
  const rest = href.slice(LOCATION_SCHEME.length);
  const split = rest.lastIndexOf(":");
  if (split <= 0) {
    return null;
  }
  const line = Number(rest.slice(split + 1));
  if (!Number.isInteger(line) || line < 1) {
    return null;
  }
  return { path: rest.slice(0, split), line };
}

/**
 * Splits markdown into the parts a reader sees as prose and the parts they see
 * as code. Fences and inline spans are returned untouched: a path inside a code
 * sample is an example, not somewhere to jump.
 */
function splitOutCode(markdown: string): Array<{ text: string; code: boolean }> {
  const parts: Array<{ text: string; code: boolean }> = [];
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    if (match.index > last) {
      parts.push({ text: markdown.slice(last, match.index), code: false });
    }
    parts.push({ text: match[0], code: true });
    last = match.index + match[0].length;
  }
  if (last < markdown.length) {
    parts.push({ text: markdown.slice(last), code: false });
  }
  return parts;
}

/**
 * Rewrites every `path:line` the assistant mentions into a markdown link, so the
 * human can jump to the place instead of hunting for it. Existing links are left
 * alone — a rewrite inside `[text](url)` would corrupt the url.
 */
export function linkifyLocations(markdown: string): string {
  return splitOutCode(markdown)
    .map(({ text, code }) => {
      if (code) {
        const only = INLINE_LOCATION_RE.exec(text);
        if (only) {
          // Keep the backticks inside the label so it still reads as code.
          return `[${text}](${LOCATION_SCHEME}${only[1]}:${only[2]})`;
        }
        return text;
      }
      return text.replace(LOCATION_RE, (whole, path: string, line: string, offset: number) => {
        if (looksLikeUrlOrDrive(text, offset)) {
          return whole;
        }
        // Inside a markdown link's target, or already the label of one.
        const after = text.slice(offset + whole.length, offset + whole.length + 2);
        const before = text.slice(Math.max(0, offset - 1), offset);
        if (before === "(" || before === "[" || after.startsWith("](")) {
          return whole;
        }
        return `[${whole}](${LOCATION_SCHEME}${path}:${line})`;
      });
    })
    .join("");
}
