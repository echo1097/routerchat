function normalizedModelId(modelId) {
  return String(modelId || "").replace(/:nitro$/, "");
}

export function modelMetadata(models, modelId) {
  const targetModelId = normalizedModelId(modelId);
  return models.find((model) => normalizedModelId(model.id) === targetModelId) || null;
}

export function supportsThinking(models, modelId) {
  const model = modelMetadata(models, modelId);
  return Boolean(
    model?.supported_parameters?.includes("reasoning")
    || (model?.reasoning && typeof model.reasoning === "object"),
  );
}

export function requiresThinking(models, modelId) {
  return modelMetadata(models, modelId)?.reasoning?.mandatory === true;
}

export function effectiveThinkingEnabled(models, modelId, thinkingEnabled) {
  return Boolean(thinkingEnabled || requiresThinking(models, modelId));
}
