import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { CurrentModelGroup } from "../settings/CurrentModelGroup.jsx";
import { SettingChip } from "../settings/SettingControls.jsx";
import { modelDisplayName } from "../modelFormatting.js";
import { ModelPicker } from "../settings/ModelPicker.jsx";
import { searchModels } from "../settings/modelSearch.js";
import { transcriptionPrice } from "./transcriptionPrice.js";

export function TranscriptionSettings() {
  const [models, setModels] = useState([]);
  const [query, setQuery] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const savedModel = useRef("");
  const saveQueue = useRef(Promise.resolve());

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api("/api/transcription/models", { signal: controller.signal }),
      api("/api/settings", { signal: controller.signal }),
    ]).then(([catalog, settings]) => {
      setModels(catalog.models);
      savedModel.current = settings.transcription_model || "openai/whisper-1";
      setSelectedModel(savedModel.current);
    }).catch((error) => {
      if (!controller.signal.aborted) setError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  function selectModel(modelId) {
    if (modelId === selectedModel) return;
    setSelectedModel(modelId);
    setError("");

    const save = saveQueue.current.then(async () => {
      try {
        const settings = await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ transcription_model: modelId }),
        });
        savedModel.current = settings.transcription_model;
      } catch (error) {
        if (saveQueue.current === save) {
          setSelectedModel(savedModel.current);
          setError(error.message);
        }
      }
    });
    saveQueue.current = save;
  }

  const filteredModels = searchModels(models, query);
  const currentModel = models.find((model) => model.id === selectedModel);
  const currentPrice = currentModel && transcriptionPrice(currentModel);
  const selectedName = currentModel ? modelDisplayName(currentModel) : selectedModel;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <CurrentModelGroup
        id="settings-group-dictation-model"
        name={loading ? "Loading models…" : selectedName || "No model selected"}
      >
        {currentPrice && <SettingChip>{currentPrice.label}</SettingChip>}
        {selectedModel && !currentModel && <SettingChip>Unavailable</SettingChip>}
      </CurrentModelGroup>
      <ModelPicker
        framed
        renderPrice={(model) => {
          const price = transcriptionPrice(model);
          if (price) return <span title={price.title}>{price.label}</span>;

          return (
            <a
              href={`https://openrouter.ai/${model.id.split("/").map(encodeURIComponent).join("/")}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`View pricing for ${model.name || model.id}`}
              className="whitespace-nowrap underline underline-offset-2 hover:text-neutral-200"
            >
              View pricing
            </a>
          );
        }}
        models={filteredModels}
        query={query}
        onQueryChange={setQuery}
        selectedId={selectedModel}
        onSelect={selectModel}
        disabled={loading}
        loading={loading}
        activePage="transcription"
        emptyMessage={loading ? "Loading models…" : models.length ? "No matching models." : "No transcription models available."}
      />
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    </section>
  );
}
