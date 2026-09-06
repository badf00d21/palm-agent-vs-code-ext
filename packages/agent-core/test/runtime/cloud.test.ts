import { beforeEach, describe, expect, it, vi } from "vitest";

const { createCloudExporter } = vi.hoisted(() => ({
  createCloudExporter: vi.fn(),
}));

vi.mock("@mozaik-ai/cloud-sdk/exporter", () => ({
  createCloudExporter,
}));

import { AgenticEnvironment, BaseParticipant } from "../../src/runtime/environment.js";
import { attachCloud } from "../../src/runtime/cloud.js";

describe("attachCloud", () => {
  beforeEach(() => {
    createCloudExporter.mockReset();
    createCloudExporter.mockReturnValue({
      participant: new BaseParticipant("cloud"),
      sessionId: "sess_1",
      flush: async () => undefined,
      end: async () => undefined,
      stats: () => ({ queued: 0, sent: 0, dropped: 0, seq: 0 }),
    });
  });

  it("joins the cloud exporter when a key is provided", () => {
    const environment = new AgenticEnvironment();
    attachCloud(environment, { apiKey: "pk_test" }, () => undefined);
    expect(createCloudExporter).toHaveBeenCalledOnce();
    const config = createCloudExporter.mock.calls[0]![0] as { projectKey: string; endpoint: string };
    expect(config.projectKey).toBe("pk_test");
    expect(config.endpoint).toBe("https://api.app.jigjoy.ai");
    expect(environment.getParticipants().some((p) => p.getManifest().name === "cloud")).toBe(true);
  });

  it("forwards the session url to onSessionUrl in addition to trace", () => {
    const environment = new AgenticEnvironment();
    const traced: string[] = [];
    const urls: string[] = [];
    attachCloud(environment, { apiKey: "pk_test" }, (line) => traced.push(line), (url) =>
      urls.push(url),
    );
    const config = createCloudExporter.mock.calls[0]![0] as { onSessionUrl: (url: string) => void };
    config.onSessionUrl("https://cloud.example/s/1");
    expect(urls).toEqual(["https://cloud.example/s/1"]);
    expect(traced).toEqual(["cloud session https://cloud.example/s/1"]);
  });
});
