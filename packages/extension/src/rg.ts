import { spawn } from "node:child_process";
import path from "node:path";
import { toWorkspaceRelative, type SearchHit } from "@palm-agent/agent-core";

const RG_TIMEOUT_MS = 30_000;

/**
 * Run ripgrep over the workspace. The explicit "." search path is load-bearing:
 * without it rg sees a piped stdin and reads that instead of the directory —
 * the pipe never closes, so the tool call hangs forever.
 */
export function searchWorkspace(
  bin: string,
  query: string,
  cwd: string,
  glob?: string,
): Promise<SearchHit[]> {
  const args = ["--json", "--max-count", "50"];
  if (glob) {
    args.push("--glob", glob);
  }
  args.push("--", query, ".");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd });
    child.stdin?.end();
    const killer = setTimeout(() => {
      child.kill();
      reject(new Error(`search timed out after ${RG_TIMEOUT_MS / 1000}s`));
    }, RG_TIMEOUT_MS);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(killer);
      if (stderr && !stdout) {
        reject(new Error(stderr.trim()));
        return;
      }
      const hits: SearchHit[] = [];
      for (const line of stdout.split("\n")) {
        if (!line) {
          continue;
        }
        try {
          const row = JSON.parse(line) as {
            type?: string;
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
          };
          if (row.type !== "match" || !row.data?.path?.text) {
            continue;
          }
          hits.push({
            path: toWorkspaceRelative(cwd, path.resolve(cwd, row.data.path.text)),
            line: row.data.line_number ?? 1,
            text: (row.data.lines?.text ?? "").replace(/\n$/, ""),
          });
        } catch {
          // skip malformed rg json lines
        }
      }
      resolve(hits);
    });
  });
}
