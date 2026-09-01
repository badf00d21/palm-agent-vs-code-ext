import type { Tool } from "@mozaik-ai/core";
import { locateWorkspaceFile } from "../workspace/locate.js";
import { toPosix } from "../workspace/paths.js";
import type { WorkspacePort } from "../workspace/port.js";
import { invokeEdit, invokeProposeEdit, invokeWrite } from "./propose-edit.js";
import { lineCount, sliceByLines } from "./read-range.js";
import type { ReviewHost } from "./review.js";

/** Local models run with a 16–32k num_ctx budget; one read must not eat it. */
const READ_LIMIT = 24_000;
const SEARCH_LIMIT = 50;
/** Paths are short, but a whole tree would still crowd out the turn's real work. */
const GLOB_LIMIT = 50;
/** start_line without end_line must not dump the rest of the file into context. */
const START_ONLY_LINE_WINDOW = 80;

export const SYSTEM_PROMPT =
  "You are a coding assistant in a local workspace. Use tools to find and read code before answering. Do not invent file contents or paths. " +
  "If the user names a function, symbol, or filename without a full path: search for it (or get_context if the file is likely open). Use glob to see which files exist and search to look inside them. Never ask the human for a path or snippet you can get with tools. read_file accepts a unique filename like abc-import.ts. After search, read_file with start_line and end_line around the hit (about 40 lines), then copy old_string from that slice (not from the [lines:] header). " +
  "To create or change a file you MUST call the write or edit tool. That is the only way a change reaches the human. Pasting code in a ``` fence writes nothing. Never claim a file was created unless a tool result confirmed it, and never say you cannot create or edit files. " +
  "write takes path and content, and creates the file or replaces it whole. Use it for new files. " +
  "edit takes path, old_string, and new_string, and replaces one literal piece of an existing file. Prefer edit for a file that already exists. old_string must be text copied exactly from read_file, long enough to appear only once (one function, or about 20-40 lines). It is literal text, never a wildcard like {[^}]*}. " +
  "One call changes one file. To create or change several files, call the tool once per file; the changes collect into a single review. " +
  "If a tool result starts with Error:, fix the arguments and call again instead of apologizing or giving up. If the result gives exact text after old_string not found, call edit again using that text verbatim. " +
  "When the user confirms (for example: ok, do it, yes, uradi, hajde), immediately call the tools — do not restate the plan and do not paste the code as your answer. " +
  "You never write to disk; the human reviews every change with Keep All / Undo All. After a successful proposal, reply in one short sentence. " +
  "Do not roleplay, do not use personal names, and do not reply with a single unrelated word.";

/**
 * `write` and `edit` are real schema tools — flat args survive Ollama's tool
 * parser where propose_edit's nested files[] did not. `propose_edit` stays out
 * of the schema: it is now only the internal target for SEARCH/REPLACE fences
 * parsed out of message content (the fallback for models that write markers
 * instead of calling a tool).
 */
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
      name: "glob",
      description:
        "Find files by name or pattern, for example **/*.rs, src/**/*.ts, or Cargo.toml. Returns workspace-relative paths. Use this to see which files exist; use search to look inside them.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob such as **/*.ts, or a bare filename",
          },
        },
        required: ["pattern"],
      },
      invoke: async (args) => {
        const pattern = String(args.pattern ?? "").trim();
        if (!pattern) {
          return "Error: glob requires a pattern, for example **/*.ts";
        }
        try {
          // One over the limit so a full page can be reported as truncated
          // rather than silently looking like the complete answer.
          const hits = await port.findFiles(pattern, GLOB_LIMIT + 1);
          const paths = [...hits].sort();
          const shown = paths.slice(0, GLOB_LIMIT);
          if (shown.length === 0) {
            return "No matches";
          }
          return paths.length > GLOB_LIMIT
            ? `${shown.join("\n")}\n[truncated to ${GLOB_LIMIT} files; narrow the pattern]`
            : shown.join("\n");
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
      name: "write",
      description:
        "Create a file, or replace an existing file whole, with the given content. Use this for new files. Does not write disk: the human reviews Keep All / Undo All. A path ending in / with empty content proposes a new empty directory.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path" },
          content: { type: "string", description: "Full file body" },
        },
        required: ["path", "content"],
      },
      invoke: async (args) => invokeWrite(args, port, reviewHost),
    },
    {
      name: "edit",
      description:
        "Replace one literal piece of an existing file. old_string must be copied exactly from read_file and must appear exactly once. Does not write disk: the human reviews Keep All / Undo All. One call edits one file; call again for another file.",
      strict: true,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path or unique filename" },
          old_string: { type: "string", description: "Exact text from read_file to replace" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
      },
      invoke: async (args) => invokeEdit(args, port, reviewHost),
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
