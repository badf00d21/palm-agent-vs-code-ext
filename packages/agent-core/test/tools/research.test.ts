import type { Tool } from "@mozaik-ai/core";
import { describe, expect, it, vi } from "vitest";
import { AgenticEnvironment, BaseParticipant, type BusEvent } from "../../src/runtime/environment.js";
import type { ChatCompletionFetch } from "../../src/model/local-inference.js";
import {
  RESEARCH_SETTLED_EVENT,
  RESEARCH_STARTED_EVENT,
  RESEARCH_WORKER_EVENT,
  createResearchTool,
  type ResearchHost,
  type ResearchSettledPayload,
  type ResearchStartedPayload,
} from "../../src/tools/research.js";

function sseText(content: string): Response {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function isDecompose(init?: RequestInit): boolean {
  const body = JSON.parse(String(init?.body)) as {
    messages: Array<{ role: string; content?: string | null }>;
  };
  return body.messages.some(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("split a research question"),
  );
}

/** A joined listener that records every semantic event delivered on the bus. */
class Recorder extends BaseParticipant {
  readonly events: BusEvent[] = [];
  constructor() {
    super("Recorder");
  }
  override onExternalEvent(_source: unknown, item: BusEvent): void {
    this.events.push(item);
  }
}

function baseTools(): Tool[] {
  const readOnly = (name: string): Tool => ({
    name,
    description: "test",
    strict: true,
    type: "function",
    parameters: { type: "object", properties: {}, required: [] },
    invoke: async () => "unused",
  });
  return [readOnly("read_file"), readOnly("search"), readOnly("glob"), readOnly("outline"), readOnly("list_dir")];
}

describe("createResearchTool", () => {
  it("requires a question", async () => {
    const tool = createResearchTool({
      getEnvironment: () => new AgenticEnvironment(),
      getModel: () => "gemma4:12b",
      tools: baseTools(),
      getSignal: () => undefined,
    });
    expect(await tool.invoke({ question: "   " })).toBe("Error: research requires a question");
  });

  it("returns the digest and emits started/worker/settled events on the shared bus", async () => {
    const environment = new AgenticEnvironment();
    const recorder = new Recorder();
    recorder.join(environment);

    const fetchImpl: ChatCompletionFetch = async (_url, init) => {
      if (isDecompose(init)) {
        return sseText('["Where is X?"]');
      }
      return sseText("X lives in src/x.ts:1");
    };

    let heartbeats = 0;
    const host: ResearchHost = {
      getEnvironment: () => environment,
      getModel: () => "gemma4:12b",
      tools: baseTools(),
      getSignal: () => new AbortController().signal,
      fetchImpl,
      onHeartbeat: () => {
        heartbeats += 1;
      },
      createId: (() => {
        let n = 0;
        return () => `id${++n}`;
      })(),
    };
    const tool = createResearchTool(host);

    const output = await tool.invoke({ question: "Explain X" });

    expect(output).toContain("X lives in src/x.ts:1");
    expect(heartbeats).toBeGreaterThan(0);

    const started = recorder.events.find((e) => e.type === RESEARCH_STARTED_EVENT);
    expect(started).toBeDefined();
    const startedPayload = started?.payload as ResearchStartedPayload;
    expect(startedPayload.question).toBe("Explain X");
    expect(startedPayload.workers).toHaveLength(1);
    expect(startedPayload.workers[0]?.status).toBe("pending");

    const workerEvents = recorder.events.filter((e) => e.type === RESEARCH_WORKER_EVENT);
    expect(workerEvents.length).toBeGreaterThan(0);

    const settled = recorder.events.find((e) => e.type === RESEARCH_SETTLED_EVENT);
    expect(settled).toBeDefined();
    const settledPayload = settled?.payload as ResearchSettledPayload;
    expect(settledPayload.status).toBe("done");
    expect(settledPayload.digest).toContain("X lives in src/x.ts:1");
  });

  it("returns an Error: string when every worker fails", async () => {
    const environment = new AgenticEnvironment();
    const fetchImpl: ChatCompletionFetch = async (_url, init) => {
      if (isDecompose(init)) {
        return sseText('["q1"]');
      }
      return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
    };
    const tool = createResearchTool({
      getEnvironment: () => environment,
      getModel: () => "gemma4:12b",
      tools: baseTools(),
      getSignal: () => undefined,
      fetchImpl,
    });

    const output = await tool.invoke({ question: "q" });
    expect(output).toMatch(/^Error: /);
  });

  it("resolves with a cancelled note rather than hanging when the signal is already aborted", async () => {
    const environment = new AgenticEnvironment();
    const controller = new AbortController();
    controller.abort();
    const tool = createResearchTool({
      getEnvironment: () => environment,
      getModel: () => "gemma4:12b",
      tools: baseTools(),
      getSignal: () => controller.signal,
      fetchImpl: async () => sseText("should not be reached"),
    });

    const output = await tool.invoke({ question: "q" });
    expect(output).toMatch(/cancelled/i);
  });

  it("reads the environment and signal live at call time, not at tool-construction time", async () => {
    let environment = new AgenticEnvironment();
    let signal: AbortSignal | undefined = new AbortController().signal;
    const seenEnvironments: AgenticEnvironment[] = [];
    const fetchImpl: ChatCompletionFetch = async (_url, init) => {
      if (isDecompose(init)) {
        return sseText('["q1"]');
      }
      return sseText("ok");
    };
    const tool = createResearchTool({
      getEnvironment: () => {
        seenEnvironments.push(environment);
        return environment;
      },
      getModel: () => "gemma4:12b",
      tools: baseTools(),
      getSignal: () => signal,
      fetchImpl,
    });

    // Swap the environment before invoking, as session.ts's rebuild() does on
    // "New Chat" — the tool must pick up the new one, not one captured earlier.
    const rebuilt = new AgenticEnvironment();
    environment = rebuilt;
    signal = new AbortController().signal;
    await tool.invoke({ question: "q" });

    expect(seenEnvironments.every((env) => env === rebuilt)).toBe(true);
  });
});
