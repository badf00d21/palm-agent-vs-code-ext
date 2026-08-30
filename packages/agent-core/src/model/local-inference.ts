import {
  DeveloperMessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelMessageItem,
  SemanticEvent,
  SystemMessageItem,
  UserMessageItem,
  type AgenticEnvironment,
  type ModelContext,
  type Participant,
  type Tool,
} from "@mozaik-ai/core";
import { parse as parseJsonc } from "jsonc-parser";
import { readSseChatCompletion } from "./chat-stream.js";

/** Assistant prose that arrived alongside native tool calls — UI-only, never context. */
export const NARRATION_EVENT = "assistant_narration";

export interface NarrationPayload {
  text: string;
}

let syntheticCallCounter = 0;

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
  trace?: (line: string) => void;
}

interface ChatToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

/**
 * Without a cap the model may monologue until the whole num_ctx is full
 * (observed: gemma4 burned 9k tokens on "ok, do it" and returned nothing).
 * 4096 still leaves room for a large propose_edit search+replace pair.
 */
const MAX_OUTPUT_TOKENS = 4096;

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      thinking?: string | null;
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
  const name =
    (typeof nested?.name === "string" && nested.name) ||
    (typeof rec.name === "string" && rec.name) ||
    (typeof rec.function === "string" && rec.function) ||
    (typeof rec.tool === "string" && rec.tool) ||
    "";
  const args = nested?.arguments ?? rec.arguments ?? rec.args ?? rec.parameters;
  const hasArgs =
    nested !== undefined
      ? "arguments" in nested || "args" in nested
      : "arguments" in rec || "args" in rec || "parameters" in rec;
  if (!name || !hasArgs) {
    return null;
  }
  return { id: typeof rec.id === "string" ? rec.id : undefined, function: { name, arguments: args } };
}

function jsonValuesFrom(text: string): unknown[] {
  const values: unknown[] = [];
  const consider = (slice: string) => {
    const value = parseJsonc(slice);
    if (value !== undefined) {
      values.push(value);
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    consider(trimmed);
  }
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    consider((fence[1] ?? "").trim());
  }
  const keyRe = /"(?:name|function|tool)"\s*:/g;
  let match: RegExpExecArray | null;
  let attempts = 0;
  while ((match = keyRe.exec(text)) !== null && attempts < 16) {
    const fromBrace = text.lastIndexOf("{", match.index);
    const fromBracket = text.lastIndexOf("[", match.index);
    const start = Math.max(fromBrace, fromBracket);
    if (start >= 0) {
      consider(text.slice(start));
      attempts += 1;
    }
  }
  return values;
}

function toolCallsFromValue(parsed: unknown): ChatToolCall[] {
  if (Array.isArray(parsed)) {
    return parsed.map(asToolCallObject).filter((call): call is ChatToolCall => call !== null);
  }
  const one = asToolCallObject(parsed);
  return one ? [one] : [];
}

/** Qwen/Ollama often emit a tool call as JSON in `message.content` instead of `tool_calls`. */
export function parseToolCallsFromContent(text: string): ChatToolCall[] {
  if (!text.trim()) {
    return [];
  }
  for (const parsed of jsonValuesFrom(text)) {
    const calls = toolCallsFromValue(parsed);
    if (calls.length > 0) {
      return calls;
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
  const choice = payload.choices?.[0];
  const message = choice?.message;
  if (!message) {
    params.onFailed("Empty completion from provider");
    return;
  }
  const nativeToolCalls = message.tool_calls ?? [];
  const toolCalls =
    nativeToolCalls.length > 0
      ? nativeToolCalls
      : parseToolCallsFromContent(message.content ?? "");
  const reasoning = message.reasoning_content ?? message.reasoning ?? message.thinking ?? "";
  params.trace?.(
    `completion: content=${(message.content ?? "").length}ch reasoning=${reasoning.length}ch nativeCalls=${nativeToolCalls.length} totalCalls=${toolCalls.length} finish=${choice?.finish_reason ?? "?"}`,
  );
  if (toolCalls.length > 0) {
    for (const call of toolCalls) {
      const item = FunctionCallItem.rehydrate({
        callId: call.id ?? `call_s${++syntheticCallCounter}`,
        name: call.function?.name ?? "tool",
        args: toolCallArgs(call.function?.arguments),
      });
      params.environment.deliverFunctionCall(params.caller, item);
    }
    return;
  }
  const text = message.content ?? "";
  if (!text.trim() && choice?.finish_reason === "length") {
    params.onFailed(
      "Model hit its output token limit without a usable answer. Ask again, or ask for a smaller change.",
    );
    return;
  }
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
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    body.stream = true;
    if (params.tools.length > 0) {
      body.tools = mapTools(params.tools);
      body.tool_choice = "auto";
    }
    const started = Date.now();
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "not-needed"}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });
    params.trace?.(`HTTP ${response.status} in ${Date.now() - started}ms`);
    if (!isCurrentTurn(params)) {
      params.trace?.("completion dropped: stale turn");
      return;
    }
    if (!response.ok) {
      throw await readHttpError(response);
    }
    const assembled = await readSseChatCompletion(
      response,
      (text) => {
        if (!isCurrentTurn(params) || !text) {
          return;
        }
        params.environment.deliverSemanticEvent(
          params.caller,
          new SemanticEvent<NarrationPayload>(NARRATION_EVENT, { text }),
        );
      },
      params.signal,
    );
    if (!isCurrentTurn(params)) {
      params.trace?.("completion dropped: stale turn");
      return;
    }
    deliverCompletion(params, {
      choices: [
        {
          finish_reason: assembled.finishReason,
          message: {
            content: assembled.content,
            tool_calls: assembled.toolCalls,
          },
        },
      ],
    });
  } catch (error) {
    params.trace?.(
      `inference error: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
    );
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
