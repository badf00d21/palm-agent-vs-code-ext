export function ollamaNativeOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function parseLoadedContextLength(payload: unknown, model: string): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return null;
  }
  const entry = models.find((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const rec = item as { name?: unknown; model?: unknown };
    return rec.name === model || rec.model === model;
  });
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const length = (entry as { context_length?: unknown }).context_length;
  if (typeof length !== "number" || !Number.isFinite(length)) {
    return null;
  }
  return length;
}

export function createContextWindow(deps: {
  fetchImpl: typeof fetch;
  baseUrl: () => string;
  model: () => string;
}): {
  attachMax(used: number): Promise<{ type: "context_usage"; used: number; max: number | null }>;
} {
  let cached: { model: string; max: number } | undefined;

  return {
    async attachMax(used: number) {
      const model = deps.model();
      if (cached && cached.model === model) {
        return { type: "context_usage" as const, used, max: cached.max };
      }
      try {
        const url = `${ollamaNativeOrigin(deps.baseUrl())}/api/ps`;
        const response = await deps.fetchImpl(url);
        if (!response.ok) {
          return { type: "context_usage" as const, used, max: null };
        }
        const max = parseLoadedContextLength(await response.json(), model);
        if (max !== null) {
          cached = { model, max };
        }
        return { type: "context_usage" as const, used, max };
      } catch {
        return { type: "context_usage" as const, used, max: null };
      }
    },
  };
}
