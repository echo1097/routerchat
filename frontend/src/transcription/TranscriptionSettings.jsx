import { useEffect, useState } from "react";
import { api } from "../api.js";
import { ModelPicker } from "../settings/ModelPicker.jsx";

export function TranscriptionSettings() {
  const [models, setModels] = useState([]);
  const [query, setQuery] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api("/api/transcription/models", { signal: controller.signal }),
      api("/api/settings", { signal: controller.signal }),
    ]).then(([catalog, settings]) => {
      setModels(catalog.models);
      setSelectedModel(settings.transcription_model || "openai/whisper-1");
    }).catch((error) => {
      if (!controller.signal.aborted) setError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  async function selectModel(modelId) {
    setSaving(true);
    setError("");
    try {
      const settings = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ transcription_model: modelId }),
      });
      setSelectedModel(settings.transcription_model);
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  }

  const searchText = query.trim().toLowerCase();
  const filteredModels = models.filter((model) =>
    `${model.name || ""} ${model.id}`.toLowerCase().includes(searchText),
  );
  const selectedName = models.find((model) => model.id === selectedModel)?.name || selectedModel;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-neutral-100">Model</h2>
          <p className="mt-0.5 truncate text-xs text-neutral-500">{selectedName || "Loading models…"}</p>
        </div>
      </div>
      <ModelPicker
        models={filteredModels}
        query={query}
        onQueryChange={setQuery}
        selectedId={selectedModel}
        onSelect={selectModel}
        disabled={loading || saving}
        activePage="transcription"
        emptyMessage={loading ? "Loading models…" : models.length ? "No matching models." : "No transcription models available."}
      />
      {saving && <p role="status" className="mt-2 text-xs text-neutral-400">Saving…</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    </section>
  );
}
