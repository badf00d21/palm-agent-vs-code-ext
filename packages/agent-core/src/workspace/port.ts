export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface EditorContext {
  activeFile: string | null;
  selection: string | null;
}

/**
 * One declaration as the editor's language support reports it. `kind` carries
 * the LSP vocabulary ("function", "struct", "method"), so agent-core never has
 * to know a single language keyword — whichever extension handles the file
 * decides what a symbol is.
 */
export interface WorkspaceSymbol {
  name: string;
  kind: string;
  /** 1-based. */
  line: number;
  /** 0 for top level, 1 for a member, and so on. */
  depth: number;
}

export interface WorkspacePort {
  hasWorkspace(): boolean;
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<DirEntry[]>;
  search(query: string, glob?: string): Promise<SearchHit[]>;
  /**
   * Workspace-relative POSIX paths whose basename or glob matches.
   * `limit` caps the result count; callers that need to detect truncation ask
   * for one more than they intend to show.
   */
  findFiles(nameOrGlob: string, limit?: number): Promise<string[]>;
  /**
   * Declarations in a file, from whatever language support the editor has.
   * Empty when no provider handles the file — callers fall back to structure.
   */
  documentSymbols(path: string): Promise<WorkspaceSymbol[]>;
  /** Workspace-relative POSIX path. Trailing slashes ignored. */
  exists(path: string): Promise<"file" | "dir" | "absent">;
  getContext(): Promise<EditorContext>;
}
