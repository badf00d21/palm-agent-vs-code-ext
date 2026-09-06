import type { ProposedFile } from "@palm-agent/agent-core";
import * as vscode from "vscode";

export async function applyFiles(
  files: Array<{ path: string; proposed: string; kind: ProposedFile["kind"] }>,
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    throw new Error("No workspace folder open");
  }
  const edit = new vscode.WorkspaceEdit();
  const mkdirs: string[] = [];
  const toSave: Array<{ uri: vscode.Uri; path: string }> = [];
  let hasEdit = false;
  for (const file of files) {
    if (file.kind === "mkdir") {
      mkdirs.push(file.path.replace(/\/+$/, ""));
      continue;
    }
    const uri = vscode.Uri.joinPath(root, file.path);
    if (file.kind === "delete") {
      // deleteFile on the same WorkspaceEdit as every other change, not
      // vscode.workspace.fs.delete: that call is not part of the undo stack,
      // so a deletion outside this edit would survive Undo All.
      edit.deleteFile(uri, { ignoreIfNotExists: false });
      hasEdit = true;
      continue;
    }
    toSave.push({ uri, path: file.path });
    if (file.kind === "create") {
      edit.createFile(uri, { ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), file.proposed);
      hasEdit = true;
      continue;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const end = doc.positionAt(doc.getText().length);
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), file.proposed);
    hasEdit = true;
  }
  if (hasEdit) {
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      throw new Error("WorkspaceEdit was not applied");
    }
    for (const file of toSave) {
      const doc = await vscode.workspace.openTextDocument(file.uri);
      const saved = await doc.save();
      if (!saved) {
        throw new Error(`Failed to save ${file.path}`);
      }
    }
  }
  for (const rel of mkdirs) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, rel));
  }
}
