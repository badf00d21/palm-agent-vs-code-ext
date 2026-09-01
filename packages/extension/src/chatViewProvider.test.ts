import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatViewProvider } from "./chatViewProvider";

vi.mock("vscode", () => ({
  Uri: {
    joinPath: vi.fn(() => ({ toString: () => "resource" })),
  },
}));

function createProvider(busy = false) {
  const clear = vi.fn();
  const reset = vi.fn();
  const session = {
    busy,
    reset,
    setSink: vi.fn(),
  };
  const provider = new ChatViewProvider({} as never, {
    session,
    store: { clear },
    port: {},
  } as never);
  return { provider, clear, reset, session };
}

describe("ChatViewProvider new chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears reviews and resets an unresolved session", () => {
    const { provider, clear, reset } = createProvider();
    provider.newChat();
    expect(clear).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("does nothing while the session is busy", () => {
    const { provider, clear, reset, session } = createProvider();
    const postMessage = vi.fn();
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: "",
        cspSource: "test",
        asWebviewUri: vi.fn(() => "resource"),
        postMessage,
        onDidReceiveMessage: vi.fn(),
      },
    } as never);
    session.busy = true;
    provider.newChat();
    expect(clear).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalledWith({ type: "session_cleared" });
  });

  it("routes new_chat and posts session_cleared when resolved", async () => {
    const { provider, clear, reset } = createProvider();
    const postMessage = vi.fn();
    let receive: ((message: { type: "new_chat" }) => void) | undefined;
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: "",
        cspSource: "test",
        asWebviewUri: vi.fn(() => "resource"),
        postMessage,
        onDidReceiveMessage: vi.fn((handler) => {
          receive = handler;
        }),
      },
    } as never);
    receive?.({ type: "new_chat" });
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: "session_cleared" });
    });
    expect(clear).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    const clearOrder = clear.mock.invocationCallOrder[0]!;
    const resetOrder = reset.mock.invocationCallOrder[0]!;
    const postOrder = postMessage.mock.invocationCallOrder[0]!;
    expect(clearOrder).toBeLessThan(resetOrder);
    expect(resetOrder).toBeLessThan(postOrder);
  });
});
