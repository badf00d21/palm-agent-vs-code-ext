import type { FunctionCallItem, FunctionCallOutputItem, Tool } from "@mozaik-ai/core";

/** Mozaik's FunctionCallRunner is not exported from @mozaik-ai/core 4.0.6. */
export type FunctionCallRunner = {
  run(call: FunctionCallItem, tool: Tool): Promise<FunctionCallOutputItem>;
};
