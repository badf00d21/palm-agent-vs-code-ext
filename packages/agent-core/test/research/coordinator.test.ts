import type { Tool } from "@mozaik-ai/core";
import { describe, expect, it, vi } from "vitest";
import type { ResearchWorker } from "@palm-agent/shared";
import { AgenticEnvironment } from "../../src/runtime/environment.js";
import type { ChatCompletionFetch } from "../../src/model/local-inference.js";
import {
  DIGEST_CHAR_LIMIT,
  FINDING_CHAR_LIMIT,
  MAX_CONCURRENT_WORKERS,
  MAX_SUBQUESTIONS,
  parseSubQuestions,
  runResearch,
  type ResearchCoordinatorHost,
} from "../../src/research/coordinator.js";

function sseText(content: string, finish = "stop"): Response {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function httpError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

interface Req {
  systemText: string;
  lastUserText: string;
}

function readReq(init?: RequestInit): Req {
  const body = JSON.parse(String(init?.body)) as {
    messages: Array<{ role: string; content?: string | null }>;
  };
  const systemText = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const userMessages = body.messages.filter((m) => m.role === "user");
  const lastUserText = String(userMessages[userMessages.length - 1]?.content ?? "");
  return { systemText, lastUserText };
}

function isDecomposeRequest(req: Req): boolean {
  return req.systemText.includes("split a research question");
}

function makeTools(): Tool[] {
  const readOnly = (name: string): Tool => ({
    name,
    description: "test",
    strict: true,
    type: "function",
    parameters: { type: "object", properties: {}, required: [] },
    invoke: async () => "unused",
  });
  return [
    readOnly("read_file"),
    readOnly("search"),
    readOnly("glob"),
    readOnly("outline"),
    readOnly("list_dir"),
    readOnly("write"),
    readOnly("edit"),
    readOnly("propose_edit"),
    readOnly("question"),
  ];
}

function baseHost(
  fetchImpl: ChatCompletionFetch,
  overrides: Partial<ResearchCoordinatorHost> = {},
): { host: ResearchCoordinatorHost; started: ResearchWorker[][]; events: ResearchWorker[]; heartbeats: number } {
  const started: ResearchWorker[][] = [];
  const events: ResearchWorker[] = [];
  const counter = { heartbeats: 0 };
  let id = 0;
  const host: ResearchCoordinatorHost = {
    environment: new AgenticEnvironment(),
    model: "gemma4:12b",
    tools: makeTools(),
    fetchImpl,
    createId: () => `w${++id}`,
    onStarted: (workers) => started.push(workers),
    onWorkerEvent: (worker) => events.push(worker),
    onHeartbeat: () => {
      counter.heartbeats += 1;
    },
    ...overrides,
  };
  return { host, started, events, get heartbeats() { return counter.heartbeats; } } as unknown as {
    host: ResearchCoordinatorHost;
    started: ResearchWorker[][];
    events: ResearchWorker[];
    heartbeats: number;
  };
}

describe("parseSubQuestions", () => {
  it("parses a clean JSON array", () => {
    expect(parseSubQuestions('["a", "b", "c"]', "orig")).toEqual(["a", "b", "c"]);
  });

  it("strips a markdown fence around the JSON", () => {
    expect(parseSubQuestions('```json\n["a", "b"]\n```', "orig")).toEqual(["a", "b"]);
  });

  it("falls back to the original question for garbage output", () => {
    expect(parseSubQuestions("I cannot help with that request.", "orig question")).toEqual([
      "orig question",
    ]);
  });

  it("caps the number of sub-questions", () => {
    const many = JSON.stringify(Array.from({ length: 10 }, (_, i) => `q${i}`));
    expect(parseSubQuestions(many, "orig")).toHaveLength(MAX_SUBQUESTIONS);
  });

  it("falls back to a numbered-list heuristic when the model ignores the JSON instruction", () => {
    const text = "1. First question\n2. Second question\n3. Third question";
    expect(parseSubQuestions(text, "orig")).toEqual([
      "First question",
      "Second question",
      "Third question",
    ]);
  });
});

describe("runResearch", () => {
  it("fans out to the decomposed sub-questions and aggregates a digest", async () => {
    const fetchImpl: ChatCompletionFetch = async (_url, init) => {
      const req = readReq(init);
      if (isDecomposeRequest(req)) {
        return sseText('["Where is X defined?", "How is Y configured?"]');
      }
      if (req.lastUserText.includes("X defined")) {
        return sseText("X is defined in src/x.ts:10");
      }
      return sseText("Y is configured via config.json");
    };
    const { host, started } = baseHost(fetchImpl);

    const result = await runResearch("Explain X and Y", host, new AbortController().signal);

    expect(result.status).toBe("done");
    expect(result.workers).toHaveLength(2);
    expect(started[0]).toHaveLength(2);
    expect(started[0]?.every((w) => w.status === "pending")).toBe(true);
    expect(result.digest).toContain("X is defined in src/x.ts:10");
    expect(result.digest).toContain("Y is configured via config.json");
  });

  it("caps each finding and the total digest length", async () => {
    const long = "z".repeat(FINDING_CHAR_LIMIT + 200);
    const fetchImpl: ChatCompletionFetch = async (_url, init) => {
      const req = readReq(init);
      if (isDecomposeRequest(req)) {
        return sseText(JSON.stringify(["q1", "q2", "q3", "q4"]));
      }
      return sseText(long);
    };
    const { host } = baseHost(fetchImpl);

    const result = await runResearch("broad question", host, new AbortController().signal);

    expect(result.status).toBe("done");
    for (const worker of result.workers) {
      expect(worker.finding?.length ?? 0).toBeLessThanOrEqual(FINDING_CHAR_LIMIT);
    }
    expect(result.digest?.length ?? 0).toBeLessThanOrEqual(DIGEST_CHAR_LIMIT + "\n[digest truncated]".length);
  });

  it("keeps other findings when exactly one worker fails", async () => {
    const fetchImpl: ChatCompletionFetch = async (_url, init) => {
      const req = readReq(init);
      if (isDecomposeRequest(req)) {
        return sseText('["good question", "bad question"]');
      }
      if (req.lastUserText.includes("bad")) {
        return httpError(500, "boom");
      }
      return sseText("all is well");
    };
    const { host } = baseHost(fetchImpl);

    const result = await runResearch("q", host, new AbortController().signal);

    expect(result.status).toBe("done");
    const good = result.workers.find((w) => w.question.includes("good"));
    const bad = result.workers.find((w) => w.question.includes("bad"));
    expect(good?.status).toBe("done");
    expect(good?.finding).toBe("all is well");
    expect(bad?.status).toBe("failed");
    expect(bad?.error).toBeTruthy();
    expect(result.digest).toContain("all is well");
  });

  it("returns a failed status when every worker fails", async () => {
    const fetchImpl: ChatCompletionFetch = async (_url, init) => {
      const req = readReq(init);
      if (isDecomposeRequest(req)) {
        return sseText('["q1", "q2"]');
      }
      return httpError(500, "everything is on fire");
    };
    const { host } = baseHost(fetchImpl);

    const result = await runResearch("q", host, new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.message).toBeTruthy();
    expect(result.workers.every((w) => w.status === "failed")).toBe(true);
  });

  it("resolves as cancelled instead of hanging when aborted mid-run", async () => {
    const controller = new AbortController();
    const fetchImpl: ChatCompletionFetch = async (_url, init) => {
      const req = readReq(init);
      if (isDecomposeRequest(req)) {
        return sseText('["q1", "q2", "q3"]');
      }
      // Never resolves on its own; only the abort signal settles it.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    };
    const { host } = baseHost(fetchImpl);

    const runPromise = runResearch("q", host, controller.signal);
    // Give the decomposition call and the first fan-out tick a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const result = await runPromise;
    expect(result.status).toBe("cancelled");
    expect(result.workers.every((w) => w.status === "failed" || w.status === "pending")).toBe(
      true,
    );
  });

  it("never runs more than MAX_CONCURRENT_WORKERS inference calls at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const fetchImpl: ChatCompletionFetch = async (_url, init) => {
      const req = readReq(init);
      if (isDecomposeRequest(req)) {
        return sseText(JSON.stringify(["q1", "q2", "q3", "q4"]));
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return sseText("done");
    };
    const { host } = baseHost(fetchImpl);

    const runPromise = runResearch("q", host, new AbortController().signal);

    // Let the decomposition call and first wave of worker calls start.
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_WORKERS);

    // Release everything so the run can finish.
    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const result = await runPromise;
    expect(result.status).toBe("done");
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_WORKERS);
  });

  it("falls back to a single worker when decomposition returns garbage", async () => {
    const fetchImpl: ChatCompletionFetch = async (_url, init) => {
      const req = readReq(init);
      if (isDecomposeRequest(req)) {
        return sseText("As an AI I cannot split this question.");
      }
      return sseText("the answer");
    };
    const { host, started } = baseHost(fetchImpl);

    const result = await runResearch("original question", host, new AbortController().signal);

    expect(result.status).toBe("done");
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0]?.question).toBe("original question");
    expect(started[0]).toHaveLength(1);
  });
});
