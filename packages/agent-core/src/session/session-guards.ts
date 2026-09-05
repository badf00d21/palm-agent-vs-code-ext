export function assertCanStartTurn(
  text: string,
  state: { busy: boolean; hasWorkspace: boolean },
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
  return null;
}
