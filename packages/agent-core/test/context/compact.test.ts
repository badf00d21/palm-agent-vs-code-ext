import {
  DeveloperMessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
} from "@mozaik-ai/core";
import { describe, expect, it } from "vitest";
import { compactContext, STUB_TEXT } from "../../src/context/compact.js";

function addTurn(
  ctx: ModelContext,
  user: string,
  tool?: { callId: string; output: string },
): void {
  ctx.addContextItem(UserMessageItem.create(user));
  if (!tool) {
    ctx.addContextItem(ModelMessageItem.rehydrate({ text: "ok" }));
    return;
  }
  ctx.addContextItem(
    FunctionCallItem.rehydrate({
      callId: tool.callId,
      name: "read_file",
      args: '{"path":"a.ts"}',
    }),
  );
  ctx.addContextItem(FunctionCallOutputItem.create(tool.callId, tool.output));
  ctx.addContextItem(ModelMessageItem.rehydrate({ text: "ok" }));
}

function users(ctx: ModelContext): string[] {
  return ctx
    .getItems()
    .filter((item) => item instanceof UserMessageItem)
    .map((item) => item.content.text);
}

function outputText(ctx: ModelContext, callId: string): string | undefined {
  const item = ctx
    .getItems()
    .find((entry) => entry instanceof FunctionCallOutputItem && entry.callId === callId);
  return item instanceof FunctionCallOutputItem ? item.output.text : undefined;
}

describe("compactContext", () => {
  it("stubs older-turn tool output and leaves the latest turn intact", () => {
    const ctx = ModelContext.create();
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "first", { callId: "c1", output: "FILE BODY" });
    addTurn(ctx, "second", { callId: "c2", output: "NEW BODY" });
    const { trimmed } = compactContext(ctx.getItems(), { max: null });
    expect(trimmed).toBe(false);
    expect(outputText(ctx, "c1")).toBe(STUB_TEXT);
    expect(outputText(ctx, "c2")).toBe("NEW BODY");
    const call = ctx.getItems().find((item) => item instanceof FunctionCallItem);
    expect(call).toMatchObject({ callId: "c1", name: "read_file" });
  });

  it("slides to the last 3 user turns when over 80%", () => {
    const ctx = ModelContext.create();
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "t1");
    addTurn(ctx, "t2");
    addTurn(ctx, "t3");
    addTurn(ctx, "t4");
    const { trimmed } = compactContext(ctx.getItems(), { lastUsed: 9000, max: 10000 });
    expect(trimmed).toBe(true);
    expect(users(ctx)).toEqual(["t2", "t3", "t4"]);
    expect(ctx.getItems()[0]).toBeInstanceOf(DeveloperMessageItem);
  });

  it("does not slide below 80% and still stubs older outputs", () => {
    const ctx = ModelContext.create();
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "t1", { callId: "c1", output: "OLD" });
    addTurn(ctx, "t2");
    addTurn(ctx, "t3");
    addTurn(ctx, "t4");
    const { trimmed } = compactContext(ctx.getItems(), { lastUsed: 7000, max: 10000 });
    expect(trimmed).toBe(false);
    expect(users(ctx)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(outputText(ctx, "c1")).toBe(STUB_TEXT);
  });

  it("does not slide when max is null", () => {
    const ctx = ModelContext.create();
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "t1");
    addTurn(ctx, "t2");
    addTurn(ctx, "t3");
    addTurn(ctx, "t4");
    const { trimmed } = compactContext(ctx.getItems(), { lastUsed: 9000, max: null });
    expect(trimmed).toBe(false);
    expect(users(ctx)).toHaveLength(4);
  });

  it("does not slide when already at 3 turns over the ratio", () => {
    const ctx = ModelContext.create();
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "t1");
    addTurn(ctx, "t2");
    addTurn(ctx, "t3");
    const { trimmed } = compactContext(ctx.getItems(), { lastUsed: 9000, max: 10000 });
    expect(trimmed).toBe(false);
    expect(users(ctx)).toHaveLength(3);
  });

  it("is idempotent after a slide", () => {
    const ctx = ModelContext.create();
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    addTurn(ctx, "t1", { callId: "c1", output: "OLD" });
    addTurn(ctx, "t2");
    addTurn(ctx, "t3");
    addTurn(ctx, "t4");
    compactContext(ctx.getItems(), { lastUsed: 9000, max: 10000 });
    const snapshot = ctx.getItems().map((item) => item);
    const again = compactContext(ctx.getItems(), { lastUsed: 9000, max: 10000 });
    expect(again.trimmed).toBe(false);
    expect(ctx.getItems()).toEqual(snapshot);
    expect(outputText(ctx, "c1")).toBeUndefined();
  });

  it("no-ops on system-only context", () => {
    const ctx = ModelContext.create();
    ctx.addContextItem(DeveloperMessageItem.create("sys"));
    expect(compactContext(ctx.getItems(), { lastUsed: 9000, max: 10000 })).toEqual({
      trimmed: false,
    });
    expect(ctx.getItems()).toHaveLength(1);
  });
});
