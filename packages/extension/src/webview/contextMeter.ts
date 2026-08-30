function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) {
    return String(Math.round(n));
  }
  const k = n / 1000;
  if (Math.abs(k) >= 10) {
    return `${Math.round(k)}k`;
  }
  return `${(Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, "")}k`;
}

export function formatContextTooltip(used: number, max: number | null): string {
  const usedLabel = formatTokens(used);
  if (max === null) {
    return usedLabel;
  }
  return `${usedLabel} / ${formatTokens(max)}`;
}

export function contextRingRatio(used: number, max: number | null): number {
  if (max === null || max <= 0) {
    return 0;
  }
  return Math.min(1, used / max);
}
