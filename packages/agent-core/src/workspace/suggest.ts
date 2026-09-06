/**
 * Dependency dumps and build outputs across common stacks — not JS-only.
 * Used by @-suggest, glob, and content search so the agent stays in source.
 */
export const WORKSPACE_NOISE_EXCLUDE =
  "**/{node_modules,bower_components,dist,out,build,target,.git,__pycache__,.venv,venv,vendor,.next,.nuxt,coverage,.tox,.mypy_cache,.pytest_cache,.gradle,.turbo,.cache,.parcel-cache,.sass-cache,Pods,.yarn/cache}/**";

/** @deprecated Prefer WORKSPACE_NOISE_EXCLUDE — same value, kept for callers. */
export const SUGGEST_EXCLUDE = WORKSPACE_NOISE_EXCLUDE;
export const SUGGEST_LIMIT = 20;

/** ripgrep `--glob` forms that skip {@link WORKSPACE_NOISE_EXCLUDE}. */
export function workspaceNoiseRgGlobs(): string[] {
  return [`!${WORKSPACE_NOISE_EXCLUDE}`];
}

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
