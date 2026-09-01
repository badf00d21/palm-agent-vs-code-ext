export interface QuestionRequest {
  question: string;
  /** Suggested answers. May be empty; the human can always type their own. */
  options: string[];
}

/**
 * Editor-side transport for a question, mirroring ReviewHost: agent-core states
 * what it needs, the host decides how a human is asked.
 */
export interface QuestionHost {
  /**
   * Resolves with the human's answer. Never rejects — a cancelled or abandoned
   * turn resolves with a note, so the tool call always produces an output and
   * the call/output pairing in the context stays intact.
   */
  ask(request: QuestionRequest): Promise<string>;
}

/** Enough for a real choice, few enough to stay readable in a narrow sidebar. */
export const QUESTION_OPTION_LIMIT = 6;
/** The question and each option are echoed back into a 16k context. */
export const QUESTION_TEXT_LIMIT = 400;

export const QUESTION_CANCELLED = "The user did not answer; the turn was stopped.";

function toOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const options: string[] = [];
  for (const value of raw) {
    if (value === null || value === undefined || typeof value === "object") {
      continue;
    }
    const text = String(value).trim().slice(0, QUESTION_TEXT_LIMIT);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    options.push(text);
    if (options.length === QUESTION_OPTION_LIMIT) {
      break;
    }
  }
  return options;
}

export async function invokeQuestion(
  args: Record<string, unknown>,
  host: QuestionHost,
): Promise<string> {
  const question = String(args.question ?? "").trim();
  if (!question) {
    return "Error: question requires a question to ask";
  }
  const answer = await host.ask({
    question: question.slice(0, QUESTION_TEXT_LIMIT),
    options: toOptions(args.options),
  });
  const text = answer.trim();
  return text ? `The user answered: ${text}` : QUESTION_CANCELLED;
}
