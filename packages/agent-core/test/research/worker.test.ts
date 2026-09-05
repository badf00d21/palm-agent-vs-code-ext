import type { Tool } from "@mozaik-ai/core";
import { describe, expect, it, vi } from "vitest";
import { AgenticEnvironment } from "../../src/runtime/environment.js";
import type { ChatCompletionFetch } from "../../src/model/local-inference.js";
import {
  ResearchWorkerAgent,
  WORKER_MAX_IDENTICAL_CALLS,
  WORKER_MAX_INFERENCE_STEPS,
  describeToolCall,
  filterReadOnlyTools,
} from "../../src/research/worker.js";
import { ModelContext } from "@mozaik-ai/core";

function sseText(content: string, finish = "stop"): Response {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function sseToolCall(name: string, args: Record<string, unknown>, callId = "call_1"): Response {
  const body =
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: callId, function: { name, arguments: "" } }] } }],
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function readOnlyTool(name: string, invoke: (args: unknown) => Promise<string>): Tool {
  return {
    name,
    description: "test",
    strict: true,
    type: "function",
    parameters: { type: "object", properties: {}, required: [] },
    invoke,
  };
}

describe("filterReadOnlyTools", () => {
  it("keeps only the read-only surface, dropping write/edit/propose_edit/question", () => {
    const all: Tool[] = [
      "read_file",
      "list_dir",
      "search",
      "outline",
      "glob",
      "references",
      "hover",
      "diagnostics",
      "web_fetch",
      "docs_search",
      "get_context",
      "write",
      "edit",
      "propose_edit",
      "question",
      "research",
    ].map((name) => readOnlyTool(name, async () => ""));

    const kept = filterReadOnlyTools(all).map((t) => t.name);

    expect(kept).toEqual([
      "read_file",
      "list_dir",
      "search",
      "outline",
      "glob",
      "references",
      "hover",
      "diagnostics",
      "web_fetch",
      "docs_search",
    ]);
  });

  it("drops a tool it has never heard of, rather than assuming it is safe", () => {
    // The allow-list has to fail closed: a tool added later that can write must
    // not reach a worker just because nobody remembered to exclude it.
    const kept = filterReadOnlyTools([readOnlyTool("run_terminal", async () => "")]);
    expect(kept).toEqual([]);
  });
});

describe("describeToolCall", () => {
  it("builds a short content-free activity line", () => {
    expect(describeToolCall("read_file", JSON.stringify({ path: "src/a.ts" }))).toBe(
      "read_file src/a.ts",
    );
    expect(describeToolCall("search", JSON.stringify({ query: "foo" }))).toBe("search foo");
    expect(describeToolCall("list_dir", "not-json")).toBe("list_dir");
  });
});

function setup(tools: Tool[], fetchImpl: ChatCompletionFetch) {
  const environment = new AgenticEnvironment();
  const context = ModelContext.create();
  const done = vi.fn();
  const failed = vi.fn();
  const activity = vi.fn();
  const agent = new ResearchWorkerAgent(
    environment,
    context,
    tools,
    "gemma4:12b",
    { onActivity: activity, onDone: done, onFailed: failed },
    fetchImpl,
  );
  agent.join(environment);
  return { environment, agent, done, failed, activity };
}

describe("ResearchWorkerAgent", () => {
  it("calls a read-only tool then finishes with the model's final answer", async () => {
    let call = 0;
    const fetchImpl: ChatCompletionFetch = async () => {
      call += 1;
      return call === 1 ? sseToolCall("search", { query: "foo" }) : sseText("Found it in a.ts:12");
    };
    const searchCalls: unknown[] = [];
    const tools = [readOnlyTool("search", async (args) => { searchCalls.push(args); return "a.ts:12: foo"; })];
    const { agent, done, failed } = setup(tools, fetchImpl);

    const controller = new AbortController();
    agent.start("Where is foo defined?", controller.signal);

    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(failed).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith("Found it in a.ts:12");
    expect(searchCalls).toEqual([{ query: "foo" }]);
  });

  it("fails after too many tool steps instead of looping forever", async () => {
    const fetchImpl: ChatCompletionFetch = async () => sseToolCall("search", { query: "x" });
    const tools = [readOnlyTool("search", async () => "no matches")];
    const { agent, failed, done } = setup(tools, fetchImpl);

    agent.start("q", new AbortController().signal);

    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    expect(done).not.toHaveBeenCalled();
    expect(failed.mock.calls[0]?.[0]).toMatch(/too many tool steps/i);
    // Never called more times than the step budget allows.
    expect(failed).toHaveBeenCalledTimes(1);
    void WORKER_MAX_INFERENCE_STEPS;
  });

  it("blocks a third identical call", async () => {
    let ran = 0;
    let call = 0;
    const fetchImpl: ChatCompletionFetch = async () => {
      call += 1;
      return call > WORKER_MAX_INFERENCE_STEPS ? sseText("giving up") : sseToolCall("search", { query: "x" }, `c${call}`);
    };
    const tools = [readOnlyTool("search", async () => { ran += 1; return "hit"; })];
    const { agent, failed } = setup(tools, fetchImpl);

    agent.start("q", new AbortController().signal);

    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    expect(ran).toBe(WORKER_MAX_IDENTICAL_CALLS);
  });

  it("resolves via onFailed, never hangs, when aborted mid-run", async () => {
    let resolveFetch: (() => void) | undefined;
    const fetchImpl: ChatCompletionFetch = (_url, init) =>
      new Promise((resolve, reject) => {
        resolveFetch = () => resolve(sseText("too late"));
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const tools: Tool[] = [];
    const { agent, failed, done } = setup(tools, fetchImpl);
    const controller = new AbortController();

    agent.start("q", controller.signal);
    controller.abort();

    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    expect(done).not.toHaveBeenCalled();
    resolveFetch?.();
  });

  it("feeds an unknown tool name back as an error instead of throwing", async () => {
    let call = 0;
    const fetchImpl: ChatCompletionFetch = async () => {
      call += 1;
      return call === 1 ? sseToolCall("nope", {}) : sseText("done");
    };
    const { agent, done, failed } = setup([readOnlyTool("search", async () => "hit")], fetchImpl);

    agent.start("q", new AbortController().signal);

    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("ResearchWorkerAgent cross-talk", () => {
  it("does not let one worker's function-call events drive another worker's loop", async () => {
    const environment = new AgenticEnvironment();
    const contextA = ModelContext.create();
    const contextB = ModelContext.create();
    let ranA = 0;
    let ranB = 0;
    const toolsA = [readOnlyTool("echo", async () => { ranA += 1; return "A"; })];
    const toolsB = [readOnlyTool("echo", async () => { ranB += 1; return "B"; })];
    const doneA = vi.fn();
    const doneB = vi.fn();

    const agentA = new ResearchWorkerAgent(
      environment,
      contextA,
      toolsA,
      "gemma4:12b",
      { onActivity: () => undefined, onDone: doneA, onFailed: () => undefined },
      async () => sseText("unused"),
    );
    const agentB = new ResearchWorkerAgent(
      environment,
      contextB,
      toolsB,
      "gemma4:12b",
      { onActivity: () => undefined, onDone: doneB, onFailed: () => undefined },
      async () => sseText("unused"),
    );
    agentA.join(environment);
    agentB.join(environment);

    // Simulate the bus delivering A's own function-call event — Mozaik broadcasts
    // this to every joined participant, so B receives it too as an "external" event.
    const { FunctionCallItem } = await import("@mozaik-ai/core");
    environment.deliverFunctionCall(
      agentA,
      FunctionCallItem.rehydrate({ callId: "call_a1", name: "echo", args: "{}" }),
    );

    await vi.waitFor(() => expect(ranA).toBe(1));
    // B must never have run its tool just because A produced a function call.
    expect(ranB).toBe(0);
    expect(doneB).not.toHaveBeenCalled();
  });
});
