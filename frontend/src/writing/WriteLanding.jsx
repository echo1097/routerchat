import { useLayoutEffect, useRef, useState } from "react";
import { MaskIcon } from "../components/IconButton.jsx";
import { CONTROL_MOTION, cx } from "../uiShared.js";
import { excerptParagraphs, formatEditedAgo, storyMetaLine } from "./landingFormatting.js";

const otherStoryLimit = 4;

const primaryPill =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full bg-neutral-100 px-4 text-sm font-semibold text-neutral-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25 disabled:cursor-not-allowed disabled:opacity-55";

const secondaryPill =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white/[0.06] px-4 text-sm font-medium text-neutral-300 hover:bg-white/[0.1] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25 disabled:cursor-not-allowed disabled:opacity-55";


function enterStyle(order) {
  return { "--landing-order": order };
}


function ExcerptWindow({ text, className }) {
  const windowRef = useRef(null);
  const textRef = useRef(null);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const windowBox = windowRef.current;
    const textBox = textRef.current;
    if (!windowBox || !textBox) return undefined;

    const checkClipped = () => setClipped(textBox.offsetHeight > windowBox.clientHeight + 1);
    checkClipped();

    const observer = new ResizeObserver(checkClipped);
    observer.observe(windowBox);
    observer.observe(textBox);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div
      ref={windowRef}
      className={cx(
        "flex max-h-[96px] flex-col justify-end overflow-hidden",
        clipped && "write-landing-excerpt-fade",
        className,
      )}
    >
      <p ref={textRef} className="shrink-0 text-pretty text-[17px] leading-8 text-neutral-200">
        {text}
      </p>
    </div>
  );
}


function ResumeStory({ story, disabled, onOpenStory }) {
  const resume = story.resume || null;
  const lastParagraph = excerptParagraphs(resume?.excerpt).at(-1) || "";
  const metaLine = storyMetaLine(story);
  const editedAgo = formatEditedAgo(story.updated_at);
  const title = story.title || "Untitled story";

  return (
    <div className="write-landing-in mt-10 w-full" style={enterStyle(1)}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-[22px] font-semibold leading-tight tracking-[-0.012em] text-neutral-50">
            {title}
          </h2>
          {(metaLine || editedAgo) && (
            <p className="mt-1.5 text-[13px] tabular-nums text-neutral-400">
              {metaLine}
              {editedAgo && (
                <span className="block sm:inline">
                  {metaLine && <span className="hidden sm:inline"> · </span>}
                  {editedAgo}
                </span>
              )}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Continue ${title}`}
          onClick={() => onOpenStory(story.id, resume?.chapter_id || null)}
          className={cx(primaryPill, "shrink-0", CONTROL_MOTION)}
        >
          Continue
        </button>
      </div>
      {lastParagraph ? (
        <ExcerptWindow text={lastParagraph} className="mt-5" />
      ) : (
        <p className="mt-5 text-[14px] leading-6 text-neutral-400">
          {story.synopsis?.trim() || "Nothing written yet. The first line is yours."}
        </p>
      )}
    </div>
  );
}


function OtherStories({ stories, disabled, onOpenStory }) {
  if (stories.length === 0) return null;

  return (
    <div className="write-landing-in -mx-3 mt-8" style={enterStyle(2)}>
      <h2 className="px-3 text-[13px] font-medium text-neutral-400">Other stories</h2>
      <ul className="mt-1.5">
        {stories.map((story) => {
          const chapterCount = Number(story.chapter_count) || 0;
          const editedAgo = formatEditedAgo(story.updated_at);
          return (
            <li key={story.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onOpenStory(story.id, story.resume?.chapter_id || null)}
                className={cx(
                  "group flex h-11 w-full items-center gap-4 rounded-xl px-3 text-left hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:opacity-60",
                  CONTROL_MOTION,
                )}
              >
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-neutral-300 group-hover:text-white">
                  {story.title || "Untitled story"}
                </span>
                <span className="shrink-0 text-[13px] tabular-nums text-neutral-400">
                  {chapterCount > 0 && (
                    <span className="hidden sm:inline">
                      {chapterCount === 1 ? "1 chapter" : `${chapterCount} chapters`}
                      {editedAgo ? " · " : ""}
                    </span>
                  )}
                  {editedAgo.replace(/^Edited /, "")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}


export function WriteLanding({
  openingMessage,
  stories = [],
  storiesLoaded = false,
  navigationLocked = false,
  onOpenStory,
  onNewStory,
  onImportStory,
}) {
  const importInputRef = useRef(null);
  const [importingStory, setImportingStory] = useState(false);

  const savedStories = stories.filter((story) => !story.temporary);
  const latestStory = savedStories[0] || null;
  const otherStories = savedStories.slice(1, 1 + otherStoryLimit);
  const isFirstStory = !latestStory;

  if (!storiesLoaded) return null;

  async function importStoryFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImportingStory(true);
    try {
      await onImportStory(file);
    } finally {
      setImportingStory(false);
    }
  }

  return (
    <section className="absolute inset-0 z-10 overflow-y-auto px-4 pb-[10vh] pt-20 sm:px-8 lg:px-10">
      <div className="mx-auto flex min-h-full w-full max-w-[600px] flex-col justify-center">
        {openingMessage && (
          <h1
            className="write-landing-in text-balance text-center text-[30px] font-medium leading-tight tracking-[-0.02em] text-neutral-200"
            style={enterStyle(0)}
          >
            {openingMessage}
          </h1>
        )}

        {isFirstStory && (
          <p
            className="write-landing-in mx-auto mt-3 max-w-[420px] text-balance text-center text-[14px] leading-6 text-neutral-400"
            style={enterStyle(1)}
          >
            Your first story gets chapters, a brainstorm canvas and a lorebook the model reads while it writes.
          </p>
        )}

        {latestStory && (
          <>
            <ResumeStory story={latestStory} disabled={navigationLocked} onOpenStory={onOpenStory} />
            <OtherStories stories={otherStories} disabled={navigationLocked} onOpenStory={onOpenStory} />
          </>
        )}

        <div
          className={cx("write-landing-in flex items-center justify-center gap-2", isFirstStory ? "mt-7" : "mt-8")}
          style={enterStyle(latestStory ? 3 : 2)}
        >
          <button
            type="button"
            disabled={navigationLocked}
            onClick={onNewStory}
            className={cx(isFirstStory ? primaryPill : secondaryPill, CONTROL_MOTION)}
          >
            <MaskIcon src="/icons/newbook.png" size={16} />
            New story
          </button>
          <button
            type="button"
            disabled={navigationLocked || importingStory}
            onClick={() => importInputRef.current?.click()}
            className={cx(secondaryPill, CONTROL_MOTION)}
          >
            <MaskIcon src="/icons/file-import.png" size={15} />
            {importingStory ? "Importing story" : "Import story"}
          </button>
          <input
            ref={importInputRef}
            type="file"
            aria-label="Choose a story file to import"
            accept=".json,application/json"
            className="hidden"
            onChange={importStoryFile}
          />
        </div>
      </div>
    </section>
  );
}
