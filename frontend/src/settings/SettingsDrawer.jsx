import { TranscriptionSettings } from "../transcription/TranscriptionSettings.jsx";
import { X, Check } from "lucide-react";
import { useState, useRef, useMemo, useEffect } from "react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { supportsThinking, resolveReasoningEffort, supportsReasoningEffort } from "../modelReasoning.js";
import {
  promptModelName,
  priceLabel,
  getModelContextLimit,
  formatTokens,
} from "../modelFormatting.js";
import { searchModels } from "./modelSearch.js";
import { SearchClearField } from "../components/SearchClearField.jsx";
import { ModelPicker } from "./ModelPicker.jsx";
import { LOREBOOK_MODEL_INHERIT } from "./settingsDefaults.js";
import { SlidingTabs } from "../components/SlidingTabs.jsx";
import { UsagePanel } from "./UsagePanel.jsx";
import { useChatSystemPromptAutosave } from "./useChatSystemPromptAutosave.js";
import { useLingeringPage } from "./useLingeringPage.js";
import { DEFAULT_PROVIDER } from "../providers/providerApi.js";
import { PROVIDER_OPTIONS } from "../providers/providerOptions.js";
import { SettingSwitch, SettingRow, SettingGroup, SettingChip } from "./SettingControls.jsx";
import { SettingsNav, SettingsNavToggle } from "./SettingsNav.jsx";
import { SETTINGS_PAGES, pageVisibleInMode, searchSettings } from "./settingsPages.js";
import { SettingsScrollPage, SettingsFixedPage } from "./SettingsScrollPage.jsx";
import { ScrollEdgeBlur, useScrollEdges } from "../components/ScrollEdgeBlur.jsx";

const REASONING_EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];


function rangeProgress(value, min, max) {
  return `${((Number(value) - min) / (max - min)) * 100}%`;
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function SettingsDrawer({
  open,
  onClose,
  keyStatus,
  onSaveKey,
  onSwitchProvider,
  provider = DEFAULT_PROVIDER,
  conversationProvider = provider,
  conversationKind = "chat",
  onMoveToProvider,
  chats,
  activeChatId,
  models,
  chatModels,
  chatMode,
  settings,
  setSettings,
  defaultModel,
  generateChatName,
  hideFreeModels,
  hideBatchModels,
  disablePromptCaching,
  hourPromptCache,
  nitroMode,
  cheapestMode,
  privacyMode,
  zdrMode,
  smoothStreaming,
  showPromptNavigationRail,
  modelLocked,
  onPersist,
  chatSystemPrompt,
  onSaveChatSystemPrompt,
  onModelSelected,
  onSetDefaultModel,
  onToggleGenerateChatName,
  onToggleHideFreeModels,
  onToggleHideBatchModels,
  onToggleDisablePromptCaching,
  onToggleHourPromptCache,
  onToggleNitroMode,
  onToggleCheapestMode,
  onTogglePrivacyMode,
  onToggleZdrMode,
  onToggleSmoothStreaming,
  updateChecks,
  onToggleUpdateChecks,
  onTogglePromptNavigationRail,
  onExportChats,
  onImportChats,
  onNotify,
}) {
  const [apiKey, setApiKey] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState(provider.id);
  const [query, setQuery] = useState("");
  const [lorebookQuery, setLorebookQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedCloudChatId, setSelectedCloudChatId] = useState("");
  const [cloudSearch, setCloudSearch] = useState("");
  const [activePage, setActivePage] = useState("provider");
  const [jump, setJump] = useState({ target: "", count: 0 });
  const [navQuery, setNavQuery] = useState("");
  const [navOpenMobile, setNavOpenMobile] = useState(false);
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
  const temperatureLocked = selectedModel?.temperature === false;
  const keyConnected = Boolean(keyStatus.has_key);
  const providerDiffers = conversationProvider.id !== provider.id;
  const providerName = provider.name;
  const keyPlaceholder = provider.keyPlaceholder;
  const capabilities = provider.capabilities || DEFAULT_PROVIDER.capabilities;
  const activePageIndex = SETTINGS_PAGES.findIndex((page) => page.id === activePage) + 1;
  const selectedCloudChat = chats.find((chat) => chat.id === selectedCloudChatId);
  const activeCloudChat = chats.find((chat) => chat.id === activeChatId);
  const cloudChat = selectedCloudChat || activeCloudChat || chats[0];
  const cloudChatId = cloudChat?.id || "";
  const chatPrompt = useChatSystemPromptAutosave({
    value: chatSystemPrompt,
    onSave: onSaveChatSystemPrompt,
    active: open && chatMode === "chat",
    resetKey: chatMode,
  });
  const chatPromptSaveLabel = chatPrompt.saveState.replace(/\b\w/g, (letter) => letter.toUpperCase());

  const visibleSettingsPages = useMemo(
    () => SETTINGS_PAGES.filter((page) => pageVisibleInMode(page, chatMode)),
    [chatMode],
  );
  const activePageLabel = visibleSettingsPages.find((page) => page.id === activePage)?.label || "Settings";

  const filteredCloudChats = useMemo(() => {
    const normalized = cloudSearch.trim().toLowerCase();
    if (!normalized) return chats;
    return chats.filter((chat) => (
      [chat.title, promptModelName(chatModels, chat.model)]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalized))
    ));
  }, [chats, cloudSearch, chatModels]);

  const filteredModels = useMemo(
    () => searchModels(models, query, { hideFree: hideFreeModels, hideBatch: hideBatchModels }),
    [hideBatchModels, hideFreeModels, models, query],
  );

  const filteredLorebookModels = useMemo(
    () => searchModels(models, lorebookQuery, { hideFree: hideFreeModels, hideBatch: hideBatchModels }),
    [hideBatchModels, hideFreeModels, lorebookQuery, models],
  );

  const lorebookInherits = !settings.lorebook_model;
  const lorebookModelId = settings.lorebook_model || settings.model;
  const lorebookModel = models.find((model) => model.id === lorebookModelId);
  const lorebookModelPrice = lorebookModel ? priceLabel(lorebookModel) : "";
  const lorebookModelContextLimit = getModelContextLimit(lorebookModel);
  const lorebookModelContext = Number.isFinite(lorebookModelContextLimit)
    ? `${formatTokens(lorebookModelContextLimit)} context`
    : "";

  const searchResults = useMemo(
    () => searchSettings(navQuery, { pages: visibleSettingsPages, capabilities }),
    [capabilities, navQuery, visibleSettingsPages],
  );

  function pageTitle(pageId) {
    return SETTINGS_PAGES.find((page) => page.id === pageId)?.label || "";
  }

  const chatListEdges = useScrollEdges(chatListRef, [filteredCloudChats.length, activePage]);

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

  function chooseProvider(providerId) {
    setSelectedProviderId(providerId);
    setApiKey("");

    if (providerId !== provider.id) onSwitchProvider?.(providerId);
  }

  useEffect(() => {
    setSelectedProviderId(provider.id);
  }, [provider.id]);

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
    onModelSelected(promptModelName(models, model.id));
  }

  function setSelectedModelAsDefault() {
    if (providerDiffers || !settings.model || settings.model === defaultModel) return;
    onSetDefaultModel(settings.model);
  }

  useEffect(() => {
    if (visibleSettingsPages.some((page) => page.id === activePage)) return;
    setActivePage("provider");
  }, [activePage, visibleSettingsPages]);

  const voicePage = useLingeringPage(open, activePage === "voice");
  const usagePage = useLingeringPage(open, activePage === "usage");

  useEffect(() => {
    if (!open) return undefined;

    function handleKeyDown(event) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (navOpenMobile) {
        setNavOpenMobile(false);
        return;
      }
      onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, navOpenMobile]);

  useEffect(() => {
    if (!open) setNavOpenMobile(false);
  }, [open]);

  useEffect(() => {
    if (!jump.target) return undefined;

    const target = document.getElementById(jump.target);
    if (!target) return undefined;

    const frame = requestAnimationFrame(() => {
      const scroller = target.closest(".settings-scroll-page");
      scroller?.scrollTo({
        top: Math.max(0, target.offsetTop - 20),
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      target.classList.add("is-flash");
    });
    const timer = window.setTimeout(() => target.classList.remove("is-flash"), 1400);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      target.classList.remove("is-flash");
    };
  }, [jump]);

  function choosePage(pageId) {
    setActivePage(pageId);
    setNavOpenMobile(false);
  }

  function chooseSearchResult(result) {
    setActivePage(result.page);
    setJump((current) => ({ target: result.target || "", count: current.count + 1 }));
    setNavOpenMobile(false);
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

  const fieldClass = "h-10 min-w-0 flex-1 rounded-full bg-white/[0.045] px-4 text-sm text-neutral-100 outline-none ring-1 ring-inset ring-white/[0.07] transition-[background-color,box-shadow] duration-150 ease-out placeholder:text-neutral-500 focus:bg-white/[0.06] focus:ring-white/[0.18]";

  const primaryButtonClass = cx(
    "h-10 shrink-0 rounded-full bg-neutral-100 px-5 text-sm font-semibold text-neutral-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:cursor-not-allowed disabled:bg-white/[0.05] disabled:text-[#6b6b6b] disabled:active:scale-100",
    CONTROL_MOTION,
  );

  const secondaryButtonClass = cx(
    "flex h-9 items-center justify-center gap-2 rounded-full bg-white/[0.06] px-4 text-[13px] font-medium text-neutral-300 hover:bg-white/[0.1] hover:text-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-[#6b6b6b] disabled:active:scale-100",
    CONTROL_MOTION,
  );

  const smallPillButtonClass = cx(
    "inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-default disabled:active:scale-100",
    CONTROL_MOTION,
  );

  const keyStatusPill = (
    <span
      className={cx(
        "inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium leading-none",
        keyConnected
          ? "bg-emerald-300/[0.1] text-[#6ee7b7]"
          : "bg-red-500/[0.14] text-[#fca5a5]",
      )}
    >
      <span
        aria-hidden="true"
        className={cx("h-1.5 w-1.5 rounded-full", keyConnected ? "bg-[#6ee7b7]" : "bg-[#fca5a5]")}
      />
      {keyConnected ? "Key saved" : "No key"}
    </span>
  );

  const accountGroup = (
    <SettingGroup
      id="settings-group-account"
      title="Account"
    >
      <SettingRow title="Provider" description="Where your messages are sent" stacked>
        <SlidingTabs
          options={PROVIDER_OPTIONS}
          value={selectedProviderId}
          onChange={chooseProvider}
          getValue={(option) => option.id}
          getLabel={(option) => option.tabLabel}
          ariaLabel="API provider"
          className="provider-tabs settings-inner-tabs flex w-full"
        />
      </SettingRow>
      <div className="settings-row space-y-3 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-balance text-[14.5px] font-medium text-neutral-50">{providerName} key</h3>
          {keyStatusPill}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveKey();
          }}
        >
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={keyConnected ? "Paste a new key to replace it" : keyPlaceholder}
            aria-label={`${providerName} key`}
            className={fieldClass}
          />
          <button
            type="submit"
            disabled={saving || !apiKey.trim()}
            className={primaryButtonClass}
          >
            {saving ? "Saving" : "Save"}
          </button>
        </form>
      </div>
    </SettingGroup>
  );

  const cachingGroup = (
    <SettingGroup
      id="settings-group-caching"
      title="Prompt caching"
    >
      <SettingRow
        title="Disable prompt caching"
        description="Don't cache chats and stories to save on repeat tokens"
      >
        <SettingSwitch
          checked={disablePromptCaching}
          onChange={onToggleDisablePromptCaching}
          label="Disable prompt caching"
        />
      </SettingRow>
      <SettingRow
        title="Keep cache for 1 hour"
        description="Cached prompts last an hour instead of 5 minutes. Saving to the cache costs a bit more, reusing it stays cheap"
      >
        <SettingSwitch
          checked={hourPromptCache && !disablePromptCaching}
          onChange={onToggleHourPromptCache}
          label="Keep cache for 1 hour"
          disabled={disablePromptCaching}
        />
      </SettingRow>
    </SettingGroup>
  );

  const routingGroup = (
    <SettingGroup id="settings-group-routing" title="Routing">
      <SettingRow title="Turbo" description={`Prioritize the fastest ${providerName} providers`}>
        <SettingSwitch checked={nitroMode} onChange={onToggleNitroMode} label="Turbo" />
      </SettingRow>
      <SettingRow
        title="Cheapest first"
        description={`Prioritize the lowest priced ${providerName} providers`}
      >
        <SettingSwitch
          checked={cheapestMode}
          onChange={onToggleCheapestMode}
          label="Cheapest first"
        />
      </SettingRow>
    </SettingGroup>
  );

  const privacyGroup = (
    <SettingGroup
      id="settings-group-privacy"
      title="Privacy"
    >
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
    </SettingGroup>
  );

  const modelFiltersGroup = (
    <SettingGroup
      id="settings-group-model-filters"
      title="Model list"
      bodyClassName={capabilities.freeModels ? "settings-group-split" : undefined}
    >
      {capabilities.freeModels && (
        <SettingRow title="Hide free models" compact>
          <SettingSwitch
            checked={hideFreeModels}
            onChange={onToggleHideFreeModels}
            label="Hide free models"
            small
          />
        </SettingRow>
      )}
      <SettingRow title="Hide batch models" compact>
        <SettingSwitch
          checked={hideBatchModels}
          onChange={onToggleHideBatchModels}
          label="Hide batch models"
          small
        />
      </SettingRow>
    </SettingGroup>
  );

  const modelsSection = (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-5 min-w-0">
        <p className="mb-1 text-[13px] font-semibold text-neutral-400">Current model</p>
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-lg font-semibold tracking-[-0.01em] text-neutral-50">
            {selectedModel?.name || settings.model || "No model selected"}
          </h2>
          {modelLocked && <SettingChip className="text-neutral-500">Model locked</SettingChip>}
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          {selectedModelPrice && <SettingChip>{selectedModelPrice}</SettingChip>}
          {selectedModelContext && <SettingChip>{selectedModelContext}</SettingChip>}
          <button
            type="button"
            disabled={providerDiffers || !settings.model || settings.model === defaultModel}
            onClick={setSelectedModelAsDefault}
            className={cx(
              smallPillButtonClass,
              settings.model === defaultModel
                ? "bg-white/[0.045] text-neutral-500"
                : "bg-white/[0.08] text-neutral-200 hover:bg-white/[0.12] hover:text-neutral-50",
            )}
          >
            {settings.model === defaultModel ? "Default" : "Set as default"}
          </button>
        </div>
      </div>

      {providerDiffers && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-2xl bg-[#fde68a]/[0.08] px-4 py-3">
          <p className="min-w-0 text-pretty text-[12.5px] leading-5 text-[#fde68a]/90">
            This {conversationKind} uses {conversationProvider.name}, not {provider.name}.
          </p>
          {onMoveToProvider && (
            <button
              type="button"
              onClick={onMoveToProvider}
              className={cx(secondaryButtonClass, "h-8 shrink-0 px-3 text-xs")}
            >
              Move to {provider.name}
            </button>
          )}
        </div>
      )}

      <div className="mb-5 shrink-0">{modelFiltersGroup}</div>

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
          <p className="mt-2 text-pretty text-xs leading-5 text-[#8a8a8a]">
            Model selection is locked after the first message in a chat.
          </p>
        )}
      />
    </section>
  );

  const reasoningGroup = (
    <SettingGroup
      id="settings-group-reasoning"
      title="Reasoning"
    >
      <SettingRow
        title="Reasoning effort"
        description={canThink
          ? "Higher effort means more thoughtful responses, but takes longer and costs more."
          : `${selectedModelOutputName || "This model"} doesn't support reasoning`}
        stacked
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
          className="settings-inner-tabs flex w-full"
        />
      </SettingRow>
    </SettingGroup>
  );

  const outputGroup = (
    <SettingGroup id="settings-group-output" title="Output">
      <div className="settings-row px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[14.5px] font-medium text-neutral-50">Temperature</h3>
            <p className="mt-1 text-pretty text-[13px] leading-5 text-[#8a8a8a]">
              {temperatureLocked
                ? `${selectedModelOutputName} picks its own temperature`
                : "Low is predictable, high is more creative"}
            </p>
          </div>
          <span className="settings-value-chip">
            {temperatureLocked ? "Auto" : settings.temperature}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="1.5"
          step="0.1"
          value={settings.temperature}
          aria-label="Temperature"
          onChange={(event) => updateSetting({ temperature: Number(event.target.value) })}
          onMouseUp={() => onPersist(settings)}
          onTouchEnd={() => onPersist(settings)}
          style={{ "--range-progress": rangeProgress(settings.temperature, 0, 1.5) }}
          disabled={temperatureLocked}
          className={cx("settings-range", temperatureLocked && "cursor-not-allowed opacity-40")}
        />
      </div>
      <div className="settings-row px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[14.5px] font-medium text-neutral-50">Max output tokens</h3>
            <p className="mt-1 truncate text-[13px] leading-5 tabular-nums text-[#8a8a8a]">
              {selectedModelContext
                ? `${selectedModelOutputName} has ${selectedModelContext}`
                : selectedModelOutputName}
            </p>
          </div>
          {editingMaxTokens ? (
            <input
              type="text"
              autoFocus
              inputMode="numeric"
              pattern="[0-9]*"
              value={maxTokensDraft}
              aria-label="Max output tokens"
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
              className="settings-value-chip w-20 bg-white/[0.1] outline-none ring-1 ring-inset ring-white/[0.18]"
            />
          ) : (
            <button
              type="button"
              title="Type an exact number"
              onClick={() => {
                setMaxTokensDraft(String(settings.max_tokens));
                setEditingMaxTokens(true);
              }}
              className={cx(
                "settings-value-chip w-20 hover:bg-white/[0.1] hover:text-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                CONTROL_MOTION,
              )}
            >
              {settings.max_tokens}
            </button>
          )}
        </div>
        <input
          type="range"
          min="1000"
          max="128000"
          step="1000"
          value={settings.max_tokens}
          aria-label="Max output tokens slider"
          onChange={(event) => updateSetting({ max_tokens: Number(event.target.value) })}
          onMouseUp={() => onPersist(settings)}
          onTouchEnd={() => onPersist(settings)}
          style={{ "--range-progress": rangeProgress(settings.max_tokens, 1000, 128000) }}
          className="settings-range"
        />
      </div>
    </SettingGroup>
  );

  const systemPromptGroup = (
    <SettingGroup
      id="settings-group-system-prompt"
      title="System prompt"
      note="Sent before every message in every chat. Write mode has its own system prompt."
      trailing={(
        <div className="flex items-center gap-1.5">
          <span
            aria-live="polite"
            className={cx(
              "inline-flex min-h-6 items-center rounded-full px-2.5 text-[11.5px] font-medium leading-none",
              chatPrompt.saveState === "save failed"
                ? "bg-red-500/[0.14] text-[#fca5a5]"
                : chatPrompt.saveState === "saving" || chatPrompt.saveState === "unsaved"
                  ? "bg-white/[0.05] text-neutral-400"
                  : "bg-emerald-300/[0.1] text-[#6ee7b7]",
            )}
          >
            {chatPromptSaveLabel}
          </span>
          {chatPrompt.draft && (
            <button
              type="button"
              onClick={() => chatPrompt.updateDraft("")}
              className={cx(
                smallPillButtonClass,
                "bg-white/[0.06] text-neutral-400 hover:bg-white/[0.1] hover:text-neutral-100",
              )}
            >
              <X size={11} strokeWidth={2.2} aria-hidden="true" />
              Clear
            </button>
          )}
        </div>
      )}
    >
      <textarea
        value={chatPrompt.draft}
        onChange={(event) => chatPrompt.updateDraft(event.target.value)}
        onBlur={chatPrompt.saveNow}
        placeholder="No chat system prompt"
        aria-label="Chat system prompt"
        data-1p-ignore="true"
        className="settings-prompt-field block w-full resize-none overflow-y-auto rounded-2xl bg-transparent px-5 py-4 text-sm leading-6 text-neutral-100 outline-none placeholder:text-neutral-500"
      />
    </SettingGroup>
  );

  const chatsGroup = (
    <SettingGroup id="settings-group-chats" title="Chats">
      <SettingRow title="Generate chat name" description="Let the model name chats">
        <SettingSwitch
          checked={generateChatName}
          onChange={onToggleGenerateChatName}
          label="Generate chat name"
        />
      </SettingRow>
    </SettingGroup>
  );

  const lorebookSection = (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-5 shrink-0">
        <SettingGroup id="settings-group-lorebook" title="Lorebook">
          <SettingRow
            title="Retry skipped edits"
            description="Make one follow-up call to fix lorebook edits that did not apply"
          >
            <SettingSwitch
              checked={settings.lorebook_retry !== false}
              onChange={(value) => commit({ lorebook_retry: value })}
              label="Retry skipped edits"
            />
          </SettingRow>
        </SettingGroup>
      </div>

      <div className="mb-3 min-w-0">
        <h2 className="text-[13px] font-semibold text-neutral-400">Lorebook model</h2>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="mr-1 truncate text-sm font-medium text-neutral-100">
            {lorebookModel?.name || lorebookModelId}
          </span>
          {lorebookModelPrice && <SettingChip>{lorebookModelPrice}</SettingChip>}
          {lorebookModelContext && <SettingChip>{lorebookModelContext}</SettingChip>}
          {lorebookInherits && <SettingChip className="text-neutral-500">Same as global</SettingChip>}
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

  const displayGroup = (
    <SettingGroup id="settings-group-display" title="Display">
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
      <SettingRow title="Smooth text" description="Resolve model responses in a word at a time">
        <SettingSwitch
          checked={smoothStreaming}
          onChange={onToggleSmoothStreaming}
          label="Smooth text"
        />
      </SettingRow>
    </SettingGroup>
  );

  const updatesGroup = (
    <SettingGroup id="settings-group-updates" title="Updates">
      <SettingRow
        title="Check for updates"
        description="Look for a new RouterChat release on GitHub each time the app starts. This only shows a dot next to the version number. Nothing is downloaded or installed automatically, and RouterChat never sends usage data."
      >
        <SettingSwitch
          checked={updateChecks}
          onChange={onToggleUpdateChecks}
          label="Check for updates"
        />
      </SettingRow>
    </SettingGroup>
  );

  const chatTransferSection = (
    <section className="flex h-full min-h-0 flex-col">
      <SettingGroup
        id="settings-group-transfer"
        title="Export or import a chat"
        className="flex min-h-0 flex-initial flex-col"
        bodyClassName="flex min-h-0 flex-initial flex-col p-2"
      >
        <div className="shrink-0 p-1">
          <SearchClearField
            value={cloudSearch}
            onChange={setCloudSearch}
            placeholder="Search chats"
          />
        </div>
        <div className="relative mt-1 flex min-h-0 flex-initial flex-col">
          <div
            ref={chatListRef}
            className="settings-chat-list min-h-0 flex-initial space-y-0.5 overflow-y-auto"
          >
            {filteredCloudChats.length === 0 ? (
              <p className="px-3 py-6 text-center text-pretty text-[12.5px] leading-5 text-[#8a8a8a]">
                {chats.length === 0 ? "No chats yet. Start one and it will show up here." : "No chats match that search."}
              </p>
            ) : (
              filteredCloudChats.map((chat) => {
                const selected = chat.id === cloudChatId;
                return (
                  <button
                    key={chat.id}
                    type="button"
                    onClick={() => setSelectedCloudChatId(chat.id)}
                    aria-pressed={selected}
                    className={cx(
                      "grid min-h-11 w-full grid-cols-[minmax(0,1fr)_16px] items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/20 active:bg-white/[0.09]",
                      selected
                        ? "bg-white/[0.07] text-neutral-50"
                        : "text-neutral-300 hover:bg-white/[0.04] hover:text-neutral-100",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{chat.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-[#8a8a8a]">
                        {promptModelName(chatModels, chat.model)}
                      </span>
                    </span>
                    <Check
                      size={15}
                      aria-hidden="true"
                      className={cx("text-neutral-200", selected ? "opacity-100" : "opacity-0")}
                    />
                  </button>
                );
              })
            )}
          </div>
          <ScrollEdgeBlur edge="top" visible={chatListEdges.top} size={28} />
          <ScrollEdgeBlur edge="bottom" visible={chatListEdges.bottom} size={36} />
        </div>
      </SettingGroup>

      <div className="flex shrink-0 items-center justify-center gap-2 pt-4">
        <button
          type="button"
          disabled={exporting || importing || !cloudChatId}
          onClick={exportChats}
          className={secondaryButtonClass}
        >
          <i className="fi fi-rr-download text-[13px] leading-none" aria-hidden="true" />
          {exporting ? "Exporting" : "Export"}
        </button>
        <button
          type="button"
          disabled={exporting || importing}
          onClick={() => fileInputRef.current?.click()}
          className={secondaryButtonClass}
        >
          <i className="fi fi-rr-cloud-upload-alt text-[13px] leading-none" aria-hidden="true" />
          {importing ? "Importing" : "Import"}
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={importChats}
      />
    </section>
  );

  return (
    <div
      className={cx(
        "modal-interaction-guard settings-page fixed inset-0 z-50 bg-[#080808]",
        open ? "is-open" : "is-closing is-inert pointer-events-none",
      )}
      inert={open ? undefined : ""}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={activePageLabel}
        aria-hidden={!open}
        className="settings-page-panel relative flex h-full min-h-0 w-full text-neutral-100"
      >
        <div
          aria-hidden="true"
          onClick={() => setNavOpenMobile(false)}
          className={cx("settings-nav-backdrop lg:hidden", navOpenMobile && "is-open")}
        />

        <aside
          className={cx("settings-nav", navOpenMobile && "is-open-mobile")}
        >
          <SettingsNav
            pages={visibleSettingsPages}
            activePage={activePage}
            warnings={{ provider: keyConnected ? "" : "No key saved" }}
            query={navQuery}
            onQueryChange={setNavQuery}
            results={searchResults}
            onSelectPage={choosePage}
            onSelectResult={chooseSearchResult}
            onBack={onClose}
            onCloseMobile={() => setNavOpenMobile(false)}
          />
        </aside>

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="absolute left-3 top-3.5 z-10 lg:hidden">
            <SettingsNavToggle
              label="Open settings menu"
              onClick={() => setNavOpenMobile(true)}
              className="settings-floating-toggle"
            />
          </div>

          <div
            className="settings-page-slide t-page-slide min-h-0 flex-1"
            data-page={String(activePageIndex)}
          >
            <SettingsScrollPage pageId="1" title={pageTitle("provider")} label="Provider settings" active={activePageIndex === 1}>
              <div className="settings-group-stack">
                {accountGroup}
                {cachingGroup}
                {capabilities.routingOptions && routingGroup}
                {capabilities.routingOptions && privacyGroup}
              </div>
            </SettingsScrollPage>
            <SettingsFixedPage pageId="2" title={pageTitle("models")} label="Model settings">
              {modelsSection}
            </SettingsFixedPage>
            <SettingsScrollPage pageId="3" title={pageTitle("generation")} label="Generation settings" active={activePageIndex === 3}>
              <div className="settings-group-stack">
                {reasoningGroup}
                {outputGroup}
              </div>
            </SettingsScrollPage>
            <SettingsScrollPage pageId="4" title={pageTitle("chat")} label="Chat settings" active={activePageIndex === 4}>
              <div className="settings-group-stack">
                {systemPromptGroup}
                {chatsGroup}
              </div>
            </SettingsScrollPage>
            <SettingsFixedPage pageId="5" title={pageTitle("writing")} label="Lorebook settings">
              {lorebookSection}
            </SettingsFixedPage>
            <SettingsFixedPage pageId="6" title={pageTitle("voice")} label="Transcription settings">
              {!provider.capabilities?.transcription && (
                <p className="mb-4 rounded-2xl bg-white/[0.04] px-4 py-3 text-pretty text-[12.5px] leading-5 text-neutral-400">
                  {provider.name} has no voice typing of its own. Voice input uses OpenRouter, so it needs an OpenRouter key saved under Provider.
                </p>
              )}
              {voicePage.mounted && <TranscriptionSettings key={voicePage.session} />}
            </SettingsFixedPage>
            <SettingsScrollPage pageId="7" title={pageTitle("interface")} label="Interface settings" active={activePageIndex === 7}>
              <div className="settings-group-stack">
                {displayGroup}
                {updatesGroup}
              </div>
            </SettingsScrollPage>
            <SettingsFixedPage pageId="8" title={pageTitle("data")} label="Data settings">
              {chatTransferSection}
            </SettingsFixedPage>
            <SettingsScrollPage pageId="9" title={pageTitle("usage")} label="Usage settings" active={activePageIndex === 9}>
              {usagePage.mounted && <UsagePanel key={usagePage.session} models={models} />}
            </SettingsScrollPage>
          </div>
        </main>
      </section>
    </div>
  );
}
