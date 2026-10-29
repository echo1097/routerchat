const BILLING_LINKS = {
  OpenRouter: "https://openrouter.ai/settings/credits",
  Anthropic: "https://console.anthropic.com/settings/billing",
};

const FALLBACK_TITLE = "Something went wrong";

export function billingLink(provider) {
  return BILLING_LINKS[provider] || null;
}

export function savedErrorNotice(savedError) {
  if (!savedError || typeof savedError !== "string") return null;
  try {
    const parsed = JSON.parse(savedError);
    return parsed && typeof parsed === "object" && parsed.kind ? parsed : null;
  } catch {
    return null;
  }
}

export function liveErrorNotice(value, fallbackMessage = "Try again.") {
  if (value && typeof value === "object" && value.message) {
    return {
      kind: value.kind || "unknown",
      title: value.title || FALLBACK_TITLE,
      message: String(value.message),
      provider: value.provider || null,
    };
  }

  const message = typeof value === "string" && value.trim() ? value : fallbackMessage;
  return { kind: "unknown", title: FALLBACK_TITLE, message, provider: null };
}
