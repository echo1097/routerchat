import { useEffect, useState } from "react";
import { api } from "../api.js";
import { ModelPicker } from "../settings/ModelPicker.jsx";
import { searchModels } from "../settings/modelSearch.js";

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

  const filteredModels = searchModels(models, query);
  const selectedName = models.find((model) => model.id === selectedModel)?.name || selectedModel;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 min-w-0 px-1">
        <h2 className="text-[13px] font-semibold text-neutral-400">Voice typing model</h2>
        <p className="mt-1.5 truncate text-sm font-medium text-neutral-100">{selectedName || "Loading models…"}</p>
      </div>
      <ModelPicker
        priceHeader="Price"
        renderPrice={(model) => (
          <a
            href={`https://openrouter.ai/${model.id.split("/").map(encodeURIComponent).join("/")}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View pricing for ${model.name || model.id}`}
            className="whitespace-nowrap underline underline-offset-2 hover:text-neutral-200"
          >
            View pricing
          </a>
        )}
        models={filteredModels}
        query={query}
        onQueryChange={setQuery}
        selectedId={selectedModel}
        onSelect={selectModel}
        disabled={loading || saving}
        loading={loading}
        activePage="transcription"
        emptyMessage={loading ? "Loading models…" : models.length ? "No matching models." : "No transcription models available."}
      />
      {saving && <p role="status" className="mt-2 text-xs text-neutral-400">Saving…</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    </section>
  );
}
