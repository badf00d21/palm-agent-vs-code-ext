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

function resolveView(
  provider: ChatViewProvider,
  opts: { visible?: boolean; postMessage?: ReturnType<typeof vi.fn> } = {},
) {
  const postMessage = opts.postMessage ?? vi.fn();
  let onVisibility: (() => void) | undefined;
  const view = {
    visible: opts.visible ?? true,
    badge: undefined as { value: number; tooltip: string } | undefined,
    onDidChangeVisibility: vi.fn((handler: () => void) => {
      onVisibility = handler;
      return { dispose: vi.fn() };
    }),
    webview: {
      options: {},
      html: "",
      cspSource: "test",
      asWebviewUri: vi.fn(() => "resource"),
      postMessage,
      onDidReceiveMessage: vi.fn(),
    },
  };
  provider.resolveWebviewView(view as never);
  return { view, postMessage, onVisibility: () => onVisibility?.() };
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
    resolveView(provider);
    session.busy = true;
    provider.newChat();
    expect(clear).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("routes new_chat and posts session_cleared when resolved", async () => {
    const { provider, clear, reset } = createProvider();
    const postMessage = vi.fn();
    let receive: ((message: { type: "new_chat" }) => void) | undefined;
    const view = {
      visible: true,
      badge: undefined as { value: number; tooltip: string } | undefined,
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
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
    };
    provider.resolveWebviewView(view as never);
    receive?.({ type: "new_chat" });
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: "session_cleared" });
    });
    expect(clear).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });
});

describe("ChatViewProvider activity badge", () => {
  it("sets a badge when a turn finishes while the view is hidden", () => {
    const { provider, session } = createProvider();
    const { view } = resolveView(provider, { visible: false });
    const sink = session.setSink.mock.calls[0]![0] as (event: { type: string }) => void;
    sink({ type: "done" });
    expect(view.badge).toEqual({
      value: 1,
      tooltip: "Palm Agent finished a reply",
    });
  });

  it("does not badge when the chat is already visible", () => {
    const { provider, session } = createProvider();
    const { view } = resolveView(provider, { visible: true });
    const sink = session.setSink.mock.calls[0]![0] as (event: { type: string }) => void;
    sink({ type: "done" });
    expect(view.badge).toBeUndefined();
  });

  it("clears the badge when the view becomes visible", () => {
    const { provider, session } = createProvider();
    const { view, onVisibility } = resolveView(provider, { visible: false });
    const sink = session.setSink.mock.calls[0]![0] as (event: { type: string }) => void;
    sink({ type: "error", message: "boom" });
    expect(view.badge?.value).toBe(1);
    view.visible = true;
    onVisibility();
    expect(view.badge).toBeUndefined();
  });
});
