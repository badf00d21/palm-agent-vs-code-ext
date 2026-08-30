import type { Tool } from "@mozaik-ai/core";
import { locateWorkspaceFile } from "../workspace/locate.js";
import { toPosix } from "../workspace/paths.js";
import type { WorkspacePort } from "../workspace/port.js";
import { exactFunctionInFile, functionNameFromSearch } from "./named-function.js";
import type { ProposedFile, ReviewHost } from "./review.js";
import { applySearchReplace } from "./search-replace.js";

const READ_LIMIT = 100_000;
const SEARCH_LIMIT = 50;

export const SYSTEM_PROMPT =
  "You are a coding assistant in a local workspace. Use tools to find and read code before answering. Do not invent file contents or paths. " +
  "If the user names a function, symbol, or filename without a full path: search for it (or get_context if the file is likely open). Never ask the human for a path or snippet you can get with tools. read_file accepts a unique filename like abc-import.ts. " +
  "When the user asks to change, refactor, apply, or edit code you MUST call propose_edit. Do not paste the new function as the final answer. Never say you cannot apply edits. " +
  "propose_edit.search is a literal substring copied from the read_file output. Do not use wildcards like {[^}]*}. If propose_edit returns exact function text, use that as search and call propose_edit again. " +
  "Never write to disk yourself. Never print a propose_edit JSON template or placeholders like <file-path>. After a successful propose_edit, reply in one short sentence. " +
  "Do not roleplay, do not use personal names, and do not reply with a single unrelated word.";

/** Model invented a wildcard body (`{[^}]*}`), not a regex that already exists in the file. */
export function searchLooksLikeRegex(search: string): boolean {
  return /\{\s*\[\^\}?\]\*\}/.test(search);
}

export function createWorkspaceTools(port: WorkspacePort, reviewHost: ReviewHost): Tool[] {
  return [
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file. Path may be workspace-relative or a unique filename (abc-import.ts).",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative path" } },
        required: ["path"],
      },
      invoke: async (args) => {
        const located = await locateWorkspaceFile(port, String(args.path ?? ""));
        if ("error" in located) {
          return `Error: ${located.error}`;
        }
        const prefix = located.path !== toPosix(String(args.path ?? "")).replace(/^\.\//, "")
          ? `[path: ${located.path}]\n`
          : "";
        if (located.text.length > READ_LIMIT) {
          return `${prefix}${located.text.slice(0, READ_LIMIT)}\n[truncated]`;
        }
        return `${prefix}${located.text}`;
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
      description:
        "Search workspace file contents. Use this to find which file contains a function or symbol when the user did not give a path.",
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
    {
      name: "propose_edit",
      description:
        "Propose literal SEARCH/REPLACE edits to existing files. search must be copied exactly from read_file (not a regex). Call this when the user wants a code change. Does not write disk. The human reviews Keep All / Undo All.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                search: { type: "string" },
                replace: { type: "string" },
              },
              required: ["path", "search", "replace"],
            },
          },
        },
        required: ["files"],
      },
      invoke: async (args) => {
        const raw: unknown[] = Array.isArray(args.files) ? args.files : [];
        const blocks = raw.map((row) => {
          const rec = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
          return {
            path: String(rec.path ?? ""),
            search: String(rec.search ?? ""),
            replace: String(rec.replace ?? ""),
          };
        });
        if (blocks.length === 0 || blocks.some((b) => !b.path.trim() || !b.search)) {
          return "Error: propose_edit requires path and search";
        }
        if (blocks.some((b) => b.search === b.replace)) {
          return "Error: search and replace are identical";
        }
        const regexSearch = blocks.find((b) => searchLooksLikeRegex(b.search));
        if (regexSearch) {
          return `Error: search is a regex, not file text (${regexSearch.search.slice(0, 80)}). Copy the exact function from read_file.`;
        }
        const order: string[] = [];
        const grouped = new Map<string, Array<{ search: string; replace: string }>>();
        for (const block of blocks) {
          if (!grouped.has(block.path)) {
            order.push(block.path);
            grouped.set(block.path, []);
          }
          grouped.get(block.path)!.push({ search: block.search, replace: block.replace });
        }
        const proposed: ProposedFile[] = [];
        for (const filePath of order) {
          const located = await locateWorkspaceFile(port, filePath);
          if ("error" in located) {
            return `Error: ${located.error}`;
          }
          const storedPath = located.path;
          let text = located.text;
          for (const block of grouped.get(filePath) ?? []) {
            const result = applySearchReplace(text, block.search, block.replace);
            if (!result.ok) {
              if (result.reason === "ambiguous") {
                return `Error: Search matches more than once in ${storedPath}`;
              }
              const name = functionNameFromSearch(block.search);
              const exact = name ? exactFunctionInFile(text, name) : undefined;
              if (exact) {
                return `Error: Search not found in ${storedPath}. Use this exact text as search:\n---\n${exact}\n---`;
              }
              return `Error: Search not found in ${storedPath}`;
            }
            text = result.text;
          }
          proposed.push({ path: storedPath, original: located.text, proposed: text });
        }
        const merged = reviewHost.merge(proposed);
        return `Proposed review ${merged.id}: ${merged.paths.join(", ")}`;
      },
    },
  ];
}
