import {
  DeveloperMessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelMessageItem,
  SystemMessageItem,
  UserMessageItem,
  type ModelContext,
  type Participant,
  type Tool,
} from "@mozaik-ai/core";
import { createSemanticEvent, type AgenticEnvironment } from "../runtime/environment.js";
import { looksLikeMalformedEditFence, parseSearchReplaceBlocks } from "../tools/edit-blocks.js";
import { parseToolCallsFromContent, type ChatToolCall } from "./completion-parse.js";
import { readSseChatCompletion } from "./chat-stream.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "./config.js";

export { parseToolCallsFromContent } from "./completion-parse.js";

/** Streamed assistant prose — UI-only, never context. */
export const NARRATION_EVENT = "assistant_narration";

export interface NarrationPayload {
  text: string;
}

/** Token usage for the composer meter — UI-only, never context. */
export const CONTEXT_USAGE_EVENT = "context_usage";

export interface ContextUsagePayload {
  used: number;
}

let syntheticCallCounter = 0;

export type ChatCompletionFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface RunLocalChatCompletionsParams {
  model: string;
  /** Output budget for this call; defaults to DEFAULT_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
  context: ModelContext;
  tools: Tool[];
  environment: AgenticEnvironment;
  caller: Participant;
  onFailed: (message: string) => void;
  /**
   * Provider returned no content and no tool calls. Return true if a recovery
   * step was scheduled (the turn continues), false to fail the turn.
   */
  onEmptyCompletion?: () => boolean;
  fetchImpl?: ChatCompletionFetch;
  signal?: AbortSignal;
  generation?: number;
  isCurrent?: () => boolean;
  trace?: (line: string) => void;
}

/**
 * Without a cap a model may monologue until the whole context is full (observed:
 * gemma4 burned 9k tokens on "ok, do it" and returned nothing). The default now
 * lives in config, because a reasoning model spends the same budget on thinking
 * before it writes anything — see DEFAULT_MAX_OUTPUT_TOKENS.
 */

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
  // propose_edit is synthetic — it is never in the Ollama tool schema. Surfacing
  // it in history as an assistant tool_call teaches Gemma to emit a native
  // call:propose_edit{...}, which Ollama's tool parser then fails on (huge escaped
  // code → "unexpected end of JSON input") and returns an empty completion. So we
  // fold each propose_edit call/output pair into plain assistant prose instead:
  // the model still learns it proposed edits, without a tool_call to imitate.
  const proposeEditCallIds = new Set<string>();
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
      if (item.name === "propose_edit") {
        proposeEditCallIds.add(item.callId);
        continue;
      }
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
      if (proposeEditCallIds.has(item.callId)) {
        messages.push({ role: "assistant", content: item.output.text });
        continue;
      }
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
  const content = message.content ?? "";
  const nativeToolCalls = message.tool_calls ?? [];
  const fromContent = parseToolCallsFromContent(content);
  const editBlocks = parseSearchReplaceBlocks(content);
  let fromFences: ChatToolCall[] = [];
  if (nativeToolCalls.length === 0 && fromContent.length === 0) {
    if (editBlocks.length > 0) {
      fromFences = [
        {
          id: `call_s${++syntheticCallCounter}`,
          function: { name: "propose_edit", arguments: JSON.stringify({ files: editBlocks }) },
        },
      ];
    } else if (looksLikeMalformedEditFence(content)) {
      // Botched markers ("Model.h <<<<<<") never parse into a block. Route them
      // through propose_edit's empty-files error so the model gets the exact
      // format and self-corrects, instead of the broken attempt ending the turn.
      fromFences = [
        {
          id: `call_s${++syntheticCallCounter}`,
          function: { name: "propose_edit", arguments: JSON.stringify({ files: [] }) },
        },
      ];
    }
  }
  const toolCalls =
    nativeToolCalls.length > 0 ? nativeToolCalls : fromContent.length > 0 ? fromContent : fromFences;
  const reasoning = message.reasoning_content ?? message.reasoning ?? message.thinking ?? "";
  params.trace?.(
    `completion: content=${content.length}ch reasoning=${reasoning.length}ch nativeCalls=${nativeToolCalls.length} totalCalls=${toolCalls.length} finish=${choice?.finish_reason ?? "?"}`,
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
  const text = content;
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
  const maxOutputTokens = params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  try {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: mapContextToChatMessages(params.context),
      max_tokens: maxOutputTokens,
    };
    body.stream = true;
    body.stream_options = { include_usage: true };
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
    let emittedNarration = false;
    const assembled = await readSseChatCompletion(
      response,
      (text) => {
        if (!isCurrentTurn(params) || !text) {
          return;
        }
        emittedNarration = true;
        params.environment.deliverSemanticEvent(
          params.caller,
          createSemanticEvent<NarrationPayload>(NARRATION_EVENT, { text }, params.caller.getId()),
        );
      },
      params.signal,
    );
    if (!isCurrentTurn(params)) {
      params.trace?.("completion dropped: stale turn");
      return;
    }
    const used = assembled.usage?.total_tokens;
    if (typeof used === "number" && Number.isFinite(used)) {
      params.environment.deliverSemanticEvent(
        params.caller,
        createSemanticEvent<ContextUsagePayload>(CONTEXT_USAGE_EVENT, { used }, params.caller.getId()),
      );
    }
    const hasNativeTools = assembled.toolCalls.length > 0;
    const emptyContent = !assembled.content.trim();
    const contentCalls = parseToolCallsFromContent(assembled.content).length;
    const contentFences = parseSearchReplaceBlocks(assembled.content).length;
    const actionable = hasNativeTools || contentCalls > 0 || contentFences > 0;
    if (!hasNativeTools && emptyContent) {
      if (assembled.finishReason === "length") {
        // Naming where the budget actually went matters: a reasoning model can
        // spend all of it thinking and return no content at all, which reads as
        // an unexplained failure unless the reasoning size is stated.
        params.onFailed(
          assembled.reasoning.length > 0
            ? `Model spent its whole ${maxOutputTokens}-token output budget reasoning (${assembled.reasoning.length} characters of thinking) and produced no answer. Raise palmAgent.maxOutputTokens, or ask for a smaller step.`
            : `Model hit its ${maxOutputTokens}-token output limit without a usable answer. Ask again, or ask for a smaller change.`,
        );
      } else if (!params.onEmptyCompletion?.()) {
        // Nothing came back and no retry was scheduled. Most often the provider
        // dropped a tool call it could not parse (Ollama's gemma4 dialect mangles
        // code-bearing arguments and then returns an empty body), so the text is
        // already gone by the time we see this — there is nothing to salvage here.
        params.onFailed("Empty completion from provider");
      }
      return;
    }
    if (!actionable && assembled.finishReason === "length") {
      // The model talked until it ran out of budget and never reached an answer
      // or a call: text cut off mid-sentence is not a result. Observed with a
      // model whose reasoning channel leaks into content — it spent the whole
      // budget deliberating. Failing here keeps those tokens out of the context,
      // where in a 16k window they would crowd out every later turn. The prose
      // already streamed to the UI, so the human still sees what happened.
      params.trace?.(
        `dropped ${assembled.content.length}ch of unfinished output (length cap, reasoning=${assembled.reasoning.length}ch)`,
      );
      params.onFailed(
        `Model used all ${maxOutputTokens} output tokens without reaching an answer or a tool call, so its unfinished text was dropped instead of kept as context. Ask for one concrete step, or try a smaller request.`,
      );
      return;
    }
    if (!hasNativeTools && !emptyContent && !emittedNarration && !actionable) {
      params.environment.deliverSemanticEvent(
        params.caller,
        createSemanticEvent<NarrationPayload>(
          NARRATION_EVENT,
          { text: assembled.content },
          params.caller.getId(),
        ),
      );
    }
    deliverCompletion(params, {
      choices: [
        {
          finish_reason: assembled.finishReason,
          message: {
            content: assembled.content,
            // Carried purely so the trace reports the real split between
            // thinking and answer; it is never added to the context.
            reasoning_content: assembled.reasoning,
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
