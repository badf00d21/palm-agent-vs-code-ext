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

export interface WorkspacePort {
  hasWorkspace(): boolean;
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<DirEntry[]>;
  search(query: string, glob?: string): Promise<SearchHit[]>;
  /** Workspace-relative POSIX paths whose basename or glob matches. */
  findFiles(nameOrGlob: string): Promise<string[]>;
  /** Workspace-relative POSIX path. Trailing slashes ignored. */
  exists(path: string): Promise<"file" | "dir" | "absent">;
  getContext(): Promise<EditorContext>;
}
