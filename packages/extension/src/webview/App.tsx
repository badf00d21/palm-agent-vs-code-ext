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
            {message.files.map((file) => (
              <li key={file.path}>
                {pending ? (
                  <button
                    type="button"
                    className="review-file"
                    onClick={() => postMessage({ type: "open_diff", id: message.id, path: file.path })}
                  >
                    {file.path}
                  </button>
                ) : (
                  <span>{file.path}</span>
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

function activeAtQuery(value: string, caret: number): string | null {
  const upto = value.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(upto);
  return match ? (match[1] ?? "") : null;
}

export function App() {
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestQuery, setSuggestQuery] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const vscodeRef = useRef(getVsCodeApi());
  const suggestTimer = useRef<number | undefined>(undefined);
  const pendingSuggest = useRef<string | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtToWebview>) => {
      const msg = event.data;
      if (msg.type === "file_suggestions") {
        if (msg.query !== pendingSuggest.current) {
          return;
        }
        setSuggestions(msg.paths);
        setHighlight(0);
        return;
      }
      if (msg.type === "selection") {
        if (msg.text) {
          setInput((prev) => (prev ? `${prev}\n${msg.text}` : msg.text));
          setHint("");
        } else {
          setHint("No selection");
        }
        return;
      }
      if (shouldClearBusy(msg)) {
        setBusy(false);
      }
      if (msg.type === "done") {
        return;
      }
      setMessages((prev) => applyExtMessage(prev, msg));
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(suggestTimer.current);
    };
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

  const scheduleSuggest = (query: string) => {
    pendingSuggest.current = query;
    window.clearTimeout(suggestTimer.current);
    suggestTimer.current = window.setTimeout(() => {
      vscodeRef.current.postMessage({ type: "suggest_files", query });
    }, 150);
  };

  const updateAtQuery = (value: string, caret: number) => {
    const query = activeAtQuery(value, caret);
    if (query === null) {
      pendingSuggest.current = null;
      window.clearTimeout(suggestTimer.current);
      setSuggestions([]);
      setSuggestQuery(null);
      setHighlight(0);
      return;
    }
    if (query === "") {
      setSuggestions([]);
      setSuggestQuery("");
      setHighlight(0);
      scheduleSuggest("");
      return;
    }
    setSuggestQuery(query);
    scheduleSuggest(query);
  };

  const insertPath = (path: string) => {
    const el = textareaRef.current;
    const value = input;
    const caret = el?.selectionStart ?? value.length;
    const upto = value.slice(0, caret);
    const atStart = upto.lastIndexOf("@");
    if (atStart < 0) {
      return;
    }
    const next = `${value.slice(0, atStart)}@${path} ${value.slice(caret)}`;
    setInput(next);
    setSuggestions([]);
    setSuggestQuery(null);
    setHighlight(0);
    pendingSuggest.current = null;
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) {
      return;
    }
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setSuggestions([]);
    setSuggestQuery(null);
    setHint("");
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
        <div className="composer-main">
          {suggestQuery !== null ? (
            <ul className="suggest" role="listbox">
              {suggestions.length === 0 ? (
                <li className="suggest-empty">No files</li>
              ) : (
                suggestions.map((path, index) => (
                  <li key={path}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === highlight}
                      onClick={() => insertPath(path)}
                    >
                      {path}
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
          {hint ? <p className="composer-hint">{hint}</p> : null}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => {
              const value = event.target.value;
              setInput(value);
              updateAtQuery(value, event.target.selectionStart ?? value.length);
            }}
            onSelect={(event) => {
              const el = event.currentTarget;
              updateAtQuery(el.value, el.selectionStart ?? el.value.length);
            }}
            onKeyDown={(event) => {
              if (suggestQuery !== null && event.key === "Escape") {
                event.preventDefault();
                setSuggestions([]);
                setSuggestQuery(null);
                setHighlight(0);
                pendingSuggest.current = null;
                return;
              }
              if (suggestions.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlight((index) => Math.min(index + 1, suggestions.length - 1));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlight((index) => Math.max(index - 1, 0));
                  return;
                }
                if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                  event.preventDefault();
                  insertPath(suggestions[highlight] ?? suggestions[0]);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder="Message Palm Agent"
            rows={3}
            disabled={busy}
          />
        </div>
        <div className="composer-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => vscodeRef.current.postMessage({ type: "get_selection" })}
          >
            Add selection
          </button>
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
        </div>
      </form>
    </div>
  );
}
