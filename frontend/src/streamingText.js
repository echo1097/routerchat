import { useEffect, useRef, useState } from "react";

const WORD_CLASS = "t-stream-w";
const SKIP_TAGS = new Set(["pre", "code"]);

//how long the reveal gets to swallow a burst, a fast model can dump a whole paragraph at once and the
//cursor takes bigger bites rather than ticking faster than a frame
const CATCHUP_MS = 600;

//words that have already settled get stamped at render time, the ticker below only has to handle the
//ones that arrived since the last tick
export function streamWordsPlugin(settledRef) {
  return function attachStreamWords() {
    return function splitIntoWords(tree) {
      let wordIndex = 0;

      function wrapText(node) {
        const pieces = node.value.split(/(\s+)/).filter((piece) => piece !== "");

        return pieces.map((piece) => {
          if (/^\s+$/.test(piece)) return { type: "text", value: piece };

          const alreadyIn = wordIndex < (settledRef.current || 0);
          wordIndex += 1;

          return {
            type: "element",
            tagName: "span",
            properties: { className: alreadyIn ? [WORD_CLASS, "is-in"] : [WORD_CLASS] },
            children: [{ type: "text", value: piece }],
          };
        });
      }

      function walk(node) {
        if (!node.children) return;
        //code keeps its whitespace, wrapping it would wreck the formatting
        if (node.type === "element" && SKIP_TAGS.has(node.tagName)) return;

        const nextChildren = [];
        node.children.forEach((child) => {
          if (child.type === "text") {
            nextChildren.push(...wrapText(child));
            return;
          }
          walk(child);
          nextChildren.push(child);
        });
        node.children = nextChildren;
      }

      walk(tree);
    };
  };
}

export function countWords(text) {
  if (!text) return 0;
  const found = text.match(/\S+/g);

  return found ? found.length : 0;
}

//cut the markdown itself rather than hiding the tail, an invisible word still takes up its line and a
//whole unrevealed backlog would reserve a page of empty space under the cursor
export function takeWords(text, wordCount) {
  if (!text || wordCount <= 0) return "";
  if (wordCount >= countWords(text)) return text;

  const pattern = /\S+/g;
  let seen = 0;
  let cut = 0;
  let match = pattern.exec(text);

  while (match) {
    seen += 1;
    cut = match.index + match[0].length;
    if (seen >= wordCount) break;
    match = pattern.exec(text);
  }

  return text.slice(0, cut);
}

function prefersLessMotion() {
  if (typeof window === "undefined") return false;

  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

//walk a cursor through the words at a steady --stream-gap no matter how bursty the model is, and hand
//back only the text the cursor has reached so layout grows a word at a time, revealing stays true past
//the end of the stream until the cursor has drained the backlog
export function useStreamReveal(containerRef, active, fullText, settledRef) {
  const [revealed, setRevealed] = useState(0);
  const revealedRef = useRef(0);
  const totalRef = useRef(0);
  const startedRef = useRef(false);

  const total = countWords(fullText);
  totalRef.current = total;

  if (active) startedRef.current = true;

  //once the model stops we keep pacing until the cursor has caught up, otherwise the tail of a reply
  //would snap in all at once the moment the stream closes
  const stillCatchingUp = startedRef.current && revealedRef.current < total;
  const paced = (Boolean(active) || stillCatchingUp) && !prefersLessMotion();

  useEffect(() => {
    if (!paced) return undefined;

    const gap = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--stream-gap"),
    ) || 60;

    let timeoutId = null;

    function tick() {
      const node = containerRef.current;

      if (node) {
        //everything on screen has had a frame to fade, so let it hold its resolved state through the
        //next render instead of animating again
        const spans = node.querySelectorAll(`.${WORD_CLASS}`);
        spans.forEach((span) => span.classList.add("is-in"));
        settledRef.current = spans.length;
      }

      const backlog = totalRef.current - revealedRef.current;

      if (backlog > 0) {
        const step = Math.max(1, Math.ceil((backlog * gap) / CATCHUP_MS));

        revealedRef.current = Math.min(totalRef.current, revealedRef.current + step);
        setRevealed(revealedRef.current);
      }

      timeoutId = window.setTimeout(tick, gap);
    }

    timeoutId = window.setTimeout(tick, gap);

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [paced, containerRef, settledRef]);

  if (!paced) {
    settledRef.current = Number.MAX_SAFE_INTEGER;
    revealedRef.current = total;

    return { text: fullText, revealing: false };
  }

  return { text: takeWords(fullText, revealed), revealing: true };
}
