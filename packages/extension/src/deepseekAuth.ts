import * as vscode from "vscode";

export const DEEPSEEK_API_KEY_SECRET = "palmAgent.deepseekApiKey";

export async function getDeepseekApiKey(secrets: vscode.SecretStorage): Promise<string> {
  const fromSecret = (await secrets.get(DEEPSEEK_API_KEY_SECRET))?.trim() ?? "";
  if (fromSecret) {
    return fromSecret;
  }
  const fromSetting =
    vscode.workspace.getConfiguration("palmAgent").get<string>("deepseekApiKey", "")?.trim() ?? "";
  if (fromSetting) {
    return fromSetting;
  }
  return (
    process.env.DEEPSEEK_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  );
}

export async function setDeepseekApiKey(
  secrets: vscode.SecretStorage,
  apiKey: string,
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await secrets.delete(DEEPSEEK_API_KEY_SECRET);
    return;
  }
  await secrets.store(DEEPSEEK_API_KEY_SECRET, trimmed);
}

export async function clearDeepseekApiKey(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(DEEPSEEK_API_KEY_SECRET);
}

export async function promptAndStoreDeepseekApiKey(
  secrets: vscode.SecretStorage,
): Promise<boolean> {
  const value = await vscode.window.showInputBox({
    title: "Palm Agent — DeepSeek API key",
    prompt: "Paste your DeepSeek API key (stored in VS Code Secret Storage)",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "sk-…",
  });
  if (value === undefined) {
    return false;
  }
  await setDeepseekApiKey(secrets, value);
  return true;
}
