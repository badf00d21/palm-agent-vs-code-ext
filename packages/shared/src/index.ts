export interface DiffFile {
  path: string;
  kind: "edit" | "create" | "mkdir";
}

export type ToolCallStatus = "running" | "done";

export type WebviewToExt =
  | { type: "user_message"; text: string }
  | { type: "apply_diff"; id: string }
  | { type: "reject_diff"; id: string }
  | { type: "open_diff"; id: string; path?: string }
  | { type: "cancel" }
  | { type: "suggest_files"; query: string }
  | { type: "get_selection" }
  | { type: "open_url"; url: string }
  | { type: "open_location"; path: string; line: number }
  | { type: "question_answered"; id: string; answer: string }
  | { type: "new_chat" };

export type ExtToWebview =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call"; name: string; args: unknown; id: string; status: ToolCallStatus }
  | { type: "diff_proposed"; id: string; files: DiffFile[] }
  | { type: "diff_settled"; id: string; status: "kept" | "undone" }
  | { type: "file_suggestions"; query: string; paths: string[] }
  | { type: "selection"; text: string | null }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "context_usage"; used: number; max: number | null }
  | { type: "session_cleared" }
  | { type: "question_asked"; id: string; question: string; options: string[] }
  | { type: "question_settled"; id: string; answer: string | null }
  | { type: "context_trimmed" };
