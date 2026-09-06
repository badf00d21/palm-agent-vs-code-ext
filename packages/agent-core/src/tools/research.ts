import type { Tool } from "@mozaik-ai/core";
import type { ResearchWorker } from "@palm-agent/shared";
import { AgenticEnvironment, BaseParticipant, createSemanticEvent } from "../runtime/environment.js";
import type { ChatCompletionFetch } from "../model/local-inference.js";
import { runResearch, type ResearchCoordinatorHost } from "../research/coordinator.js";

/** A research run began; payload mirrors ExtToWebview's "research_started" minus `type`. */
export const RESEARCH_STARTED_EVENT = "research_started";
/** One worker changed; payload mirrors ExtToWebview's "research_worker" minus `type`. */
export const RESEARCH_WORKER_EVENT = "research_worker";
/** The run finished; payload mirrors ExtToWebview's "research_settled" minus `type`. */
export const RESEARCH_SETTLED_EVENT = "research_settled";

export interface ResearchStartedPayload {
  id: string;
  question: string;
  workers: ResearchWorker[];
}

export interface ResearchWorkerPayload {
  id: string;
  worker: ResearchWorker;
}

export interface ResearchSettledPayload {
  id: string;
  status: "done" | "failed" | "cancelled";
  digest?: string;
  message?: string;
}

/**
 * Editor-side wiring for the `research` tool, mirroring QuestionHost/ReviewHost:
 * agent-core states what it needs, session.ts decides how the run is hosted.
 *
 * `getEnvironment` and `getSignal` are live getters, not static values, because
 * this tool is built once alongside the other workspace tools while `environment`
 * and the turn's AbortController are recreated per turn (and per "New Chat")
 * inside session.ts — a value captured at tool-construction time would go stale.
 */
export interface ResearchHost {
  /** The bus the current turn's EditorAgent and UIBridge are joined to. */
  getEnvironment: () => AgenticEnvironment;
  /** Model id for both the decomposition call and every worker (live — settings can change). */
  getModel: () => string;
  /** The full workspace tool list (same array given to EditorAgent). Filtered to a read-only subset internally — do not pre-filter. */
  tools: Tool[];
  /** The AbortSignal for the turn currently in flight, if any. */
  getSignal: () => AbortSignal | undefined;
  /**
   * Fired on every worker lifecycle change. Research is model/I-O time, not human
   * time, so — unlike `question` — the caller's idle timer must keep being bumped
   * for as long as the run makes progress, or a run past 120s kills the turn.
   * Must not throw.
   */
  onHeartbeat?: () => void;
  /** Injectable for tests; defaults to crypto.randomUUID. */
  createId?: () => string;
  /** Injectable transport for tests; production omits it so global fetch is used. */
  fetchImpl?: ChatCompletionFetch;
}

function readQuestion(args: Record<string, unknown>): string {
  return String(args.question ?? "").trim();
}

export function createResearchTool(host: ResearchHost): Tool {
  return {
    name: "research",
    description:
      "Decompose a broad question into a few sub-questions and research each one in parallel using read-only " +
      "workers (read_file, search, glob, outline, list_dir). Returns one compact digest — the files each worker " +
      "reads never reach your context, only their findings do. Use this for a question that would otherwise take " +
      "many reads across many files to answer yourself (for example 'how does X flow through the codebase' or " +
      "'where are all the places Y is configured'). Do not use it for a single known file or a narrow lookup you " +
      "can answer with one or two direct tool calls.",
    strict: true,
    type: "function",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The broad question to research" },
      },
      required: ["question"],
    },
    invoke: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const question = readQuestion(args);
      if (!question) {
        return "Error: research requires a question";
      }

      const environment = host.getEnvironment();
      const signal = host.getSignal() ?? new AbortController().signal;
      const runId = (host.createId ?? (() => crypto.randomUUID()))();
      const producer = new BaseParticipant("Research Coordinator", "agent");
      // sendEvent looks the producer up by id among joined participants and
      // throws if it is not registered — this participant exists only to label
      // these events, but it still has to join.
      environment.join(producer);

      const emit = (type: string, payload: unknown): void => {
        environment.deliverSemanticEvent(producer, createSemanticEvent(type, payload, producer.getId()));
      };

      const coordinatorHost: ResearchCoordinatorHost = {
        environment,
        model: host.getModel(),
        tools: host.tools,
        fetchImpl: host.fetchImpl,
        createId: host.createId,
        onHeartbeat: host.onHeartbeat,
        onStarted: (workers) => {
          emit(RESEARCH_STARTED_EVENT, {
            id: runId,
            question,
            workers,
          } satisfies ResearchStartedPayload);
        },
        onWorkerEvent: (worker) => {
          emit(RESEARCH_WORKER_EVENT, { id: runId, worker } satisfies ResearchWorkerPayload);
        },
      };

      const result = await runResearch(question, coordinatorHost, signal);

      emit(RESEARCH_SETTLED_EVENT, {
        id: runId,
        status: result.status,
        digest: result.digest,
        message: result.message,
      } satisfies ResearchSettledPayload);

      if (result.status === "failed") {
        return `Error: ${result.message ?? "All research workers failed."}`;
      }
      if (result.status === "cancelled") {
        return result.digest
          ? `${result.digest}\n\n[Research cancelled before all workers finished.]`
          : "Research cancelled before it produced findings.";
      }
      return result.digest && result.digest.length > 0 ? result.digest : "No findings.";
    },
  };
}
