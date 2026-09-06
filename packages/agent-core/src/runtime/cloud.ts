import { createCloudExporter, type CloudExporter } from "@mozaik-ai/cloud-sdk/exporter";
import type { AgenticEnvironment } from "./environment.js";

type CloudTrace = (line: string) => void;

export interface CloudAttach {
  apiKey: string;
  endpoint?: string;
}

const DEFAULT_CLOUD_ENDPOINT = "https://api.app.jigjoy.ai";

export function attachCloud(
  environment: AgenticEnvironment,
  attach: CloudAttach,
  trace: CloudTrace,
  onSessionUrl?: (url: string) => void,
): CloudExporter {
  const cloud = createCloudExporter({
    endpoint: attach.endpoint?.trim() || DEFAULT_CLOUD_ENDPOINT,
    projectKey: attach.apiKey,
    participants: () => environment.getParticipants(),
    onSessionUrl: (url) => {
      trace(`cloud session ${url}`);
      onSessionUrl?.(url);
    },
    onError: (error) => {
      trace(`cloud error: ${error.message}`);
    },
  });
  environment.join(cloud.participant);
  return cloud;
}
