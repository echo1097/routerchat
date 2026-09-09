import { lazy, useRef, useLayoutEffect, useCallback, useEffect, Suspense } from "react";
import { useRafScroller } from "../streamScroll.js";
import StoryLorebook from "../lorebook/StoryLorebook.jsx";
import { WriteOperationStatus } from "./WriteOperationStatus.jsx";
import ChapterStreamingCanvas from "./ChapterStreamingCanvas.jsx";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { ArrowLeft } from "lucide-react";

const ChapterCanvasEditor = lazy(() => import("./ChapterCanvasEditor.jsx"));

export function StoryWorkspace({
  stories,
  chapters,
  lorebookEntries,
  activeStoryId,
  activeChapterId,
  workspaceView,
  chapterContent,
  contextWindowInfo,
  saveState,
  generationStatus,
  canvasStreaming,
  smoothStreaming,
  lorebookStatus,
  writeReasoning,
  lorebookReasoning,
  lorebookThinking,
  writeEditPreview,
  canvasScrollPosition,
  onOpenRail,
  onOpenLorebook,
  onBackToChapter,
  onCanvasScrollPositionChange,
  onChangeContent,
  onCanvasImportFallback,
  onCreateLorebookEntry,
  onUpdateLorebookEntry,
  onDeleteLorebookEntry,
  onConfirmDeleteLorebookEntry,
  onRepairTimeline,
  onRepairLorebook,
  onGenerateLorebookEntry,
}) {
  const canvasScrollRef = useRef(null);
  const generationActiveRef = useRef(false);
  const activeStory = stories.find((story) => story.id === activeStoryId);
  const activeChapter = chapters.find((chapter) => chapter.id === activeChapterId);
  const writingLocked = Boolean(generationStatus || lorebookStatus);

  const writeStatus = generationStatus || lorebookStatus;

  const statusReasoning = lorebookThinking
    ? lorebookReasoning
    : generationStatus
      ? writeReasoning
      : null;
  const statusEditPreview = lorebookThinking || !generationStatus ? null : writeEditPreview;
  const {
    markUserScroll: markCanvasScroll,
    markWheelIntent: markCanvasWheelIntent,
    markTouchStart: markCanvasTouchStart,
    markTouchMove: markCanvasTouchMove,
    scrollToBottom: scrollCanvasToBottom,
    startFollowing: startCanvasFollowing,
  } = useRafScroller(canvasScrollRef);

  useLayoutEffect(() => {
    if (workspaceView !== "chapter" || generationStatus) return undefined;

    const canvas = canvasScrollRef.current;
    if (!canvas) return undefined;

    const maxScroll = Math.max(canvas.scrollHeight - canvas.clientHeight, 0);
    const savedScrollTop = Number.isFinite(canvasScrollPosition) ? canvasScrollPosition : 0;
    canvas.scrollTop = Math.min(Math.max(savedScrollTop, 0), maxScroll);

    return undefined;

  }, [activeChapterId, activeStoryId, canvasScrollPosition, workspaceView]);

  const handleCanvasScroll = useCallback(() => {
    markCanvasScroll();

    const canvas = canvasScrollRef.current;
    if (canvas) onCanvasScrollPositionChange(canvas.scrollTop);
  }, [markCanvasScroll, onCanvasScrollPositionChange]);

  useEffect(() => {
    const generationActive = Boolean(generationStatus);
    if (generationActive && !generationActiveRef.current) {
      startCanvasFollowing();
    }
    generationActiveRef.current = generationActive;
  }, [generationStatus, startCanvasFollowing]);

  useEffect(() => {
    if (!generationStatus) return;
    scrollCanvasToBottom();
  }, [chapterContent, generationStatus, scrollCanvasToBottom]);

  if (!activeStory || !activeChapter) {
    return (
      <section className="min-h-0 overflow-y-auto px-4 py-20 sm:px-8 lg:px-10">
        <div className="mx-auto flex min-h-[65dvh] max-w-4xl flex-col items-center justify-center text-center">
          <button
            type="button"
            className="mb-6 inline-flex h-10 items-center justify-center rounded-full px-4 text-sm text-neutral-400 shadow-[var(--shadow-border)] hover:text-neutral-100 lg:hidden"
            onClick={onOpenRail}
          >
            Open stories
          </button>
          <div className="text-2xl font-medium text-neutral-100">Choose a story and chapter</div>
          <p className="mt-3 max-w-md text-sm leading-6 text-neutral-500">
            Story mode keeps prose in the chapter canvas. The chat section is separate.
          </p>
        </div>
      </section>
    );
  }

  if (workspaceView === "lorebook" || workspaceView === "characters") {
    return (
      <StoryLorebook
        story={activeStory}
        chapters={chapters}
        activeChapterId={activeChapterId}
        entries={lorebookEntries}
        onBack={onBackToChapter}
        initialCategory={workspaceView === "characters" ? "character" : "all"}
        onCreateEntry={onCreateLorebookEntry}
        onUpdateEntry={onUpdateLorebookEntry}
        onDeleteEntry={onDeleteLorebookEntry}
        onConfirmDeleteEntry={onConfirmDeleteLorebookEntry}
        onRepairTimeline={onRepairTimeline}
        onRepairLorebook={onRepairLorebook}
        onGenerateEntry={onGenerateLorebookEntry}
        locked={writingLocked}
      />
    );
  }

  return (
    <section
      data-tour="write-chapter-canvas"
      ref={canvasScrollRef}
      onScroll={handleCanvasScroll}
      onWheel={markCanvasWheelIntent}
      onTouchStart={markCanvasTouchStart}
      onTouchMove={markCanvasTouchMove}
      className="write-canvas-scroll min-h-0 overflow-y-auto overscroll-contain px-4 pb-6 sm:px-8 lg:px-10"
    >
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="write-canvas-header mb-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h1 className="m-0 block min-w-0 truncate text-left text-2xl font-semibold leading-none text-neutral-100" title={activeChapter.title}>
                {activeChapter.title}
              </h1>
              <div className="flex shrink-0 items-center gap-3 text-xs text-neutral-500">
                {writeStatus ? (
                  <WriteOperationStatus
                    status={writeStatus}
                    reasoning={statusReasoning?.text}
                    reasoningStreaming={statusReasoning?.streaming}
                    reasoningDurationMs={statusReasoning?.durationMs}
                    editPreview={statusEditPreview}
                  />
                ) : (
                  <span>{saveState || `${activeChapter.word_count || 0} words`}</span>
                )}
              </div>
            </div>
          </div>

          {canvasStreaming && smoothStreaming ? (
            <ChapterStreamingCanvas markdown={chapterContent} />
          ) : (
            <Suspense fallback={<div className="chapter-editor-loading" aria-hidden="true" />}>
              <ChapterCanvasEditor
                key={activeChapter.id}
                chapterId={activeChapter.id}
                markdown={chapterContent}
                readOnly={writingLocked}
                placeholder="Start writing here, or prompt the model to begin."
                onChange={onChangeContent}
                onImportFallback={onCanvasImportFallback}
              />
            </Suspense>
          )}
        </div>
      </div>
    </section>
  );
}

function StoryWorkspaceBackButton({ onBack }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className={cx(
        "inline-flex h-8 items-center gap-2 rounded-full bg-white/[0.035] px-3 text-xs font-medium text-neutral-300 shadow-[var(--shadow-border)] hover:bg-white/[0.06] hover:text-neutral-100 hover:shadow-[var(--shadow-border-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
        CONTROL_MOTION,
      )}
    >
      <ArrowLeft size={14} />
      Back to chapter
    </button>
  );
}
