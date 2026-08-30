function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\r" && text[i + 1] === "\n") {
      i += 2;
      starts.push(i);
    } else if (text[i] === "\n" || text[i] === "\r") {
      i += 1;
      starts.push(i);
    } else {
      i += 1;
    }
  }
  return starts;
}

export function lineCount(text: string): number {
  const starts = lineStartOffsets(text);
  const last = starts[starts.length - 1] ?? 0;
  return last === text.length && starts.length > 1 ? starts.length - 1 : starts.length;
}

export function sliceByLines(
  text: string,
  startLine: number,
  endLine: number,
): { text: string; start: number; end: number; total: number } | { error: string } {
  const total = lineCount(text);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1) {
    return { error: "start_line and end_line must be 1-based integers" };
  }
  if (startLine > endLine) {
    return { error: `start_line ${startLine} is after end_line ${endLine}` };
  }
  if (startLine > total) {
    return { error: `start_line ${startLine} is past end of file (${total} lines)` };
  }
  const ends = Math.min(endLine, total);
  const starts = lineStartOffsets(text);
  const from = starts[startLine - 1] ?? 0;
  const to = starts[ends] ?? text.length;
  return { text: text.slice(from, to), start: startLine, end: ends, total };
}
