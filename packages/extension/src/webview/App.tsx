import { useEffect, useRef, useState } from "react";
import type { ExtToWebview } from "@palm-agent/shared";
import { getVsCodeApi } from "./vscode";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const vscodeRef = useRef(getVsCodeApi());

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtToWebview>) => {
      const msg = event.data;
      if (msg.type === "assistant_delta") {
        setMessages((prev) => [...prev, { role: "assistant", text: msg.text }]);
        return;
      }
      if (msg.type === "error") {
        setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${msg.message}` }]);
        setBusy(false);
        return;
      }
      if (msg.type === "done") {
        setBusy(false);
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [messages]);

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

  return (
    <div className="app">
      <div className="messages" ref={listRef}>
        {messages.length === 0 ? (
          <p className="empty">Send a message. v0 echoes it back through the extension host.</p>
        ) : (
          messages.map((message, index) => (
            <article key={`${message.role}-${index}`} className={`bubble ${message.role}`}>
              <span className="role">{message.role === "user" ? "You" : "Agent"}</span>
              <p>{message.text}</p>
            </article>
          ))
        )}
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
        <button type="submit" disabled={busy || input.trim().length === 0}>
          Send
        </button>
      </form>
    </div>
  );
}
