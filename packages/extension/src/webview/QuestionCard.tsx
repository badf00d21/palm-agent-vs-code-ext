import { useState } from "react";
import type { WebviewToExt } from "@palm-agent/shared";
import type { QuestionLine } from "./chatMessages";

export interface QuestionCardProps {
  message: QuestionLine;
  postMessage: (msg: WebviewToExt) => void;
}

export function QuestionCard({ message, postMessage }: QuestionCardProps) {
  const [draft, setDraft] = useState("");
  const open = !message.settled;

  const answer = (text: string) => {
    const value = text.trim();
    if (!value) {
      return;
    }
    postMessage({ type: "question_answered", id: message.id, answer: value });
  };

  if (!open) {
    return (
      <>
        <p className="question-text">{message.question}</p>
        <p className="question-answer">
          {message.answer ? message.answer : "Not answered"}
        </p>
      </>
    );
  }

  return (
    <>
      <p className="question-text">{message.question}</p>
      {message.options.length > 0 ? (
        <ul className="question-options">
          {message.options.map((option) => (
            <li key={option}>
              <button type="button" onClick={() => answer(option)}>
                {option}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="question-form"
        onSubmit={(event) => {
          event.preventDefault();
          answer(draft);
          setDraft("");
        }}
      >
        <input
          type="text"
          value={draft}
          aria-label="Your answer"
          placeholder={message.options.length > 0 ? "Or type an answer" : "Your answer"}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={draft.trim().length === 0}>
          Answer
        </button>
      </form>
    </>
  );
}
