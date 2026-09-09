import { cx, PROMPT_BAR_CONTROL_MOTION } from "../uiShared.js";
import {
  supportsThinking,
  supportsImageInput,
  requiresThinking,
  effectiveThinkingEnabled,
  reasoningEffortLabel,
} from "../modelReasoning.js";
import { useRef, useState, useEffect } from "react";
import { promptModelName } from "../modelFormatting.js";
import AttachmentChips from "../attachments/AttachmentChips.jsx";
import AttachButton from "../attachments/AttachButton.jsx";
import { MAX_FILES_PER_MESSAGE } from "../attachments/attachmentsApi.js";
import { MaskIcon } from "../components/IconButton.jsx";
import { ChevronDown, Square, Plus } from "lucide-react";
import { ContextWindowMeter } from "../components/ContextWindowMeter.jsx";
import { WriteHistoryModal } from "../writing/WriteHistoryModal.jsx";
import { SystemPromptModal } from "../settings/SystemPromptModal.jsx";

const WRITE_GENERATION_MODES = {
  edit: "Edit Chapter",
  new: "New Chapter",
};

const LOREBOOK_UPDATE_MODES = {
  auto: "Auto Lorebook",
  manual: "Manual Lorebook",
};

function ComposerMenuButton({ label, detail, active = false, dataTour, disabled = false, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-tour={dataTour}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex min-h-10 w-full items-center justify-between gap-4 rounded-xl px-3 py-2 text-left text-sm transition-[background-color,color,scale] duration-150 ease-out hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.96] disabled:cursor-default disabled:hover:bg-transparent disabled:active:scale-100",
        active ? "text-neutral-100" : "text-neutral-300",
      )}
    >
      <span>{label}</span>
      <span className={cx("max-w-[132px] truncate text-xs", active ? "text-neutral-400" : "text-neutral-500")}>
        {detail}
      </span>
    </button>
  );
}

export function Composer({
  value,
  setValue,
  disabled,
  isStreaming,
  settings,
  models,
  contextWindowInfo,
  modelLocked,
  onSubmit,
  onStop,
  onOpenSettings,
  onToggleThinking,
  openingMessage,
  variant = "default",
  forceShowThinking = false,
  showContextMeter = true,
  writeGenerationMode = null,
  onToggleWriteGenerationMode,
  writeHistoryEntries = [],
  writeHistoryTitle = "Chapter history",
  onOpenLorebook,
  onOpenBrainstorm,
  onUpdateLorebook,
  onSetLorebookAuto,
  lorebookUpdating = false,
  systemPrompt = "",
  onSaveSystemPrompt,
  tourUi = null,
  attachments = [],
  attachmentsUploading = false,
  onAttachFiles,
  onRemoveAttachment,
  dragActive = false,
  webSearchEnabled = false,
  onToggleWebSearch = null,
}) {
  const canThink = supportsThinking(models, settings.model) || forceShowThinking;
  const canAttach = Boolean(onAttachFiles);
  const canSeeImages = supportsImageInput(models, settings.model);
  const canWebSearch = Boolean(onToggleWebSearch) && !writeGenerationMode;
  const reasoningRequired = requiresThinking(models, settings.model);
  const thinkingEnabled = effectiveThinkingEnabled(
    models, settings.model, settings.thinking_enabled,
  );
  const thinkingStateLabel = thinkingEnabled
    ? reasoningEffortLabel(models, settings.model, settings.reasoning_effort)
    : "Instant";
  const textareaRef = useRef(null);
  const composerControlsRef = useRef(null);
  const tourUiRef = useRef(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const isEmptyVariant = variant === "empty";

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = isEmptyVariant ? 184 : 126;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [isEmptyVariant, value]);

  useEffect(() => {
    function closeComposerMenus(event) {
      if (event.key === "Escape") {
        setContextMenuOpen(false);
        setModelMenuOpen(false);
      }
    }

    function closeOnOutsidePress(event) {
      if (!composerControlsRef.current?.contains(event.target)) {
        setContextMenuOpen(false);
        setModelMenuOpen(false);
      }
    }

    document.addEventListener("keydown", closeComposerMenus);
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      document.removeEventListener("keydown", closeComposerMenus);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, []);

  useEffect(() => {
    if (!tourUi) {
      if (tourUiRef.current) {
        setContextMenuOpen(false);
        setModelMenuOpen(false);
        setSystemPromptOpen(false);
        setHistoryOpen(false);
      }
      tourUiRef.current = null;
      return;
    }

    tourUiRef.current = tourUi;

    setContextMenuOpen(
      ["tools", "generationMode", "lorebookMode", "lorebookUpdate"].includes(tourUi),
    );
    setModelMenuOpen(tourUi === "model");
    setSystemPromptOpen(tourUi === "systemPrompt");
    setHistoryOpen(tourUi === "history");
  }, [tourUi]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        isStreaming ? onStop() : onSubmit();
      }}
      className={cx(
        isEmptyVariant
          ? "pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 pb-[12vh] pt-20 sm:px-8 lg:px-10"
          : "bg-[#080808] px-4 py-4 sm:px-8 lg:px-10",
        !isEmptyVariant && writeGenerationMode && "write-composer",
      )}
    >
      <div className={cx("mx-auto w-full", isEmptyVariant ? "pointer-events-auto max-w-[760px]" : "max-w-4xl")}>
        {isEmptyVariant && openingMessage && (
          <div className="mb-8 text-center text-[22px] font-medium leading-tight text-neutral-200 sm:text-3xl">
            {openingMessage}
          </div>
        )}
        <div
          className={cx(
            "relative bg-[#141414]",
            isEmptyVariant
              ? "rounded-[30px]"
              : "rounded-[24px]",
          )}
        >
          <div className={cx(isEmptyVariant ? "px-[18px] pt-[15px] sm:px-[21px] sm:pt-[18px]" : "px-4 pt-3")}>
            <textarea
              ref={textareaRef}
              value={value}
              rows={1}
              data-1p-ignore="true"
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  isStreaming ? onStop() : onSubmit();
                }
              }}
              placeholder={
                isEmptyVariant
                  ? "Ask anything"
                  : writeGenerationMode
                    ? `Ask ${promptModelName(models, settings.model)} to write anything`
                    : `Ask ${promptModelName(models, settings.model)} anything`
              }
              className={cx(
                "block w-full resize-none bg-transparent text-neutral-100 outline-none",
                isEmptyVariant
                  ? "max-h-[184px] min-h-[72px] text-base leading-7 placeholder:text-neutral-500 sm:text-lg sm:leading-8"
                  : "max-h-[126px] min-h-6 text-sm leading-6 placeholder:text-neutral-600",
              )}
            />
            {canAttach && (
              <AttachmentChips
                attachments={attachments}
                uploading={attachmentsUploading}
                onRemove={onRemoveAttachment}
                compact={!isEmptyVariant}
                className={isEmptyVariant ? "mt-3" : "mt-2.5"}
              />
            )}
          </div>
          <div
            ref={composerControlsRef}
            className={cx(
              "flex items-center gap-2",
              isEmptyVariant
                ? "flex-wrap justify-between px-3 pb-[4.5px] pt-[3px] sm:flex-nowrap sm:px-[15px]"
                : "justify-between px-4 pb-[5px] pt-[3px]",
            )}
            >
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="flex items-center gap-0.5">
              {canAttach && (
                <AttachButton
                  onFilesPicked={onAttachFiles}
                  allowImages={canSeeImages}
                  disabled={disabled || attachments.length >= MAX_FILES_PER_MESSAGE}
                  modelName={promptModelName(models, settings.model)}
                />
              )}
              {canWebSearch && (
                <button
                  type="button"
                  onClick={onToggleWebSearch}
                  aria-pressed={webSearchEnabled}
                  aria-label="Web search"
                  title={
                    webSearchEnabled
                      ? "Web search is on, OpenRouter bills each search"
                      : "Search the web before answering"
                  }
                  className={cx(
                    "grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-white/[0.08] focus:outline-none",
                    webSearchEnabled
                      ? "text-blue-400"
                      : "text-neutral-400",
                    PROMPT_BAR_CONTROL_MOTION,
                  )}
                >
                  <MaskIcon src="/icons/web.png" size={13} />
                </button>
              )}
              </div>
              {writeGenerationMode && (
                <div className="relative">
                  <button
                    type="button"
                    data-tour="write-tools-button"
                    onClick={() => {
                      setContextMenuOpen((open) => !open);
                      setModelMenuOpen(false);
                    }}
                    aria-expanded={contextMenuOpen}
                    aria-haspopup="menu"
                    className={cx(
                      "inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-full bg-transparent px-3 text-xs font-medium text-neutral-300 hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.96]",
                      PROMPT_BAR_CONTROL_MOTION,
                    )}
                  >
                    <span>Writing tools</span>
                    <span className="text-neutral-500">{WRITE_GENERATION_MODES[writeGenerationMode]}</span>
                    <ChevronDown size={14} className={cx("writing-tools-chevron transition-transform duration-200", contextMenuOpen && "rotate-180")} />
                  </button>
                  {contextMenuOpen && (
                    <div role="menu" className="absolute bottom-[calc(100%+8px)] -left-4 z-30 w-72 rounded-2xl bg-[#292929] p-1.5">
                      <ComposerMenuButton label="Lorebook" detail="Story knowledge" onClick={() => { onOpenLorebook(); setContextMenuOpen(false); }} />
                      <ComposerMenuButton label="Brainstorm" detail="Branch story ideas" onClick={() => { onOpenBrainstorm(); setContextMenuOpen(false); }} />
                      <ComposerMenuButton label="System Prompt" detail={systemPrompt.trim() ? "Custom instructions" : "Default instructions"} onClick={() => { setSystemPromptOpen(true); setContextMenuOpen(false); }} active={Boolean(systemPrompt.trim())} />
                      <ComposerMenuButton label="History" detail={`${writeHistoryEntries.length} saved events`} onClick={() => { setHistoryOpen(true); setContextMenuOpen(false); }} />
                      <div className="my-1 border-t border-white/[0.08]" />
                      <ComposerMenuButton dataTour="write-generation-mode" label={WRITE_GENERATION_MODES[writeGenerationMode]} detail="Switch writing action" onClick={onToggleWriteGenerationMode} />
                      <ComposerMenuButton
                        dataTour="write-lorebook-mode"
                        label={LOREBOOK_UPDATE_MODES[settings.lorebook_auto ? "auto" : "manual"]}
                        detail="Switch update mode"
                        disabled={isStreaming || lorebookUpdating}
                        onClick={() => onSetLorebookAuto(!settings.lorebook_auto)}
                      />
                      <ComposerMenuButton
                        dataTour="write-lorebook-update"
                        label="Update Lorebook"
                        detail="Save story details"
                        disabled={lorebookUpdating || isStreaming}
                        onClick={() => { onUpdateLorebook(); setContextMenuOpen(false); }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-1.5">
              <div className="flex min-w-0 items-center gap-0">
                {showContextMeter && <span data-tour="write-context-meter"><ContextWindowMeter info={contextWindowInfo} /></span>}
                <div className="relative min-w-0">
                <button
                  type="button"
                  data-tour="model-button"
                  onClick={() => { setModelMenuOpen((open) => !open); setContextMenuOpen(false); }}
                  aria-expanded={modelMenuOpen}
                  aria-haspopup="menu"
                  className={cx(
                    "inline-flex min-w-0 max-w-[220px] items-center justify-center gap-1.5 rounded-full text-xs font-medium text-neutral-300 hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.96] sm:max-w-[280px]",
                    "h-8",
                    "px-3 bg-transparent shadow-none",
                    PROMPT_BAR_CONTROL_MOTION,
                  )}
                >
                  <span className="truncate">{promptModelName(models, settings.model)}</span>
                  {canThink && (
                    <span className="hidden text-neutral-500 sm:inline">
                      <span>{thinkingStateLabel}</span>
                    </span>
                  )}
                  <ChevronDown size={14} className={cx("thinking-toggle-chevron shrink-0 transition-transform duration-200", modelMenuOpen && "rotate-180")} />
                </button>
                {modelMenuOpen && (
                  <div role="menu" className="absolute bottom-[calc(100%+8px)] right-0 z-30 w-64 rounded-2xl bg-[#292929] p-1.5">
                    <ComposerMenuButton
                      label="Settings"
                      detail={(
                        <>
                          {promptModelName(models, settings.model)}
                          {modelLocked && <span className="ml-1 text-neutral-400">locked</span>}
                        </>
                      )}
                      onClick={() => { onOpenSettings(); setModelMenuOpen(false); }}
                    />
                    {canThink && (
                      <ComposerMenuButton
                        label="Thinking"
                        detail={(
                          <>
                            <span>{reasoningRequired ? "Required" : thinkingEnabled ? "On" : "Off"}</span>
                          </>
                        )}
                        active={thinkingEnabled}
                        dataTour="thinking-button"
                        disabled={reasoningRequired}
                        onClick={() => { onToggleThinking(); setModelMenuOpen(false); }}
                      />
                    )}
                  </div>
                )}
                </div>
              </div>

            <button
              type="submit"
              data-tour="send-button"
              disabled={!isStreaming && ((!value.trim() && attachments.length === 0) || disabled)}
              className={cx(
                "group relative inline-flex shrink-0 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                "h-8 w-8 hover:bg-white/[0.08] disabled:hover:bg-transparent",
                PROMPT_BAR_CONTROL_MOTION,
                isStreaming
                  ? "text-neutral-200"
                  : cx(
                    "text-neutral-300",
                    "disabled:cursor-not-allowed disabled:text-neutral-600 disabled:active:scale-100",
                  ),
              )}
              aria-label={isStreaming ? "Stop" : "Send"}
              title={isStreaming ? "Stop" : "Send"}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "absolute inset-[3px] grid place-items-center overflow-hidden rounded-full transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
                  isStreaming
                    ? "scale-100 opacity-100 blur-0"
                    : "scale-[0.25] opacity-0 blur-[4px]",
                )}
              >
                <Square size={13} />
              </span>
              <span
                aria-hidden="true"
                className={cx(
                  "absolute inset-[3px] grid place-items-center overflow-hidden rounded-full transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
                  isStreaming
                    ? "scale-[0.25] opacity-0 blur-[4px]"
                    : "scale-100 opacity-100 blur-0",
                )}
              >
                <i className="fi fi-rr-arrow-small-up send-arrow-icon" />
              </span>
            </button>
            </div>
          </div>
          {canAttach && dragActive && (
            <div
              className={cx(
                "attachment-drop-overlay pointer-events-none absolute inset-0 z-20 grid place-items-center",
                "border border-dashed border-white/25 bg-[#141414]/95",
                isEmptyVariant ? "rounded-[30px]" : "rounded-[24px]",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium text-neutral-300">
                <Plus size={16} strokeWidth={2.25} />
                {canSeeImages ? "Drop files to attach" : "Drop documents to attach"}
              </span>
            </div>
          )}
        </div>
      </div>
      <WriteHistoryModal
        open={historyOpen}
        entries={writeHistoryEntries}
        title={writeHistoryTitle}
        onClose={() => setHistoryOpen(false)}
      />
      <SystemPromptModal
        open={systemPromptOpen}
        value={systemPrompt}
        onSave={onSaveSystemPrompt}
        onClose={() => setSystemPromptOpen(false)}
      />
    </form>
  );
}
