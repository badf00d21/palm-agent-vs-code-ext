import type { ExtToWebview } from "@palm-agent/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspacePort } from "../../src/workspace/port.js";
import { createAgentSession } from "../../src/session/session.js";

const FILE_CONTENTS = "export const echo = true;\n";

function fakePort(overrides: Partial<WorkspacePort> = {}): WorkspacePort {
  return {
    hasWorkspace: () => true,
    readFile: async () => "",
    listDir: async () => [],
    search: async () => [],
    findFiles: async () => [],
    exists: async () => "absent" as const,
    getContext: async () => ({ activeFile: null, selection: null }),
    ...overrides,
  };
}

function sseResponse(deltas: unknown[]): Response {
  const body =
    deltas.map((delta) => `data: ${JSON.stringify({ choices: [delta] })}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("createAgentSession inference failures", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("puts AGENTS.md ahead of the first user message", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content?: string | null }> }> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse([{ delta: { content: "ok" }, finish_reason: "stop" }]);
    }) as typeof fetch;

    const session = createAgentSession(
      fakePort({
        exists: async (path) => (path === "AGENTS.md" ? "file" : "absent"),
        readFile: async () => "Never use npm; this repo is pnpm only.",
      }),
      { baseUrl: "http://localhost:11434/v1", model: "gemma4:12b", apiKey: "not-needed" },
      () => undefined,
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );

    await session.startTurn("hello");

    const messages = bodies[0]!.messages;
    const firstUser = messages.findIndex((m) => m.role === "user");
    const instructions = messages.findIndex((m) => m.content?.includes("pnpm only"));
    expect(instructions).toBeGreaterThanOrEqual(0);
    // Ahead of the first user message is exactly the region compactContext keeps.
    expect(instructions).toBeLessThan(firstUser);
  });

  it("loads the instruction file once, not on every turn", async () => {
    let reads = 0;
    globalThis.fetch = (async () =>
      sseResponse([{ delta: { content: "ok" }, finish_reason: "stop" }])) as typeof fetch;

    const session = createAgentSession(
      fakePort({
        exists: async (path) => (path === "AGENTS.md" ? "file" : "absent"),
        readFile: async () => {
          reads += 1;
          return "project rules";
        },
      }),
      { baseUrl: "http://localhost:11434/v1", model: "gemma4:12b", apiKey: "not-needed" },
      () => undefined,
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );

    await session.startTurn("one");
    await session.startTurn("two");
    expect(reads).toBe(1);

    // New chat is the refresh point: the file is read again for the new context.
    session.reset();
    await session.startTurn("three");
    expect(reads).toBe(2);
  });

  it("starts a turn normally when the workspace has no instruction file", async () => {
    globalThis.fetch = (async () =>
      sseResponse([{ delta: { content: "ok" }, finish_reason: "stop" }])) as typeof fetch;

    const events: ExtToWebview[] = [];
    const session = createAgentSession(
      fakePort(),
      { baseUrl: "http://localhost:11434/v1", model: "gemma4:12b", apiKey: "not-needed" },
      (event) => events.push(event),
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );

    await session.startTurn("hello");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("asks the human, waits, and feeds the answer back to the model", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content?: string | null }> }> = [];
    let posts = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      posts += 1;
      if (posts === 1) {
        return sseResponse([
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_q",
                  function: {
                    name: "question",
                    arguments: '{"question":"Which framework?","options":["axum","actix"]}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ]);
      }
      return sseResponse([{ delta: { content: "Using axum." }, finish_reason: "stop" }]);
    }) as typeof fetch;

    const events: ExtToWebview[] = [];
    const session = createAgentSession(
      fakePort(),
      { baseUrl: "http://localhost:11434/v1", model: "gemma4:12b", apiKey: "not-needed" },
      (event) => {
        events.push(event);
        // The turn is parked on the human until answerQuestion is called.
        if (event.type === "question_asked") {
          queueMicrotask(() => session.answerQuestion(event.id, "axum"));
        }
      },
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );

    await session.startTurn("pick a framework");

    const asked = events.find((e) => e.type === "question_asked");
    expect(asked).toMatchObject({ question: "Which framework?", options: ["axum", "actix"] });
    expect(events.some((e) => e.type === "question_settled" && e.answer === "axum")).toBe(true);

    const toolReply = bodies[1]!.messages.find((m) => m.role === "tool");
    expect(toolReply?.content).toBe("The user answered: axum");
    expect(posts).toBe(2);
  });

  it("releases a waiting question when the turn is cancelled", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_q",
                function: { name: "question", arguments: '{"question":"Which one?"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ])) as typeof fetch;

    const events: ExtToWebview[] = [];
    const session = createAgentSession(
      fakePort(),
      { baseUrl: "http://localhost:11434/v1", model: "gemma4:12b", apiKey: "not-needed" },
      (event) => {
        events.push(event);
        if (event.type === "question_asked") {
          // Stop pressed while the question is still on screen.
          queueMicrotask(() => session.cancel());
        }
      },
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );

    // Without releasing the pending promise this never settles.
    await session.startTurn("pick one");

    expect(events.some((e) => e.type === "question_settled" && e.answer === null)).toBe(true);
    expect(session.busy).toBe(false);
  });

  it("ignores an answer for a question that is no longer open", async () => {
    globalThis.fetch = (async () =>
      sseResponse([{ delta: { content: "ok" }, finish_reason: "stop" }])) as typeof fetch;

    const events: ExtToWebview[] = [];
    const session = createAgentSession(
      fakePort(),
      { baseUrl: "http://localhost:11434/v1", model: "gemma4:12b", apiKey: "not-needed" },
      (event) => events.push(event),
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );

    await session.startTurn("hello");
    session.answerQuestion("q_nope", "late answer");

    expect(events.some((e) => e.type === "question_settled")).toBe(false);
  });

  it("settles startTurn immediately when the provider is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const events: ExtToWebview[] = [];
    const session = createAgentSession(
      fakePort(),
      {
        baseUrl: "http://localhost:11434/v1",
        model: "deepseek-v4-pro",
        apiKey: "not-needed",
      },
      (event) => events.push(event),
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );

    const started = Date.now();
    await session.startTurn("hello");

    expect(Date.now() - started).toBeLessThan(2000);
    expect(events).toEqual([
      {
        type: "error",
        message: "Cannot reach Ollama at http://localhost:11434/v1. Is it running?",
      },
    ]);
    expect(session.busy).toBe(false);
  });

  it("emits tool_call then assistant_delta then done on a stubbed tool-call turn", async () => {
    let posts = 0;
    globalThis.fetch = (async () => {
      posts += 1;
      if (posts === 1) {
        return sseResponse([
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_echo",
                  function: { name: "read_file", arguments: '{"path":"echo.ts"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ]);
      }
      return sseResponse([
        { delta: { content: "echo.ts exports echo" }, finish_reason: "stop" },
      ]);
    }) as typeof fetch;

    const events: ExtToWebview[] = [];
    const session = createAgentSession(
      fakePort({
        readFile: async (path) => {
          expect(path).toBe("echo.ts");
          return FILE_CONTENTS;
        },
      }),
      {
        baseUrl: "http://localhost:11434/v1",
        model: "deepseek-v4-pro",
        apiKey: "not-needed",
      },
      (event) => events.push(event),
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );

    await session.startTurn("what is in echo.ts?");

    expect(posts).toBe(2);
    expect(events).toEqual([
      {
        type: "tool_call",
        name: "read_file",
        args: { path: "echo.ts" },
        id: "call_echo",
        status: "running",
      },
      {
        type: "tool_call",
        name: "",
        args: {},
        id: "call_echo",
        status: "done",
      },
      { type: "assistant_delta", text: "echo.ts exports echo" },
      { type: "done" },
    ]);
    expect(session.busy).toBe(false);
  });

  it("cancel settles a hanging turn", async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort, { once: true });
      })) as typeof fetch;

    const events: ExtToWebview[] = [];
    const session = createAgentSession(
      fakePort(),
      {
        baseUrl: "http://localhost:11434/v1",
        model: "deepseek-v4-pro",
        apiKey: "not-needed",
      },
      (event) => events.push(event),
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );

    const running = session.startTurn("hello");
    session.cancel();
    await running;

    expect(session.busy).toBe(false);
    expect(events.some((e) => e.type === "error" && e.message === "Cancelled")).toBe(true);
  });

  it("reset drops prior turns from the next request", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content?: string | null }> }> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string | null }> });
      const body =
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const session = createAgentSession(
      fakePort(),
      { baseUrl: "http://localhost:11434/v1", model: "gemma4:12b", apiKey: "not-needed" },
      () => undefined,
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );
    await session.startTurn("first");
    session.reset();
    await session.startTurn("second");
    const last = bodies[bodies.length - 1]!;
    const userTexts = last.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts).toEqual(["second"]);
    expect(session.busy).toBe(false);
  });

  it("reset is a no-op while a turn is in flight", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const abort = (): void => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch;

    const session = createAgentSession(
      fakePort(),
      { baseUrl: "http://localhost:11434/v1", model: "gemma4:12b", apiKey: "not-needed" },
      () => undefined,
      { merge: (files) => ({ id: "rev_test", paths: files.map((f) => f.path) }) },
    );
    const running = session.startTurn("hello");
    expect(session.busy).toBe(true);
    session.reset();
    expect(session.busy).toBe(true);
    session.cancel();
    await running;
    expect(session.busy).toBe(false);
  });
});
