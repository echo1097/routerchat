const FALLBACK_ERROR = "Could not generate the entry.";

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
export async function generateLorebookEntry({ storyId, category, brief, chapterId, onEvent }) {
  const response = await fetch(
    `/api/stories/${encodeURIComponent(storyId)}/lorebook/generate/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, brief, chapter_id: chapterId || null }),
    },
  );
  if (!response.ok || !response.body) {
    throw await streamError(response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let completedRun = null;
  let runError = null;

  function handleLine(line) {
    if (!line.trim()) return;

    const event = JSON.parse(line);
    onEvent(event);
    if (event.type === "complete") completedRun = event.value;
    if (event.type === "error") {
      const value = event.value;
      runError = new Error(
        typeof value === "string" ? value : value?.message || FALLBACK_ERROR,
      );
      runError.code = typeof value === "object" ? value?.code || null : null;
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

  if (runError) throw runError;
  if (!completedRun?.entry) {
    throw new Error("Entry generation ended before it returned an entry.");
  }
  return completedRun;
}
