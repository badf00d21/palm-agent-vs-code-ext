import type { Tool } from "@mozaik-ai/core";
import { locateWorkspaceFile } from "../workspace/locate.js";
import { toPosix } from "../workspace/paths.js";
import type { WorkspacePort } from "../workspace/port.js";
import { classifyEditBlock, type EditKind } from "./edit-blocks.js";
import { exactFunctionInFile, functionNameFromSearch } from "./named-function.js";
import { lineCount, sliceByLines } from "./read-range.js";
import type { ProposedFile, ReviewHost } from "./review.js";
import { applySearchReplace } from "./search-replace.js";

/** Local models run with a 16–32k num_ctx budget; one read must not eat it. */
const READ_LIMIT = 24_000;
const SEARCH_LIMIT = 50;

export const SYSTEM_PROMPT =
  "You are a coding assistant in a local workspace. Use tools to find and read code before answering. Do not invent file contents or paths. " +
  "If the user names a function, symbol, or filename without a full path: search for it (or get_context if the file is likely open). Never ask the human for a path or snippet you can get with tools. read_file accepts a unique filename like abc-import.ts. After search, read_file with start_line and end_line around the hit (about 40 lines), then copy SEARCH from that slice (not from the [lines:] header). " +
  "When the user asks to change, refactor, apply, or edit code you MUST write SEARCH/REPLACE blocks in your message. Do not call a tool to edit. Do not paste the new function as the final answer. Never say you cannot apply edits. " +
  "Each block is exactly:\npath/to/file\n<<<<<<< SEARCH\nexact old text from read_file\n=======\nnew text\n>>>>>>> REPLACE\n" +
  "SEARCH is a literal substring copied from read_file. One function or about 20-40 lines per block. Do not use wildcards like {[^}]*}. If a tool result includes exact function text after Search not found, use that as SEARCH and write the block again. " +
  "If a tool result starts with Error:, fix the arguments and call the tool again instead of apologizing or giving up. " +
  "When the user confirms a suggestion (for example: ok, do it, yes, uradi), immediately write the SEARCH/REPLACE blocks — do not restate the plan and do not paste code without the markers. " +
  "Never write to disk yourself. After a successful edit proposal, reply in one short sentence. " +
  "Do not roleplay, do not use personal names, and do not reply with a single unrelated word. " +
  "A new file is an empty SEARCH and the file body as REPLACE. A new empty directory is a path ending with / and both SEARCH and REPLACE empty. Never overwrite: if the path exists, read it and use a real SEARCH.";

/** Model invented a wildcard body (`{[^}]*}`), not a regex that already exists in the file. */
export function searchLooksLikeRegex(search: string): boolean {
  return /\{\s*\[\^\}?\]\*\}/.test(search);
}

export function createWorkspaceTools(port: WorkspacePort, reviewHost: ReviewHost): Tool[] {
  return [
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file. Path may be workspace-relative or a unique filename. Optional start_line/end_line (1-based, inclusive) return a raw slice — copy propose_edit.search from that slice, not the header.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path or unique filename" },
          start_line: { type: "integer", description: "1-based inclusive start line" },
          end_line: { type: "integer", description: "1-based inclusive end line" },
        },
        required: ["path"],
      },
      invoke: async (args) => {
        const located = await locateWorkspaceFile(port, String(args.path ?? ""));
        if ("error" in located) {
          return `Error: ${located.error}`;
        }
        const hasStart = args.start_line !== undefined && args.start_line !== null && args.start_line !== "";
        const hasEnd = args.end_line !== undefined && args.end_line !== null && args.end_line !== "";
        let body = located.text;
        let bodyStartLine = 1;
        const headers: string[] = [];
        if (located.path !== toPosix(String(args.path ?? "")).replace(/^\.\//, "")) {
          headers.push(`[path: ${located.path}]`);
        }
        if (hasStart || hasEnd) {
          const start = hasStart ? Number(args.start_line) : 1;
          const end = hasEnd ? Number(args.end_line) : lineCount(located.text);
          const sliced = sliceByLines(located.text, start, end);
          if ("error" in sliced) {
            return `Error: ${sliced.error}`;
          }
          body = sliced.text;
          bodyStartLine = sliced.start;
          headers.push(`[lines: ${sliced.start}-${sliced.end} of ${sliced.total}]`);
        }
        const prefix = headers.length > 0 ? `${headers.join("\n")}\n` : "";
        if (body.length > READ_LIMIT) {
          const shown = body.slice(0, READ_LIMIT);
          const endsOnLineBreak = /(?:\r\n|\n|\r)$/.test(shown);
          const nextLine = bodyStartLine + lineCount(shown) - (endsOnLineBreak ? 0 : 1);
          return `${prefix}${shown}\n[truncated: continue with read_file start_line=${nextLine}]`;
        }
        return `${prefix}${body}`;
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
        if (blocks.length === 0 || blocks.some((b) => !b.path.trim())) {
          return "Error: propose_edit requires path and search";
        }
        const classified: Array<{ path: string; kind: EditKind; search: string; replace: string }> = [];
        for (const block of blocks) {
          const result = classifyEditBlock(block);
          if (!result.ok) {
            return `Error: ${result.error}`;
          }
          if (result.kind === "edit" && block.search === block.replace) {
            return "Error: search and replace are identical";
          }
          classified.push({
            path: result.path,
            kind: result.kind,
            search: block.search,
            replace: block.replace,
          });
        }
        const regexSearch = classified.find((b) => searchLooksLikeRegex(b.search));
        if (regexSearch) {
          return `Error: search is a regex, not file text (${regexSearch.search.slice(0, 80)}). Copy the exact function from read_file.`;
        }
        const order: string[] = [];
        const grouped = new Map<string, { kind: EditKind; blocks: Array<{ search: string; replace: string }> }>();
        for (const block of classified) {
          const existing = grouped.get(block.path);
          if (!existing) {
            order.push(block.path);
            grouped.set(block.path, {
              kind: block.kind,
              blocks: [{ search: block.search, replace: block.replace }],
            });
            continue;
          }
          if (existing.kind !== block.kind) {
            return `Error: cannot mix ${existing.kind} and ${block.kind} on ${block.path}`;
          }
          if (block.kind === "create" || block.kind === "mkdir") {
            existing.blocks = [{ search: block.search, replace: block.replace }];
          } else {
            existing.blocks.push({ search: block.search, replace: block.replace });
          }
        }
        const proposed: ProposedFile[] = [];
        for (const filePath of order) {
          const group = grouped.get(filePath);
          if (!group) {
            continue;
          }
          if (group.kind === "create" || group.kind === "mkdir") {
            if ((await port.exists(filePath)) !== "absent") {
              return `Error: ${filePath} already exists`;
            }
            const last = group.blocks[group.blocks.length - 1];
            proposed.push({
              path: filePath,
              original: "",
              proposed: group.kind === "mkdir" ? "" : (last?.replace ?? ""),
              kind: group.kind,
            });
            continue;
          }
          const located = await locateWorkspaceFile(port, filePath);
          if ("error" in located) {
            return `Error: ${located.error}`;
          }
          const storedPath = located.path;
          let text = located.text;
          for (const block of group.blocks) {
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
          proposed.push({ path: storedPath, original: located.text, proposed: text, kind: "edit" });
        }
        const merged = reviewHost.merge(proposed);
        return `Proposed review ${merged.id}: ${merged.paths.join(", ")}`;
      },
    },
  ];
}
