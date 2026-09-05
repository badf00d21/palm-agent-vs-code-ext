export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * Model name for the configured Chat Completions endpoint. The runner POSTs
 * this name as-is, so any name the provider accepts works.
 */
export const DEFAULT_MODEL = "deepseek-v4-flash";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
