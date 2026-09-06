export interface DiffFile {
  path: string;
  kind: "edit" | "create" | "mkdir";
}

export type ToolCallStatus = "running" | "done";

/** A place a tool reported, offered to the human as somewhere to jump. */
export interface ToolLocation {
  /** Workspace-relative POSIX path. */
  path: string;
  /** 1-based. */
  line: number;
  text: string;
}

/** Lifecycle of one research worker, as the human sees it. */
export type ResearchWorkerStatus = "pending" | "running" | "done" | "failed";

/**
 * One worker's public state. Deliberately small: the worker's own context holds
 * the raw material (file text, fetched pages), and none of it belongs here — the
 * panel shows what a worker is doing, not what it read.
 */
export interface ResearchWorker {
  id: string;
  /** The sub-question this worker owns. */
  question: string;
  status: ResearchWorkerStatus;
  /** Short activity line, e.g. `read src/foo.ts`. Never file contents. */
  activity?: string;
  /** The worker's digest, once done. Capped by the runtime. */
  finding?: string;
  /** Why it failed, when status is "failed". */
  error?: string;
  /** Tool calls made so far, for the progress row. */
  steps: number;
}

export type WebviewToExt =
  | { type: "user_message"; text: string }
  | { type: "apply_diff"; id: string }
  | { type: "reject_diff"; id: string }
  | { type: "open_diff"; id: string; path?: string }
  | { type: "cancel" }
  | { type: "suggest_files"; query: string }
  | { type: "open_url"; url: string }
  | { type: "open_location"; path: string; line: number }
  | { type: "question_answered"; id: string; answer: string }
  | { type: "new_chat" };

export type ExtToWebview =
  | { type: "assistant_delta"; text: string }
  | {
      type: "tool_call";
      name: string;
      args: unknown;
      id: string;
      status: ToolCallStatus;
      /** Places the tool reported; present on "done" when it found any. */
      locations?: ToolLocation[];
    }
  | { type: "diff_proposed"; id: string; files: DiffFile[] }
  | { type: "diff_settled"; id: string; status: "kept" | "undone" }
  | { type: "file_suggestions"; query: string; paths: string[] }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "context_usage"; used: number; max: number | null }
  | { type: "session_cleared" }
  | { type: "problems"; summary: string; locations: ToolLocation[] }
  | { type: "question_asked"; id: string; question: string; options: string[] }
  | { type: "question_settled"; id: string; answer: string | null }
  | { type: "context_trimmed" }
  /** A research run began; `workers` is the full fan-out, all "pending". */
  | { type: "research_started"; id: string; question: string; workers: ResearchWorker[] }
  /** One worker changed. The panel replaces that worker by id. */
  | { type: "research_worker"; id: string; worker: ResearchWorker }
  /**
   * The run finished. `digest` is what the parent agent actually receives as the
   * tool result — showing it keeps the human's view and the model's view honest.
   */
  | {
      type: "research_settled";
      id: string;
      status: "done" | "failed" | "cancelled";
      digest?: string;
      message?: string;
    };
