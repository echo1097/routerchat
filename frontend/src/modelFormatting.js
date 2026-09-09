function modelName(models, id) {
  return models.find((model) => model.id === id)?.name || id || "No model";
}

export function promptModelName(models, id) {
  return modelName(models, id)
    .replace(/^[^:]+:\s*/, "")
    .replace(/^[^/]+\//, "");
}

export function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatTokens(tokens) {
  if (!Number.isFinite(tokens)) return "Unavailable";
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return `${tokens}`;
}

export function getModelContextLimit(model) {
  const providerLimit = toFiniteNumber(model?.top_provider?.context_length);
  const modelLimit = toFiniteNumber(model?.context_length);
  return providerLimit > 0 ? providerLimit : modelLimit > 0 ? modelLimit : null;
}

export function getContextWindowInfo(contextTokens, contextLimit) {
  if (!Number.isFinite(contextTokens) || !Number.isFinite(contextLimit) || contextLimit <= 0) {
    return null;
  }
  const percentFull = (contextTokens / contextLimit) * 100;
  const remainingTokens = Math.max(contextLimit - contextTokens, 0);

  return {
    contextTokens,
    contextLimit,
    remainingTokens,
    percentFull,
    displayPercent: `${Math.round(percentFull)}% full`,
    displayUsage: `${formatTokens(contextTokens)} / ${formatTokens(contextLimit)} tokens used`,
  };
}

export function priceLabel(model) {
  const prompt = Number(model.pricing?.prompt || 0) * 1000000;
  const completion = Number(model.pricing?.completion || 0) * 1000000;
  if ((!prompt && !completion) || prompt < 0 || completion < 0) return "";
  return `$${prompt.toFixed(prompt >= 1 ? 0 : 2)} / $${completion.toFixed(
    completion >= 1 ? 0 : 2,
  )}`;
}

export function isFreeModel(model) {
  if (String(model.id || "").endsWith(":free")) return true;
  const prompt = Number(model.pricing?.prompt || 0);
  const completion = Number(model.pricing?.completion || 0);
  return prompt === 0 && completion === 0;
}
