import type { Tool } from "@mozaik-ai/core";
import { locateWorkspaceFile } from "../workspace/locate.js";
import { toPosix } from "../workspace/paths.js";
import type { WorkspacePort } from "../workspace/port.js";
import { invokeProposeEdit } from "./propose-edit.js";
import { lineCount, sliceByLines } from "./read-range.js";
import type { ReviewHost } from "./review.js";

/** Local models run with a 16–32k num_ctx budget; one read must not eat it. */
const READ_LIMIT = 24_000;
const SEARCH_LIMIT = 50;
/** start_line without end_line must not dump the rest of the file into context. */
const START_ONLY_LINE_WINDOW = 80;

export const SYSTEM_PROMPT =
  "You are a coding assistant in a local workspace. Use tools to find and read code before answering. Do not invent file contents or paths. " +
  "If the user names a function, symbol, or filename without a full path: search for it (or get_context if the file is likely open). Never ask the human for a path or snippet you can get with tools. read_file accepts a unique filename like abc-import.ts. After search, read_file with start_line and end_line around the hit (about 40 lines), then copy SEARCH from that slice (not from the [lines:] header). " +
  "To create or change a file you MUST write SEARCH/REPLACE blocks directly in your message. That is the only way to write to disk. Do not call a tool to edit. Pasting code inside ``` fences writes nothing. Never claim a file was created, and never say you cannot create or edit files — writing the block is how you do it. " +
  "Each block is exactly:\npath/to/file\n<<<<<<< SEARCH\nexact old text from read_file\n=======\nnew text\n>>>>>>> REPLACE\n" +
  "For an existing file, SEARCH is a literal substring copied from read_file (one function or about 20-40 lines per block); read the file first so it matches. For a NEW file, leave SEARCH empty and put the whole file body in REPLACE. For a new empty directory, use a path ending with / and leave SEARCH and REPLACE empty. To create several files, write one block per file in the same message. " +
  "Example that creates two files:\nsrc/model.h\n<<<<<<< SEARCH\n=======\n#pragma once\nstruct User { };\n>>>>>>> REPLACE\nsrc/main.cpp\n<<<<<<< SEARCH\n=======\nint main() { return 0; }\n>>>>>>> REPLACE\n" +
  "Do not use wildcards like {[^}]*} in SEARCH; it is literal text. If a tool result includes exact function text after Search not found, use that as SEARCH and write the block again. If a tool result starts with Error:, fix the arguments and try again instead of apologizing or giving up. " +
  "When the user confirms (for example: ok, do it, yes, uradi, hajde), immediately write the SEARCH/REPLACE blocks — do not restate the plan and do not paste code without the markers. " +
  "Never write to disk yourself; the human reviews Keep All / Undo All. After a successful edit proposal, reply in one short sentence. " +
  "Do not roleplay, do not use personal names, and do not reply with a single unrelated word. " +
  "Never overwrite: if the path exists, read it and use a real SEARCH.";

export function toolsVisibleToModel(tools: Tool[]): Tool[] {
  return tools.filter((tool) => tool.name !== "propose_edit");
}

export function createWorkspaceTools(port: WorkspacePort, reviewHost: ReviewHost): Tool[] {
  return [
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file. Path may be workspace-relative or a unique filename. Optional start_line/end_line (1-based, inclusive) return a raw slice — copy SEARCH from that slice, not the header. If you pass start_line without end_line, at most 80 lines are returned.",
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
          const end = hasEnd
            ? Number(args.end_line)
            : start + START_ONLY_LINE_WINDOW - 1;
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
      invoke: async (args) => invokeProposeEdit(args, port, reviewHost),
    },
  ];
}
