import { useEffect, useRef, useState } from "react";
import type { ExtToWebview, WebviewToExt } from "@palm-agent/shared";
import {
  applyCloudSession,
  applyExtMessage,
  dockedReviews,
  reviewDockSummary,
  shouldClearBusy,
  transcriptLines,
  type ChatLine,
} from "./chatMessages";
import { contextRingRatio, formatContextTooltip } from "./contextMeter";
import { AssistantMarkdown, isPlainErrorText } from "./markdown";
import { QuestionCard } from "./QuestionCard";
import { ResearchCard } from "./ResearchCard";
import { ReviewCard } from "./ReviewCard";
import { StatusOrb } from "./StatusOrb";
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
  if (role === "status") {
    return "Status";
  }
  if (role === "question") {
    return "Question";
  }
  if (role === "research") {
    return "Research";
  }
  return "Agent";
}

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ContextRing({ used, max }: { used: number; max: number | null }) {
  const label = formatContextTooltip(used, max);
  const ratio = contextRingRatio(used, max);
  const offset = RING_CIRCUMFERENCE * (1 - ratio);
  return (
    <svg
      className="context-ring"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle className="context-ring-track" cx="7" cy="7" r={RING_RADIUS} fill="none" />
      <circle
        className="context-ring-fill"
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={offset}
        transform="rotate(-90 7 7)"
      />
    </svg>
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
  const [suggestReady, setSuggestReady] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [context, setContext] = useState<{ used: number; max: number | null } | null>(null);
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);
  const [reviewExpanded, setReviewExpanded] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const vscodeRef = useRef(getVsCodeApi());
  const suggestTimer = useRef<number | undefined>(undefined);
  const pendingSuggest = useRef<string | null>(null);
  const prevPendingCount = useRef(0);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtToWebview>) => {
      const msg = event.data;
      if (msg.type === "file_suggestions") {
        if (msg.query !== pendingSuggest.current) {
          return;
        }
        setSuggestions(msg.paths);
        setSuggestReady(true);
        setHighlight(0);
        return;
      }
      if (msg.type === "session_cleared") {
        setMessages([]);
        setContext(null);
        setCloudUrl((current) => applyCloudSession(current, msg));
        setBusy(false);
        return;
      }
      if (msg.type === "context_usage") {
        setContext({ used: msg.used, max: msg.max });
        return;
      }
      if (msg.type === "cloud_session") {
        setCloudUrl((current) => applyCloudSession(current, msg));
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

  const dismissSuggest = () => {
    pendingSuggest.current = null;
    window.clearTimeout(suggestTimer.current);
    setSuggestions([]);
    setSuggestQuery(null);
    setSuggestReady(false);
    setHighlight(0);
  };

  const updateAtQuery = (value: string, caret: number) => {
    const query = activeAtQuery(value, caret);
    if (query === null || query === "") {
      dismissSuggest();
      return;
    }
    setSuggestQuery(query);
    setSuggestReady(false);
    setHighlight(0);
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
    const nextCaret = atStart + 1 + path.length + 1;
    setInput(next);
    dismissSuggest();
    queueMicrotask(() => {
      const field = textareaRef.current;
      if (!field) {
        return;
      }
      field.focus();
      field.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) {
      return;
    }
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    dismissSuggest();
    setBusy(true);
    vscodeRef.current.postMessage({ type: "user_message", text });
  };

  const postMessage = (msg: WebviewToExt) => {
    vscodeRef.current.postMessage(msg);
  };

  // An open question is human time, not model time: showing the model spinner
  // under it would claim the agent is thinking when it is waiting on a person.
  const awaitingAnswer = messages.some((line) => line.role === "question" && !line.settled);

  // While research runs, show one busy orb per active worker (pending/running)
  // with the sub-question as hover title — instead of the generic waiting bubble.
  const reviews = dockedReviews(messages);
  const pendingReviews = reviews.filter((review) => review.status === "pending");
  const hasPendingReview = pendingReviews.length > 0;
  const dockSummary = reviewDockSummary(pendingReviews);
  const transcript = transcriptLines(messages);
  const lastLine = transcript[transcript.length - 1];
  const researchInFlight = lastLine?.role === "research" && lastLine.status === "running";
  const researchWorkers =
    researchInFlight && lastLine.role === "research"
      ? lastLine.workers.filter(
          (worker) => worker.status === "pending" || worker.status === "running",
        )
      : [];
  const showResearchOrbs = researchWorkers.length > 0;
  const showOrbBusy =
    busy && lastLine?.role !== "assistant" && !awaitingAnswer && !researchInFlight;

  useEffect(() => {
    const count = pendingReviews.length;
    if (prevPendingCount.current === 0 && count > 0) {
      setReviewExpanded(true);
    }
    prevPendingCount.current = count;
  }, [pendingReviews.length]);

  const shownSuggestions =
    suggestQuery && suggestQuery.length > 0
      ? suggestions.filter((path) => path.toLowerCase().includes(suggestQuery.toLowerCase()))
      : [];
  const showSuggest =
    suggestQuery !== null &&
    suggestQuery !== "" &&
    (shownSuggestions.length > 0 || suggestReady);
  const activeSuggestIndex = Math.min(highlight, Math.max(shownSuggestions.length - 1, 0));

  return (
    <div className="app">
      {hasPendingReview ? (
        <div className="review-dock" aria-label="Review">
          <div id="review-dock-body" className="review-dock-body" hidden={!reviewExpanded}>
            {pendingReviews.map((review) => (
              <article key={review.id} className="msg msg-review" aria-label="Review">
                <ReviewCard message={review} postMessage={postMessage} />
              </article>
            ))}
          </div>
          <button
            type="button"
            className="review-dock-summary"
            aria-expanded={reviewExpanded}
            aria-controls="review-dock-body"
            onClick={() => setReviewExpanded((value) => !value)}
          >
            <span>{dockSummary.label}</span>
            <span className="review-dock-chevron" aria-hidden="true">
              {reviewExpanded ? "▴" : "▾"}
            </span>
          </button>
        </div>
      ) : null}
      <div className="messages" ref={listRef}>
        {transcript.length === 0 && !hasPendingReview && !busy ? (
          <p className="empty">
            Ask about a file in this workspace.{"\n"}
            Type @ to mention a path.
          </p>
        ) : (
          transcript.map((message, index) => (
            <article
              key={
                message.role === "question" || message.role === "research"
                  ? message.id
                  : `${message.role}-${index}`
              }
              aria-label={roleLabel(message.role)}
              className={`msg msg-${message.role}${message.role === "tool" && message.status === "running" ? " is-running" : ""}${message.role === "research" ? ` msg-research-${message.status}` : ""}${message.role === "assistant" && isPlainErrorText(message.text) ? " is-error" : ""}`}
            >
              {message.role === "question" ? (
                <QuestionCard message={message} postMessage={postMessage} />
              ) : message.role === "research" ? (
                <ResearchCard message={message} postMessage={postMessage} />
              ) : message.role === "assistant" && !isPlainErrorText(message.text) ? (
                <AssistantMarkdown
                  text={message.text}
                  onOpenUrl={(url) => postMessage({ type: "open_url", url })}
                  onOpenLocation={(path, line) =>
                    postMessage({ type: "open_location", path, line })
                  }
                />
              ) : message.role === "tool" ? (
                <p className="tool-line">
                  <span className="tool-marker" aria-hidden="true">
                    ⏺
                  </span>
                  <span>{message.text}</span>
                </p>
              ) : message.role === "review" ? null : (
                <p>{message.text}</p>
              )}
              {(message.role === "tool" || message.role === "status") &&
              message.locations &&
              message.locations.length > 0 ? (
                <ul className="tool-locations">
                  {message.locations.map((hit) => (
                    <li key={`${hit.path}:${hit.line}`}>
                      <button
                        type="button"
                        onClick={() =>
                          postMessage({ type: "open_location", path: hit.path, line: hit.line })
                        }
                      >
                        <span className="tool-location-where">
                          {hit.path}:{hit.line}
                        </span>
                        {hit.text ? <span className="tool-location-text">{hit.text}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))
        )}
        <div className="messages-status">
          {showResearchOrbs ? (
            <article
              className="msg msg-assistant is-waiting"
              aria-label="Research"
              aria-live="polite"
              aria-busy="true"
            >
              <p className="waiting-line">
                <span className="status-orb-row" role="group" aria-label="Active research workers">
                  {researchWorkers.map((worker) => (
                    <StatusOrb key={worker.id} busy title={worker.question} />
                  ))}
                </span>
                {waitSeconds < 8
                  ? "Researching…"
                  : `Researching… ${waitSeconds}s`}
              </p>
            </article>
          ) : showOrbBusy ? (
            <article
              className="msg msg-assistant is-waiting"
              aria-label="Agent"
              aria-live="polite"
              aria-busy="true"
            >
              <p className="waiting-line">
                <StatusOrb busy />
                {waitSeconds < 8
                  ? "Waiting for reply"
                  : `Loading model / thinking… ${waitSeconds}s`}
              </p>
            </article>
          ) : (
            <StatusOrb busy={false} />
          )}
        </div>
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="composer-main">
          {showSuggest ? (
            <ul className="suggest" id="file-suggest" role="listbox" aria-label="Workspace files">
              {shownSuggestions.length === 0 ? (
                <li className="suggest-empty">No files</li>
              ) : (
                shownSuggestions.map((path, index) => (
                  <li key={path}>
                    <button
                      type="button"
                      id={`file-suggest-${index}`}
                      role="option"
                      aria-selected={index === activeSuggestIndex}
                      onClick={() => insertPath(path)}
                    >
                      {path}
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
          <textarea
            ref={textareaRef}
            value={input}
            aria-autocomplete="list"
            aria-expanded={showSuggest}
            aria-controls={showSuggest ? "file-suggest" : undefined}
            aria-activedescendant={
              showSuggest && shownSuggestions.length > 0 ? `file-suggest-${activeSuggestIndex}` : undefined
            }
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
                dismissSuggest();
                return;
              }
              if (shownSuggestions.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlight((index) => Math.min(index + 1, shownSuggestions.length - 1));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlight((index) => Math.max(index - 1, 0));
                  return;
                }
                if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                  event.preventDefault();
                  insertPath(shownSuggestions[activeSuggestIndex] ?? shownSuggestions[0]);
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
          {cloudUrl ? (
            <button
              type="button"
              className="btn btn-ghost cloud-session-link"
              onClick={() => postMessage({ type: "open_url", url: cloudUrl })}
              title={cloudUrl}
            >
              Cloud session ↗
            </button>
          ) : null}
          {context ? <ContextRing used={context.used} max={context.max} /> : null}
          <div className="composer-buttons">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || messages.length === 0}
              onClick={() => vscodeRef.current.postMessage({ type: "new_chat" })}
            >
              New chat
            </button>
            {busy ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => vscodeRef.current.postMessage({ type: "cancel" })}
              >
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={input.trim().length === 0}>
                Send
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
