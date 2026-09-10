import { MessageSquarePlus, SlidersHorizontal, X, Check } from "lucide-react";
import { useState, useRef, useMemo, useEffect } from "react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { supportsThinking, resolveReasoningEffort, supportsReasoningEffort } from "../modelReasoning.js";
import {
  promptModelName,
  priceLabel,
  getModelContextLimit,
  formatTokens,
  isFreeModel,
} from "../modelFormatting.js";
import { SearchClearField } from "../components/SearchClearField.jsx";
import { ModelPicker } from "./ModelPicker.jsx";
import { LOREBOOK_MODEL_INHERIT } from "./settingsDefaults.js";
import { Accordion } from "../components/Accordion.jsx";
import { SlidingTabs } from "../components/SlidingTabs.jsx";
import { MaskIcon, IconButton } from "../components/IconButton.jsx";
import { UsagePanel } from "./UsagePanel.jsx";

const REASONING_EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

const SETTINGS_PAGES = [
  { id: "general", label: "API", iconClass: "fi fi-rr-key" },
  { id: "models", label: "Models", iconClass: "fi fi-rr-bulb" },
  { id: "system", label: "System", iconClass: "fi fi-rr-settings" },
  { id: "ui", label: "UI", iconClass: "fi fi-rr-apps-add" },
  { id: "cloud", label: "Chats", icon: MessageSquarePlus },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
  { id: "lorebook", label: "Lorebook", iconSrc: "/icons/newbook.png" },
  { id: "usage", label: "Usage", iconSrc: "/icons/money.png" },
];

function rangeProgress(value, min, max) {
  return `${((Number(value) - min) / (max - min)) * 100}%`;
}

function SettingSwitch({ checked, onChange, label, disabled = false }) {
  const [interacted, setInteracted] = useState(false);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        setInteracted(true);
        onChange(!checked);
      }}
      data-on={String(checked)}
      className={cx(
        "t-toggle relative h-7 w-12 shrink-0 rounded-full shadow-[var(--shadow-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed",
        interacted && "is-init",
        disabled && "opacity-45",
        checked ? "bg-accent/80" : "bg-white/[0.08]",
      )}
    >
      <span className="t-toggle-thumb absolute left-1 top-1 h-5 w-5 rounded-full bg-neutral-50" />
    </button>
  );
}

function SettingRow({ title, description, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-balance text-sm font-semibold text-neutral-100">{title}</h2>
        <p className="mt-0.5 text-pretty text-xs leading-5 text-neutral-500">{description}</p>
      </div>
      {children}
    </div>
  );
}

export function SettingsDrawer({
  open,
  onClose,
  keyStatus,
  onSaveKey,
  chats,
  activeChatId,
  models,
  chatMode,
  settings,
  setSettings,
  defaultModel,
  generateChatName,
  hideFreeModels,
  nitroMode,
  cheapestMode,
  privacyMode,
  zdrMode,
  smoothStreaming,
  showPromptNavigationRail,
  modelLocked,
  onPersist,
  onModelSelected,
  onSetDefaultModel,
  onToggleGenerateChatName,
  onToggleHideFreeModels,
  onToggleNitroMode,
  onToggleCheapestMode,
  onTogglePrivacyMode,
  onToggleZdrMode,
  onToggleSmoothStreaming,
  onTogglePromptNavigationRail,
  onExportChats,
  onImportChats,
  onNotify,
}) {
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [lorebookQuery, setLorebookQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedCloudChatId, setSelectedCloudChatId] = useState("");
  const [cloudSearch, setCloudSearch] = useState("");
  const [activePage, setActivePage] = useState("general");
  const [chatListScrolled, setChatListScrolled] = useState(false);
  const [chatListHasMoreBelow, setChatListHasMoreBelow] = useState(false);
  const [openAccordions, setOpenAccordions] = useState({
    reasoning: true,
    generation: true,
  });
  const fileInputRef = useRef(null);
  const chatListRef = useRef(null);
  const modelSearchWrapRef = useRef(null);
  const modelSearchInputRef = useRef(null);
  const modelSearchRevertRef = useRef(null);
  const modelSearchHadResultsRef = useRef(true);
  const [editingMaxTokens, setEditingMaxTokens] = useState(false);
  const [maxTokensDraft, setMaxTokensDraft] = useState("");
  const canThink = supportsThinking(models, settings.model);
  const reasoningEffort = resolveReasoningEffort(
    models,
    settings.model,
    settings.reasoning_effort,
  );
  const selectedModel = models.find((model) => model.id === settings.model);
  const selectedModelOutputName = promptModelName(models, settings.model);
  const selectedModelPrice = selectedModel ? priceLabel(selectedModel) : "";
  const selectedModelContextLimit = getModelContextLimit(selectedModel);
  const selectedModelContext = Number.isFinite(selectedModelContextLimit)
    ? `${formatTokens(selectedModelContextLimit)} context`
    : "";
  const keyConnected = Boolean(keyStatus.has_key);
  const activePageIndex = SETTINGS_PAGES.findIndex((page) => page.id === activePage) + 1;
  const selectedCloudChat = chats.find((chat) => chat.id === selectedCloudChatId);
  const activeCloudChat = chats.find((chat) => chat.id === activeChatId);
  const cloudChat = selectedCloudChat || activeCloudChat || chats[0];
  const cloudChatId = cloudChat?.id || "";
  const promptModeName = chatMode === "write" ? "Write" : "Chat";

  const visibleSettingsPages = chatMode === "write"
    ? SETTINGS_PAGES.filter((page) => page.id !== "system")
    : SETTINGS_PAGES.filter((page) => page.id !== "lorebook");

  const filteredCloudChats = useMemo(() => {
    const normalized = cloudSearch.trim().toLowerCase();
    if (!normalized) return chats;
    return chats.filter((chat) => (
      [chat.title, promptModelName(models, chat.model)]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalized))
    ));
  }, [chats, cloudSearch, models]);

  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return models
      .filter((model) => {
        if (hideFreeModels && isFreeModel(model)) return false;
        if (!normalized) return true;
        return [model.name, model.id, model.description]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalized));
      });
  }, [hideFreeModels, models, query]);

  const filteredLorebookModels = useMemo(() => {
    const normalized = lorebookQuery.trim().toLowerCase();
    return models
      .filter((model) => {
        if (hideFreeModels && isFreeModel(model)) return false;
        if (!normalized) return true;
        return [model.name, model.id, model.description]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalized));
      });
  }, [hideFreeModels, lorebookQuery, models]);

  const lorebookInherits = !settings.lorebook_model;
  const lorebookModelId = settings.lorebook_model || settings.model;
  const lorebookModel = models.find((model) => model.id === lorebookModelId);
  const lorebookModelPrice = lorebookModel ? priceLabel(lorebookModel) : "";
  const lorebookModelContextLimit = getModelContextLimit(lorebookModel);
  const lorebookModelContext = Number.isFinite(lorebookModelContextLimit)
    ? `${formatTokens(lorebookModelContextLimit)} context`
    : "";

  function updateChatListEdges(element) {
    const scrollTop = element.scrollTop;
    const bottomOffset = element.scrollHeight - element.clientHeight - scrollTop;
    setChatListScrolled(scrollTop > 2);
    setChatListHasMoreBelow(bottomOffset > 2);
  }

  useEffect(() => {
    const chatList = chatListRef.current;
    if (!chatList) return;

    requestAnimationFrame(() => updateChatListEdges(chatList));
  }, [filteredCloudChats.length, activePage]);

  useEffect(() => {
    if (chatMode === "write" && activePage === "system") {
      setActivePage("general");
    }
  }, [activePage, chatMode]);

  useEffect(() => {
    const hasQuery = query.trim().length > 0;
    const hasResults = filteredModels.length > 0;
    const shouldShake = hasQuery && !hasResults && modelSearchHadResultsRef.current;
    const shakeActive = modelSearchInputRef.current?.classList.contains("is-shaking");

    modelSearchHadResultsRef.current = hasResults || !hasQuery;

    if (!shouldShake) {
      if (hasResults || !hasQuery) {
        if (shakeActive) {
          return;
        }
        modelSearchWrapRef.current?.classList.remove("is-error");
        modelSearchInputRef.current?.classList.remove("is-error");
      }
      return;
    }

    const wrap = modelSearchWrapRef.current;
    const input = modelSearchInputRef.current;
    if (!wrap || !input) return;

    wrap.classList.add("is-error");
    input.classList.add("is-error");

    input.classList.remove("is-shaking");
    void input.offsetWidth;
    input.classList.add("is-shaking");

    const style = getComputedStyle(document.documentElement);
    const readMs = (name, fallback) => {
      const value = Number.parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const shakeMs = readMs("--shake-dur-a", 80) * 2 + readMs("--shake-dur-b", 60) * 2;
    const holdMs = readMs("--revert-hold", 3000);

    window.clearTimeout(modelSearchRevertRef.current);
    window.setTimeout(() => {
      input.classList.remove("is-shaking");
      if (filteredModels.length > 0 || !query.trim()) {
        wrap.classList.remove("is-error");
        input.classList.remove("is-error");
      }
    }, shakeMs + 20);
    modelSearchRevertRef.current = window.setTimeout(() => {
      wrap.classList.remove("is-error");
      input.classList.remove("is-error");
    }, shakeMs + holdMs);
  }, [filteredModels.length, query]);

  async function saveKey() {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await onSaveKey(apiKey.trim());
      setApiKey("");
    } finally {
      setSaving(false);
    }
  }

  function updateSetting(next) {
    setSettings((current) => ({ ...current, ...next }));
  }

  useEffect(() => {
    if (!canThink || reasoningEffort === settings.reasoning_effort) return;
    commit({ reasoning_effort: reasoningEffort });
  }, [canThink, models, reasoningEffort, settings.model, settings.reasoning_effort]);

  function commit(next) {
    const merged = { ...settings, ...next };
    setSettings(merged);
    onPersist(merged);
  }

  function commitMaxTokensDraft() {
    const parsed = Math.round(Number(maxTokensDraft));
    if (Number.isFinite(parsed) && parsed > 0) {
      commit({ max_tokens: parsed });
    }
    setEditingMaxTokens(false);
  }

  function selectModel(model) {
    commit({
      model: model.id,
      reasoning_effort: resolveReasoningEffort(
        models,
        model.id,
        settings.reasoning_effort,
      ),
      thinking_enabled: model?.reasoning?.mandatory === true
        ? true
        : settings.thinking_enabled,
    });
    onModelSelected(model.name || model.id);
    onClose();
  }

  function setSelectedModelAsDefault() {
    if (!settings.model || settings.model === defaultModel) return;
    onSetDefaultModel(settings.model);
  }

  useEffect(() => {
    if (visibleSettingsPages.some((page) => page.id === activePage)) return;
    setActivePage("general");
  }, [activePage, visibleSettingsPages]);

  function choosePage(pageId) {
    setActivePage(pageId);
  }

  function toggleAccordion(id) {
    setOpenAccordions((current) => ({
      ...current,
      [id]: !current[id],
    }));
  }

  function handleChatListScroll(event) {
    updateChatListEdges(event.currentTarget);
  }

  function handleModelSearchChange(event) {
    setQuery(event.target.value);
  }

  async function exportChats() {
    if (!cloudChatId) return;
    setExporting(true);
    try {
      await onExportChats(cloudChatId, cloudChat);
    } catch (error) {
      onNotify(error.message || "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function importChats(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await onImportChats(payload);
    } catch (error) {
      onNotify(error.message || "Import failed");
    } finally {
      setImporting(false);
    }
  }

  const StatusDot = (
    <span
      aria-label={keyConnected ? "OpenRouter key connected" : "OpenRouter key not set"}
      title={keyConnected ? "OpenRouter key connected" : "OpenRouter key not set"}
      className={cx(
        "relative top-px inline-block h-2 w-2 rounded-full",
        keyConnected
          ? "bg-emerald-300 shadow-[0_0_0_3px_rgba(110,231,183,0.12)]"
          : "bg-rose-400 shadow-[0_0_0_3px_rgba(251,113,133,0.12)]",
      )}
    />
  );

  const keySection = (
    <section className="border-b border-white/[0.08] pb-3">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-balance text-sm font-semibold text-neutral-100">
          OpenRouter key
          {StatusDot}
        </h2>
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-or-v1-..."
          className="h-10 min-w-0 flex-1 rounded-xl bg-black/20 px-3 text-sm text-neutral-100 shadow-[var(--shadow-border)] outline-none transition-[background-color,box-shadow] duration-150 ease-out placeholder:text-neutral-600 focus:bg-black/25 focus:shadow-[0_0_0_1px_rgba(255,255,255,0.16)]"
        />
        <button
          type="button"
          onClick={saveKey}
          disabled={saving || !apiKey.trim()}
          className={cx(
            "h-10 rounded-xl bg-neutral-100 px-3 text-sm font-semibold text-neutral-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500 disabled:shadow-[var(--shadow-border)] disabled:active:scale-100",
            CONTROL_MOTION,
          )}
        >
          {saving ? "Saving" : "Save"}
        </button>
      </div>
    </section>
  );

  const chatNameSection = (
    <section className="border-b border-white/[0.08] py-3">
      <SettingRow
        title="Generate chat name"
        description="Let the model name chats"
      >
        <SettingSwitch
          checked={generateChatName}
          onChange={onToggleGenerateChatName}
          label="Generate chat name"
        />
      </SettingRow>
    </section>
  );

  const modelFilterSection = (
    <section className="border-b border-white/[0.08] py-3">
      <SettingRow
        title="Disable free models"
        description="Don't show free OpenRouter models in the model picker"
      >
        <SettingSwitch
          checked={hideFreeModels}
          onChange={onToggleHideFreeModels}
          label="Hide free models"
        />
      </SettingRow>
    </section>
  );

  const turboSection = (
    <section className="border-b border-white/[0.08] py-3">
      <SettingRow title="Turbo" description="Prioritize the fastest OpenRouter providers">
        <SettingSwitch checked={nitroMode} onChange={onToggleNitroMode} label="Turbo" />
      </SettingRow>
    </section>
  );

  const cheapestSection = (
    <section className="border-b border-white/[0.08] py-3">
      <SettingRow
        title="Cheapest first"
        description="Prioritize the lowest priced OpenRouter providers"
      >
        <SettingSwitch
          checked={cheapestMode}
          onChange={onToggleCheapestMode}
          label="Cheapest first"
        />
      </SettingRow>
    </section>
  );

  const privacySection = (
    <section className="border-b border-white/[0.08] py-3">
      <SettingRow
        title="Privacy mode"
        description={
          zdrMode
            ? "Already covered by zero data retention"
            : "Skip providers that may keep your prompts for training"
        }
      >
        <SettingSwitch
          checked={privacyMode || zdrMode}
          onChange={onTogglePrivacyMode}
          label="Privacy mode"
          disabled={zdrMode}
        />
      </SettingRow>
    </section>
  );

  const zdrSection = (
    <section className="py-3">
      <SettingRow
        title="Zero data retention"
        description="Only use providers that store nothing at all. Fewer models available"
      >
        <SettingSwitch
          checked={zdrMode}
          onChange={onToggleZdrMode}
          label="Zero data retention"
        />
      </SettingRow>
    </section>
  );

  const smoothTextSection = (
    <section className="py-3">
      <SettingRow title="Smooth text" description="Resolve model responses in a word at a time">
        <SettingSwitch
          checked={smoothStreaming}
          onChange={onToggleSmoothStreaming}
          label="Smooth text"
        />
      </SettingRow>
    </section>
  );

  const promptNavigationSection = (
    <section className="border-b border-white/[0.08] py-3">
      <SettingRow
        title="Navigation bar"
        description="Show a navigation bar for easily navigating long chats"
      >
        <SettingSwitch
          checked={showPromptNavigationRail}
          onChange={onTogglePromptNavigationRail}
          label="Navigation bar"
        />
      </SettingRow>
    </section>
  );

  const systemSection = (
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-balance text-sm font-semibold text-neutral-100">
            {promptModeName} system prompt
          </h2>
          {settings.system_prompt && (
            <button
              type="button"
              onClick={() => {
                updateSetting({ system_prompt: "" });
                onPersist({ ...settings, system_prompt: "" });
              }}
              className={cx(
                "flex shrink-0 items-center gap-1 rounded-full bg-white/[0.055] px-2 py-0.5 text-[11px] font-medium leading-normal text-neutral-400 shadow-[var(--shadow-border)] hover:bg-white/[0.085] hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                CONTROL_MOTION,
              )}
            >
              <X size={11} strokeWidth={2.2} />
              Clear
            </button>
          )}
        </div>
        <p className="mt-0.5 mb-3 text-pretty text-xs leading-5 text-neutral-500">
          {promptModeName === "Write"
            ? "Optional instructions sent before every write-mode message. Chat mode has its own system prompt."
            : "Optional instructions sent before every chat-mode message. Write mode has its own system prompt."}
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <div className="prompt-edit-surface h-full w-full rounded-[22px] px-4 py-3">
          <textarea
            value={settings.system_prompt}
            onChange={(event) => updateSetting({ system_prompt: event.target.value })}
            onBlur={() => onPersist(settings)}
            placeholder={`No ${promptModeName.toLowerCase()} system prompt`}
            data-1p-ignore="true"
            className="block h-full w-full resize-none overflow-y-auto bg-transparent text-sm leading-6 text-neutral-100 outline-none placeholder:text-neutral-500"
          />
        </div>
      </div>
    </section>
  );

  const importExportSection = (
    <section className="flex h-full min-h-0 flex-col">
      <section className="flex min-h-0 flex-1 flex-col px-1 py-3">
        <h2 className="shrink-0 text-balance text-sm font-semibold text-neutral-100">
          Select Chat
        </h2>
        <div className="mt-2 shrink-0">
          <SearchClearField
            value={cloudSearch}
            onChange={setCloudSearch}
            placeholder="Search chats"
          />
        </div>
        <div className="relative mt-2 min-h-0 flex-1">
          <div
            ref={chatListRef}
            onScroll={handleChatListScroll}
            className="settings-chat-list h-full space-y-1 overflow-y-auto"
          >
              {filteredCloudChats.length === 0 ? (
                <div className="grid min-h-10 w-full grid-cols-[18px_minmax(0,1fr)_14px] items-center gap-2 rounded-xl bg-black/15 px-3 py-3 text-pretty text-xs leading-5 text-neutral-500 shadow-[var(--shadow-border)]">
                  <span className="col-start-2 min-w-0">
                    {chats.length === 0 ? "No chats yet." : "No matching chats."}
                  </span>
                </div>
              ) : (
                filteredCloudChats.map((chat) => {
                  const selected = chat.id === cloudChatId;
                  return (
                    <button
                      key={chat.id}
                      type="button"
                      onClick={() => setSelectedCloudChatId(chat.id)}
                      className={cx(
                        "grid min-h-10 w-full grid-cols-[18px_minmax(0,1fr)_14px] items-center gap-2 rounded-xl px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                        CONTROL_MOTION,
                        selected
                          ? "bg-white/[0.065] text-neutral-100 shadow-[var(--shadow-border)]"
                          : "text-neutral-300 hover:bg-white/[0.035] hover:text-neutral-100",
                      )}
                    >
                      <span className="col-start-2 min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {chat.title}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-neutral-500">
                          {promptModelName(models, chat.model)}
                        </span>
                      </span>
                      <Check
                        size={14}
                        aria-hidden="true"
                        className={cx(
                          "col-start-3 justify-self-end text-neutral-200",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </button>
                  );
                })
              )}
          </div>
          <div
            aria-hidden="true"
            className={cx(
              "settings-list-fade pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-[#202020]/95 to-transparent transition-opacity duration-150 ease-out",
              chatListScrolled ? "opacity-100" : "opacity-0",
            )}
          />
          <div
            aria-hidden="true"
            className={cx(
              "settings-list-fade pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-[#202020]/95 to-transparent transition-opacity duration-150 ease-out",
              chatListHasMoreBelow ? "opacity-100" : "opacity-0",
            )}
          />
          </div>
      </section>

      <section className="shrink-0 pb-1 pt-3">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={exporting || importing || !cloudChatId}
            onClick={exportChats}
            className={cx(
              "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/[0.055] px-3 text-xs font-semibold text-neutral-100 shadow-[var(--shadow-border)] hover:bg-white/[0.085] hover:shadow-[var(--shadow-border-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:text-neutral-600 disabled:opacity-60 disabled:active:scale-100",
              CONTROL_MOTION,
            )}
          >
            <i className="fi fi-rr-download text-[13px] leading-none" aria-hidden="true" />
            {exporting ? "Exporting" : "Export"}
          </button>

          <button
            type="button"
            disabled={exporting || importing}
            onClick={() => fileInputRef.current?.click()}
            className={cx(
              "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/[0.055] px-3 text-xs font-semibold text-neutral-100 shadow-[var(--shadow-border)] hover:bg-white/[0.085] hover:shadow-[var(--shadow-border-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:text-neutral-600 disabled:opacity-60 disabled:active:scale-100",
              CONTROL_MOTION,
            )}
          >
            <i className="fi fi-rr-cloud-upload-alt text-[13px] leading-none" aria-hidden="true" />
            {importing ? "Importing" : "Import"}
          </button>
        </div>
      </section>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={importChats}
      />
    </section>
  );

  const modelList = (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-balance text-sm font-semibold text-neutral-100">
            Model
            {modelLocked && (
              <span className="inline-flex min-h-6 items-center rounded-full bg-white/[0.04] px-2 text-[11px] font-medium text-neutral-500 shadow-[var(--shadow-border)]">
                Model locked
              </span>
            )}
          </h2>
          <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-neutral-500">
            <span className="truncate">{selectedModel?.name || settings.model}</span>
            {selectedModelPrice && (
              <span className="inline-flex min-h-5 shrink-0 items-center rounded-full bg-white/[0.055] px-2 text-[11px] font-medium leading-none tabular-nums text-neutral-500 shadow-[var(--shadow-border)]">
                {selectedModelPrice}
              </span>
            )}
            <button
              type="button"
              disabled={!settings.model || settings.model === defaultModel}
              onClick={setSelectedModelAsDefault}
              className={cx(
                "inline-flex min-h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium leading-none shadow-[var(--shadow-border)] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-default disabled:active:scale-100",
                CONTROL_MOTION,
                settings.model === defaultModel
                  ? "bg-white/[0.045] text-neutral-500"
                  : "bg-white/[0.065] text-neutral-300 hover:bg-white/[0.1] hover:text-neutral-100",
              )}
            >
              {settings.model === defaultModel ? "Default" : "Set default"}
            </button>
          </p>
        </div>
      </div>

      <ModelPicker
        models={filteredModels}
        query={query}
        onQueryChange={setQuery}
        selectedId={settings.model}
        onSelect={(modelId) => {
          const model = models.find((entry) => entry.id === modelId);
          if (model) selectModel(model);
        }}
        emptyMessage={models.length === 0 ? "Save an API key to load models." : "No matching models."}
        disabled={modelLocked}
        activePage={activePage}
        searchWrapRef={modelSearchWrapRef}
        searchInputRef={modelSearchInputRef}
        note={modelLocked && (
          <p className="mt-2 text-pretty text-xs leading-5 text-neutral-600">
            Model selection is locked after the first message in a chat.
          </p>
        )}
      />
    </section>
  );

  const lorebookSection = (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-balance text-sm font-semibold text-neutral-100">Lorebook model</h2>
          <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-neutral-500">
            <span className="truncate">{lorebookModel?.name || lorebookModelId}</span>
            {lorebookModelPrice && (
              <span className="inline-flex min-h-5 shrink-0 items-center rounded-full bg-white/[0.055] px-2 text-[11px] font-medium leading-none tabular-nums text-neutral-500 shadow-[var(--shadow-border)]">
                {lorebookModelPrice}
              </span>
            )}
            {lorebookModelContext && (
              <span className="inline-flex min-h-5 shrink-0 items-center rounded-full bg-white/[0.055] px-2 text-[11px] font-medium leading-none tabular-nums text-neutral-500 shadow-[var(--shadow-border)]">
                {lorebookModelContext}
              </span>
            )}
            {lorebookInherits && (
              <span className="inline-flex min-h-5 shrink-0 items-center rounded-full bg-white/[0.045] px-2 text-[11px] font-medium leading-none text-neutral-500 shadow-[var(--shadow-border)]">
                Same as global
              </span>
            )}
          </p>
        </div>
      </div>

      <ModelPicker
        models={filteredLorebookModels}
        query={lorebookQuery}
        onQueryChange={setLorebookQuery}
        selectedId={settings.lorebook_model || LOREBOOK_MODEL_INHERIT}
        onSelect={(modelId) => commit({ lorebook_model: modelId })}
        emptyMessage={models.length === 0 ? "Save an API key to load models." : "No matching models."}
        activePage={activePage}
        inheritOption={{
          name: "Same as global",
          subLabel: promptModelName(models, settings.model),
          model: models.find((model) => model.id === settings.model) || null,
        }}
      />
    </section>
  );

  const reasoningSection = (
    <Accordion
      id="reasoning"
      title="Reasoning"
      open={openAccordions.reasoning}
      onToggle={toggleAccordion}
      trailing={!canThink ? "Unavailable" : null}
    >
      <SlidingTabs
        options={REASONING_EFFORTS}
        value={reasoningEffort}
        onChange={(value) => commit({ reasoning_effort: value })}
        getValue={(effort) => effort.value}
        getLabel={(effort) => effort.shortLabel || effort.label}
        isOptionDisabled={(effort) => !supportsReasoningEffort(
          models,
          settings.model,
          effort.value,
        )}
        ariaLabel="Reasoning effort"
        disabled={!canThink}
        className="reasoning-tabs w-full"
      />
    </Accordion>
  );

  const generationSection = (
    <Accordion
      id="generation"
      title="Generation"
      open={openAccordions.generation}
      onToggle={toggleAccordion}
    >
      <div className="space-y-3">
        <div className="settings-slider-row">
          <div className="mb-2.5 flex items-center justify-between text-xs font-medium">
            <span className="text-neutral-400">Temperature</span>
            <span className="min-w-9 rounded-full bg-white/[0.055] px-2 py-0.5 text-center tabular-nums text-neutral-200 shadow-[var(--shadow-border)]">
              {settings.temperature}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.1"
            value={settings.temperature}
            onChange={(event) => updateSetting({ temperature: Number(event.target.value) })}
            onMouseUp={() => onPersist(settings)}
            onTouchEnd={() => onPersist(settings)}
            style={{ "--range-progress": rangeProgress(settings.temperature, 0, 1.5) }}
            className="settings-range"
          />
        </div>
        <div className="settings-slider-row">
          <div className="mb-2.5 flex items-center justify-between text-xs font-medium">
            <span className="text-neutral-400">Max output tokens</span>
            <div className="flex items-center gap-1.5">
              <span className="max-w-[220px] truncate rounded-full bg-white/[0.055] px-2 py-0.5 text-[11px] font-medium leading-normal tabular-nums text-neutral-500 shadow-[var(--shadow-border)]">
                {selectedModelContext
                  ? `${selectedModelOutputName} - ${selectedModelContext}`
                  : selectedModelOutputName}
              </span>
              {editingMaxTokens ? (
                <input
                  type="text"
                  autoFocus
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={maxTokensDraft}
                  data-1p-ignore="true"
                  onChange={(event) => {
                    const digitsOnly = event.target.value.replace(/[^0-9]/g, "");
                    setMaxTokensDraft(digitsOnly);
                  }}
                  onBlur={commitMaxTokensDraft}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitMaxTokensDraft();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingMaxTokens(false);
                    }
                  }}
                  className="w-16 shrink-0 rounded-full bg-white/[0.08] px-2 py-0.5 text-center tabular-nums text-neutral-100 shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setMaxTokensDraft(String(settings.max_tokens));
                    setEditingMaxTokens(true);
                  }}
                  className={cx(
                    "w-16 shrink-0 rounded-full bg-white/[0.055] px-2 py-0.5 text-center tabular-nums text-neutral-200 shadow-[var(--shadow-border)] hover:bg-white/[0.085] hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                    CONTROL_MOTION,
                  )}
                >
                  {settings.max_tokens}
                </button>
              )}
            </div>
          </div>
          <input
            type="range"
            min="1000"
            max="128000"
            step="1000"
            value={settings.max_tokens}
            onChange={(event) => updateSetting({ max_tokens: Number(event.target.value) })}
            onMouseUp={() => onPersist(settings)}
            onTouchEnd={() => onPersist(settings)}
            style={{ "--range-progress": rangeProgress(settings.max_tokens, 1000, 128000) }}
            className="settings-range"
          />
        </div>
      </div>
    </Accordion>
  );

  return (
    <div
      className={cx(
        "modal-interaction-guard fixed inset-0 z-50 grid place-items-center px-3 py-4 sm:px-6",
        !open && "is-inert pointer-events-none",
      )}
      inert={open ? undefined : ""}
    >
      <button
        type="button"
        aria-label="Close settings"
        className={cx(
          "absolute inset-0 bg-black/55 transition-[opacity,backdrop-filter] duration-200 ease-out",
          open ? "pointer-events-auto opacity-100 backdrop-blur-sm" : "pointer-events-none opacity-0 backdrop-blur-none",
        )}
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        aria-hidden={!open}
        className={cx(
          "t-modal settings-modal relative z-10 grid w-full grid-cols-1 overflow-hidden rounded-[18px] bg-[#202020] text-neutral-100 [box-shadow:var(--shadow-surface)] md:grid-cols-[132px_minmax(0,1fr)]",
          activePage === "usage" ? "h-[min(780px,calc(100dvh-2rem))] max-w-[980px]" : "h-[min(400px,calc(100vh-2rem))] max-w-[560px]",
          open ? "is-open" : "is-closing",
        )}
      >
        <aside className="hidden min-h-0 border-r border-white/10 p-2 md:flex md:flex-col">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className={cx(
              "mb-2.5 grid h-10 w-10 place-items-center rounded-xl bg-white/[0.06] text-neutral-100 hover:bg-white/[0.09] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
              CONTROL_MOTION,
            )}
          >
            <X size={20} strokeWidth={1.9} />
          </button>
          <nav className="space-y-1.5 overflow-y-auto" aria-label="Settings sections">
            {visibleSettingsPages.map((page) => {
              const Icon = page.icon;
              const selected = activePage === page.id;
              return (
                <button
                  key={page.id}
                  type="button"
                  onClick={() => choosePage(page.id)}
                  className={cx(
                    "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-medium leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                    CONTROL_MOTION,
                    selected
                      ? "bg-white/[0.08] text-neutral-50"
                      : "text-neutral-200 hover:bg-white/[0.045] hover:text-neutral-50",
                    )}
                >
                  <span
                    className={cx(
                      "settings-nav-icon",
                      page.id === "models" && "-translate-x-0.5",
                    )}
                    aria-hidden="true"
                  >
                    {page.iconClass && (
                      <i className={cx(page.iconClass, "text-[15px] leading-none")} />
                    )}
                    {page.iconSrc && <MaskIcon src={page.iconSrc} size={15} />}
                    {!page.iconClass && !page.iconSrc && <Icon size={15} strokeWidth={1.9} />}
                  </span>
                  <span className="truncate">{page.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col">
          <header className="border-b border-white/10 px-4 py-2.5 md:px-4 md:py-2.5">
            <div className="flex items-center justify-between gap-4">
              <h1
                id="settings-modal-title"
                className="text-lg font-medium tracking-normal text-neutral-50 md:text-xl"
              >
                {visibleSettingsPages.find((page) => page.id === activePage)?.label || "Settings"}
              </h1>
              <div className="md:hidden">
                <IconButton label="Close settings" onClick={onClose}>
                  <X size={17} />
                </IconButton>
              </div>
            </div>
            <SlidingTabs
              options={visibleSettingsPages}
              value={activePage}
              onChange={choosePage}
              getValue={(page) => page.id}
              getLabel={(page) => page.label}
              ariaLabel="Settings sections"
              className="settings-mobile-tabs mt-3 flex w-full md:hidden"
            />
          </header>

          <div
            className="settings-page-slide t-page-slide min-h-0 flex-1"
            data-page={String(activePageIndex)}
          >
            <section
              className="settings-scroll-page t-page space-y-0 overflow-y-auto px-4 py-3 md:px-4 md:py-3"
              data-page-id="1"
              aria-label="API settings"
            >
              {keySection}
              {chatNameSection}
              {modelFilterSection}
              {turboSection}
              {cheapestSection}
              {privacySection}
              {zdrSection}
            </section>
            <section
              className="t-page flex min-h-0 flex-col px-4 py-3 md:px-4 md:py-3"
              data-page-id="2"
              aria-label="Model settings"
            >
              {modelList}
            </section>
            <section
              className="t-page flex min-h-0 flex-col px-4 py-3 md:px-4 md:py-3"
              data-page-id="3"
              aria-label="System settings"
            >
              {systemSection}
            </section>
            <section
              className="settings-scroll-page t-page space-y-0 overflow-y-auto px-4 py-3 md:px-4 md:py-3"
              data-page-id="4"
              aria-label="UI settings"
            >
              {promptNavigationSection}
              {smoothTextSection}
            </section>
            <section
              className="t-page overflow-hidden px-4 py-3 md:px-4 md:py-3"
              data-page-id="5"
              aria-label="Chats settings"
            >
              {importExportSection}
            </section>
            <section
              className="settings-scroll-page t-page space-y-0 overflow-y-auto px-4 py-3 md:px-4 md:py-3"
              data-page-id="6"
              aria-label="Advanced settings"
            >
              {reasoningSection}
              {generationSection}
            </section>
            <section
              className="t-page flex min-h-0 flex-col px-4 py-3 md:px-4 md:py-3"
              data-page-id="7"
              aria-label="Lorebook settings"
            >
              {lorebookSection}
            </section>
            <section
              className="settings-scroll-page t-page overflow-y-auto px-4 py-3"
              data-page-id="8"
              aria-label="Usage settings"
            >
              {open && activePage === "usage" && <UsagePanel models={models} />}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
