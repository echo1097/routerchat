import { useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { MaskIcon } from "../components/IconButton.jsx";
import { CONTROL_MOTION, cx } from "../uiShared.js";
import { excerptParagraphs, formatEditedAgo, storyMetaLine } from "./landingFormatting.js";

const otherStoryLimit = 4;
const longExcerptLength = 140;

const primaryPill =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full bg-neutral-100 px-4 text-sm font-semibold text-neutral-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25 disabled:cursor-not-allowed disabled:opacity-55";

const secondaryPill =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white/[0.06] px-4 text-sm font-medium text-neutral-300 hover:bg-white/[0.1] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25 disabled:cursor-not-allowed disabled:opacity-55";


function enterStyle(order) {
  return { "--landing-order": order };
}


function ResumeStory({ story, disabled, onOpenStory }) {
  const resume = story.resume || null;
  const paragraphs = excerptParagraphs(resume?.excerpt);
  const isLongExcerpt = (resume?.excerpt || "").length > longExcerptLength;
  const metaLine = storyMetaLine(story);
  const editedAgo = formatEditedAgo(story.updated_at);
  const title = story.title || "Untitled story";

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`Continue ${title}`}
      onClick={() => onOpenStory(story.id, resume?.chapter_id || null)}
      className={cx(
        "write-landing-in group mt-9 block w-full rounded-[24px] bg-[#141414] p-5 text-left ring-1 ring-inset ring-white/[0.07] hover:bg-[#161616] hover:ring-white/[0.11] focus:outline-none focus-visible:ring-white/25 disabled:cursor-not-allowed disabled:opacity-60 sm:p-6",
        "transition-[background-color,box-shadow,scale] duration-200 ease-out active:scale-[0.99]",
      )}
      style={enterStyle(1)}
    >
      <span className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 truncate text-[22px] font-semibold leading-tight tracking-[-0.012em] text-neutral-50">
          {title}
        </span>
        {editedAgo && (
          <span className="hidden shrink-0 text-[13px] font-medium tabular-nums text-neutral-500 sm:inline">
            {editedAgo}
          </span>
        )}
      </span>

      {(metaLine || editedAgo) && (
        <span className="mt-1.5 block text-[13px] tabular-nums text-neutral-400">
          {metaLine}
          {editedAgo && (
            <span className="sm:hidden">{metaLine ? ` · ${editedAgo}` : editedAgo}</span>
          )}
        </span>
      )}

      {paragraphs.length > 0 ? (
        <span
          className={cx(
            "mt-5 flex max-h-[96px] flex-col justify-end overflow-hidden",
            isLongExcerpt && "write-landing-excerpt-fade",
          )}
        >
          <span className="block whitespace-pre-line text-pretty text-[17px] leading-8 text-neutral-200">
            {paragraphs.join("\n")}
          </span>
        </span>
      ) : (
        <span className="mt-5 block text-[14px] leading-6 text-neutral-500">
          {story.synopsis?.trim() || "Nothing written yet. The first line is yours."}
        </span>
      )}

      <span className="mt-5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] text-neutral-500">
          {resume?.chapter_title ? `In ${resume.chapter_title}` : ""}
        </span>
        <span
          className={cx(
            "inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-neutral-100 pl-4 pr-3.5 text-sm font-semibold text-neutral-950 group-hover:bg-white",
            "transition-[background-color] duration-150 ease-out",
          )}
        >
          Continue
          <ArrowRight
            aria-hidden="true"
            size={16}
            strokeWidth={2.25}
            className="transition-transform duration-200 ease-out group-hover:translate-x-0.5"
          />
        </span>
      </span>
    </button>
  );
}


function OtherStories({ stories, disabled, onOpenStory }) {
  if (stories.length === 0) return null;

  return (
    <div className="write-landing-in mt-8" style={enterStyle(2)}>
      <h2 className="px-3 text-[13px] font-medium text-neutral-500">Other stories</h2>
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
                <span className="shrink-0 text-[13px] tabular-nums text-neutral-500">
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
  const isFirstStory = storiesLoaded && !latestStory;

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

        {storiesLoaded && (
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
        )}
      </div>
    </section>
  );
}
