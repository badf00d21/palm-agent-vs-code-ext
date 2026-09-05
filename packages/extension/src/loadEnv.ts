import { config as loadDotenv } from "dotenv";
import path from "node:path";
import * as vscode from "vscode";

export function loadWorkspaceEnv(extensionPath: string): void {
  const workspaceEnvs = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    path.join(folder.uri.fsPath, ".env"),
  );
  loadDotenv({
    quiet: true,
    path: [...workspaceEnvs, path.join(extensionPath, "..", "..", ".env")],
  });
}

export function readMozaikCloudOptions(): { mozaikApiKey?: string; mozaikCloudEndpoint?: string } {
  const mozaikApiKey = process.env.MOZAIK_API_KEY?.trim();
  const mozaikCloudEndpoint = process.env.MOZAIK_CLOUD_ENDPOINT?.trim();
  return {
    ...(mozaikApiKey ? { mozaikApiKey } : {}),
    ...(mozaikCloudEndpoint ? { mozaikCloudEndpoint } : {}),
  };
}