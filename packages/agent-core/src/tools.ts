import type { Tool } from "@mozaik-ai/core";
import { toPosix } from "./paths.js";
import type { WorkspacePort } from "./port.js";
import type { ProposedFile, ReviewHost } from "./review.js";
import { applySearchReplace } from "./search-replace.js";

const READ_LIMIT = 100_000;
const SEARCH_LIMIT = 50;

export const SYSTEM_PROMPT =
  "You are a coding assistant in a local workspace. Use tools to read the workspace before answering about code. Do not invent file contents. " +
  "When the user asks to change, refactor, apply, or edit code you MUST call propose_edit. Do not paste the new function as the final answer. Never say you cannot apply edits. " +
  "propose_edit.search is a literal substring copied from read_file. Do not use wildcards like {[^}]*}. If propose_edit fails, copy the exact bytes from the read_file output you already have — do not ask the human for a snippet. " +
  "Never write to disk yourself. Never print a propose_edit JSON template or placeholders like <file-path>. Call the tool. The human reviews Keep All / Undo All. After a successful propose_edit, reply in one short sentence. " +
  "Do not roleplay, do not use personal names, and do not reply with a single unrelated word.";

/** Model invented a wildcard body (`{[^}]*}`), not a regex that already exists in the file. */
export function searchLooksLikeRegex(search: string): boolean {
  return /\{\s*\[\^\}?\]\*\}/.test(search);
}

export function createWorkspaceTools(port: WorkspacePort, reviewHost: ReviewHost): Tool[] {
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
          let original: string;
          try {
            original = await port.readFile(filePath);
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
          const storedPath = toPosix(filePath).replace(/^\.\//, "");
          let text = original;
          for (const block of grouped.get(filePath) ?? []) {
            const result = applySearchReplace(text, block.search, block.replace);
            if (!result.ok) {
              return result.reason === "ambiguous"
                ? `Error: Search matches more than once in ${storedPath}`
                : `Error: Search not found in ${storedPath}`;
            }
            text = result.text;
          }
          proposed.push({ path: storedPath, original, proposed: text });
        }
        const merged = reviewHost.merge(proposed);
        return `Proposed review ${merged.id}: ${merged.paths.join(", ")}`;
      },
    },
  ];
}
