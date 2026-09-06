import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyFiles } from "./applyFiles";

const { applyEdit, save, openTextDocument, createDirectory, folders } = vi.hoisted(() => {
  const save = vi.fn(async () => true);
  return {
    applyEdit: vi.fn(async () => true),
    save,
    openTextDocument: vi.fn(async () => ({
      getText: () => "old",
      positionAt: (offset: number) => ({ line: 0, character: offset }),
      save,
    })),
    createDirectory: vi.fn(async () => undefined),
    folders: { current: [{ uri: { fsPath: "/ws" } }] as Array<{ uri: { fsPath: string } }> | undefined },
  };
});

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (_root: unknown, path: string) => ({ path, toString: () => path }),
  },
  Position: class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  Range: class Range {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
  WorkspaceEdit: class WorkspaceEdit {
    createFile = vi.fn();
    insert = vi.fn();
    replace = vi.fn();
    deleteFile = vi.fn();
  },
  workspace: {
    get workspaceFolders() {
      return folders.current;
    },
    applyEdit,
    openTextDocument,
    fs: { createDirectory },
  },
}));

describe("applyFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    folders.current = [{ uri: { fsPath: "/ws" } }];
    applyEdit.mockResolvedValue(true);
    save.mockResolvedValue(true);
  });

  it("saves each edited file after applyEdit", async () => {
    await applyFiles([{ path: "a.ts", proposed: "b", kind: "edit" }]);
    expect(applyEdit).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(applyEdit.mock.invocationCallOrder[0]!).toBeLessThan(save.mock.invocationCallOrder[0]!);
  });

  it("saves a created file after applyEdit", async () => {
    await applyFiles([{ path: "n.ts", proposed: "hi\n", kind: "create" }]);
    expect(applyEdit).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not save mkdir-only reviews", async () => {
    await applyFiles([{ path: "d/", proposed: "", kind: "mkdir" }]);
    expect(applyEdit).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(createDirectory).toHaveBeenCalledOnce();
  });

  it("does not save when applyEdit fails", async () => {
    applyEdit.mockResolvedValueOnce(false);
    await expect(applyFiles([{ path: "a.ts", proposed: "b", kind: "edit" }])).rejects.toThrow(
      "WorkspaceEdit was not applied",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("throws when save fails", async () => {
    save.mockResolvedValueOnce(false);
    await expect(applyFiles([{ path: "a.ts", proposed: "b", kind: "edit" }])).rejects.toThrow(
      "Failed to save a.ts",
    );
  });

  it("deletes through the same WorkspaceEdit as other changes, not workspace.fs.delete", async () => {
    // deleteFile on the shared edit lands in the same undo transaction as any
    // other proposed change, so Undo All can bring the file back.
    // vscode.workspace.fs.delete is not undoable and must never be used here.
    await applyFiles([
      { path: "old.ts", proposed: "", kind: "delete" },
      { path: "new.ts", proposed: "hi\n", kind: "create" },
    ]);
    expect(applyEdit).toHaveBeenCalledOnce();
    const edit = applyEdit.mock.calls[0]![0] as { deleteFile: ReturnType<typeof vi.fn> };
    expect(edit.deleteFile).toHaveBeenCalledOnce();
    expect(edit.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "old.ts" }),
      { ignoreIfNotExists: false },
    );
  });

  it("does not open or save a deleted file", async () => {
    await applyFiles([{ path: "old.ts", proposed: "", kind: "delete" }]);
    expect(openTextDocument).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("deletes without other edits still going through applyEdit", async () => {
    await applyFiles([{ path: "old.ts", proposed: "", kind: "delete" }]);
    expect(applyEdit).toHaveBeenCalledOnce();
  });
});
