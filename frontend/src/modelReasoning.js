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

export function supportsReasoningEffort(models, modelId, effort) {
  const supportedEfforts = modelMetadata(models, modelId)?.reasoning?.supported_efforts;

  // Older model metadata does not list its levels, so keep OpenRouter's defaults available.
  if (!Array.isArray(supportedEfforts)) return true;

  if (supportedEfforts.includes(effort)) return true;

  // OpenRouter treats these as equivalent highest-effort values. Prefer max in new requests.
  return effort === "max" && supportedEfforts.includes("xhigh");
}

const reasoningEffortOrder = ["low", "medium", "high", "max"];

function normalizedReasoningEffort(effort) {
  return effort === "xhigh" ? "max" : effort;
}

export function resolveReasoningEffort(models, modelId, effort) {
  const preferredEffort = normalizedReasoningEffort(effort);
  const supportedEfforts = modelMetadata(models, modelId)?.reasoning?.supported_efforts;

  if (!Array.isArray(supportedEfforts)) return preferredEffort;

  const availableEfforts = new Set(
    supportedEfforts.map(normalizedReasoningEffort).filter((level) => (
      reasoningEffortOrder.includes(level)
    )),
  );

  if (availableEfforts.has(preferredEffort)) return preferredEffort;

  const preferredIndex = reasoningEffortOrder.indexOf(preferredEffort);
  if (preferredIndex === -1) return preferredEffort;

  for (let index = preferredIndex + 1; index < reasoningEffortOrder.length; index += 1) {
    const nextEffort = reasoningEffortOrder[index];
    if (availableEfforts.has(nextEffort)) return nextEffort;
  }

  for (let index = preferredIndex - 1; index >= 0; index -= 1) {
    const nextEffort = reasoningEffortOrder[index];
    if (availableEfforts.has(nextEffort)) return nextEffort;
  }

  return preferredEffort;
}

export function requiresThinking(models, modelId) {
  return modelMetadata(models, modelId)?.reasoning?.mandatory === true;
}

export function effectiveThinkingEnabled(models, modelId, thinkingEnabled) {
  return Boolean(thinkingEnabled || requiresThinking(models, modelId));
}

const reasoningEffortLabels = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

export function reasoningEffortLabel(models, modelId, effort) {
  const resolvedEffort = resolveReasoningEffort(models, modelId, effort);
  return reasoningEffortLabels[resolvedEffort] || "Thinking";
}

export function supportsImageInput(models, modelId) {
  const architecture = modelMetadata(models, modelId)?.architecture;
  if (!architecture) return false;

  const inputModalities = architecture.input_modalities;
  if (Array.isArray(inputModalities)) {
    return inputModalities.includes("image");
  }

  const modality = architecture.modality;
  if (typeof modality === "string" && modality.includes("->")) {
    const [inputs] = modality.split("->");
    return inputs.split("+").includes("image");
  }

  return false;
}
