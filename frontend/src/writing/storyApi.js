import { api, responseError } from "../api.js";

export const storyApi = {
  async listStories() {
    const payload = await api("/api/stories");
    return payload.stories || [];
  },

  async getStory(storyId) {
    return api(`/api/stories/${encodeURIComponent(storyId)}`);
  },

  async getGenerationStatus(run) {
    return api(`/api/stories/${encodeURIComponent(run.storyId)}/chapters/${encodeURIComponent(run.chapterId)}/generations/${encodeURIComponent(run.generationId)}`);
  },

  async createStory(data) {
    const payload = await api("/api/stories", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return payload.story;
  },

  async createStoryWithInitialChapter(data, initialChapter) {
    return api("/api/stories/with-initial-chapter", {
      method: "POST",
      body: JSON.stringify({ ...data, initial_chapter: initialChapter }),
    });
  },

  async updateStory(storyId, data) {
    const payload = await api(`/api/stories/${encodeURIComponent(storyId)}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    return payload.story;
  },

  async deleteStory(storyId) {
    return api(`/api/stories/${encodeURIComponent(storyId)}`, { method: "DELETE" });
  },

  async importStory(data) {
    return api("/api/stories/import", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async closeStory(storyId) {
    return api(`/api/stories/${encodeURIComponent(storyId)}/close`, { method: "POST" });
  },

  async listChapters(storyId) {
    const payload = await api(`/api/stories/${encodeURIComponent(storyId)}/chapters`);
    return payload.chapters || [];
  },

  async createChapter(storyId, data) {
    const payload = await api(`/api/stories/${encodeURIComponent(storyId)}/chapters`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    return payload.chapter;
  },

  async updateChapter(storyId, chapterId, data) {
    const payload = await api(
      `/api/stories/${encodeURIComponent(storyId)}/chapters/${encodeURIComponent(chapterId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
    );
    return payload.chapter;
  },

  async deleteChapter(storyId, chapterId) {
    return api(
      `/api/stories/${encodeURIComponent(storyId)}/chapters/${encodeURIComponent(chapterId)}`,
      { method: "DELETE" },
    );
  },

  async saveChapterContent(storyId, chapterId, content, revision) {
    const payload = await api(
      `/api/stories/${encodeURIComponent(storyId)}/chapters/${encodeURIComponent(chapterId)}/content`,
      {
        method: "PATCH",
        body: JSON.stringify({ content, revision }),
      },
    );
    return payload.chapter;
  },

  async listLorebook(storyId) {
    const payload = await api(`/api/stories/${encodeURIComponent(storyId)}/lorebook`);
    return payload.entries || [];
  },

  async createLorebookEntry(storyId, data) {
    const payload = await api(`/api/stories/${encodeURIComponent(storyId)}/lorebook`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    return payload.entry;
  },

  async updateLorebookEntry(storyId, entryId, data) {
    const payload = await api(
      `/api/stories/${encodeURIComponent(storyId)}/lorebook/${encodeURIComponent(entryId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
    );
    return payload.entry;
  },

  async deleteLorebookEntry(storyId, entryId) {
    return api(
      `/api/stories/${encodeURIComponent(storyId)}/lorebook/${encodeURIComponent(entryId)}`,
      { method: "DELETE" },
    );
  },

  async updateLorebookFromChapter(storyId, chapterId) {
    return api(`/api/stories/${encodeURIComponent(storyId)}/lorebook/update`, {
      method: "POST",
      body: JSON.stringify({ chapter_id: chapterId }),
    });
  },

  async repairTimeline({ storyId, currentTimeline, onEvent }) {
    const response = await fetch(
      `/api/stories/${encodeURIComponent(storyId)}/lorebook/timeline/repair/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_timeline: currentTimeline }),
      },
    );
    if (!response.ok || !response.body) {
      throw await responseError(response);
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
          typeof value === "string" ? value : value?.message || "Could not rebuild timeline.",
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
    if (!completedRepair?.entry) {
      throw new Error("Timeline repair ended before it returned a rebuilt timeline.");
    }
    return completedRepair;
  },

  async getBrainstorm(storyId) {
    return api(`/api/stories/${encodeURIComponent(storyId)}/brainstorm`);
  },

  async updateBrainstormNode(storyId, nodeId, data) {
    const payload = await api(
      `/api/stories/${encodeURIComponent(storyId)}/brainstorm/nodes/${encodeURIComponent(nodeId)}`,
      { method: "PATCH", body: JSON.stringify(data) },
    );
    return payload.node;
  },

  async deleteBrainstormNode(storyId, nodeId, cascade = false) {
    return api(
      `/api/stories/${encodeURIComponent(storyId)}/brainstorm/nodes/${encodeURIComponent(nodeId)}?cascade=${cascade}`,
      { method: "DELETE" },
    );
  },

  async updateBrainstormViewport(storyId, viewport) {
    return api(`/api/stories/${encodeURIComponent(storyId)}/brainstorm/viewport`, {
      method: "PATCH",
      body: JSON.stringify({
        position_x: viewport.x,
        position_y: viewport.y,
        zoom: viewport.zoom,
      }),
    });
  },

  async generateBrainstorm({ storyId, prompt, selectedIdeaIds, ideaCount, settings, onEvent, signal }) {
    const response = await fetch(
      `/api/stories/${encodeURIComponent(storyId)}/brainstorm/generate/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          ...settings,
          write_system_prompt: settings.system_prompt,
          selected_idea_ids: selectedIdeaIds,
          brainstorm_idea_count: ideaCount,
          message: prompt,
        }),
      },
    );
    if (!response.ok || !response.body) {
      throw await responseError(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) onEvent(JSON.parse(line));
      }
    }
    if (buffered.trim()) onEvent(JSON.parse(buffered));
  },

  async generateChapter({
    storyId,
    chapterId,
    prompt,
    settings,
    generationMode,
    chapterRevision,
    generationRunId,
    generationStatusId,
    repairContext,
    attachmentIds = [],
    onEvent,
    signal,
  }) {
    const response = await fetch(
      `/api/stories/${encodeURIComponent(storyId)}/chapters/${encodeURIComponent(chapterId)}/generate/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          ...settings,
          write_system_prompt: settings.system_prompt,
          write_generation_mode: generationMode,
          chapter_revision: chapterRevision,
          generation_run_id: generationRunId,
          generation_status_id: generationStatusId,
          repair_context: repairContext || null,
          message: prompt,
          attachment_ids: attachmentIds,
        }),
      },
    );

    if (!response.ok) {
      const error = await responseError(response);
      error.generationRejected = true;
      throw error;
    }
    if (!response.body) throw new Error("The generation stream is missing.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        onEvent(JSON.parse(line));
      }
    }
    if (buffered.trim()) {
      onEvent(JSON.parse(buffered));
    }
  },
};
