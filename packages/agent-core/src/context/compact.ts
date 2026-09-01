import {
  FunctionCallOutputItem,
  UserMessageItem,
  type ContextItem,
} from "@mozaik-ai/core";

export const KEEP_TURNS = 3;
export const SLIDE_RATIO = 0.8;
export const STUB_TEXT = "[omitted from context; call again if needed]";
export const CONTEXT_TRIMMED_EVENT = "context_trimmed";

export interface CompactBudget {
  lastUsed?: number;
  max: number | null;
}

function userStarts(items: ContextItem[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (items[i] instanceof UserMessageItem) {
      starts.push(i);
    }
  }
  return starts;
}

function shouldSlide(budget: CompactBudget): boolean {
  const { lastUsed, max } = budget;
  return (
    typeof lastUsed === "number" &&
    Number.isFinite(lastUsed) &&
    typeof max === "number" &&
    max > 0 &&
    lastUsed / max >= SLIDE_RATIO
  );
}

export function compactContext(
  items: ContextItem[],
  budget: CompactBudget,
): { trimmed: boolean } {
  const starts = userStarts(items);
  const lastStart = starts[starts.length - 1] ?? items.length;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!(item instanceof FunctionCallOutputItem)) {
      continue;
    }
    if (i >= lastStart) {
      continue;
    }
    if (item.output.text === STUB_TEXT) {
      continue;
    }
    items[i] = FunctionCallOutputItem.create(item.callId, STUB_TEXT);
  }
  const afterStub = userStarts(items);
  if (!shouldSlide(budget) || afterStub.length <= KEEP_TURNS) {
    return { trimmed: false };
  }
  const keepFrom = afterStub[afterStub.length - KEEP_TURNS]!;
  const prefixEnd = afterStub[0]!;
  items.splice(prefixEnd, keepFrom - prefixEnd);
  return { trimmed: true };
}
