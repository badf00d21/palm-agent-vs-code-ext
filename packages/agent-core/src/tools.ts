import type { Tool } from "@mozaik-ai/core";
import type { WorkspacePort } from "./port.js";

const READ_LIMIT = 100_000;
const SEARCH_LIMIT = 50;

export const SYSTEM_PROMPT =
  "You are a coding assistant in a local workspace. Use the provided tools to read the workspace before answering questions about code. Do not invent file contents. You cannot write files or apply patches in this version — only read, list, search, and report the active editor context. Never print a tool call as JSON in your reply — call the tool instead. This repo is TypeScript (not Python); prefer *.ts / *.tsx when searching.";

export function createWorkspaceTools(port: WorkspacePort): Tool[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file in the workspace. Path is relative to the workspace root.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative path" } },
        required: ["path"],
      },
      invoke: async (args) => {
        const filePath = String(args.path ?? "");
        try {
          const text = await port.readFile(filePath);
          if (text.length > READ_LIMIT) {
            return `${text.slice(0, READ_LIMIT)}\n[truncated]`;
          }
          return text;
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "list_dir",
      description: "List one directory level in the workspace.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative directory" } },
        required: ["path"],
      },
      invoke: async (args) => {
        try {
          const entries = await port.listDir(String(args.path ?? ""));
          return entries.map((e) => `${e.type} ${e.name}`).join("\n");
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "search",
      description: "Search workspace file contents with a text query. Optional glob limits files.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          glob: { type: "string" },
        },
        required: ["query"],
      },
      invoke: async (args) => {
        const query = String(args.query ?? "").trim();
        if (!query) {
          return "Error: Empty search query";
        }
        const glob = typeof args.glob === "string" ? args.glob : undefined;
        try {
          const hits = await port.search(query, glob);
          const sliced = hits.slice(0, SEARCH_LIMIT);
          const lines = sliced.map((h) => `${h.path}:${h.line}:${h.text}`);
          if (hits.length > SEARCH_LIMIT) {
            lines.push("[truncated to 50 hits]");
          }
          return lines.join("\n") || "No matches";
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "get_context",
      description: "Return the active editor file path and selected text, if any.",
      strict: true,
      type: "function",
      parameters: { type: "object", properties: {}, required: [] },
      invoke: async () => {
        try {
          return JSON.stringify(await port.getContext());
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
  ];
}
