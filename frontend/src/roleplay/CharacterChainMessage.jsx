import { useMemo } from "react";
import { cx } from "../uiShared.js";
import { MarkdownContent } from "../chat/MarkdownContent.jsx";
import { characterColor, splitChainMessages, withHardBreaks } from "./characterChain.js";
import "./CharacterBook.css";

export function CharacterChainMessage({ content, characters }) {
  const speakers = useMemo(() => {
    const map = {};
    characters.forEach((character, index) => {
      map[String(character.name || "").toLowerCase()] = {
        name: character.name,
        color: characterColor(character, index),
      };
    });
    return map;
  }, [characters]);

  const bubbles = useMemo(
    () => splitChainMessages(content, characters),
    [content, characters],
  );

  return (
    <div className="flex flex-col">
      {bubbles.map((bubble, index) => {
        const speaker = bubble.speaker ? speakers[bubble.speaker.toLowerCase()] : null;
        const previous = bubbles[index - 1];
        const repeatedSpeaker = Boolean(
          speaker && previous?.speaker && previous.speaker === bubble.speaker,
        );

        return (
          <div
            key={index}
            className={cx("character-bubble flex flex-col items-start", repeatedSpeaker && "is-continued")}
          >
            {speaker && !repeatedSpeaker && (
              <span className="character-speaker" style={{ color: speaker.color }}>
                <span
                  className="character-speaker-dot"
                  style={{ background: speaker.color }}
                  aria-hidden="true"
                />
                {speaker.name}
              </span>
            )}
            <div
              className={cx(
                "character-bubble-body w-fit max-w-full rounded-[22px] text-pretty text-[15px] leading-7",
                speaker
                  ? "bg-[#1d1d1d] px-4 py-3 text-neutral-100"
                  : "px-0 py-0 text-neutral-400",
              )}
            >
              <MarkdownContent>{withHardBreaks(bubble.content)}</MarkdownContent>
            </div>
          </div>
        );
      })}
    </div>
  );
}
