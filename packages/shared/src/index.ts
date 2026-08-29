export interface DiffFile {
  path: string;
}

export type WebviewToExt =
  | { type: "user_message"; text: string }
  | { type: "apply_diff"; id: string }
  | { type: "reject_diff"; id: string }
  | { type: "open_diff"; id: string; path?: string }
  | { type: "cancel" };

export type ExtToWebview =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "diff_proposed"; id: string; files: DiffFile[] }
  | { type: "diff_settled"; id: string; status: "kept" | "undone" }
  | { type: "done" }
  | { type: "error"; message: string };
