import {
  OpenAIChatCompletions,
  type Endpoint,
  type InferenceInput,
} from "@mozaik-ai/core";
import {
  applyChatChunk,
  emptyAssembly,
  promote,
  type AssembledCompletion,
} from "./chat-stream.js";

export interface MozaikChatEndpointOptions {
  baseURL: string;
  apiKey: string;
  maxOutputTokens: number;
}

export interface CollectMozaikChatStreamParams {
  endpoint: Pick<Endpoint, "stream">;
  input: InferenceInput;
  onProseDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface InferenceOutputPayload {
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  rowResponse?: {
    usage?: OpenAIUsage;
    choices?: Array<{ finish_reason?: string | null }>;
  };
}

export function createMozaikChatEndpoint(
  options: MozaikChatEndpointOptions,
): OpenAIChatCompletions {
  return new OpenAIChatCompletions(undefined, {
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    extraBody: {
      max_tokens: options.maxOutputTokens,
      stream_options: { include_usage: true },
    },
  });
}

function isInferenceOutput(
  event: unknown,
): event is { type: "inference.output"; payload: InferenceOutputPayload } {
  return (
    !!event &&
    typeof event === "object" &&
    (event as { type?: string }).type === "inference.output"
  );
}

function mergeFinalMetadata(
  acc: AssembledCompletion,
  payload: InferenceOutputPayload,
): void {
  const rowUsage = payload.rowResponse?.usage;
  if (typeof rowUsage?.total_tokens === "number") {
    acc.usage = {
      prompt_tokens: rowUsage.prompt_tokens ?? 0,
      completion_tokens: rowUsage.completion_tokens ?? 0,
      total_tokens: rowUsage.total_tokens,
    };
  } else if (typeof payload.tokenUsage?.totalTokens === "number") {
    acc.usage = {
      prompt_tokens: payload.tokenUsage.inputTokens ?? 0,
      completion_tokens: payload.tokenUsage.outputTokens ?? 0,
      total_tokens: payload.tokenUsage.totalTokens,
    };
  }
  const finishReason = payload.rowResponse?.choices?.[0]?.finish_reason;
  if (finishReason) {
    acc.finishReason = finishReason;
  }
}

function abortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  if (!signal) {
    return iterator.next();
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function collectMozaikChatStream(
  params: CollectMozaikChatStreamParams,
): Promise<AssembledCompletion> {
  if (params.signal?.aborted) {
    throw abortError();
  }
  const acc = emptyAssembly();
  let mode: "prose" | "tool" | "unknown" = "unknown";
  const iterator = params.endpoint.stream(params.input)[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const result = await nextWithAbort(iterator, params.signal);
      if (result.done) {
        completed = true;
        break;
      }
      const event = result.value;
      if (isInferenceOutput(event)) {
        mergeFinalMetadata(acc, event.payload);
        continue;
      }
      const { contentDelta } = applyChatChunk(acc, event);
      mode = promote(acc, mode, contentDelta, params.onProseDelta ?? (() => undefined));
    }
  } finally {
    if (!completed && iterator.return) {
      try {
        const cleanup = iterator.return();
        void Promise.resolve(cleanup).catch(() => undefined);
      } catch {
        // Preserve the stream/abort error; cleanup is best-effort.
      }
    }
  }
  return acc;
}
