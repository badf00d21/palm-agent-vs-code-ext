import { isForbiddenModelName } from "../model/config.js";

export function assertCanStartTurn(
  text: string,
  state: { busy: boolean; hasWorkspace: boolean; model: string },
): { type: "error"; message: string } | null {
  if (text.trim().length === 0) {
    return { type: "error", message: "Empty message" };
  }
  if (state.busy) {
    return { type: "error", message: "Agent is busy" };
  }
  if (!state.hasWorkspace) {
    return { type: "error", message: "No workspace folder open" };
  }
  if (isForbiddenModelName(state.model)) {
    return {
      type: "error",
      message:
        "Model name routes to the wrong API. Use a local Ollama name such as deepseek-v4-pro.",
    };
  }
  return null;
}
