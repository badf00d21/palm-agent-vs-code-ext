export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * Local Ollama Chat Completions model. Default is `gemma4:12b` (reliable
 * tool-format). Do not use `gpt-*` / `o1`–`o9` / `text-*` names — those
 * route to the Responses API. The local runner POSTs this name as-is.
 */
export const DEFAULT_MODEL = "deepseek-v4-pro";

export const DEFAULT_BASE_URL = "http://localhost:11434/v1";

export function isForbiddenModelName(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (m.startsWith("gpt-") || m.startsWith("chatgpt-") || m.startsWith("text-")) {
    return true;
  }
  if (m.startsWith("davinci")) {
    return true;
  }
  return /^o[1-9]/.test(m);
}
