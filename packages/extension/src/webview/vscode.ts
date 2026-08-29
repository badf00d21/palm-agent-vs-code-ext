import type { WebviewToExt } from "@palm-agent/shared";

export interface VsCodeApi {
  postMessage(message: WebviewToExt): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    api = acquireVsCodeApi();
  }
  return api;
}
