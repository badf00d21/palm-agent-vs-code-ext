import type { ExtToWebview, ResearchWorker, ToolLocation } from "@palm-agent/shared";

export interface TextLine {
  role: "user" | "assistant";
  text: string;
}

export interface ToolLine {
  role: "tool";
  text: string;
  id: string;
  status: "running" | "done";
  /** Places the tool reported, taken from its result rather than the model's prose. */
  locations?: ToolLocation[];
}

export interface ReviewLine {
  role: "review";
  id: string;
  files: Array<{ path: string; kind: "edit" | "create" | "mkdir" }>;
  status: "pending" | "kept" | "undone";
}

export interface StatusLine {
  role: "status";
  text: string;
  /** Present for problems reported after an apply, so each is somewhere to go. */
  locations?: ToolLocation[];
}

export interface QuestionLine {
  role: "question";
  id: string;
  question: string;
  options: string[];
  /** The given answer once settled; null while open or if the turn ended first. */
  answer: string | null;
  settled: boolean;
}

export interface ResearchLine {
  role: "research";
  id: string;
  question: string;
  workers: ResearchWorker[];
  /** Mirrors `research_settled`'s status; "running" while the fan-out is in flight. */
  status: "running" | "done" | "failed" | "cancelled";
  digest?: string;
  message?: string;
}

export type ChatLine =
  | TextLine
  | ToolLine
  | ReviewLine
  | StatusLine
  | QuestionLine
  | ResearchLine;

export function isReviewLine(line: ChatLine): line is ReviewLine {
  return line.role === "review";
}

/** Pending first so a live proposal stays on top when an older review is still listed. */
export function dockedReviews(messages: ChatLine[]): ReviewLine[] {
  const reviews = messages.filter(isReviewLine);
  return [
    ...reviews.filter((review) => review.status === "pending"),
    ...reviews.filter((review) => review.status !== "pending"),
  ];
}

export function reviewDockSummary(reviews: ReviewLine[]): {
  reviewCount: number;
  fileCount: number;
  label: string;
} {
  const pending = reviews.filter((review) => review.status === "pending");
  const reviewCount = pending.length;
  const fileCount = pending.reduce((sum, review) => sum + review.files.length, 0);
  if (reviewCount === 0) {
    return { reviewCount: 0, fileCount: 0, label: "" };
  }
  const reviewWord = reviewCount === 1 ? "review" : "reviews";
  const fileWord = fileCount === 1 ? "file" : "files";
  return {
    reviewCount,
    fileCount,
    label: `${reviewCount} ${reviewWord} · ${fileCount} ${fileWord}`,
  };
}

export function transcriptLines(messages: ChatLine[]): ChatLine[] {
  return messages.filter((line) => !isReviewLine(line));
}

export function formatToolArgs(args: unknown): string {
  if (args && typeof args === "object" && "path" in args) {
    return String((args as { path: unknown }).path);
  }
  if (args && typeof args === "object" && "query" in args) {
    return String((args as { query: unknown }).query);
  }
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

export function isReviewStoreError(message: string): boolean {
  return (
    message === "No pending review" ||
    message === "File is not in the review" ||
    message === "Directory has no diff" ||
    message.startsWith("File changed since proposal:")
  );
}

export function shouldClearBusy(msg: ExtToWebview): boolean {
  if (msg.type === "done") {
    return true;
  }
  if (msg.type === "error") {
    return !isReviewStoreError(msg.message);
  }
  return false;
}

export function applyExtMessage(messages: ChatLine[], msg: ExtToWebview): ChatLine[] {
  if (msg.type === "assistant_delta") {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      return [...messages.slice(0, -1), { role: "assistant", text: last.text + msg.text }];
    }
    return [...messages, { role: "assistant", text: msg.text }];
  }
  if (msg.type === "tool_call") {
    const existing = messages.findIndex((line) => line.role === "tool" && line.id === msg.id);
    if (existing >= 0 && msg.status === "done") {
      return messages.map((line, index) =>
        index === existing && line.role === "tool"
          ? {
              ...line,
              status: "done" as const,
              ...(msg.locations ? { locations: msg.locations } : {}),
            }
          : line,
      );
    }
    if (msg.status === "done") {
      return messages;
    }
    const detail = formatToolArgs(msg.args);
    const text = detail ? `${msg.name}  ${detail}` : msg.name;
    return [...messages, { role: "tool", text, id: msg.id, status: msg.status }];
  }
  if (msg.type === "error") {
    return [...messages, { role: "assistant", text: `Error: ${msg.message}` }];
  }
  if (msg.type === "diff_proposed") {
    const files = msg.files;
    const exists = messages.some((line) => line.role === "review" && line.id === msg.id);
    if (exists) {
      return messages.map((line) =>
        line.role === "review" && line.id === msg.id
          ? { ...line, files, status: "pending" as const }
          : line,
      );
    }
    return [...messages, { role: "review", id: msg.id, files, status: "pending" }];
  }
  if (msg.type === "diff_settled") {
    return messages.map((line) =>
      line.role === "review" && line.id === msg.id ? { ...line, status: msg.status } : line,
    );
  }
  if (msg.type === "question_asked") {
    return [
      ...messages,
      {
        role: "question",
        id: msg.id,
        question: msg.question,
        options: msg.options,
        answer: null,
        settled: false,
      },
    ];
  }
  if (msg.type === "question_settled") {
    return messages.map((line) =>
      line.role === "question" && line.id === msg.id
        ? { ...line, answer: msg.answer, settled: true }
        : line,
    );
  }
  if (msg.type === "problems") {
    return [...messages, { role: "status", text: msg.summary, locations: msg.locations }];
  }
  if (msg.type === "context_trimmed") {
    return [...messages, { role: "status", text: "Context trimmed to last 3 turns" }];
  }
  if (msg.type === "research_started") {
    return [
      ...messages,
      {
        role: "research",
        id: msg.id,
        question: msg.question,
        workers: msg.workers,
        status: "running",
      },
    ];
  }
  if (msg.type === "research_worker") {
    return messages.map((line) => {
      if (line.role !== "research" || line.id !== msg.id) {
        return line;
      }
      const known = line.workers.some((worker) => worker.id === msg.worker.id);
      if (!known) {
        return line;
      }
      return {
        ...line,
        workers: line.workers.map((worker) => (worker.id === msg.worker.id ? msg.worker : worker)),
      };
    });
  }
  if (msg.type === "research_settled") {
    return messages.map((line) => {
      if (line.role !== "research" || line.id !== msg.id) {
        return line;
      }
      // A worker still "pending"/"running" when the run settles has no further
      // updates coming — resolve it now so no row spins forever.
      const workers = line.workers.map((worker) => {
        if (worker.status !== "pending" && worker.status !== "running") {
          return worker;
        }
        if (msg.status === "done") {
          return { ...worker, status: "done" as const };
        }
        return {
          ...worker,
          status: "failed" as const,
          error: worker.error ?? (msg.status === "cancelled" ? "Cancelled" : msg.message ?? "Failed"),
        };
      });
      return { ...line, status: msg.status, digest: msg.digest, message: msg.message, workers };
    });
  }
  return messages;
}
