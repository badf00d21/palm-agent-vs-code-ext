import type { WorkspacePort } from "../workspace/port.js";

/**
 * Checked in order; the first one that exists wins. AGENTS.md is this project's
 * own convention, CLAUDE.md is the common fallback in other repos.
 */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Instructions sit ahead of the first user message, which compactContext never
 * trims, so every character is permanent overhead for the whole session. At the
 * 16k num_ctx a local model runs with, 8000 characters is roughly 2k tokens —
 * enough for a normal AGENTS.md, small enough to leave the turn room to work.
 */
export const INSTRUCTIONS_CHAR_LIMIT = 12000;

function truncationNote(name: string): string {
  return `\n[truncated: ${name} is longer than ${INSTRUCTIONS_CHAR_LIMIT} characters]`;
}

export function formatInstructions(name: string, body: string): string {
  const trimmed = body.trim();
  const clipped =
    trimmed.length > INSTRUCTIONS_CHAR_LIMIT
      ? trimmed.slice(0, INSTRUCTIONS_CHAR_LIMIT) + truncationNote(name)
      : trimmed;
  return (
    `Project instructions from ${name}. They describe this specific workspace ` +
    "and take precedence over your general habits, but never over the rules above.\n\n" +
    clipped
  );
}

/**
 * Reads the workspace's own instruction file, if it has one. Local files only:
 * opencode also resolves instructions from remote URLs, which would put text
 * fetched over the network into the system prompt of an agent that proposes
 * code edits. Returns null when there is nothing to add.
 */
export async function loadWorkspaceInstructions(
  port: WorkspacePort,
): Promise<string | null> {
  for (const name of INSTRUCTION_FILES) {
    try {
      if ((await port.exists(name)) !== "file") {
        continue;
      }
      const body = await port.readFile(name);
      if (!body.trim()) {
        continue;
      }
      return formatInstructions(name, body);
    } catch {
      // An unreadable instruction file must not stop the turn.
      continue;
    }
  }
  return null;
}
