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
    getContext: async () => ({ activeFile: null, selection: null }),
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createAgentSession inference failures", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
        return jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_echo",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"echo.ts"}' },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "echo.ts exports echo" } }],
      });
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
        id: "call_unknown",
        status: "running",
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
});
