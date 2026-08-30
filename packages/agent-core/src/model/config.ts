export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * Ollama alias for the local qwen coder weights (`qwen2.5-coder:14b`).
 * Mozaik 3.x only accepts a closed ModelName set (`gpt-*`, `claude-*`,
 * `gemini-*`, `deepseek-v4-*`). A real qwen name throws `Unsupported model`
 * if anything still goes through `runInference`. `deepseek-v4-pro` is an
 * `ollama cp` / alias so the served weights stay qwen coder while the name
 * is Mozaik-legal.
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
