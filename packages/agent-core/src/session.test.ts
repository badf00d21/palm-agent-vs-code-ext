import type { ExtToWebview } from "@palm-agent/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspacePort } from "./port.js";
import { createAgentSession } from "./session.js";

const FILE_CONTENTS = "export const echo = true;\n";

function fakePort(overrides: Partial<WorkspacePort> = {}): WorkspacePort {
  return {
    hasWorkspace: () => true,
    readFile: async () => "",
    listDir: async () => [],
    search: async () => [],
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
    );

    await session.startTurn("what is in echo.ts?");

    expect(posts).toBe(2);
    expect(events).toEqual([
      { type: "tool_call", name: "read_file", args: { path: "echo.ts" } },
      { type: "assistant_delta", text: "echo.ts exports echo" },
      { type: "done" },
    ]);
    expect(session.busy).toBe(false);
  });
});
