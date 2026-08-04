const FALLBACK_ERROR = "Could not update the lorebook.";

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

//same ndjson shape as the repairs: status, reasoning, then one complete or error
export async function updateLorebookStream({ storyId, chapterId, onEvent }) {
  const response = await fetch(
    `/api/stories/${encodeURIComponent(storyId)}/lorebook/update/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapter_id: chapterId }),
    },
  );
  if (!response.ok || !response.body) {
    throw await streamError(response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let completedUpdate = null;
  let updateError = null;

  function handleLine(line) {
    if (!line.trim()) return;

    const event = JSON.parse(line);
    onEvent(event);
    if (event.type === "complete") completedUpdate = event.value;
    if (event.type === "error") {
      const value = event.value;
      updateError = new Error(
        typeof value === "string" ? value : value?.message || FALLBACK_ERROR,
      );
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

  if (updateError) throw updateError;
  if (!completedUpdate) {
    throw new Error("The lorebook update ended before it finished.");
  }
  return completedUpdate;
}
