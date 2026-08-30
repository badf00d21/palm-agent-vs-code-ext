export function isSafeMarkdownUrl(href: string | undefined): boolean {
  if (!href) {
    return false;
  }
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}
