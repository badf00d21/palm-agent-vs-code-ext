export const SUGGEST_EXCLUDE = "**/{node_modules,dist,out,.git}/**";
export const SUGGEST_LIMIT = 20;

export type FileSuggestPlan =
  | { action: "empty" }
  | { action: "search"; glob: string; exclude: string; max: number };

export function planFileSuggestions(query: string): FileSuggestPlan {
  const safe = query.replace(/[*?\[\]{}]/g, "").trim();
  if (!safe) {
    return { action: "empty" };
  }
  return {
    action: "search",
    glob: `**/*${safe}*`,
    exclude: SUGGEST_EXCLUDE,
    max: SUGGEST_LIMIT,
  };
}
