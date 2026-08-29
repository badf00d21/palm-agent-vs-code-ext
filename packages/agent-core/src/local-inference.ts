import {
  DeveloperMessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelMessageItem,
  SystemMessageItem,
  UserMessageItem,
  type AgenticEnvironment,
  type ModelContext,
  type Participant,
  type Tool,
} from "@mozaik-ai/core";

export type ChatCompletionFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface RunLocalChatCompletionsParams {
  model: string;
  context: ModelContext;
  tools: Tool[];
  environment: AgenticEnvironment;
  caller: Participant;
  onFailed: (message: string) => void;
  fetchImpl?: ChatCompletionFetch;
  signal?: AbortSignal;
  generation?: number;
  isCurrent?: () => boolean;
}

interface ChatToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ChatToolCall[];
    };
  }>;
  error?: { message?: string };
  message?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function configuredBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL ?? "the configured URL").replace(/\/$/, "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isCurrentTurn(params: RunLocalChatCompletionsParams): boolean {
  if (params.signal?.aborted) {
    return false;
  }
  if (params.isCurrent) {
    return params.isCurrent();
  }
  return true;
}

function isNetworkError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }
  if (error instanceof TypeError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ENETUNREACH|ECONNRESET|ETIMEDOUT|network/i.test(message)) {
    return true;
  }
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause) {
    return /ECONNREFUSED|ENOTFOUND|ENETUNREACH|ECONNRESET|ETIMEDOUT/.test(String(cause.code));
  }
  return false;
}

function providerMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export function formatInferenceFailure(error: unknown, baseUrl = configuredBaseUrl()): string {
  if (isNetworkError(error)) {
    return `Cannot reach Ollama at ${baseUrl}. Is it running?`;
  }
  return providerMessage(error).slice(0, 400);
}

export function mapContextToChatMessages(context: ModelContext): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of context.getItems()) {
    if (item instanceof DeveloperMessageItem || item instanceof SystemMessageItem) {
      messages.push({ role: "system", content: item.content.text });
      continue;
    }
    if (item instanceof UserMessageItem) {
      messages.push({ role: "user", content: item.content.text });
      continue;
    }
    if (item instanceof ModelMessageItem) {
      messages.push({ role: "assistant", content: item.content.text });
      continue;
    }
    if (item instanceof FunctionCallItem) {
      const toolCall = {
        id: item.callId,
        type: "function" as const,
        function: { name: item.name, arguments: item.args },
      };
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") {
        last.tool_calls = last.tool_calls ?? [];
        last.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }
    if (item instanceof FunctionCallOutputItem) {
      messages.push({
        role: "tool",
        tool_call_id: item.callId,
        content: item.output.text,
      });
    }
  }
  return messages;
}

function mapTools(tools: Tool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function toolCallArgs(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  return JSON.stringify(raw ?? {});
}

function asToolCallObject(value: unknown): ChatToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const nested =
    rec.function && typeof rec.function === "object"
      ? (rec.function as Record<string, unknown>)
      : undefined;
  const name = nested?.name ?? rec.name;
  const args = nested?.arguments ?? rec.arguments ?? rec.args ?? rec.parameters;
  const hasArgs =
    nested !== undefined
      ? "arguments" in nested || "args" in nested
      : "arguments" in rec || "args" in rec || "parameters" in rec;
  if (typeof name !== "string" || name.length === 0 || !hasArgs) {
    return null;
  }
  return { id: typeof rec.id === "string" ? rec.id : undefined, function: { name, arguments: args } };
}

/** Qwen/Ollama often emit a tool call as JSON in `message.content` instead of `tool_calls`. */
export function parseToolCallsFromContent(text: string): ChatToolCall[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const candidates = [unfenced];
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(unfenced.slice(start, end + 1));
  }
  const arrayStart = unfenced.indexOf("[");
  const arrayEnd = unfenced.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(unfenced.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      const calls = parsed.map(asToolCallObject).filter((call): call is ChatToolCall => call !== null);
      if (calls.length > 0) {
        return calls;
      }
      continue;
    }
    const one = asToolCallObject(parsed);
    if (one) {
      return [one];
    }
  }
  return [];
}

async function readHttpError(response: Response): Promise<Error> {
  const body = await response.text();
  let message = response.statusText || `HTTP ${response.status}`;
  if (body) {
    try {
      const parsed = JSON.parse(body) as ChatCompletionResponse;
      message = parsed.error?.message ?? parsed.message ?? body;
    } catch {
      message = body;
    }
  }
  return new Error(String(message));
}

function deliverCompletion(
  params: RunLocalChatCompletionsParams,
  payload: ChatCompletionResponse,
): void {
  if (!isCurrentTurn(params)) {
    return;
  }
  const message = payload.choices?.[0]?.message;
  if (!message) {
    params.onFailed("Empty completion from provider");
    return;
  }
  const toolCalls =
    message.tool_calls && message.tool_calls.length > 0
      ? message.tool_calls
      : parseToolCallsFromContent(message.content ?? "");
  if (toolCalls.length > 0) {
    for (const [index, call] of toolCalls.entries()) {
      const item = FunctionCallItem.rehydrate({
        callId: call.id ?? `call_${index}`,
        name: call.function?.name ?? "tool",
        args: toolCallArgs(call.function?.arguments),
      });
      params.environment.deliverFunctionCall(params.caller, item);
    }
    return;
  }
  const text = message.content ?? "";
  params.environment.deliverModelMessage(
    params.caller,
    ModelMessageItem.rehydrate({ text }),
  );
}

export async function runLocalChatCompletions(
  params: RunLocalChatCompletionsParams,
): Promise<void> {
  const baseUrl = configuredBaseUrl();
  const fetchImpl = params.fetchImpl ?? fetch;
  try {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: mapContextToChatMessages(params.context),
    };
    if (params.tools.length > 0) {
      body.tools = mapTools(params.tools);
      body.tool_choice = "auto";
    }
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "not-needed"}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });
    if (!isCurrentTurn(params)) {
      return;
    }
    if (!response.ok) {
      throw await readHttpError(response);
    }
    const payload = (await response.json()) as ChatCompletionResponse;
    deliverCompletion(params, payload);
  } catch (error) {
    if (isAbortError(error)) {
      params.onFailed(formatInferenceFailure(error, baseUrl));
      return;
    }
    if (!isCurrentTurn(params)) {
      return;
    }
    params.onFailed(formatInferenceFailure(error, baseUrl));
  }
}
