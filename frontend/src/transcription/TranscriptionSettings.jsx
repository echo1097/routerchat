import { useEffect, useState } from "react";
import { api } from "../api.js";

export function TranscriptionSettings() {
  const [models, setModels] = useState([]);
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

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-neutral-400">Choose the transcription model for Chat, Write, and Brainstorm. Recordings use your OpenRouter key and the selected model’s rates.</p>
      <label className="block text-sm text-neutral-200">
        Transcription model
        <select aria-label="Transcription model" value={selectedModel} disabled={loading || saving || !models.length} onChange={(event) => selectModel(event.target.value)} className="mt-2 w-full rounded-xl bg-[#303030] p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-white/30">
          {!models.some((model) => model.id === selectedModel) && <option value={selectedModel}>{loading ? "Loading models…" : selectedModel || "No models available"}</option>}
          {models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
        </select>
      </label>
      <p className="text-xs leading-5 text-neutral-500">The square adds your transcript to the prompt. The arrow transcribes and sends it. Cancel discards the recording. Privacy and ZDR must be off to use transcription.</p>
      {saving && <p role="status" className="text-xs text-neutral-400">Saving…</p>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
