import {
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelMessageItem,
  type Participant,
} from "@mozaik-ai/core";
import { describe, expect, it } from "vitest";
import { AgenticEnvironment, BaseParticipant, createSemanticEvent } from "../../src/runtime/environment.js";

describe("AgenticEnvironment", () => {
  it("delivers a user message to other participants", () => {
    const environment = new AgenticEnvironment();
    const seen: string[] = [];
    const listener = new (class extends BaseParticipant {
      override onMessage(message: string): void {
        seen.push(message);
      }
    })("listener");
    const user = new BaseParticipant("user");
    listener.join(environment);
    user.join(environment);
    environment.sendUserMessage("hello", user);
    expect(seen).toEqual(["hello"]);
  });

  it("delivers a function call to the producer", () => {
    const environment = new AgenticEnvironment();
    const names: string[] = [];
    const agent = new (class extends BaseParticipant {
      override onFunctionCall(item: FunctionCallItem): void {
        names.push(item.name);
      }
    })("agent", "agent");
    agent.join(environment);
    environment.deliverFunctionCall(
      agent,
      FunctionCallItem.rehydrate({ callId: "c1", name: "read_file", args: "{}" }),
    );
    expect(names).toEqual(["read_file"]);
  });

  it("delivers function output and model answer to the producer", () => {
    const environment = new AgenticEnvironment();
    const events: string[] = [];
    const agent = new (class extends BaseParticipant {
      override onFunctionCallOutput(): void {
        events.push("output");
      }
      override onModelMessage(): void {
        events.push("answer");
      }
    })("agent", "agent");
    agent.join(environment);
    environment.deliverFunctionCallOutput(agent, FunctionCallOutputItem.create("c1", "ok"));
    environment.deliverModelMessage(agent, ModelMessageItem.rehydrate({ text: "done" }));
    expect(events).toEqual(["output", "answer"]);
  });

  it("forwards custom events to observers", () => {
    const environment = new AgenticEnvironment();
    const types: string[] = [];
    const observer = new (class extends BaseParticipant {
      override onExternalEvent(_source: Participant, item: { type: string }): void {
        types.push(item.type);
      }
    })("ui");
    const agent = new BaseParticipant("agent", "agent");
    observer.join(environment);
    agent.join(environment);
    environment.deliverSemanticEvent(agent, createSemanticEvent("assistant_narration", { text: "hi" }, agent.getId()));
    expect(types).toEqual(["assistant_narration"]);
  });

  it("exposes Mozaik DefaultFunctionCallRunner via getFunctionCallRunner", async () => {
    const environment = new AgenticEnvironment();
    const runner = environment.getFunctionCallRunner();
    const tool = {
      name: "echo",
      description: "echo",
      strict: true,
      type: "function" as const,
      parameters: { type: "object", properties: {}, required: [] },
      invoke: async () => "hello\nworld",
    };
    const item = await runner.run(
      FunctionCallItem.rehydrate({ callId: "c1", name: "echo", args: "{}" }),
      tool,
    );
    expect(item.callId).toBe("c1");
    expect(item.output.text).toBe("hello\nworld");
  });
});
