export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Output budget per completion. Omit to use DEFAULT_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
}

/**
 * A reasoning model spends this budget on chain-of-thought *before* writing any
 * answer, so it has to cover thinking plus the reply plus a large write/edit
 * payload. Too low and turns die with an empty completion and finish_reason
 * "length" — the budget is gone before the answer starts.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/** DeepSeek Chat Completions endpoint (only supported provider for now). */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** Models exposed in the VS Code setting UI for the current release. */
export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];

export function isDeepSeekModel(model: string): model is DeepSeekModel {
  return (DEEPSEEK_MODELS as readonly string[]).includes(model);
}

/**
 * Model name for the configured Chat Completions endpoint. The runner POSTs
 * this name as-is, so any name the provider accepts works.
 */
export const DEFAULT_MODEL: DeepSeekModel = "deepseek-v4-flash";

export const DEFAULT_BASE_URL = DEEPSEEK_BASE_URL;
