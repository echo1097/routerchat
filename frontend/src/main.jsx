import {
  readLocalAppSettings,
  pickOpeningMessage,
  PENDING_CHAPTER_DRAFTS_STORAGE_KEY,
  readLocalChatFolders,
  clearLocalChatFolders,
  writeLocalAppSettings,
} from "./localStorage.js";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { newSettings, DEFAULT_MODEL } from "./settings/settingsDefaults.js";
import { parseRoute, storyRoute, routePath, chatRoute } from "./routing.js";
import { useTour } from "./tour/useTour.js";
import { WRITE_TOUR_STEPS } from "./tour/tourSteps.js";
import { useNotifications } from "./notifications/useNotifications.js";
import { useAttachments } from "./attachments/useAttachments.js";
import {
  supportsImageInput,
  requiresThinking,
  effectiveThinkingEnabled,
  reasoningEffortLabel,
} from "./modelReasoning.js";
import { createNavigationCoordinator } from "./writing/navigationCoordinator.js";
import { createSaveCoordinator } from "./writing/saveCoordinator.js";
import { storyApi } from "./writing/storyApi.js";
import { useRafScroller } from "./streamScroll.js";
import {
  chapterRunTargetsOpenChapter,
  loadSettledGeneration,
  chapterGenerationEventMatchesRun,
  parseStreamingEditPreview,
  nextEditPreview,
  chapterUpdateMatchesRun,
  chapterFromUpdateEvent,
  chapterRepairContext,
  chapterGenerationErrorMessage,
  chapterGenerationErrorIsRepairable,
  chapterAppliedEditSummary,
} from "./writing/chapterGenerationEvents.js";
import {
  getModelContextLimit,
  toFiniteNumber,
  getContextWindowInfo,
  isFreeModel,
  promptModelName,
} from "./modelFormatting.js";
import { api, responseErrorDetail } from "./api.js";
import { exportFileName, shortTitle, storyExportFileName } from "./textFormatting.js";
import { updateLorebookStream } from "./lorebook/lorebookUpdateApi.js";
import { repairLorebook as repairLorebookStream } from "./lorebook/repairLorebookApi.js";
import { generateLorebookEntry as generateLorebookEntryStream } from "./lorebook/generateEntryApi.js";
import { useFileDrop } from "./attachments/useFileDrop.js";
import { StoryRail } from "./sidebar/StoryRail.jsx";
import { ConversationRail } from "./sidebar/ConversationRail.jsx";
import { SidebarRevealButton } from "./sidebar/SidebarRevealButton.jsx";
import { IconButton } from "./components/IconButton.jsx";
import { Menu } from "lucide-react";
import HelpTourButton from "./HelpTourButton.jsx";
import { TemporaryChatButton, TemporaryChatMarker } from "./chat/TemporaryChatButton.jsx";
import StoryBrainstorm from "./brainstorm/StoryBrainstorm.jsx";
import { ContextWindowMeter } from "./components/ContextWindowMeter.jsx";
import { StoryWorkspace } from "./writing/StoryWorkspace.jsx";
import { LOREBOOK_PHASE_LABELS } from "./writing/WriteOperationStatus.jsx";
import { MessageList } from "./chat/MessageList.jsx";
import { PromptNavigationRail } from "./chat/PromptNavigationRail.jsx";
import { EmptyChatState } from "./chat/EmptyChatState.jsx";
import { WriteLanding } from "./writing/WriteLanding.jsx";
import { Composer } from "./composer/Composer.jsx";
import { SettingsDrawer } from "./settings/SettingsDrawer.jsx";
import { ConfirmModal } from "./components/ConfirmModal.jsx";
import { NewStoryModal } from "./writing/NewStoryModal.jsx";
import NotificationStack from "./notifications/NotificationStack.jsx";
import TourOverlay from "./tour/TourOverlay.jsx";
import { TosLoadingScreen, TosUnavailableScreen, TosGateModal } from "./TosGate.jsx";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  const localAppSettings = readLocalAppSettings();
  const [chats, setChats] = useState([]);
  const [folders, setFolders] = useState([]);
  const [messages, setMessages] = useState([]);
  const [stories, setStories] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [lorebookEntries, setLorebookEntries] = useState([]);
  const [lorebookUpdating, setLorebookUpdating] = useState(false);
  const [brainstormNodes, setBrainstormNodes] = useState([]);
  const [brainstormEdges, setBrainstormEdges] = useState([]);
  const [brainstormViewport, setBrainstormViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [brainstormPrompt, setBrainstormPrompt] = useState("");
  const [latestBrainstormGeneration, setLatestBrainstormGeneration] = useState(null);
  const [activeStoryId, setActiveStoryId] = useState(null);
  const [activeChapterId, setActiveChapterId] = useState(null);
  const [storyWorkspaceView, setStoryWorkspaceView] = useState("chapter");
  const [chapterContent, setChapterContent] = useState("");
  const [chapterSaveState, setChapterSaveState] = useState("");
  const [storyGenerationStatus, setStoryGenerationStatus] = useState("");
  //true only while a new chapter is streaming prose into the canvas, edit runs never touch it
  const [canvasStreaming, setCanvasStreaming] = useState(false);
  const [writeReasoning, setWriteReasoning] = useState({ text: "", streaming: false, durationMs: null });
  //the lorebook thinks in its own pass, so it gets its own reasoning rather than sharing the chapter's
  const [lorebookReasoning, setLorebookReasoning] = useState({ text: "", streaming: false, durationMs: null });
  const [lorebookThinking, setLorebookThinking] = useState(false);
  //"working" until the model's first token lands, then "thinking" while it reasons, then "updating" while it streams the json
  const [lorebookPhase, setLorebookPhase] = useState("");
  const [writeEditPreview, setWriteEditPreview] = useState(null);
  const [latestStoryGeneration, setLatestStoryGeneration] = useState(null);
  const [writeGenerationMode, setWriteGenerationMode] = useState("edit");
  const [writeHistoryEntries, setWriteHistoryEntries] = useState([]);
  const [models, setModels] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [temporaryChat, setTemporaryChat] = useState(false);
  const [tempChatId, setTempChatId] = useState(null);
  const [settings, setSettings] = useState(newSettings);
  const [defaultModel, setDefaultModel] = useState(DEFAULT_MODEL);
  const [generateChatName, setGenerateChatName] = useState(
    Boolean(localAppSettings.generate_chat_name),
  );
  const [namingChatId, setNamingChatId] = useState(null);
  const [hideFreeModels, setHideFreeModels] = useState(Boolean(localAppSettings.hide_free_models));
  const [nitroMode, setNitroMode] = useState(Boolean(localAppSettings.nitro_mode));
  const [cheapestMode, setCheapestMode] = useState(Boolean(localAppSettings.cheapest_mode));
  const [privacyMode, setPrivacyMode] = useState(Boolean(localAppSettings.privacy_mode));
  const [zdrMode, setZdrMode] = useState(Boolean(localAppSettings.zdr_mode));
  const [smoothStreaming, setSmoothStreaming] = useState(Boolean(localAppSettings.smooth_streaming));
  const [showPromptNavigationRail, setShowPromptNavigationRail] = useState(
    localAppSettings.show_prompt_navigation_rail !== false,
  );
  const [keyStatus, setKeyStatus] = useState({ has_key: false });
  const [prompt, setPrompt] = useState("");
  const [openingMessage] = useState(() => pickOpeningMessage());
  const [writingOpeningMessage] = useState(() => pickOpeningMessage("write"));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [chatMode, setChatMode] = useState(() => {
    const route = parseRoute();
    return route.page === "story" ? "write" : route.mode || "chat";
  });
  const [previousChatMode, setPreviousChatMode] = useState(null);

  //the rails are separate components, so the outgoing mode has to survive until the new one mounts and reads it
  useEffect(() => {
    if (!previousChatMode || previousChatMode === chatMode) return;
    setPreviousChatMode(null);
  }, [chatMode, previousChatMode]);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState(null);
  const [reasoningStreamingMessageId, setReasoningStreamingMessageId] = useState(null);
  const [searchingMessageId, setSearchingMessageId] = useState(null);
  const [reasoningDurations, setReasoningDurations] = useState({});
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [newStoryDialogOpen, setNewStoryDialogOpen] = useState(false);
  const [temporaryTourStory, setTemporaryTourStory] = useState(null);
  const tour = useTour();
  const writeTour = useTour(WRITE_TOUR_STEPS);
  const { notifications, setStatus, showToast } = useNotifications();
  const promptAttachments = useAttachments({
    allowImages: supportsImageInput(models, settings.model),
    onError: showToast,
  });
  const [tourForceThinking, setTourForceThinking] = useState(false);
  const [tourSampleChatActive, setTourSampleChatActive] = useState(false);
  const abortRef = useRef(null);
  const writeGenerationRunRef = useRef(null);
  //held until the run settles so the retry offer never lands mid stream
  const pendingRepairRef = useRef(null);
  const generateStoryChapterRef = useRef(null);
  const routeRef = useRef(parseRoute());
  const initialRouteHandledRef = useRef(false);
  const appSettingsLoadedRef = useRef(false);
  const latestChatLoadRef = useRef(0);
  const latestStoryLoadRef = useRef(0);
  const temporaryTourStoryIdRef = useRef(null);
  const defaultModelRef = useRef(DEFAULT_MODEL);
  const skipNextStoryAutoloadRef = useRef(false);
  const tempChatIdRef = useRef(null);
  const reasoningStartedAtRef = useRef({});
  const writeReasoningStartedAtRef = useRef(null);
  const writeReasoningStreamingRef = useRef(false);
  const lorebookReasoningStartedAtRef = useRef(null);
  const streamRef = useRef(null);
  const previousRailStateRef = useRef(null);
  const brainstormViewportTimeoutRef = useRef(null);
  const brainstormPromptNodeIdRef = useRef(null);
  const chapterContentRef = useRef("");
  const chaptersRef = useRef([]);
  const activeStoryIdRef = useRef(null);
  const activeChapterIdRef = useRef(null);
  const chapterCanvasScrollPositionsRef = useRef(new Map());
  const storyWorkspaceViewRef = useRef("chapter");
  const navigationCoordinatorRef = useRef(null);
  const chapterSaveCoordinatorRef = useRef(null);

  if (!navigationCoordinatorRef.current) {
    navigationCoordinatorRef.current = createNavigationCoordinator();
  }

  if (!chapterSaveCoordinatorRef.current) {
    chapterSaveCoordinatorRef.current = createSaveCoordinator({
      saveChapter: ({ storyId, chapterId, content, revision }) => (
        storyApi.saveChapterContent(storyId, chapterId, content, revision)
      ),
      onStateChange: (snapshot) => {
        if (snapshot.confirmedChapter) {
          setChapters((current) => current.map((chapter) => {
            if (chapter.id !== snapshot.chapterId) return chapter;
            const nextChapter = snapshot.confirmedChapter;
            if (!snapshot.draft) return nextChapter;
            const draftContent = snapshot.draft.content;
            return {
              ...nextChapter,
              content: draftContent,
              word_count: draftContent.trim() ? draftContent.trim().split(/\s+/).length : 0,
            };
          }));
        }

        if (
          snapshot.storyId !== activeStoryIdRef.current
          || snapshot.chapterId !== activeChapterIdRef.current
        ) return;

        const labels = {
          queued: "Saving",
          saving: "Saving",
          saved: "Saved",
          failed: "Save failed",
        };
        setChapterSaveState(labels[snapshot.state] || "");
        if (snapshot.state === "failed" && snapshot.error) {
          setStatus(snapshot.error.message);
        }
      },
    });
  }

  const chapterSaveCoordinator = chapterSaveCoordinatorRef.current;

  function chapterCanvasScrollKey(storyId, chapterId) {
    return `${storyId}/${chapterId}`;
  }

  function chapterCanvasScrollPosition(storyId, chapterId) {
    if (!storyId || !chapterId) return 0;
    return chapterCanvasScrollPositionsRef.current.get(
      chapterCanvasScrollKey(storyId, chapterId),
    ) || 0;
  }

  function rememberChapterCanvasScroll(storyId, chapterId, scrollTop) {
    if (!storyId || !chapterId || !Number.isFinite(scrollTop)) return;
    chapterCanvasScrollPositionsRef.current.set(
      chapterCanvasScrollKey(storyId, chapterId),
      scrollTop,
    );
  }

  function persistPendingChapterDrafts() {
    const pendingDrafts = chapterSaveCoordinator.getPendingDrafts();
    try {
      if (pendingDrafts.length > 0) {
        window.sessionStorage.setItem(
          PENDING_CHAPTER_DRAFTS_STORAGE_KEY,
          JSON.stringify(pendingDrafts),
        );
      } else {
        window.sessionStorage.removeItem(PENDING_CHAPTER_DRAFTS_STORAGE_KEY);
      }
    } catch {
      //storage can be unavailable in private browser modes and thats fine
    }
  }

  function restorePendingChapterDrafts(nextChapters) {
    let storedDrafts = [];
    try {
      storedDrafts = JSON.parse(
        window.sessionStorage.getItem(PENDING_CHAPTER_DRAFTS_STORAGE_KEY) || "[]",
      );
    } catch {
      storedDrafts = [];
    }

    if (!Array.isArray(storedDrafts) || storedDrafts.length === 0) return;

    const restoredKeys = new Set();
    for (const draft of storedDrafts) {
      const chapter = nextChapters.find(
        (item) => item.id === draft.chapterId && item.story_id === draft.storyId,
      );
      if (!chapter) continue;

      chapterSaveCoordinator.rememberServerChapter(chapter);
      const key = `${draft.storyId}/${draft.chapterId}`;
      const draftBaseRevision = Number.isInteger(draft.baseRevision)
        ? draft.baseRevision
        : chapter.revision;
      //a stored draft the server has already moved past is not worth restoring, it would only fight whatever moved it
      const draftIsStale = Number(draftBaseRevision) < Number(chapter.revision);
      if (!chapterSaveCoordinator.getDraft(draft.storyId, draft.chapterId) && !draftIsStale) {
        if (chapter.content !== draft.content) {
          chapterSaveCoordinator.queueDraft(
            draft.storyId,
            draft.chapterId,
            String(draft.content || ""),
            draftBaseRevision,
          );
        }
      }
      restoredKeys.add(key);
    }

    const remainingDrafts = storedDrafts.filter(
      (draft) => !restoredKeys.has(`${draft.storyId}/${draft.chapterId}`),
    );
    try {
      if (remainingDrafts.length > 0) {
        window.sessionStorage.setItem(
          PENDING_CHAPTER_DRAFTS_STORAGE_KEY,
          JSON.stringify(remainingDrafts),
        );
      } else {
        window.sessionStorage.removeItem(PENDING_CHAPTER_DRAFTS_STORAGE_KEY);
      }
    } catch {
      //storage can be unavailable in private browser modes and thats fine
    }
  }

  useEffect(() => {
    activeStoryIdRef.current = activeStoryId;
    activeChapterIdRef.current = activeChapterId;
    chaptersRef.current = chapters;
    storyWorkspaceViewRef.current = storyWorkspaceView;
  }, [activeStoryId, activeChapterId, chapters, storyWorkspaceView]);

  useEffect(() => {
    function handlePageHide() {
      persistPendingChapterDrafts();
    }

    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      persistPendingChapterDrafts();
      chapterSaveCoordinator.dispose({ abandon: true });
      window.clearTimeout(brainstormViewportTimeoutRef.current);
    };
  }, []);

  const {
    isNearBottom,
    markUserScroll,
    markWheelIntent,
    markTouchStart,
    markTouchMove,
    scrollToBottom,
    startFollowing,
    followRef,
  } =
    useRafScroller(streamRef);

  useEffect(() => {
    tempChatIdRef.current = tempChatId;
  }, [tempChatId]);

  useEffect(() => {
    if (tour.isActive) {
      previousRailStateRef.current = { collapsed: railCollapsed, open: railOpen };
      setRailCollapsed(false);
      setRailOpen(true);
      if (chats.length === 0) setTourSampleChatActive(true);
      return;
    }

    setTourForceThinking(false);
    setTourSampleChatActive(false);

    const previousRailState = previousRailStateRef.current;
    if (previousRailState) {
      setRailCollapsed(previousRailState.collapsed);
      setRailOpen(previousRailState.open);
      previousRailStateRef.current = null;
    }
  }, [tour.isActive]);

  useEffect(() => {
    setTourForceThinking(Boolean(tour.currentStep?.forceThinkingVisible));
  }, [tour.currentStep]);

  useEffect(() => {
    const storyId = temporaryTourStoryIdRef.current;
    const nextView = writeTour.currentStep?.workspaceView;
    if (!writeTour.isActive || !storyId || !nextView) return;

    setStoryWorkspaceView(nextView);
    writeRoute(storyRoute(storyId, activeChapterId, nextView), { replace: true });
  }, [writeTour.currentStep]);

  useEffect(() => {
    function closeTourStoryOnPageExit() {
      const storyId = temporaryTourStoryIdRef.current;
      if (!storyId) return;
      navigator.sendBeacon?.(`/api/stories/${encodeURIComponent(storyId)}/close`);
    }

    window.addEventListener("pagehide", closeTourStoryOnPageExit);
    return () => {
      closeTourStoryOnPageExit();
      window.removeEventListener("pagehide", closeTourStoryOnPageExit);
    };
  }, []);

  function writeRoute(route, { replace = false } = {}) {
    const nextPath = routePath(route);
    routeRef.current = route;
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (currentPath === nextPath) return;
    window.history[replace ? "replaceState" : "pushState"]({ route }, "", nextPath);
  }

  function beginNavigationIntent() {
    return navigationCoordinatorRef.current.begin();
  }

  function navigationIntentIsCurrent(intentId) {
    return navigationCoordinatorRef.current.isCurrent(intentId);
  }

  function currentNavigationIntent() {
    return navigationCoordinatorRef.current.current();
  }

  function setCommittedWriteSelection({ storyId, chapterId, workspaceView, chapters: nextChapters, lorebook, generation, story, chapter }) {
    const nextView = ["lorebook", "brainstorm"].includes(workspaceView)
      ? workspaceView
      : "chapter";
    const nextChapter = chapter || nextChapters.find((item) => item.id === chapterId) || null;

    activeStoryIdRef.current = storyId;
    activeChapterIdRef.current = nextChapter?.id || null;
    storyWorkspaceViewRef.current = nextView;
    chaptersRef.current = nextChapters;
    setActiveStoryId(storyId);
    setChapters(nextChapters);
    setLorebookEntries(lorebook || []);
    setLatestStoryGeneration(generation || null);
    setActiveChapterId(nextChapter?.id || null);
    setChapterContent(nextChapter?.content || "");
    setWriteHistoryEntries(nextChapter?.history || []);
    chapterContentRef.current = nextChapter?.content || "";
    setChapterSaveState("");
    setStoryWorkspaceView(nextView);
    setSettings({
      model: story.model,
      temperature: story.temperature,
      max_tokens: story.max_tokens,
      system_prompt: story.system_prompt || "",
      thinking_enabled: Boolean(story.thinking_enabled),
      reasoning_effort: story.reasoning_effort || "medium",
      web_search_enabled: false,
      nitro_mode: nitroMode,
      lorebook_auto: Boolean(story.lorebook_auto),
      lorebook_model: story.lorebook_model || "",
    });
  }

  function hasActiveWriteGeneration() {
    const status = writeGenerationRunRef.current?.status;
    return ["preparing", "streaming", "applying", "reconciling"].includes(status);
  }

  function rejectWriteNavigationDuringGeneration() {
    if (!hasActiveWriteGeneration()) return false;
    setStatus("Finish or stop the current generation first.");
    return true;
  }

  function generationRunOwnsVisibleWorkspace(run) {
    return writeGenerationRunRef.current === run
      && run.navigationIntent === currentNavigationIntent()
      && activeStoryIdRef.current === run.storyId;
  }

  function generationRunTargetsOpenChapter(run) {
    return chapterRunTargetsOpenChapter(
      run,
      activeStoryIdRef.current,
      activeChapterIdRef.current,
    );
  }

  async function reconcileGenerationRun(run) {
    if (run.navigationIntent !== currentNavigationIntent()) return;
    const payload = await loadSettledGeneration(run, {
      getStatus: (currentRun) => storyApi.getGenerationStatus(currentRun),
      getStory: (storyId) => storyApi.getStory(storyId),
      isCurrent: () => generationRunOwnsVisibleWorkspace(run),
    });
    if (!payload) return;
    const nextChapters = payload.chapters || [];
    nextChapters.forEach((chapter) => chapterSaveCoordinator.rememberServerChapter(chapter));

    if (activeStoryIdRef.current !== run.storyId) return;
    const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
    setChapters(visibleChapters);
    setLorebookEntries(payload.lorebook || []);
    setLatestStoryGeneration(payload.latest_generation || null);

    if (!generationRunTargetsOpenChapter(run)) return;
    const targetChapter = visibleChapters.find((chapter) => chapter.id === run.chapterId);
    if (!targetChapter) return;
    setChapterContent(targetChapter.content || "");
    setWriteHistoryEntries(targetChapter.history || []);
    chapterContentRef.current = targetChapter.content || "";
  }

  async function closeTempForRouteChange(nextRoute, navigationIntent = null) {
    const currentRoute = routeRef.current;
    const chatId = tempChatIdRef.current;
    if (currentRoute?.page !== "temp" || !chatId) return;
    if (nextRoute?.page === "temp" && nextRoute.chatId === chatId) return;
    await closeTemporaryChat(chatId);
    if (navigationIntent !== null && !navigationIntentIsCurrent(navigationIntent)) return false;
    return true;
  }

  async function navigateToChat(chat, { replace = false } = {}) {
    if (rejectWriteNavigationDuringGeneration()) return;
    const navigationIntent = beginNavigationIntent();
    const nextRoute = chatRoute(chat);
    try {
      await flushChapterSave(activeStoryIdRef.current, activeChapterIdRef.current);
      if (!navigationIntentIsCurrent(navigationIntent)) return;
    } catch (error) {
      setStatus(error.message);
      return;
    }
    await closeTempForRouteChange(nextRoute, navigationIntent);
    if (!navigationIntentIsCurrent(navigationIntent)) return;
    writeRoute(nextRoute, { replace });
    setChatMode("chat");
  }

  const isEmptyChat = !activeChatId && messages.length === 0;
  const isWritingMode = chatMode === "write";
  const isEmptyWriting = !activeStoryId || !activeChapterId;
  const writingStories = temporaryTourStory
    ? [temporaryTourStory, ...stories.filter((story) => story.id !== temporaryTourStory.id)]
    : stories;
  const activeMessages = isWritingMode ? [] : messages;
  const activeConversationId = isWritingMode ? activeStoryId : activeChatId;
  const activeModelLocked = Boolean(!isWritingMode && activeConversationId && activeMessages.length > 0);
  const activeChapterTitle = chapters.find((chapter) => chapter.id === activeChapterId)?.title || "Chapter";


  
  const sidebarChats =
    !isWritingMode && tourSampleChatActive && chats.length === 0
      ? [{ id: "__tour_sample_chat__", title: "Sample chat", model: settings.model }]
      : chats;

  const contextWindowInfo = useMemo(() => {
    const selectedModel = models.find((model) => model.id === settings.model);
    const contextLimit = getModelContextLimit(selectedModel);
    const latestItemWithUsage = isWritingMode
      ? storyWorkspaceView === "brainstorm"
        ? latestBrainstormGeneration
        : latestStoryGeneration
      : [...activeMessages]
          .reverse()
          .find((message) => {
            if (message.role !== "assistant") return false;
            if (toFiniteNumber(message.total_tokens) !== null) return true;
            return (
              toFiniteNumber(message.prompt_tokens) !== null &&
              toFiniteNumber(message.completion_tokens) !== null
            );
          });
    const totalTokens = toFiniteNumber(latestItemWithUsage?.total_tokens);
    const promptTokens = toFiniteNumber(latestItemWithUsage?.prompt_tokens);
    const completionTokens = toFiniteNumber(latestItemWithUsage?.completion_tokens);
    const contextTokens =
      totalTokens ?? (
        promptTokens !== null && completionTokens !== null
          ? promptTokens + completionTokens
          : null
      );

    return getContextWindowInfo(
      isWritingMode && contextTokens === null ? 0 : contextTokens,
      contextLimit,
    );
  }, [activeMessages, isWritingMode, latestBrainstormGeneration, latestStoryGeneration, models, settings.model, storyWorkspaceView]);

  const loadChats = useCallback(async () => {
    const payload = await api("/api/chats");
    setChats(payload.chats || []);
  }, []);

  const loadFolders = useCallback(async () => {
    const payload = await api("/api/folders");
    let nextFolders = payload.folders || [];

    //folders used to live in localStorage before they had a table, so lift those over once and forget the key
    const legacyFolders = readLocalChatFolders();
    if (legacyFolders.length > 0) {
      try {
        if (nextFolders.length === 0) {
          for (const folder of legacyFolders) {
            await api("/api/folders", {
              method: "POST",
              body: JSON.stringify({ name: folder.name }),
            });
          }
          nextFolders = (await api("/api/folders")).folders || [];
        }
        clearLocalChatFolders();
      } catch {
        //a failed lift is not worth blocking the sidebar, the key stays put so the next load can retry
      }
    }

    setFolders(nextFolders);
  }, []);

  const loadStories = useCallback(async () => {
    const nextStories = await storyApi.listStories();
    setStories(nextStories);
    return nextStories;
  }, []);

  function chapterWithCoordinatorState(chapter) {
    const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
      chapter.story_id,
      chapter.id,
    ) || chapter;
    const draftContent = chapterSaveCoordinator.getDraft(chapter.story_id, chapter.id);
    if (draftContent === null) return confirmedChapter;

    return {
      ...confirmedChapter,
      content: draftContent,
      word_count: draftContent.trim() ? draftContent.trim().split(/\s+/).length : 0,
    };
  }

  async function loadStoryBundle(storyId, preferredChapterId = null, options = {}) {
    const navigationIntent = options.navigationIntent ?? beginNavigationIntent();
    const loadId = navigationIntent;
    latestStoryLoadRef.current = loadId;
    await flushChapterSave(activeStoryIdRef.current, activeChapterIdRef.current);

    if (!navigationIntentIsCurrent(navigationIntent)) return null;

    const payload = await storyApi.getStory(storyId);
    if (!navigationIntentIsCurrent(navigationIntent) || loadId !== latestStoryLoadRef.current) return null;
    const nextStory = payload.story;
    const nextChapters = payload.chapters || [];
    nextChapters.forEach((chapter) => chapterSaveCoordinator.rememberServerChapter(chapter));
    restorePendingChapterDrafts(nextChapters);
    const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
    const nextLorebook = payload.lorebook || [];
    const nextGeneration = payload.latest_generation || null;
    const preferredChapter = visibleChapters.find((chapter) => chapter.id === preferredChapterId);
    if (options.requirePreferredChapter && preferredChapterId && !preferredChapter) {
      throw new Error("Chapter not found.");
    }
    const nextChapter =
      preferredChapter ||
      visibleChapters[0] ||
      null;

    return {
      story: nextStory,
      chapters: visibleChapters,
      chapter: nextChapter,
      lorebook: nextLorebook,
      generation: nextGeneration,
      loadId,
      navigationIntent,
    };
  }

  function commitStoryBundle(result, workspaceView = "chapter") {
    setCommittedWriteSelection({
      storyId: result.story.id,
      chapterId: result.chapter?.id || null,
      workspaceView,
      chapters: result.chapters,
      lorebook: result.lorebook,
      generation: result.generation,
      story: result.story,
      chapter: result.chapter,
    });
  }

  async function loadBrainstormBundle(storyId, storyLoadId = latestStoryLoadRef.current) {
    const payload = await storyApi.getBrainstorm(storyId);
    if (storyLoadId !== latestStoryLoadRef.current || !navigationIntentIsCurrent(storyLoadId)) return null;
    setBrainstormNodes(payload.nodes || []);
    setBrainstormEdges(payload.edges || []);
    setBrainstormViewport(payload.viewport || { x: 0, y: 0, zoom: 1 });
    setLatestBrainstormGeneration(payload.latest_generation || null);
    return payload;
  }

  async function loadStoryRoute(route, { replace = false, fromRoute = false } = {}) {
    if (rejectWriteNavigationDuringGeneration()) {
      writeRoute(routeRef.current, { replace: true });
      return;
    }
    const navigationIntent = beginNavigationIntent();
    const expectedLoadId = navigationIntent;
    try {
      const result = await loadStoryBundle(route.storyId, route.chapterId, {
        requirePreferredChapter: Boolean(route.chapterId),
        navigationIntent,
      });
      if (!result) return;
      const workspaceView = ["lorebook", "brainstorm"].includes(route.workspaceView)
        ? route.workspaceView
        : "chapter";
      if (workspaceView === "brainstorm") {
        await loadBrainstormBundle(result.story.id, result.loadId);
      }
      if (!navigationIntentIsCurrent(navigationIntent) || result.loadId !== latestStoryLoadRef.current) return;
      const routeChapterId = route.chapterId ? result.chapter?.id || null : null;
      const nextRoute = storyRoute(result.story.id, routeChapterId, workspaceView);
      await closeTempForRouteChange(nextRoute, navigationIntent);
      if (!navigationIntentIsCurrent(navigationIntent)) return;
      setCommittedWriteSelection({
        storyId: result.story.id,
        chapterId: result.chapter?.id || null,
        workspaceView,
        chapters: result.chapters,
        lorebook: result.lorebook,
        generation: result.generation,
        story: result.story,
        chapter: result.chapter,
      });
      writeRoute(nextRoute, { replace: replace || fromRoute });
      setChatMode("write");
    } catch (error) {
      if (!navigationIntentIsCurrent(navigationIntent) || expectedLoadId !== latestStoryLoadRef.current) return;
      if (fromRoute) {
        skipNextStoryAutoloadRef.current = true;
        await resetChat({ replace: true, mode: "write" });
      } else {
        setStatus(error.message);
      }
    }
  }

  const loadModels = useCallback(async () => {
    try {
      const payload = await api("/api/models");
      const loaded = payload.models || [];
      setModels(loaded);
      setSettings((current) => {
        const currentModel = loaded.find((model) => model.id === current.model);
        if (
          currentModel &&
          (activeChatId || activeStoryId || !hideFreeModels || !isFreeModel(currentModel))
        ) {
          return requiresThinking(loaded, current.model)
            ? { ...current, thinking_enabled: true }
            : current;
        }
        const selectableModels = hideFreeModels
          ? loaded.filter((model) => !isFreeModel(model))
          : loaded;
        const savedDefaultModel = defaultModelRef.current;
        const fallbackModel = selectableModels.some((model) => model.id === savedDefaultModel)
          ? savedDefaultModel
          : selectableModels[0]?.id || loaded[0]?.id || DEFAULT_MODEL;
        return {
          ...current,
          model: fallbackModel,
          thinking_enabled: requiresThinking(loaded, fallbackModel)
            ? true
            : current.thinking_enabled,
        };
      });
    } catch (error) {
      setStatus(error.message);
    }
  }, [activeChatId, activeStoryId, defaultModel, hideFreeModels]);

  const loadAppSettings = useCallback(async () => {
    try {
      const payload = await api("/api/settings");
      const nextDefaultModel = payload.default_model || DEFAULT_MODEL;
      const nextHideFreeModels =
        typeof payload.hide_free_models === "boolean"
          ? payload.hide_free_models
          : Boolean(readLocalAppSettings().hide_free_models);
      const nextGenerateChatName =
        typeof payload.generate_chat_name === "boolean"
          ? payload.generate_chat_name
          : Boolean(readLocalAppSettings().generate_chat_name);
      const nextNitroMode =
        typeof payload.nitro_mode === "boolean"
          ? payload.nitro_mode
          : Boolean(readLocalAppSettings().nitro_mode);
      const nextSmoothStreaming =
        typeof payload.smooth_streaming === "boolean"
          ? payload.smooth_streaming
          : Boolean(readLocalAppSettings().smooth_streaming);
      const nextCheapestMode =
        typeof payload.cheapest_mode === "boolean"
          ? payload.cheapest_mode
          : Boolean(readLocalAppSettings().cheapest_mode);
      const nextPrivacyMode =
        typeof payload.privacy_mode === "boolean"
          ? payload.privacy_mode
          : Boolean(readLocalAppSettings().privacy_mode);
      const nextZdrMode =
        typeof payload.zdr_mode === "boolean"
          ? payload.zdr_mode
          : Boolean(readLocalAppSettings().zdr_mode);
      setDefaultModel(nextDefaultModel);
      defaultModelRef.current = nextDefaultModel;
      setGenerateChatName(nextGenerateChatName);
      setHideFreeModels(nextHideFreeModels);
      setNitroMode(nextNitroMode);
      setSmoothStreaming(nextSmoothStreaming);
      setCheapestMode(nextCheapestMode);
      setPrivacyMode(nextPrivacyMode);
      setZdrMode(nextZdrMode);
      writeLocalAppSettings({
        generate_chat_name: nextGenerateChatName,
        hide_free_models: nextHideFreeModels,
        nitro_mode: nextNitroMode,
        smooth_streaming: nextSmoothStreaming,
        cheapest_mode: nextCheapestMode,
        privacy_mode: nextPrivacyMode,
        zdr_mode: nextZdrMode,
      });
      setSettings((current) => (
        activeChatId || activeStoryId || appSettingsLoadedRef.current
          ? { ...current, nitro_mode: nextNitroMode }
          : { ...current, model: nextDefaultModel, nitro_mode: nextNitroMode }
      ));
      appSettingsLoadedRef.current = true;
    } catch (error) {
      setStatus(error.message);
    }
  }, [activeChatId, activeStoryId]);

  const loadKeyStatus = useCallback(async () => {
    try {
      setKeyStatus(await api("/api/settings/key-status"));
    } catch (error) {
      setStatus(error.message);
    }
  }, []);

  useEffect(() => {
    loadKeyStatus();
    loadAppSettings();
    loadModels();
    loadChats();
    loadFolders();
    loadStories();
  }, [loadAppSettings, loadChats, loadFolders, loadKeyStatus, loadModels, loadStories]);

  useEffect(() => {
    scrollToBottom(true);
  }, [activeChatId, activeStoryId, activeChapterId, scrollToBottom]);

  useEffect(() => {
    if (!isWritingMode || activeStoryId || stories.length === 0) return;
    if (routeRef.current?.page === "home" && routeRef.current?.mode === "write") return;
    if (routeRef.current?.page === "story") return;
    if (skipNextStoryAutoloadRef.current) {
      skipNextStoryAutoloadRef.current = false;
      return;
    }
    const navigationIntent = beginNavigationIntent();
    void loadStoryBundle(stories[0].id, null, { navigationIntent }).then((result) => {
      if (!result) return;
      if (!navigationIntentIsCurrent(navigationIntent)) return;
      setCommittedWriteSelection({
        storyId: result.story.id,
        chapterId: result.chapter?.id || null,
        workspaceView: "chapter",
        chapters: result.chapters,
        lorebook: result.lorebook,
        generation: result.generation,
        story: result.story,
        chapter: result.chapter,
      });
      writeRoute(storyRoute(result.story.id, null, "chapter"), {
        replace: true,
      });
    }).catch((error) => {
      setStatus(error.message);
    });
  }, [activeStoryId, isWritingMode, stories]);

  function applyChat(chat, nextMessages) {
    const isTemporary = Boolean(chat.temporary);
    setTemporaryChat(isTemporary);
    setTempChatId(isTemporary ? chat.id : null);
    setActiveChatId(chat.id);
    setMessages(nextMessages || []);
    setSettings({
      model: chat.model,
      temperature: chat.temperature,
      max_tokens: chat.max_tokens,
      system_prompt: chat.system_prompt || "",
      thinking_enabled: effectiveThinkingEnabled(
        models, chat.model, Boolean(chat.thinking_enabled),
      ),
      reasoning_effort: chat.reasoning_effort || "medium",
      web_search_enabled: Boolean(chat.web_search_enabled),
      nitro_mode: nitroMode,
      lorebook_auto: false, //chats have no lorebook, this just keeps the object shape steady across modes
      lorebook_model: "",
    });
  }

  async function closeTemporaryChat(chatId = tempChatIdRef.current) {
    if (!chatId) return;
    try {
      await api(`/api/chats/${chatId}/close`, { method: "POST" });
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  useEffect(() => {
    function closeTempOnPageExit() {
      const chatId = tempChatIdRef.current;
      if (!chatId || routeRef.current?.page !== "temp") return;
      navigator.sendBeacon?.(`/api/chats/${chatId}/close`);
    }

    window.addEventListener("pagehide", closeTempOnPageExit);
    return () => {
      closeTempOnPageExit();
      window.removeEventListener("pagehide", closeTempOnPageExit);
    };
  }, []);

  async function loadChat(chatId, { replace = false, fromRoute = false } = {}) {
    if (rejectWriteNavigationDuringGeneration()) {
      writeRoute(routeRef.current, { replace: true });
      return;
    }
    const navigationIntent = beginNavigationIntent();
    const loadId = latestChatLoadRef.current + 1;
    latestChatLoadRef.current = loadId;
    try {
      await flushChapterSave(activeStoryIdRef.current, activeChapterIdRef.current);
      if (!navigationIntentIsCurrent(navigationIntent)) return;
      const payload = await api(`/api/chats/${chatId}`);
      if (loadId !== latestChatLoadRef.current || !navigationIntentIsCurrent(navigationIntent)) return;
      const nextRoute = chatRoute(payload.chat);
      await closeTempForRouteChange(nextRoute, navigationIntent);
      if (loadId !== latestChatLoadRef.current || !navigationIntentIsCurrent(navigationIntent)) return;
      writeRoute(nextRoute, { replace: replace || fromRoute });
      setChatMode("chat");
      applyChat(payload.chat, payload.messages || []);
    } catch (error) {
      if (loadId !== latestChatLoadRef.current || !navigationIntentIsCurrent(navigationIntent)) return;
      if (fromRoute) {
        await resetChat({ replace: true });
      } else {
        setStatus(error.message);
      }
    }
  }

  async function persistSettings(nextSettings = settings) {
    if (isWritingMode) {
      if (!activeStoryId) return;
      try {
        await storyApi.updateStory(activeStoryId, nextSettings);
        await loadStories();
      } catch (error) {
        setStatus(error.message);
      }
      return;
    }

    if (!activeChatId) return;
    try {
      await api(`/api/chats/${activeChatId}`, {
        method: "PATCH",
        body: JSON.stringify(nextSettings),
      });
      await loadChats();
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function saveStorySystemPrompt(systemPrompt) {
    if (!activeStoryId) {
      throw new Error("No active story.");
    }

    const nextSettings = { ...settings, system_prompt: systemPrompt };
    try {
      await storyApi.updateStory(activeStoryId, nextSettings);
      setSettings(nextSettings);
      await loadStories();
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function resetChat({ replace = false, mode = chatMode } = {}) {
    if (rejectWriteNavigationDuringGeneration()) return;
    const navigationIntent = beginNavigationIntent();
    const nextMode = mode === "write" ? "write" : "chat";
    const nextRoute = { page: "home", mode: nextMode };
    try {
      await flushChapterSave(activeStoryIdRef.current, activeChapterIdRef.current);
      if (!navigationIntentIsCurrent(navigationIntent)) return;
    } catch (error) {
      //a conflict now settles itself in the coordinator, the chapter is already back in sync so only a real failure earns a label
      if (error.code !== "chapter_revision_conflict") setChapterSaveState("Save failed");
      setStatus(error.message);
      return;
    }
    await closeTempForRouteChange(nextRoute, navigationIntent);
    if (!navigationIntentIsCurrent(navigationIntent)) return;
    writeRoute(nextRoute, { replace });
    setChatMode(nextMode);
    setActiveChatId(null);
    setTemporaryChat(false);
    setTempChatId(null);
    setMessages([]);
    setActiveStoryId(null);
    setActiveChapterId(null);
    activeStoryIdRef.current = null;
    activeChapterIdRef.current = null;
    storyWorkspaceViewRef.current = "chapter";
    chaptersRef.current = [];
    setChapters([]);
    setLorebookEntries([]);
    setBrainstormNodes([]);
    setBrainstormEdges([]);
    setBrainstormViewport({ x: 0, y: 0, zoom: 1 });
    setLatestBrainstormGeneration(null);
    setLatestStoryGeneration(null);
    setChapterContent("");
    setWriteHistoryEntries([]);
    chapterContentRef.current = "";
    setChapterSaveState("");
    setStoryGenerationStatus("");
    setCanvasStreaming(false);
    setStoryWorkspaceView("chapter");
    setSettings((current) => ({
      ...newSettings,
      model: current.model || defaultModel,
      nitro_mode: nitroMode,
    }));
    setPrompt("");
    setStatus("");
  }

  useEffect(() => {
    if (initialRouteHandledRef.current) return;
    initialRouteHandledRef.current = true;

    const route = parseRoute();
    routeRef.current = route;
    if (route.page === "chat" || route.page === "temp") {
      setChatMode("chat");
      void loadChat(route.chatId, { replace: true, fromRoute: true });
    } else if (route.page === "story") {
      void loadStoryRoute(route, { replace: true, fromRoute: true });
    } else {
      setChatMode(route.mode || "chat");
      writeRoute({ page: "home", mode: route.mode || "chat" }, { replace: true });
    }
  }, []);

  useEffect(() => {
    function handlePopState() {
      const nextRoute = parseRoute();
      if (hasActiveWriteGeneration()) {
        setStatus("Finish or stop the current generation first.");
        writeRoute(routeRef.current, { replace: true });
        return;
      }
      if (nextRoute.page === "chat" || nextRoute.page === "temp") {
        setChatMode("chat");
        void loadChat(nextRoute.chatId, { replace: true, fromRoute: true });
        return;
      }
      if (nextRoute.page === "story") {
        void loadStoryRoute(nextRoute, { replace: true, fromRoute: true });
        return;
      }
      void resetChat({ replace: true, mode: nextRoute.mode || "chat" });
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  async function updateDefaultModel(modelId) {
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ default_model: modelId }),
      });
      const nextDefaultModel = payload.default_model || modelId;
      setDefaultModel(nextDefaultModel);
      defaultModelRef.current = nextDefaultModel;
      if (!activeChatId && !activeStoryId) {
        setSettings((current) => ({ ...current, model: nextDefaultModel }));
      }
      showToast("Default model updated");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function updateHideFreeModels(value) {
    setHideFreeModels(value);
    writeLocalAppSettings({ hide_free_models: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ hide_free_models: value }),
      });
      const nextValue =
        typeof payload.hide_free_models === "boolean"
          ? payload.hide_free_models
          : value;
      setHideFreeModels(nextValue);
      writeLocalAppSettings({ hide_free_models: nextValue });
      showToast(value ? "Free models hidden" : "Free models shown");
    } catch (error) {
      setHideFreeModels(value);
      writeLocalAppSettings({ hide_free_models: value });
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  async function updateGenerateChatName(value) {
    setGenerateChatName(value);
    writeLocalAppSettings({ generate_chat_name: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ generate_chat_name: value }),
      });
      //an older backend drops unknown fields and still answers 200, so a missing key is a stale server
      if (typeof payload.generate_chat_name !== "boolean") {
        setStatus("Saved locally. Restart the server to use generated chat names.");
        return;
      }
      setGenerateChatName(payload.generate_chat_name);
      writeLocalAppSettings({ generate_chat_name: payload.generate_chat_name });
      showToast(value ? "Chat names will be generated" : "Chat name generation off");
    } catch (error) {
      setGenerateChatName(value);
      writeLocalAppSettings({ generate_chat_name: value });
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  async function updateNitroMode(value) {
    applyRoutingSettings(null, { nitro: value, cheapest: value ? false : cheapestMode });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ nitro_mode: value }),
      });
      applyRoutingSettings(payload, { nitro: value, cheapest: value ? false : cheapestMode });
      showToast(value ? "Turbo enabled" : "Turbo disabled");
    } catch (error) {
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  function applyRoutingSettings(payload, fallback) {
    const nextNitro =
      typeof payload?.nitro_mode === "boolean" ? payload.nitro_mode : fallback.nitro;
    const nextCheapest =
      typeof payload?.cheapest_mode === "boolean" ? payload.cheapest_mode : fallback.cheapest;
    setNitroMode(nextNitro);
    setCheapestMode(nextCheapest);
    setSettings((current) => ({ ...current, nitro_mode: nextNitro }));
    writeLocalAppSettings({ nitro_mode: nextNitro, cheapest_mode: nextCheapest });
  }

  async function updateCheapestMode(value) {
    //turbo and cheapest are opposite sort orders, so one always wins over the other
    applyRoutingSettings(null, { nitro: value ? false : nitroMode, cheapest: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ cheapest_mode: value }),
      });
      applyRoutingSettings(payload, { nitro: value ? false : nitroMode, cheapest: value });
      showToast(value ? "Cheapest first enabled" : "Cheapest first disabled");
    } catch (error) {
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  async function updatePrivacyMode(value) {
    setPrivacyMode(value);
    writeLocalAppSettings({ privacy_mode: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ privacy_mode: value }),
      });
      const nextValue =
        typeof payload.privacy_mode === "boolean" ? payload.privacy_mode : value;
      setPrivacyMode(nextValue);
      writeLocalAppSettings({ privacy_mode: nextValue });
      showToast(value ? "Privacy mode enabled" : "Privacy mode disabled");
    } catch (error) {
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  async function updateZdrMode(value) {
    setZdrMode(value);
    writeLocalAppSettings({ zdr_mode: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ zdr_mode: value }),
      });
      const nextValue = typeof payload.zdr_mode === "boolean" ? payload.zdr_mode : value;
      setZdrMode(nextValue);
      writeLocalAppSettings({ zdr_mode: nextValue });
      showToast(value ? "Zero data retention enabled" : "Zero data retention disabled");
    } catch (error) {
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  async function updateSmoothStreaming(value) {
    setSmoothStreaming(value);
    writeLocalAppSettings({ smooth_streaming: value });
    try {
      const payload = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ smooth_streaming: value }),
      });
      const nextValue =
        typeof payload.smooth_streaming === "boolean"
          ? payload.smooth_streaming
          : value;
      setSmoothStreaming(nextValue);
      writeLocalAppSettings({ smooth_streaming: nextValue });
      showToast(value ? "Smooth text enabled" : "Smooth text disabled");
    } catch (error) {
      setSmoothStreaming(value);
      writeLocalAppSettings({ smooth_streaming: value });
      setStatus(`Saved locally. Restart the server to sync this setting. ${error.message}`);
    }
  }

  function updatePromptNavigationRail(value) {
    setShowPromptNavigationRail(value);
    writeLocalAppSettings({ show_prompt_navigation_rail: value });
    showToast(value ? "Nav bar shown" : "Nav bar hidden");
  }

  async function createChat({ temporary = false } = {}) {
    const payload = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        ...settings,
        chat_system_prompt: settings.system_prompt,
        ...(temporary ? { title: "Temporary chat", temporary: true } : {}),
      }),
    });
    applyChat(payload.chat, []);
    await navigateToChat(payload.chat);
    if (!temporary) {
      await loadChats();
    }
    return payload.chat;
  }

  async function ensureChat() {
    if (activeChatId) return activeChatId;
    return (await createChat()).id;
  }

  async function ensureTemporaryChat() {
    if (tempChatId) return tempChatId;
    if (temporaryChat && activeChatId) return activeChatId;
    return (await createChat({ temporary: true })).id;
  }

  function toggleTemporaryChat() {
    if (isStreaming) return;
    if (temporaryChat) {
      void resetChat();
      return;
    }
    setTemporaryChat(true);
  }

  async function deleteChat(chatId) {
    const chat = chats.find((item) => item.id === chatId);
    if (!chat) return;
    setConfirmDialog({
      title: "Delete chat?",
      chatTitle: chat.title,
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await api(`/api/chats/${chatId}`, { method: "DELETE" });
          if (chatId === activeChatId) await resetChat();
          await loadChats();
          setStatus("Chat deleted");
        } catch (error) {
          setStatus(error.message);
        }
      },
    });
  }

  async function exportChats(chatId, chat) {
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/export`);
    if (!response.ok) {
      throw new Error(await responseErrorDetail(response));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(chat);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`Exported ${shortTitle(chat?.title) || "chat"}`);
  }

  async function exportChatFromMenu(chat) {
    if (!chat?.id) return;
    try {
      await exportChats(chat.id, chat);
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function importChats(payload) {
    const result = await api("/api/chats/import", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadChats();
    showToast(
      `Imported ${result.imported_chats || 0} chats and ${result.imported_messages || 0} messages`,
    );
    return result;
  }

  async function renameChat(chatId, title) {
    try {
      const payload = await api(`/api/chats/${chatId}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      await loadChats();
      if (chatId === activeChatId && payload.chat) {
        await navigateToChat(payload.chat, { replace: true });
      }
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function toggleChatPin(chat) {
    const nextPinned = !Boolean(chat.pinned);
    setChats((current) => current.map((item) => (
      item.id === chat.id ? { ...item, pinned: nextPinned } : item
    )));

    try {
      const payload = await api(`/api/chats/${chat.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned: nextPinned }),
      });
      setChats((current) => current.map((item) => (
        item.id === chat.id ? payload.chat : item
      )));
      await loadChats();
      showToast(nextPinned ? "Chat pinned" : "Chat unpinned");
    } catch (error) {
      setChats((current) => current.map((item) => (
        item.id === chat.id ? chat : item
      )));
      setStatus(error.message);
    }
  }

  async function createFolder(name) {
    try {
      const payload = await api("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      await loadFolders();
      showToast(`Folder "${payload.folder.name}" created`);
      return payload.folder;
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function renameFolder(folderId, name) {
    try {
      await api(`/api/folders/${folderId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      await loadFolders();
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  function deleteFolder(folder) {
    const folderChats = chats.filter((chat) => chat.folder_id === folder.id);
    setConfirmDialog({
      title: "Delete folder?",
      chatTitle: folder.name,
      body: folderChats.length
        ? `The ${folderChats.length} ${folderChats.length === 1 ? "chat" : "chats"} inside will move back to Recents.`
        : "This cannot be undone.",
      confirmLabel: "Delete folder",
      secondaryLabel: folderChats.length ? "Delete folder and chats" : null,
      onSecondary: async () => {
        await removeFolder(folder, true);
      },
      onConfirm: async () => {
        await removeFolder(folder, false);
      },
    });
  }

  async function removeFolder(folder, deleteChats) {
    try {
      await api(`/api/folders/${folder.id}?delete_chats=${deleteChats ? "true" : "false"}`, {
        method: "DELETE",
      });
      await loadFolders();
      await loadChats();
      if (deleteChats && chats.some((chat) => chat.folder_id === folder.id && chat.id === activeChatId)) {
        await resetChat();
      }
      showToast(deleteChats ? "Folder and chats deleted" : "Folder deleted");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function moveChatToFolder(chat, folderId) {
    const previousFolderId = chat.folder_id || null;
    const nextFolderId = folderId || null;
    if (previousFolderId === nextFolderId) return;

    setChats((current) => current.map((item) => (
      item.id === chat.id ? { ...item, folder_id: nextFolderId } : item
    )));

    try {
      await api(`/api/chats/${chat.id}`, {
        method: "PATCH",
        body: JSON.stringify({ folder_id: nextFolderId || "" }),
      });
      await loadChats();
      await loadFolders();
      const folder = folders.find((item) => item.id === nextFolderId);
      showToast(folder ? `Moved to ${folder.name}` : "Removed from folder");
    } catch (error) {
      setChats((current) => current.map((item) => (
        item.id === chat.id ? { ...item, folder_id: previousFolderId } : item
      )));
      setStatus(error.message);
    }
  }

  async function createChatInFolder(folderId) {
    try {
      const payload = await api("/api/chats", {
        method: "POST",
        body: JSON.stringify({
          ...settings,
          chat_system_prompt: settings.system_prompt,
          folder_id: folderId,
        }),
      });
      applyChat(payload.chat, []);
      await navigateToChat(payload.chat);
      await loadChats();
      await loadFolders();
      return payload.chat;
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function saveKey(apiKey) {
    try {
      const payload = await api("/api/settings/openrouter-key", {
        method: "POST",
        body: JSON.stringify({ api_key: apiKey }),
      });
      setKeyStatus(payload);
      setStatus("OpenRouter connected");
      await loadModels();
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function readStream(response, assistantId, savedAssistantId = assistantId, setMessageList = setMessages) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const smoothBuffers = { content: "", reasoning: "" };
    let smoothFrame = null;

    function applyStreamText(nextContent, nextReasoning) {
      if (!nextContent && !nextReasoning) return;
      setMessageList((current) =>
        current.map((message) => {
          if (message.id !== assistantId) return message;
          return {
            ...message,
            content: nextContent
              ? `${message.content || ""}${nextContent}`
              : message.content,
            reasoning: nextReasoning
              ? `${message.reasoning || ""}${nextReasoning}`
              : message.reasoning,
          };
        }),
      );
      scrollToBottom();
    }

    function flushSmoothBuffers() {
      smoothFrame = null;
      const nextContent = smoothBuffers.content;
      const nextReasoning = smoothBuffers.reasoning;
      smoothBuffers.content = "";
      smoothBuffers.reasoning = "";
      applyStreamText(nextContent, nextReasoning);
    }

    function queueSmoothText(type, value) {
      smoothBuffers[type] += value;
      if (smoothFrame) return;
      smoothFrame = window.requestAnimationFrame(flushSmoothBuffers);
    }

    function flushNow() {
      if (smoothFrame) {
        window.cancelAnimationFrame(smoothFrame);
        smoothFrame = null;
      }
      flushSmoothBuffers();
    }

    function startReasoningTimer() {
      if (!reasoningStartedAtRef.current[assistantId]) {
        reasoningStartedAtRef.current[assistantId] = performance.now();
      }
    }

    function finishReasoningTimer() {
      const startedAt = reasoningStartedAtRef.current[assistantId];
      if (!startedAt) return;
      const durationMs = performance.now() - startedAt;
      delete reasoningStartedAtRef.current[assistantId];
      setReasoningDurations((current) => ({
        ...current,
        [assistantId]: durationMs,
        [savedAssistantId]: durationMs,
      }));
    }

    function clearReasoningStreaming() {
      finishReasoningTimer();
      setReasoningStreamingMessageId((current) =>
        current === assistantId ? null : current,
      );
    }

    function clearSearching() {
      setSearchingMessageId((current) => (current === assistantId ? null : current));
    }

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        followRef.current = followRef.current && isNearBottom();
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            event = { type: "content", value: line };
          }
          if (event.type === "usage") {
            clearReasoningStreaming();
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId ? { ...message, ...(event.value || {}) } : message,
              ),
            );
            continue;
          }
          if (event.type === "sources") {
            const foundSources = event.value || [];
            setMessageList((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? { ...message, sources: foundSources }
                  : message,
              ),
            );
            continue;
          }
          if (event.type === "reasoning") {
            clearSearching();
            startReasoningTimer();
            setReasoningStreamingMessageId(assistantId);
            queueSmoothText("reasoning", String(event.value || ""));
            continue;
          }
          clearSearching();
          clearReasoningStreaming();
          queueSmoothText("content", String(event.value || ""));
        }
      }
      if (buffered.trim()) {
        clearReasoningStreaming();
        queueSmoothText("content", buffered);
      }
    } finally {
      flushNow();
      clearSearching();
      clearReasoningStreaming();
    }
  }

  async function sendMessage(text = prompt.trim(), regenerateMessageId = null) {
    const sentAttachmentIds = regenerateMessageId ? [] : promptAttachments.attachmentIds();
    const sentAttachments = regenerateMessageId ? [] : promptAttachments.attachments;
    if (isStreaming || (!text && sentAttachmentIds.length === 0)) return;
    setIsStreaming(true);
    setStatus("");
    abortRef.current = new AbortController();
    let currentAssistantId = null;
    let conversationId = null;
    let currentTempMode = false;
    //the name comes from the opening prompt, so a regenerate of that same turn is not a new chat
    const shouldName = generateChatName && !regenerateMessageId && messages.length === 0;

    try {
      const tempMode = temporaryChat && (!activeChatId || activeChatId === tempChatId);
      currentTempMode = tempMode;
      conversationId = tempMode ? await ensureTemporaryChat() : await ensureChat();
      if (shouldName) {
        setNamingChatId(conversationId);
      }
      const shouldAddUser = !regenerateMessageId;
      const userMessage = {
        id: `local-user-${crypto.randomUUID()}`,
        chat_id: conversationId,
        role: "user",
        content: text,
        attachments: sentAttachments,
        created_at: new Date().toISOString(),
      };

      const assistantId = `local-assistant-${crypto.randomUUID()}`;
      currentAssistantId = assistantId;
      const assistantMessage = {
        id: assistantId,
        chat_id: conversationId,
        role: "assistant",
        content: "",
        reasoning: "",
        created_at: new Date().toISOString(),
      };

      startFollowing();
      setStreamingMessageId(assistantId);
      setSearchingMessageId(settings.web_search_enabled ? assistantId : null);
      setReasoningDurations((current) => {
        const next = { ...current };
        delete next[assistantId];
        return next;
      });
      setMessages((current) =>
        shouldAddUser
          ? [...current, userMessage, assistantMessage]
          : [...current, assistantMessage],
      );
      setPrompt("");
      promptAttachments.releaseAttachments();

      const response = await fetch(`/api/chats/${conversationId}/messages/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          ...settings,
          chat_system_prompt: settings.system_prompt,
          message: text,
          regenerate_message_id: regenerateMessageId,
          attachment_ids: sentAttachmentIds,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(await responseErrorDetail(response));
      }

      const savedAssistantId = response.headers.get("X-Assistant-Message-Id") || assistantId;
      await readStream(response, assistantId, savedAssistantId, setMessages);
      if (tempMode) {
        await loadChat(conversationId, { replace: true });
      } else {
        await loadChats();
        await loadChat(conversationId, { replace: true });
      }
      if (shouldName) {
        await nameChat(conversationId, tempMode);
      }
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus("Response stopped");
        if (conversationId) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!currentTempMode) {
            await loadChats();
            await loadChat(conversationId, { replace: true });
          } else {
            await loadChat(conversationId, { replace: true });
          }
        }
      } else {
        setStatus(error.message);
        if (regenerateMessageId && conversationId) {
          await loadChat(conversationId, { replace: true });
        } else {
          setMessages((current) =>
            current.map((message) =>
              message.id === currentAssistantId
                ? { ...message, content: error.message }
                : message,
            ),
          );
        }
      }
    } finally {
      setIsStreaming(false);
      setStreamingMessageId(null);
      setReasoningStreamingMessageId(null);
      setSearchingMessageId(null);
      if (currentAssistantId) {
        delete reasoningStartedAtRef.current[currentAssistantId];
      }
      abortRef.current = null;
      //a stopped or failed run never reaches the naming call, so the lock has to lift here too
      setNamingChatId(null);
    }
  }

  //the route always answers with a title, so a rejection here is the network rather than the model
  async function nameChat(chatId, tempMode) {
    try {
      const payload = await api(`/api/chats/${chatId}/title`, { method: "POST" });
      if (!tempMode) {
        await loadChats();
      }
      if (chatId === activeChatId && payload.chat) {
        await navigateToChat(payload.chat, { replace: true });
      }
    } catch (error) {
      //a chat that keeps its fallback title is not worth interrupting the reply for, but a silent
      //failure here is impossible to tell apart from the feature never running at all
      console.error("chat naming failed", error);
    }
  }

  function stopStream() {
    abortRef.current?.abort();
  }

  async function regenerate(assistantId) {
    const index = messages.findIndex((message) => message.id === assistantId);
    const previousUser = [...messages.slice(0, index)].reverse().find((message) => message.role === "user");
    if (!previousUser) return;
    setMessages(messages.slice(0, messages.findIndex((message) => message.id === previousUser.id) + 1));
    await sendMessage(previousUser.content, previousUser.id);
  }

  async function copyMessage(message) {
    await navigator.clipboard.writeText(message.content || "");
    setStatus("Copied");
  }

  async function editUserMessage(message, content) {
    if (!activeChatId || isStreaming) return;
    try {
      setStatus("Prompt updated. Regenerating...");
      setMessages((current) => {
        const messageIndex = current.findIndex((item) => item.id === message.id);
        if (messageIndex < 0) return current;
        return [
          ...current.slice(0, messageIndex),
          { ...current[messageIndex], content },
        ];
      });
      await sendMessage(content, message.id);
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function deleteUserMessage(message) {
    if (!activeChatId || isStreaming) return;
    setConfirmDialog({
      title: "Delete prompt?",
      body: "Delete this prompt and the replies after it? This cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          const payload = await api(`/api/chats/${activeChatId}/messages/${message.id}`, {
            method: "DELETE",
          });
          applyChat(payload.chat, payload.messages || []);
          await navigateToChat(payload.chat, { replace: true });
          await loadChats();
          setStatus("Prompt deleted");
        } catch (error) {
          setStatus(error.message);
        }
      },
    });
  }

  function toggleWebSearch() {
    setSettings((current) => {
      const next = { ...current, web_search_enabled: !current.web_search_enabled };
      if (activeConversationId) persistSettings(next);
      return next;
    });
  }

  function toggleThinking() {
    setSettings((current) => {
      if (requiresThinking(models, current.model)) return current;
      const next = { ...current, thinking_enabled: !current.thinking_enabled };
      if (activeConversationId) persistSettings(next);
      return next;
    });
  }

  function setLorebookAutoMode(autoEnabled) {
    setSettings((current) => {
      const next = { ...current, lorebook_auto: autoEnabled };
      if (activeStoryId) persistSettings(next);
      return next;
    });
  }

  function toggleWriteGenerationMode() {
    if (hasActiveWriteGeneration()) return setStatus("Finish or stop the current generation first.");
    setWriteGenerationMode((current) => (current === "new" ? "edit" : "new"));
  }

  function changeChatMode(nextMode) {
    if (rejectWriteNavigationDuringGeneration()) return;
    const mode = nextMode === "write" ? "write" : "chat";
    if (mode !== chatMode) setPreviousChatMode(chatMode);
    void resetChat({ mode });
  }

  async function finishWriteTour() {
    if (rejectWriteNavigationDuringGeneration()) return;
    const navigationIntent = beginNavigationIntent();
    const storyId = temporaryTourStoryIdRef.current;
    writeTour.finish();

    try {
      if (storyId) {
        await chapterSaveCoordinator.flush(storyId);
        if (!navigationIntentIsCurrent(navigationIntent)) return;
        await storyApi.closeStory(storyId);
        if (!navigationIntentIsCurrent(navigationIntent)) return;
      }
    } catch (error) {
      setStatus(error.message);
    } finally {
      if (!navigationIntentIsCurrent(navigationIntent)) return;
      temporaryTourStoryIdRef.current = null;
      await loadStories();
      await resetChat({ replace: true, mode: "write" });
      setTemporaryTourStory(null);
      setRailOpen(false);
      setRailCollapsed(false);
    }
  }

  async function startWriteTour() {
    if (isStreaming || writeTour.isActive || temporaryTourStoryIdRef.current) return;

    let storyId = null;
    try {
      setStatus("Preparing write tour");
      const story = await storyApi.createStory({
        title: "Write tour · temporary story",
        model: settings.model,
        system_prompt: "Keep the prose atmospheric, concise, and grounded in the story lore.",
        temperature: settings.temperature,
        max_tokens: settings.max_tokens,
        thinking_enabled: settings.thinking_enabled,
        reasoning_effort: settings.reasoning_effort,
        lorebook_auto: settings.lorebook_auto,
        lorebook_model: settings.lorebook_model,
        temporary: true,
      });
      storyId = story.id;
      temporaryTourStoryIdRef.current = story.id;
      setTemporaryTourStory(story);

      const chapter = await storyApi.createChapter(story.id, {
        title: "Chapter 1 · The Signal",
        content: "# The Tower\n\nLucy began to climb the tower steps, in awe of the moss covering everything",
      });
      await storyApi.createLorebookEntry(story.id, {
        name: "Lucy",
        category: "character",
        description: "A mage with a deep connection to the arcane.",
        aliases: ["Lucy"],
        tags: ["protagonist"],
      });

      const navigationIntent = beginNavigationIntent();
      const result = await loadStoryBundle(story.id, chapter.id, { navigationIntent });
      if (!result || !navigationIntentIsCurrent(navigationIntent)) return;
      commitStoryBundle(result);
      setRailCollapsed(false);
      setRailOpen(true);
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(story.id, chapter.id, "chapter"));
      setStatus("");
      writeTour.start();
    } catch (error) {
      temporaryTourStoryIdRef.current = null;
      setTemporaryTourStory(null);
      if (storyId) {
        try {
          await storyApi.closeStory(storyId);
        } catch {
          //cleanup also runs at startup if the browser decided today was the day
        }
      }
      await loadStories();
      await resetChat({ replace: true, mode: "write" });
      setStatus(error.message);
    }
  }

  async function startNewStory(title = "New story") {
    if (rejectWriteNavigationDuringGeneration() || isStreaming) return;
    try {
      const scaffold = await storyApi.createStoryWithInitialChapter(
        {
          title: title.trim() || "New story",
          model: settings.model,
          system_prompt: "",
          temperature: settings.temperature,
          max_tokens: settings.max_tokens,
          thinking_enabled: settings.thinking_enabled,
          reasoning_effort: settings.reasoning_effort,
          lorebook_auto: settings.lorebook_auto,
          lorebook_model: settings.lorebook_model,
        },
        { title: "Chapter 1", content: "" },
      );
      const { story, chapter } = scaffold;
      await loadStories();
      const navigationIntent = beginNavigationIntent();
      const result = await loadStoryBundle(story.id, chapter.id, { navigationIntent });
      if (!result || !navigationIntentIsCurrent(navigationIntent)) return;
      commitStoryBundle(result);
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(story.id, chapter.id, "chapter"));
      showToast("Story created");
      showToast("Remember to update your Lorebook!");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function selectStory(storyId) {
    if (rejectWriteNavigationDuringGeneration()) return;
    const navigationIntent = beginNavigationIntent();
    const expectedLoadId = navigationIntent;
    try {
      const result = await loadStoryBundle(storyId, null, { navigationIntent });
      if (!result) return;
      if (!navigationIntentIsCurrent(navigationIntent)) return;
      commitStoryBundle(result);
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(result.story.id, null, "chapter"));
    } catch (error) {
      if (!navigationIntentIsCurrent(navigationIntent) || expectedLoadId !== latestStoryLoadRef.current) return;
      setStatus(error.message);
    }
  }

  async function selectChapter(chapterId) {
    if (rejectWriteNavigationDuringGeneration()) return;
    const storyId = activeStoryIdRef.current;
    if (!storyId) return;
    const navigationIntent = beginNavigationIntent();

    try {
      await flushChapterSave(storyId, activeChapterIdRef.current);
      if (!navigationIntentIsCurrent(navigationIntent) || activeStoryIdRef.current !== storyId) return;
      const nextChapters = await storyApi.listChapters(storyId);
      if (!navigationIntentIsCurrent(navigationIntent) || activeStoryIdRef.current !== storyId) return;
      nextChapters.forEach((chapter) => chapterSaveCoordinator.rememberServerChapter(chapter));
      const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
      const chapter = visibleChapters.find((item) => item.id === chapterId);
      if (!chapter) return;
      const nextChapter = chapterWithCoordinatorState(chapter);
      chaptersRef.current = visibleChapters;
      activeChapterIdRef.current = nextChapter.id;
      storyWorkspaceViewRef.current = "chapter";
      setChapters(visibleChapters);
      setActiveChapterId(nextChapter.id);
      setChapterContent(nextChapter.content || "");
      setWriteHistoryEntries(nextChapter.history || []);
      chapterContentRef.current = nextChapter.content || "";
      setChapterSaveState("");
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(storyId, nextChapter.id, "chapter"));
    } catch (error) {
      //a conflict now settles itself in the coordinator, the chapter is already back in sync so only a real failure earns a label
      if (error.code !== "chapter_revision_conflict") setChapterSaveState("Save failed");
      setStatus(error.message);
    }
  }

  async function createStoryChapter() {
    if (rejectWriteNavigationDuringGeneration()) return;
    const storyId = activeStoryIdRef.current;
    if (!storyId) return;
    const navigationIntent = beginNavigationIntent();
    try {
      await flushChapterSave(storyId, activeChapterIdRef.current);
      if (!navigationIntentIsCurrent(navigationIntent) || activeStoryIdRef.current !== storyId) return;
      const chapter = await storyApi.createChapter(storyId, {
        title: `Chapter ${chaptersRef.current.length + 1}`,
      });
      if (!navigationIntentIsCurrent(navigationIntent) || activeStoryIdRef.current !== storyId) return;
      const nextChapters = await storyApi.listChapters(storyId);
      if (!navigationIntentIsCurrent(navigationIntent) || activeStoryIdRef.current !== storyId) return;
      nextChapters.forEach((item) => chapterSaveCoordinator.rememberServerChapter(item));
      const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
      chaptersRef.current = visibleChapters;
      activeChapterIdRef.current = chapter.id;
      storyWorkspaceViewRef.current = "chapter";
      setChapters(visibleChapters);
      setActiveChapterId(chapter.id);
      setChapterContent(chapter.content || "");
      setWriteHistoryEntries(chapter.history || []);
      chapterContentRef.current = chapter.content || "";
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(storyId, chapter.id, "chapter"));
      showToast("Chapter created");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function exportStoryItem(story) {
    if (!story?.id || rejectWriteNavigationDuringGeneration()) return;

    try {
      if (story.id === activeStoryIdRef.current) {
        await chapterSaveCoordinator.flush(story.id);
      }

      const response = await fetch(
        `/api/stories/${encodeURIComponent(story.id)}/export`,
      );
      if (!response.ok) {
        throw new Error(await responseErrorDetail(response));
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = storyExportFileName(story);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast(`Exported ${shortTitle(story.title) || "story"}`);
    } catch (error) {
      setStatus(error.message || "Story export failed");
    }
  }

  async function importStoryFile(file) {
    if (!file || rejectWriteNavigationDuringGeneration()) return;

    try {
      const text = await file.text();
      const archive = JSON.parse(text);
      const imported = await storyApi.importStory(archive);
      await loadStories();

      const navigationIntent = beginNavigationIntent();
      const result = await loadStoryBundle(
        imported.story_id,
        imported.first_chapter_id,
        { navigationIntent },
      );
      if (!result || !navigationIntentIsCurrent(navigationIntent)) return;

      commitStoryBundle(result);
      setStoryWorkspaceView("chapter");
      writeRoute(storyRoute(result.story.id, result.chapter?.id || null, "chapter"));
      showToast(`Imported ${shortTitle(result.story.title) || "story"}`);
      return true;
    } catch (error) {
      setStatus(error.message || "Story import failed");
      return false;
    }
  }

  async function renameStoryItem(story, title) {
    try {
      await storyApi.updateStory(story.id, { title });
      await loadStories();
      if (story.id === activeStoryIdRef.current) {
        const navigationIntent = beginNavigationIntent();
        const result = await loadStoryBundle(
          story.id,
          activeChapterIdRef.current,
          { navigationIntent },
        );
        if (result && navigationIntentIsCurrent(navigationIntent)) {
          commitStoryBundle(result);
        }
      }
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function renameChapterItem(chapter, title) {
    const storyId = activeStoryIdRef.current;
    if (!storyId) return;

    try {
      await flushChapterSave(storyId, chapter.id);
      const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
        storyId,
        chapter.id,
      ) || chapter;
      const updated = await storyApi.updateChapter(storyId, chapter.id, {
        title,
        revision: confirmedChapter.revision,
      });
      chapterSaveCoordinator.rememberServerChapter(updated);
      setChapters((current) =>
        current.map((item) => (
          item.id === updated.id ? chapterWithCoordinatorState(updated) : item
        )),
      );
    } catch (error) {
      setStatus(error.message);
      throw error;
    }
  }

  async function toggleChapterContext(chapter) {
    if (!activeStoryId) return;

    try {
      await flushChapterSave(activeStoryId, chapter.id);
      const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
        activeStoryId,
        chapter.id,
      ) || chapter;
      const updated = await storyApi.updateChapter(activeStoryId, chapter.id, {
        disabled: !chapter.disabled,
        revision: confirmedChapter.revision,
      });
      chapterSaveCoordinator.rememberServerChapter(updated);
      setChapters((current) =>
        current.map((item) => (item.id === updated.id ? chapterWithCoordinatorState(updated) : item)),
      );
      showToast(updated.disabled ? "Chapter hidden" : "Chapter shown");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function deleteStoryItem(story) {
    if (rejectWriteNavigationDuringGeneration()) return;
    setConfirmDialog({
      title: "Delete story?",
      chatTitle: story.title,
      body: "This deletes its chapters and lorebook. This cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await chapterSaveCoordinator.flush(story.id);

          await storyApi.deleteStory(story.id);
          const nextStories = await loadStories();
          if (story.id !== activeStoryId) {
            setStatus("Story deleted");
            return;
          }

          const nextStory = nextStories[0];
          if (nextStory) {
            const navigationIntent = beginNavigationIntent();
            const result = await loadStoryBundle(nextStory.id, null, { navigationIntent });
            if (!result) return;
            if (!navigationIntentIsCurrent(navigationIntent)) return;
            commitStoryBundle(result);
            setStoryWorkspaceView("chapter");
            writeRoute(storyRoute(result.story.id, null, "chapter"), {
              replace: true,
            });
          } else {
            setActiveStoryId(null);
            setActiveChapterId(null);
            setChapters([]);
            setLorebookEntries([]);
            setBrainstormNodes([]);
            setBrainstormEdges([]);
            setBrainstormViewport({ x: 0, y: 0, zoom: 1 });
            setLatestBrainstormGeneration(null);
            setLatestStoryGeneration(null);
            setChapterContent("");
            setWriteHistoryEntries([]);
            setStoryWorkspaceView("chapter");
            writeRoute({ page: "home", mode: "write" }, { replace: true });
          }
          setStatus("Story deleted");
        } catch (error) {
          setStatus(error.message);
        }
      },
    });
  }

  async function deleteChapterItem(chapter) {
    if (rejectWriteNavigationDuringGeneration()) return;
    if (!activeStoryId) return;
    setConfirmDialog({
      title: "Delete chapter?",
      chatTitle: chapter.title,
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await chapterSaveCoordinator.flush(activeStoryId, chapter.id);

          await storyApi.deleteChapter(activeStoryId, chapter.id);
          const nextChapters = await storyApi.listChapters(activeStoryId);
          nextChapters.forEach((item) => chapterSaveCoordinator.rememberServerChapter(item));
          const visibleChapters = nextChapters.map(chapterWithCoordinatorState);
          setChapters(visibleChapters);
          if (chapter.id !== activeChapterId) {
            setStatus("Chapter deleted");
            return;
          }

          const nextChapter = visibleChapters[0] || null;
          setActiveChapterId(nextChapter?.id || null);
          setChapterContent(nextChapter?.content || "");
          setWriteHistoryEntries(nextChapter?.history || []);
          chapterContentRef.current = nextChapter?.content || "";
          setStoryWorkspaceView("chapter");
          writeRoute(storyRoute(activeStoryId, nextChapter?.id || null, "chapter"), {
            replace: true,
          });
          setStatus("Chapter deleted");
        } catch (error) {
          setStatus(error.message);
        }
      },
    });
  }

  async function createLorebookEntry(data) {
    if (!activeStoryId) throw new Error("No active story.");

    const entry = await storyApi.createLorebookEntry(activeStoryId, data);
    setLorebookEntries((currentEntries) => [entry, ...currentEntries]);
    showToast("Lorebook entry created");
    return entry;
  }

  async function updateLorebookEntry(entryId, data) {
    if (!activeStoryId) throw new Error("No active story.");

    const previousEntry = lorebookEntries.find((currentEntry) => currentEntry.id === entryId);
    const entry = await storyApi.updateLorebookEntry(activeStoryId, entryId, data);
    setLorebookEntries((currentEntries) =>
      currentEntries.map((currentEntry) => (currentEntry.id === entry.id ? entry : currentEntry)),
    );
    const contextChanged = previousEntry
      && Boolean(previousEntry.disabled) !== Boolean(entry.disabled);
    showToast(contextChanged ? (entry.disabled ? "Entry disabled" : "Entry enabled") : "Lorebook entry updated");
    return entry;
  }

  async function deleteLorebookEntry(entryId) {
    if (!activeStoryId) throw new Error("No active story.");

    await storyApi.deleteLorebookEntry(activeStoryId, entryId);
    setLorebookEntries((currentEntries) => currentEntries.filter((entry) => entry.id !== entryId));
    showToast("Lorebook entry deleted");
  }

  function confirmDeleteLorebookEntry(entry) {
    return new Promise((resolve) => {
      setConfirmDialog({
        title: "Delete lorebook entry?",
        chatTitle: entry.name,
        body: "This cannot be undone.",
        confirmLabel: "Delete",
        onConfirm: async () => {
          resolve(true);
        },
        onCancel: () => resolve(false),
      });
    });
  }

  function startLorebookThinking() {
    lorebookReasoningStartedAtRef.current = null;
    setLorebookReasoning({ text: "", streaming: false, durationMs: null });
    setLorebookThinking(true);
    setLorebookPhase("working");
  }

  function appendLorebookReasoning(chunk) {
    if (!lorebookReasoningStartedAtRef.current) {
      lorebookReasoningStartedAtRef.current = performance.now();
    }
    setLorebookReasoning((current) => ({
      text: `${current.text || ""}${String(chunk || "")}`,
      streaming: true,
      durationMs: null,
    }));
    setLorebookPhase("thinking");
  }

  //the model stopped reasoning and is now streaming the actual lorebook json
  function markLorebookUpdating() {
    const startedAt = lorebookReasoningStartedAtRef.current;
    if (startedAt) {
      setLorebookReasoning((current) => ({
        ...current,
        streaming: false,
        durationMs: performance.now() - startedAt,
      }));
    }
    setLorebookPhase("updating");
  }

  function finishLorebookThinking() {
    const startedAt = lorebookReasoningStartedAtRef.current;
    lorebookReasoningStartedAtRef.current = null;
    setLorebookThinking(false);
    setLorebookPhase("");
    setLorebookReasoning((current) => ({
      ...current,
      streaming: false,
      durationMs: startedAt ? performance.now() - startedAt : current.durationMs,
    }));
  }

  async function updateLorebookNow() {
    if (!activeStoryId || !activeChapterId || isStreaming || lorebookUpdating) return;

    try {
      setLorebookUpdating(true);
      startLorebookThinking();
      //the editor autosaves, so push any pending draft before the server reads the chapter
      await flushChapterSave(activeStoryId, activeChapterId);
      const result = await updateLorebookStream({
        storyId: activeStoryId,
        chapterId: activeChapterId,
        onEvent: (event) => {
          if (event.type === "reasoning") appendLorebookReasoning(event.value);
          if (event.type === "content") markLorebookUpdating();
        },
      });

      setLorebookEntries(result.entries || []);
      (result.history || []).forEach(appendWriteHistoryEntry);

      const appliedUpdates = Array.isArray(result.applied) ? result.applied : [];
      const skippedUpdates = Array.isArray(result.skipped) ? result.skipped : [];
      if (result.error) {
        setStatus("Lorebook update failed");
      } else if (skippedUpdates.length) {
        showToast("Lorebook updated; some edits were skipped");
      } else {
        showToast(appliedUpdates.length ? "Lorebook updated" : "Nothing new to save");
      }
    } catch (error) {
      setStatus(error.message);
    } finally {
      finishLorebookThinking();
      setLorebookUpdating(false);
    }
  }

  async function repairTimeline(currentTimeline, onEvent) {
    if (!activeStoryId || isStreaming || lorebookUpdating) {
      throw new Error("Finish the current writing task first.");
    }

    try {
      setLorebookUpdating(true);
      setStatus("");
      const result = await storyApi.repairTimeline({
        storyId: activeStoryId,
        currentTimeline,
        onEvent,
      });
      const repairedEntry = result.entry;

      setLorebookEntries((currentEntries) => {
        const entryExists = currentEntries.some((entry) => entry.id === repairedEntry.id);
        if (!entryExists) return [repairedEntry, ...currentEntries];
        return currentEntries.map((entry) => (
          entry.id === repairedEntry.id ? repairedEntry : entry
        ));
      });
      return result;
    } finally {
      setLorebookUpdating(false);
    }
  }

  async function repairLorebook(onEvent) {
    if (!activeStoryId || isStreaming || lorebookUpdating) {
      throw new Error("Finish the current writing task first.");
    }

    try {
      setLorebookUpdating(true);
      setStatus("");
      const result = await repairLorebookStream({ storyId: activeStoryId, onEvent });

      //the rebuild replaces every visible entry with brand new rows, so swap the whole list rather than merging
      setLorebookEntries(result.entries);
      return result;
    } finally {
      setLorebookUpdating(false);
    }
  }

  async function generateLorebookEntry(category, brief, onEvent, chapterId = null) {
    if (!activeStoryId || isStreaming || lorebookUpdating) {
      throw new Error("Finish the current writing task first.");
    }

    if (category === "synopsis" && chapterId) {
      await flushChapterSave(activeStoryId, chapterId);
    }

    //nothing is saved here, the draft goes back to the editor and the author decides
    return generateLorebookEntryStream({
      storyId: activeStoryId,
      category,
      brief,
      chapterId,
      onEvent,
    });
  }

  function updateChapterCanvasContent(content) {
    setChapterContent(content);
    chapterContentRef.current = content;
    if (!activeStoryId || !activeChapterId) return;

    const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
      activeStoryId,
      activeChapterId,
    ) || chaptersRef.current.find((chapter) => chapter.id === activeChapterId);
    chapterSaveCoordinator.queueDraft(
      activeStoryId,
      activeChapterId,
      content,
      confirmedChapter?.revision ?? 0,
    );
  }

  async function flushChapterSave(storyId = activeStoryId, chapterId = activeChapterId) {
    if (!storyId) return null;
    return chapterSaveCoordinator.flush(storyId, chapterId);
  }

  async function openBrainstorm() {
    if (!activeStoryId || isStreaming) return;
    try {
      await flushChapterSave(activeStoryId, activeChapterId);
      await loadBrainstormBundle(activeStoryId);
      setStoryWorkspaceView("brainstorm");
      writeRoute(storyRoute(activeStoryId, activeChapterId, "brainstorm"));
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function updateBrainstormNode(nodeId, changes) {
    if (!activeStoryId) return;
    setBrainstormNodes((current) => current.map((node) => (
      node.id === nodeId
        ? {
            ...node,
            ...changes,
            position_x: changes.position_x ?? node.position_x,
            position_y: changes.position_y ?? node.position_y,
          }
        : node
    )));
    try {
      const updated = await storyApi.updateBrainstormNode(activeStoryId, nodeId, changes);
      setBrainstormNodes((current) => current.map((node) => (
        node.id === updated.id
          ? {
              ...node,
              ...updated,
              // the row the server hands back knows nothing about the live stream, so dont let it
              // clobber what we have been accumulating
              generation_phase: node.generation_phase,
              reasoning: updated.reasoning ?? node.reasoning,
            }
          : node
      )));
    } catch (error) {
      setStatus(error.message);
      await loadBrainstormBundle(activeStoryId);
      throw error;
    }
  }

  async function deleteBrainstormNode(nodeId, hasDescendants = false, skipConfirm = false) {
    if (!activeStoryId || isStreaming) return;
    const nodeType = brainstormNodes.find((node) => node.id === nodeId)?.node_type;
    const performDelete = async () => {
      try {
        const payload = await storyApi.deleteBrainstormNode(
          activeStoryId,
          nodeId,
          hasDescendants,
        );
        const deletedIds = new Set(payload.deleted_node_ids || []);
        setBrainstormNodes((current) => current.filter((node) => !deletedIds.has(node.id)));
        setBrainstormEdges((current) => current.filter((edge) => (
          !deletedIds.has(edge.source_node_id) && !deletedIds.has(edge.target_node_id)
        )));
        if (!skipConfirm) {
          showToast(hasDescendants ? "Branch deleted" : `${nodeType === "prompt" ? "Prompt" : "Idea"} deleted`);
        }
      } catch (error) {
        setStatus(error.message);
        throw error;
      }
    };

    if (hasDescendants && !skipConfirm) {
      setConfirmDialog({
        title: "Delete brainstorm branch?",
        body: "This removes the selected card and every prompt and idea descended from it. This cannot be undone.",
        confirmLabel: "Delete branch",
        onConfirm: performDelete,
      });
      return;
    }
    await performDelete();
  }

  function updateBrainstormViewport(viewport) {
    if (!activeStoryId) return;
    setBrainstormViewport(viewport);
    window.clearTimeout(brainstormViewportTimeoutRef.current);
    brainstormViewportTimeoutRef.current = window.setTimeout(() => {
      storyApi.updateBrainstormViewport(activeStoryId, viewport).catch((error) => {
        setStatus(error.message);
      });
    }, 350);
  }

  async function generateBrainstorm(text = brainstormPrompt.trim(), selectedIdeaIds = [], ideaCount = 3) {
    if (isStreaming || !text || !activeStoryId) return false;
    const brainstormThinkingEnabled = effectiveThinkingEnabled(
      models,
      settings.model,
      settings.thinking_enabled,
    );
    setIsStreaming(true);
    setStatus("");
    setBrainstormPrompt("");
    const abortController = new AbortController();
    abortRef.current = abortController;
    let streamError = "";
    let hasGeneratedIdeas = false;

    try {
      await storyApi.generateBrainstorm({
        storyId: activeStoryId,
        prompt: text,
        selectedIdeaIds,
        ideaCount,
        settings,
        signal: abortController.signal,
        onEvent: (event) => {
          if (event.type === "prompt") {
            const value = event.value || {};
            if (value.node) {
              brainstormPromptNodeIdRef.current = value.node.id;
              setBrainstormNodes((current) => [
                ...current.filter((node) => node.id !== value.node.id),
                {
                  ...value.node,
                  generation_phase: value.node.generation_phase || "waiting",
                  reasoning: value.node.reasoning || "",
                },
              ]);
            }
            if (Array.isArray(value.edges)) {
              setBrainstormEdges((current) => [
                ...current.filter((edge) => !value.edges.some((next) => next.id === edge.id)),
                ...value.edges,
              ]);
            }
            return;
          }
          if (event.type === "reasoning") {
            const promptNodeId = brainstormPromptNodeIdRef.current;
            const reasoningValue = String(event.value || "");
            if (!promptNodeId || !reasoningValue) return;
            setBrainstormNodes((current) => current.map((node) => (
              node.id === promptNodeId
                ? {
                    ...node,
                    generation_phase: node.generation_phase === "working"
                      ? node.generation_phase
                      : "thinking",
                    reasoning: `${node.reasoning || ""}${reasoningValue}`,
                  }
                : node
            )));
            return;
          }
          if (event.type === "working") {
            const promptNodeId = brainstormPromptNodeIdRef.current;
            if (!promptNodeId) return;
            setBrainstormNodes((current) => current.map((node) => (
              node.id === promptNodeId
                ? { ...node, generation_phase: "working" }
                : node
            )));
            return;
          }
          if (event.type === "ideas") {
            const value = event.value || {};
            hasGeneratedIdeas = Array.isArray(value.nodes) && value.nodes.some(
              (node) => node.node_type === "idea",
            );
            const promptNodeId = brainstormPromptNodeIdRef.current;
            setBrainstormNodes((current) => [
              ...current.map((node) => (
                node.id === promptNodeId
                  ? {
                      ...node,
                      status: "complete",
                      generation_phase: "complete",
                      duration_ms: value.duration_ms,
                    }
                  : node
              )),
              ...(value.nodes || []),
            ]);
            setBrainstormEdges((current) => [...current, ...(value.edges || [])]);
            return;
          }
          if (event.type === "usage") {
            setLatestBrainstormGeneration(event.value || null);
            return;
          }
          if (event.type === "error") {
            streamError = String(event.value || "Brainstorming failed");
            setStatus(streamError);
          }
        },
      });
      if (abortController.signal.aborted) {
        setStatus("Brainstorm stopped");
        return false;
      }
      if (streamError) return false;
      if (!hasGeneratedIdeas) {
        setStatus("Brainstorming ended before any ideas were received. Try again.");
        return false;
      }

      showToast("Ideas added");
      return true;
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus("Brainstorm stopped");
      } else {
        setStatus(error.message);
      }
      return false;
    } finally {
      brainstormPromptNodeIdRef.current = null;
      abortRef.current = null;
      try {
        await loadBrainstormBundle(activeStoryId);
      } catch (error) {
        setStatus(error.message);
      }
      setIsStreaming(false);
    }
  }

  function appendWriteHistoryEntry(entry) {
    if (!entry?.id) return;
    setWriteHistoryEntries((current) => {
      if (current.some((item) => item.id === entry.id)) return current;
      return [...current, entry];
    });
    setChapters((current) =>
      current.map((chapter) => {
        if (chapter.id !== entry.chapter_id) return chapter;
        const history = Array.isArray(chapter.history) ? chapter.history : [];
        if (history.some((item) => item.id === entry.id)) return chapter;
        return { ...chapter, history: [...history, entry] };
      }),
    );
  }

  async function generateStoryChapter(text = prompt.trim(), repairContext = null, repairAttachmentIds = null) {
    const sentAttachmentIds = repairAttachmentIds || promptAttachments.attachmentIds();
    const hasPrompt = Boolean(text) || sentAttachmentIds.length > 0;
    if (isStreaming || hasActiveWriteGeneration() || lorebookUpdating || !hasPrompt || !activeStoryId || !activeChapterId) return;
    const selectedGenerationMode = repairContext ? "edit" : writeGenerationMode;
    const abortController = new AbortController();
    const run = {
      runId: crypto.randomUUID(),
      storyId: activeStoryId,
      chapterId: activeChapterId,
      baseRevision: 0,
      generationMode: selectedGenerationMode,
      status: "preparing",
      abortController,
      startedAt: Date.now(),
      navigationIntent: currentNavigationIntent(),
    };
    writeGenerationRunRef.current = run;
    pendingRepairRef.current = null;
    abortRef.current = abortController;
    setIsStreaming(true);
    setStoryGenerationStatus("Preparing");
    setWriteReasoning({ text: "", streaming: false, durationMs: null });
    setLorebookReasoning({ text: "", streaming: false, durationMs: null });
    setLorebookThinking(false);
    setWriteEditPreview(null);
    writeReasoningStartedAtRef.current = null;
    writeReasoningStreamingRef.current = false;
    lorebookReasoningStartedAtRef.current = null;
    setStatus("");
    let generatedText = "";
    let streamFailed = false;
    let terminalStatus = "completed";
    let targetChapterId = run.chapterId;
    let targetChapterContent = "";
    let targetChapterRevision = 0;

    try {
      await flushChapterSave(run.storyId, run.chapterId);
      const confirmedChapter = chapterSaveCoordinator.getConfirmedChapter(
        run.storyId,
        run.chapterId,
      ) || chaptersRef.current.find((chapter) => chapter.id === run.chapterId);
      targetChapterContent = chapterSaveCoordinator.getDraft(run.storyId, run.chapterId)
        ?? confirmedChapter?.content
        ?? chapterContentRef.current;
      targetChapterRevision = confirmedChapter?.revision ?? 0;
      run.baseRevision = targetChapterRevision;
      run.generationMode = selectedGenerationMode === "edit" && !targetChapterContent.trim()
        ? "new"
        : selectedGenerationMode;
      setPrompt("");
      if (!repairContext) promptAttachments.releaseAttachments();
      if (selectedGenerationMode === "new") {
        const chapter = await storyApi.createChapter(run.storyId, {
          title: `Chapter ${chapters.length + 1}`,
        });
        const nextChapters = await storyApi.listChapters(run.storyId);
        nextChapters.forEach((chapterItem) => chapterSaveCoordinator.rememberServerChapter(chapterItem));
        targetChapterId = chapter.id;
        run.chapterId = chapter.id;
        run.baseRevision = chapter.revision;
        run.generationMode = "new";
        targetChapterContent = "";
        targetChapterRevision = chapter.revision;
        setChapters(nextChapters.map(chapterWithCoordinatorState));
        setActiveChapterId(chapter.id);
        setChapterContent("");
        setWriteHistoryEntries(chapter.history || []);
        chapterContentRef.current = "";
        setStoryWorkspaceView("chapter");
        writeRoute(storyRoute(run.storyId, chapter.id, "chapter"));
      }

      run.status = "streaming";
      setStoryGenerationStatus(repairContext ? "Fixing the edit" : "Working");
      abortController.signal.throwIfAborted();
      run.generationId = crypto.randomUUID();
      await storyApi.generateChapter({
        storyId: run.storyId,
        chapterId: targetChapterId,
        prompt: text,
        settings,
        generationMode: run.generationMode,
        chapterRevision: targetChapterRevision,
        generationRunId: run.runId,
        generationStatusId: run.generationId,
        repairContext,
        attachmentIds: sentAttachmentIds,
        signal: abortController.signal,
        onEvent: (event) => {
          if (!chapterGenerationEventMatchesRun(event, run)) return;
          if (!generationRunOwnsVisibleWorkspace(run)) return;
          if (event.generationId) run.generationId = event.generationId;
          if (event.type === "history") {
            appendWriteHistoryEntry(event.value || {});
            return;
          }
          if (event.type === "reasoning") {
            if (!writeReasoningStartedAtRef.current) {
              writeReasoningStartedAtRef.current = performance.now();
            }
            writeReasoningStreamingRef.current = true;
            setStoryGenerationStatus("Thinking");
            setWriteReasoning((current) => ({
              ...current,
              text: `${current.text || ""}${String(event.value || "")}`,
              streaming: true,
              durationMs: null,
            }));
            return;
          }
          if (event.type === "content") {
            const value = String(event.value || "");
            if (writeReasoningStreamingRef.current && writeReasoningStartedAtRef.current) {
              const durationMs = performance.now() - writeReasoningStartedAtRef.current;
              writeReasoningStreamingRef.current = false;
              setWriteReasoning((current) => ({
                ...current,
                streaming: false,
                durationMs,
              }));
            }
            setStoryGenerationStatus("Writing");
            generatedText += value;
            if (run.generationMode === "new") {
              setCanvasStreaming(true);
              setChapterContent(generatedText);
              chapterContentRef.current = generatedText;
            } else {
              const preview = parseStreamingEditPreview(generatedText);
              setWriteEditPreview((current) => nextEditPreview(current, preview));
            }
            return;
          }
          if (event.type === "chapter_updated") {
            if (!chapterUpdateMatchesRun(event, run)) return;
            run.status = "applying";
            const result = event.value || {};
            const updatedChapter = chapterFromUpdateEvent(result);
            if (!updatedChapter) return;
            const nextContent = String(updatedChapter.content || "");
            const currentChapter = chapterSaveCoordinator.getConfirmedChapter(
              run.storyId,
              targetChapterId,
            ) || chaptersRef.current.find((chapter) => chapter.id === run.chapterId);
            if (currentChapter) {
              chapterSaveCoordinator.rememberServerChapter({
                ...currentChapter,
                ...updatedChapter,
              });
            }
            setChapters((current) => current.map((chapter) => (
              chapter.id === run.chapterId ? { ...chapter, ...updatedChapter } : chapter
            )));
            if (generationRunTargetsOpenChapter(run)) {
              setChapterContent(nextContent);
              chapterContentRef.current = nextContent;
            }

            //the applied edits are already committed above, so the offer below can only ever add to them
            const skipped = Array.isArray(result.rejected) ? result.rejected : [];
            const appliedCount = (result.edits || []).length;
            if (skipped.length || result.truncated) {
              //a truncated run has no rejected list to count, the edits it never got to write simply are not here
              setStatus(skipped.length
                ? `Applied ${appliedCount} of ${appliedCount + skipped.length} edits — ${skipped.length} skipped.`
                : run.generationMode === "new"
                  ? "The connection dropped before the response finished, but what was written so far was saved."
                  : `Applied ${appliedCount} edits before the response hit the token limit.`);
              if (result.repairable) {
                pendingRepairRef.current = {
                  prompt: text,
                  attachmentIds: sentAttachmentIds,
                  context: chapterRepairContext(result, generatedText, appliedCount),
                  appliedCount,
                  skippedCount: skipped.length,
                  truncated: Boolean(result.truncated),
                };
              }
            }
            return;
          }
          if (event.type === "lorebook_start") {
            setStoryGenerationStatus("Working");
            startLorebookThinking();
            return;
          }
          if (event.type === "lorebook_reasoning") {
            setStoryGenerationStatus("Thinking");
            appendLorebookReasoning(event.value);
            return;
          }
          if (event.type === "lorebook_content") {
            setStoryGenerationStatus("Updating Lorebook");
            markLorebookUpdating();
            return;
          }
          if (event.type === "lorebook") {
            finishLorebookThinking();
            const skippedUpdates = Array.isArray(event.value?.skipped) ? event.value.skipped : [];
            if (skippedUpdates.length) {
              showToast("Lorebook updated; some edits were skipped");
            }
            //a run that changed nothing stays quiet, the history line already covers it
            void storyApi.listLorebook(run.storyId).then(setLorebookEntries).catch((error) => {
              setStatus(error.message);
            });
          }
          if (event.type === "usage") {
            setLatestStoryGeneration(event.value || null);
          }
          if (event.type === "error") {
            streamFailed = true;
            const errorValue = event.value;
            if (errorValue?.code === "chapter_revision_conflict") {
              setStatus("Chapter changed while generation was running.");
              terminalStatus = "conflicted";
            } else {
              setStatus(chapterGenerationErrorMessage(errorValue));
              if (chapterGenerationErrorIsRepairable(errorValue)) {
                pendingRepairRef.current = {
                  prompt: text,
                  attachmentIds: sentAttachmentIds,
                  context: chapterRepairContext(errorValue, generatedText, 0),
                  appliedCount: 0,
                  skippedCount: 0,
                  truncated: errorValue?.code === "chapter_edit_truncated",
                };
              }
            }
          }
        },
      });
      run.status = "reconciling";
      setStoryGenerationStatus("Reconciling");
      await reconcileGenerationRun(run);
      run.status = terminalStatus;
      if (!streamFailed) showToast("Finished chapter");
    } catch (error) {
      if (error.generationRejected) run.generationId = null;
      if (error.name === "AbortError") {
        setStatus("Response stopped");
        terminalStatus = "aborted";
      } else {
        setStatus(error.message);
        terminalStatus = "failed";
      }
    } finally {
      if (run.status !== "reconciling") {
        run.status = "reconciling";
        setStoryGenerationStatus("Reconciling");
        try {
          await reconcileGenerationRun(run);
        } catch (error) {
          if (terminalStatus === "completed") terminalStatus = "failed";
          setStatus(error.message);
        }
      }
      run.status = terminalStatus;
      setIsStreaming(false);
      setStoryGenerationStatus("");
      setCanvasStreaming(false);
      setWriteReasoning((current) => ({
        ...current,
        streaming: false,
        durationMs:
          current.durationMs ||
          (writeReasoningStartedAtRef.current
            ? performance.now() - writeReasoningStartedAtRef.current
            : null),
      }));
      writeReasoningStartedAtRef.current = null;
      writeReasoningStreamingRef.current = false;
      //a run that dies mid lorebook would otherwise leave the label shimmering forever
      finishLorebookThinking();
      if (abortRef.current === abortController) abortRef.current = null;
      if (writeGenerationRunRef.current === run) writeGenerationRunRef.current = null;
      setStoryGenerationStatus("");
    }

    //asked only once the run has fully settled, otherwise the modal lands on top of a chapter that is still moving
    const pendingRepair = pendingRepairRef.current;
    pendingRepairRef.current = null;
    if (pendingRepair && !repairContext) offerChapterEditRepair(pendingRepair);
  }

  generateStoryChapterRef.current = generateStoryChapter;

  function offerChapterEditRepair(pendingRepair) {
    const { appliedCount, skippedCount, truncated } = pendingRepair;
    const partial = appliedCount > 0;

    const costNote = "This runs the model again and costs tokens.";
    const appliedSummary = chapterAppliedEditSummary(appliedCount, skippedCount);
    //a truncated run has no skipped count to quote, the edits it never wrote are simply absent
    const partialBody = skippedCount
      ? `${appliedSummary}. `
        + `Retry the ${skippedCount === 1 ? "one that failed" : `${skippedCount} that failed`}? ${costNote}`
      : `${appliedSummary}, `
        + `but the response hit the token limit, so anything it had not written yet is missing. `
        + `Ask for the rest? ${costNote}`;

    setConfirmDialog({
      title: partial
        ? (skippedCount ? "Some edits did not apply" : "The response was cut off")
        : "That edit could not be applied",
      tone: "neutral",
      confirmLabel: "Try again",
      busyLabel: "Retrying",
      body: partial
        ? partialBody
        : (truncated
          ? "The response hit the token limit before a complete edit came through. "
          : "The chapter is unchanged. ")
          + `Retry with the error sent back to the model? ${costNote}`,
      //through the ref, otherwise this closure still sees the isStreaming that was true when the dialog was built and the retry quietly does nothing
      onConfirm: () => {
        void generateStoryChapterRef.current?.(
          pendingRepair.prompt,
          pendingRepair.context,
          pendingRepair.attachmentIds || [],
        );
      },
    });
  }

  const landingMessage = isWritingMode ? writingOpeningMessage : openingMessage;
  const visibleMessages = activeMessages;
  const visibleActiveChatId = activeConversationId;
  const showLandingComposer = isWritingMode ? isEmptyWriting : isEmptyChat;
  const showComposer =
    !(isWritingMode && ["lorebook", "characters", "brainstorm"].includes(storyWorkspaceView) && !showLandingComposer);
  const composerAcceptsFiles =
    showComposer && !(isWritingMode && showLandingComposer) && keyStatus.has_key;
  const filesDraggedOverApp = useFileDrop({
    enabled: composerAcceptsFiles,
    onFiles: promptAttachments.addFiles,
  });

  return (
    <div className="flex h-screen overflow-hidden bg-[#080808] text-ink">
      {isWritingMode ? (
        <StoryRail
          stories={writingStories}
          chapters={chapters}
          activeStoryId={activeStoryId}
          activeChapterId={activeChapterId}
          mobileOpen={railOpen}
          onCloseMobile={() => setRailOpen(false)}
          collapsed={railCollapsed}
          onCollapse={() => setRailCollapsed(true)}
          onGoHome={() => resetChat({ mode: "write" })}
          onCreateChapter={createStoryChapter}
          onSelectStory={selectStory}
          onSelectChapter={selectChapter}
          onNewStory={() => {
            if (!isStreaming) setNewStoryDialogOpen(true);
          }}
          onImportStory={importStoryFile}
          onRenameStory={renameStoryItem}
          onExportStory={exportStoryItem}
          onRenameChapter={renameChapterItem}
          onDeleteStory={deleteStoryItem}
          onDeleteChapter={deleteChapterItem}
          onToggleChapterContext={toggleChapterContext}
          previousChatMode={previousChatMode}
          onChatModeChange={changeChatMode}
          navigationLocked={hasActiveWriteGeneration()}
        />
      ) : (
        <ConversationRail
          chats={sidebarChats}
          activeChatId={visibleActiveChatId}
          models={models}
          onNewChat={() => resetChat({ mode: chatMode })}
          onLoadChat={loadChat}
          onRenameChat={renameChat}
          namingChatId={namingChatId}
          onDeleteChat={deleteChat}
          onExportChat={exportChatFromMenu}
          onTogglePinChat={toggleChatPin}
          folders={folders}
          onCreateFolder={createFolder}
          onRenameFolder={renameFolder}
          onDeleteFolder={deleteFolder}
          onMoveChatToFolder={moveChatToFolder}
          onNewChatInFolder={createChatInFolder}
          mobileOpen={railOpen}
          onCloseMobile={() => setRailOpen(false)}
          collapsed={railCollapsed}
          onCollapse={() => setRailCollapsed(true)}
          highlightFirstChatActions={tour.currentStep?.id === "chatActions"}
          chatMode={chatMode}
          previousChatMode={previousChatMode}
          onChatModeChange={changeChatMode}
        />
      )}
      <SidebarRevealButton
        visible={railCollapsed}
        onClick={() => setRailCollapsed(false)}
      />

      <main className="relative grid min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto]">
        <header className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex items-center gap-3 bg-transparent px-4 py-4 sm:px-8 lg:px-10">
          <IconButton
            label="Open chats"
            className="pointer-events-auto lg:hidden"
            onClick={() => setRailOpen(true)}
          >
            <Menu size={18} />
          </IconButton>
          {showLandingComposer && !isWritingMode && (
            <div className="ml-auto flex items-center gap-2">
              <HelpTourButton onClick={tour.start} />
              <TemporaryChatButton
                active={temporaryChat}
                onClick={toggleTemporaryChat}
              />
            </div>
          )}
          {showLandingComposer && isWritingMode && (
            <div className="ml-auto">
              <HelpTourButton onClick={startWriteTour} />
            </div>
          )}
        </header>

        <TemporaryChatMarker visible={!isWritingMode && temporaryChat && activeChatId === tempChatId && messages.length > 0} />

        {isWritingMode && !showLandingComposer && storyWorkspaceView === "brainstorm" ? (
          <StoryBrainstorm
            story={writingStories.find((story) => story.id === activeStoryId)}
            graphNodes={brainstormNodes}
            graphEdges={brainstormEdges}
            viewport={brainstormViewport}
            prompt={brainstormPrompt}
            setPrompt={setBrainstormPrompt}
            isStreaming={isStreaming}
            disabled={!keyStatus.has_key}
            modelLabel={promptModelName(models, settings.model)}
            thinkingEnabled={effectiveThinkingEnabled(
              models, settings.model, settings.thinking_enabled,
            )}
            reasoningRequired={requiresThinking(models, settings.model)}
            thinkingStateLabel={
              effectiveThinkingEnabled(models, settings.model, settings.thinking_enabled)
                ? reasoningEffortLabel(models, settings.model, settings.reasoning_effort)
                : "Instant"
            }
            contextMeter={<ContextWindowMeter info={contextWindowInfo} />}
            onBack={() => {
              setStoryWorkspaceView("chapter");
              writeRoute(storyRoute(activeStoryId, activeChapterId, "chapter"));
            }}
            onGenerate={generateBrainstorm}
            onStop={stopStream}
            onOpenSettings={() => setSettingsOpen(true)}
            onToggleThinking={toggleThinking}
            onUpdateNode={updateBrainstormNode}
            onDeleteNode={deleteBrainstormNode}
            onUpdateViewport={updateBrainstormViewport}
            onConfirm={setConfirmDialog}
          />
        ) : isWritingMode && !showLandingComposer ? (
          <StoryWorkspace
            stories={writingStories}
            chapters={chapters}
            lorebookEntries={lorebookEntries}
            activeStoryId={activeStoryId}
            activeChapterId={activeChapterId}
            workspaceView={storyWorkspaceView}
            chapterContent={chapterContent}
            contextWindowInfo={contextWindowInfo}
            saveState={chapterSaveState}
            generationStatus={storyGenerationStatus}
            canvasStreaming={canvasStreaming}
            smoothStreaming={smoothStreaming}
            lorebookStatus={lorebookUpdating ? LOREBOOK_PHASE_LABELS[lorebookPhase] || "Working" : ""}
            writeReasoning={writeReasoning}
            lorebookReasoning={lorebookReasoning}
            lorebookThinking={lorebookThinking}
            writeEditPreview={writeEditPreview}
            canvasScrollPosition={chapterCanvasScrollPosition(activeStoryId, activeChapterId)}
            onOpenRail={() => setRailOpen(true)}
            onOpenLorebook={() => {
              setStoryWorkspaceView("lorebook");
              writeRoute(storyRoute(activeStoryId, activeChapterId, "lorebook"));
            }}
            onBackToChapter={() => {
              setStoryWorkspaceView("chapter");
              writeRoute(storyRoute(activeStoryId, activeChapterId, "chapter"));
            }}
            onCanvasScrollPositionChange={(scrollTop) => {
              rememberChapterCanvasScroll(activeStoryId, activeChapterId, scrollTop);
            }}
            onChangeContent={updateChapterCanvasContent}
            onCanvasImportFallback={(error) => {
              console.error("Chapter Markdown opened as literal text", error);
              setStatus("Some chapter formatting opened as plain Markdown so no writing was lost.");
            }}
            onCreateLorebookEntry={createLorebookEntry}
            onUpdateLorebookEntry={updateLorebookEntry}
            onDeleteLorebookEntry={deleteLorebookEntry}
            onConfirmDeleteLorebookEntry={confirmDeleteLorebookEntry}
            onRepairTimeline={repairTimeline}
            onRepairLorebook={repairLorebook}
            onGenerateLorebookEntry={generateLorebookEntry}
          />
        ) : !isWritingMode ? (
          <>
            <MessageList
              messages={visibleMessages}
              activeChatId={visibleActiveChatId}
              streamingMessageId={streamingMessageId}
              smoothStreaming={smoothStreaming}
              reasoningStreamingMessageId={reasoningStreamingMessageId}
              searchingMessageId={searchingMessageId}
              reasoningDurations={reasoningDurations}
              streamRef={streamRef}
              onScroll={markUserScroll}
              onWheel={markWheelIntent}
              onTouchStart={markTouchStart}
              onTouchMove={markTouchMove}
              onCopy={copyMessage}
              onRegenerate={regenerate}
              onEditUserMessage={editUserMessage}
              onDeleteUserMessage={deleteUserMessage}
            />

            <PromptNavigationRail
              messages={visibleMessages}
              streamRef={streamRef}
              visible={showPromptNavigationRail}
              activeChatId={visibleActiveChatId}
            />
          </>
        ) : (
          <EmptyChatState />
        )}

        {showComposer && (showLandingComposer ? (
          isWritingMode ? (
            <WriteLanding openingMessage={landingMessage} />
          ) : (
            <Composer
              value={prompt}
              setValue={setPrompt}
              disabled={!keyStatus.has_key}
              isStreaming={isStreaming}
              settings={settings}
              models={models}
              contextWindowInfo={contextWindowInfo}
              modelLocked={activeModelLocked}
              onSubmit={() => sendMessage()}
              onStop={stopStream}
              onOpenSettings={() => setSettingsOpen(true)}
              onToggleThinking={toggleThinking}
              openingMessage={landingMessage}
              variant="empty"
              forceShowThinking={tourForceThinking}
              attachments={promptAttachments.attachments}
              attachmentsUploading={promptAttachments.uploading}
              onAttachFiles={promptAttachments.addFiles}
              onRemoveAttachment={promptAttachments.removeAttachment}
              dragActive={filesDraggedOverApp}
              webSearchEnabled={settings.web_search_enabled}
              onToggleWebSearch={toggleWebSearch}
            />
          )
        ) : (
          <Composer
            value={prompt}
            setValue={setPrompt}
            disabled={!keyStatus.has_key}
            isStreaming={isStreaming}
            settings={settings}
            models={models}
            contextWindowInfo={contextWindowInfo}
            modelLocked={activeModelLocked}
            onSubmit={() => (isWritingMode ? generateStoryChapter() : sendMessage())}
            onStop={stopStream}
            onOpenSettings={() => setSettingsOpen(true)}
            onToggleThinking={toggleThinking}
            showContextMeter
            writeGenerationMode={isWritingMode ? writeGenerationMode : null}
            onToggleWriteGenerationMode={toggleWriteGenerationMode}
            writeHistoryEntries={writeHistoryEntries}
            writeHistoryTitle={`${activeChapterTitle} history`}
            onOpenLorebook={() => {
              setStoryWorkspaceView("lorebook");
              writeRoute(storyRoute(activeStoryId, activeChapterId, "lorebook"));
            }}
            onOpenBrainstorm={openBrainstorm}
            onUpdateLorebook={updateLorebookNow}
            onSetLorebookAuto={setLorebookAutoMode}
            lorebookUpdating={lorebookUpdating}
            systemPrompt={isWritingMode ? settings.system_prompt : ""}
            onSaveSystemPrompt={isWritingMode ? saveStorySystemPrompt : null}
            forceShowThinking={Boolean(writeTour.currentStep?.forceThinkingVisible)}
            tourUi={writeTour.currentStep?.composerUi || null}
            attachments={promptAttachments.attachments}
            attachmentsUploading={promptAttachments.uploading}
            onAttachFiles={promptAttachments.addFiles}
            onRemoveAttachment={promptAttachments.removeAttachment}
            dragActive={filesDraggedOverApp}
            webSearchEnabled={settings.web_search_enabled}
            onToggleWebSearch={toggleWebSearch}
          />
        ))}
      </main>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        keyStatus={keyStatus}
        onSaveKey={saveKey}
        chats={chats}
        activeChatId={activeChatId}
        models={models}
        chatMode={chatMode}
        settings={settings}
        setSettings={setSettings}
        defaultModel={defaultModel}
        generateChatName={generateChatName}
        hideFreeModels={hideFreeModels}
        nitroMode={nitroMode}
        cheapestMode={cheapestMode}
        privacyMode={privacyMode}
        zdrMode={zdrMode}
        smoothStreaming={smoothStreaming}
        showPromptNavigationRail={showPromptNavigationRail}
        modelLocked={activeModelLocked}
        onPersist={persistSettings}
        onModelSelected={(name) => showToast(`Model selected: ${name}`)}
        onSetDefaultModel={updateDefaultModel}
        onToggleGenerateChatName={updateGenerateChatName}
        onToggleHideFreeModels={updateHideFreeModels}
        onToggleNitroMode={updateNitroMode}
        onToggleCheapestMode={updateCheapestMode}
        onTogglePrivacyMode={updatePrivacyMode}
        onToggleZdrMode={updateZdrMode}
        onToggleSmoothStreaming={updateSmoothStreaming}
        onTogglePromptNavigationRail={updatePromptNavigationRail}
        onExportChats={exportChats}
        onImportChats={importChats}
        onNotify={showToast}
      />
      <ConfirmModal
        dialog={confirmDialog}
        onClose={() => {
          confirmDialog?.onCancel?.();
          setConfirmDialog(null);
        }}
      />
      <NewStoryModal
        open={newStoryDialogOpen}
        onClose={() => setNewStoryDialogOpen(false)}
        onCreate={startNewStory}
      />
      <NotificationStack notifications={notifications} />
      {tour.isActive && tour.currentStep && (
        <TourOverlay
          step={tour.currentStep}
          stepNumber={tour.stepIndex + 1}
          stepCount={tour.stepCount}
          isLastStep={tour.isLastStep}
          onNext={tour.isLastStep ? tour.finish : tour.next}
          onPrevious={tour.previous}
          onClose={tour.finish}
        />
      )}
      {writeTour.isActive && writeTour.currentStep && (
        <TourOverlay
          step={writeTour.currentStep}
          stepNumber={writeTour.stepIndex + 1}
          stepCount={writeTour.stepCount}
          isLastStep={writeTour.isLastStep}
          onNext={writeTour.isLastStep ? finishWriteTour : writeTour.next}
          onPrevious={writeTour.previous}
          onClose={finishWriteTour}
        />
      )}
    </div>
  );
}

function Root() {
  const [gate, setGate] = useState({ status: "loading", tos: null, message: "" });
  const [acceptError, setAcceptError] = useState("");

  const loadTos = useCallback(async () => {
    setGate((current) => ({ ...current, status: "loading" }));

    try {
      const tos = await api("/api/tos");
      setGate({
        status: tos.accepted ? "accepted" : "blocked",
        tos,
        message: "",
      });
    } catch (error) {
      //anything that isnt a clean "accepted" answer keeps the app shut, including the backend being down
      setGate({
        status: "unavailable",
        tos: null,
        message:
          error?.code === "api_auth_required"
            ? "Open RouterChat through its launcher to authorize this browser."
            : error?.code === "tos_missing"
              ? error.message
              : "Could not reach the RouterChat backend to load the Terms of Service.",
      });
    }
  }, []);

  useEffect(() => {
    loadTos();
  }, [loadTos]);

  const acceptTos = useCallback(async () => {
    setAcceptError("");

    try {
      const accepted = await api("/api/tos/accept", {
        method: "POST",
        body: JSON.stringify({ hash: gate.tos.hash }),
      });
      setGate({ status: "accepted", tos: accepted, message: "" });
    } catch (error) {
      if (error?.code === "tos_stale") {
        //TOS.md changed underneath us, pull the new text instead of letting them through
        setAcceptError(error.message);
        await loadTos();
        return;
      }

      setAcceptError(error?.message || "Could not record your acceptance. Try again.");
    }
  }, [gate.tos, loadTos]);

  if (gate.status === "loading") {
    return <TosLoadingScreen />;
  }

  if (gate.status === "unavailable") {
    return <TosUnavailableScreen message={gate.message} onRetry={loadTos} />;
  }

  if (gate.status === "blocked") {
    return <TosGateModal tos={gate.tos} onAccept={acceptTos} error={acceptError} />;
  }

  return <App />;
}

createRoot(document.getElementById("root")).render(<Root />);
