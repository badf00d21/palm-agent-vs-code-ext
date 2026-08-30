import { useEffect, useRef, useState } from "react";
import type { ExtToWebview, WebviewToExt } from "@palm-agent/shared";
import { applyExtMessage, shouldClearBusy, type ChatLine, type ReviewLine } from "./chatMessages";
import { getVsCodeApi } from "./vscode";

function roleLabel(role: ChatLine["role"]): string {
  if (role === "user") {
    return "You";
  }
  if (role === "tool") {
    return "Tool";
  }
  if (role === "review") {
    return "Review";
  }
  return "Agent";
}

function ReviewCard({
  message,
  postMessage,
}: {
  message: ReviewLine;
  postMessage: (msg: WebviewToExt) => void;
}) {
  const [open, setOpen] = useState(message.status === "pending");
  const pending = message.status === "pending";
  const fileLabel = `${message.files.length} file${message.files.length === 1 ? "" : "s"}`;
  const statusText =
    message.status === "kept" ? "Kept" : message.status === "undone" ? "Undone" : undefined;

  return (
    <>
      <div className="review-head">
        <button type="button" onClick={() => setOpen((value) => !value)}>
          {fileLabel}
        </button>
        {statusText ? <span>{statusText}</span> : null}
      </div>
      {open ? (
        <>
          <ul className="review-list">
            {message.files.map((path) => (
              <li key={path}>
                {pending ? (
                  <button
                    type="button"
                    className="review-file"
                    onClick={() => postMessage({ type: "open_diff", id: message.id, path })}
                  >
                    {path}
                  </button>
                ) : (
                  <span>{path}</span>
                )}
              </li>
            ))}
          </ul>
          {pending ? (
            <div className="review-actions">
              <button type="button" onClick={() => postMessage({ type: "reject_diff", id: message.id })}>
                Undo All
              </button>
              <button type="button" onClick={() => postMessage({ type: "apply_diff", id: message.id })}>
                Keep All
              </button>
              <button type="button" onClick={() => postMessage({ type: "open_diff", id: message.id })}>
                Review
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function App() {
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const vscodeRef = useRef(getVsCodeApi());

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtToWebview>) => {
      const msg = event.data;
      if (shouldClearBusy(msg)) {
        setBusy(false);
      }
      if (msg.type === "done") {
        return;
      }
      setMessages((prev) => applyExtMessage(prev, msg));
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  useEffect(() => {
    if (!busy) {
      setWaitSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      setWaitSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) {
      return;
    }
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setBusy(true);
    vscodeRef.current.postMessage({ type: "user_message", text });
  };

  const postMessage = (msg: WebviewToExt) => {
    vscodeRef.current.postMessage(msg);
  };

  return (
    <div className="app">
      <div className="messages" ref={listRef}>
        {messages.length === 0 && !busy ? (
          <p className="empty">Ask about a file in this workspace.</p>
        ) : (
          messages.map((message, index) => (
            <article
              key={message.role === "review" ? message.id : `${message.role}-${index}`}
              className={`bubble ${message.role}${message.role === "tool" && message.status === "running" ? " running" : ""}`}
            >
              <span className="role">{roleLabel(message.role)}</span>
              {message.role === "review" ? (
                <ReviewCard message={message} postMessage={postMessage} />
              ) : (
                <p>{message.text}</p>
              )}
            </article>
          ))
        )}
        {busy && messages[messages.length - 1]?.role !== "assistant" ? (
          <article className="bubble assistant waiting" aria-live="polite" aria-busy="true">
            <span className="role">Agent</span>
            <p className="waiting-line">
              <span className="waiting-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {waitSeconds < 8
                ? "Waiting for reply"
                : `Loading model / thinking… ${waitSeconds}s`}
            </p>
            <button
              type="button"
              className="waiting-stop"
              onClick={() => vscodeRef.current.postMessage({ type: "cancel" })}
            >
              Stop
            </button>
          </article>
        ) : null}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder="Message Palm Agent"
          rows={3}
          disabled={busy}
        />
        {busy ? (
          <button
            type="button"
            className="waiting-stop"
            onClick={() => vscodeRef.current.postMessage({ type: "cancel" })}
          >
            Stop
          </button>
        ) : (
          <button type="submit" disabled={input.trim().length === 0}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
