export interface DiffFile {
  path: string;
  search: string;
  replace: string;
}

export type WebviewToExt =
  | { type: "user_message"; text: string }
  | { type: "apply_diff"; id: string }
  | { type: "reject_diff"; id: string }
  | { type: "cancel" };

export type ExtToWebview =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "diff_proposed"; id: string; files: DiffFile[] }
  | { type: "done" }
  | { type: "error"; message: string };
