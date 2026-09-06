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

/**
 * Model name for the configured Chat Completions endpoint. The runner POSTs
 * this name as-is, so any name the provider accepts works.
 */
export const DEFAULT_MODEL = "deepseek-v4-flash";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
