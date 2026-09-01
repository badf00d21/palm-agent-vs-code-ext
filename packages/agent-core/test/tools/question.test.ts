import { describe, expect, it } from "vitest";
import {
  QUESTION_CANCELLED,
  QUESTION_OPTION_LIMIT,
  QUESTION_TEXT_LIMIT,
  invokeQuestion,
  type QuestionHost,
  type QuestionRequest,
} from "../../src/tools/question.js";

function recordingHost(answer = "yes"): QuestionHost & { asked: QuestionRequest[] } {
  const asked: QuestionRequest[] = [];
  return {
    asked,
    ask: async (request) => {
      asked.push(request);
      return answer;
    },
  };
}

describe("invokeQuestion", () => {
  it("returns the human's answer in a form the model can read", async () => {
    const host = recordingHost("use axum");
    expect(await invokeQuestion({ question: "Which web framework?" }, host)).toBe(
      "The user answered: use axum",
    );
    expect(host.asked[0]?.question).toBe("Which web framework?");
  });

  it("rejects an empty question without troubling the human", async () => {
    const host = recordingHost();
    expect(await invokeQuestion({ question: "   " }, host)).toBe(
      "Error: question requires a question to ask",
    );
    expect(host.asked).toHaveLength(0);
  });

  it("reports a turn that ended before an answer arrived", async () => {
    const host: QuestionHost = { ask: async () => "" };
    expect(await invokeQuestion({ question: "Which one?" }, host)).toBe(QUESTION_CANCELLED);
  });

  it("passes options through, trimmed and deduplicated", async () => {
    const host = recordingHost();
    await invokeQuestion({ question: "Pick", options: [" axum ", "actix", "axum"] }, host);
    expect(host.asked[0]?.options).toEqual(["axum", "actix"]);
  });

  it("caps the option count", async () => {
    const host = recordingHost();
    const many = Array.from({ length: 20 }, (_, i) => `option ${i}`);
    await invokeQuestion({ question: "Pick", options: many }, host);
    expect(host.asked[0]?.options).toHaveLength(QUESTION_OPTION_LIMIT);
  });

  it("drops non-scalar options instead of stringifying objects", async () => {
    const host = recordingHost();
    await invokeQuestion({ question: "Pick", options: ["ok", { a: 1 }, null, 42] }, host);
    expect(host.asked[0]?.options).toEqual(["ok", "42"]);
  });

  it("treats a non-array options value as no options", async () => {
    const host = recordingHost();
    await invokeQuestion({ question: "Pick", options: "axum" }, host);
    expect(host.asked[0]?.options).toEqual([]);
  });

  it("clips a long question so it cannot flood a 16k context", async () => {
    const host = recordingHost();
    await invokeQuestion({ question: "x".repeat(QUESTION_TEXT_LIMIT + 200) }, host);
    expect(host.asked[0]?.question).toHaveLength(QUESTION_TEXT_LIMIT);
  });
});
