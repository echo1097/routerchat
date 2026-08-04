const FALLBACK_ERROR = "Could not rebuild lorebook.";

async function streamError(response) {
  const fallback = response.statusText || "Request failed";
  const body = await response.text();
  let payload = null;

  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
  }

  const detail = payload?.detail;
  const message = typeof detail === "string"
    ? detail
    : detail?.message || payload?.error?.message || body || fallback;
  const error = new Error(message);
  error.name = "ApiError";
  error.status = response.status;
  return error;
}

//same ndjson shape as every other write stream: status, reasoning, usage, then one complete or error
export async function repairLorebook({ storyId, onEvent }) {
  const response = await fetch(
    `/api/stories/${encodeURIComponent(storyId)}/lorebook/repair/stream`,
    { method: "POST" },
  );
  if (!response.ok || !response.body) {
    throw await streamError(response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let completedRepair = null;
  let repairError = null;

  function handleLine(line) {
    if (!line.trim()) return;

    const event = JSON.parse(line);
    onEvent(event);
    if (event.type === "complete") completedRepair = event.value;
    if (event.type === "error") {
      const value = event.value;
      repairError = new Error(
        typeof value === "string" ? value : value?.message || FALLBACK_ERROR,
      );
      repairError.code = typeof value === "object" ? value?.code || null : null;
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() || "";
    lines.forEach(handleLine);
  }
  if (buffered.trim()) handleLine(buffered);

  if (repairError) throw repairError;
  if (!Array.isArray(completedRepair?.entries)) {
    throw new Error("Lorebook repair ended before it returned a rebuilt lorebook.");
  }
  return completedRepair;
}
