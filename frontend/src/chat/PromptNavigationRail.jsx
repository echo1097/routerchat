import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { truncatePromptText } from "../textFormatting.js";
import { cx } from "../uiShared.js";

export function PromptNavigationRail({ messages, streamRef, visible, activeChatId }) {
  const railRef = useRef(null);
  const frameRef = useRef(null);
  const [railItems, setRailItems] = useState([]);
  const [activePromptId, setActivePromptId] = useState(null);
  const [previewPromptId, setPreviewPromptId] = useState(null);

  const promptMessages = useMemo(
    () => messages.filter((message) => message.role === "user"),
    [messages],
  );

  const measureRail = useCallback(() => {
    frameRef.current = null;

    const scroller = streamRef.current;
    const rail = railRef.current;
    if (!visible || !activeChatId || !scroller || !rail || promptMessages.length === 0) {
      setRailItems([]);
      setActivePromptId(null);
      return;
    }

    const railPadding = 12;
    const railHeight = Math.max(rail.clientHeight - railPadding * 2, 1);
    const railCenter = railPadding + railHeight / 2;
    const promptGap = 8;
    const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 1);
    const activeLine = scroller.scrollTop + scroller.clientHeight * 0.5;
    const scrollerTop = scroller.getBoundingClientRect().top;

    const messageNodes = Array.from(scroller.querySelectorAll("[data-message-id]"));

    const baseItems = promptMessages.map((message, index) => {
      const node = messageNodes.find(
        (messageNode) => messageNode.dataset.messageId === String(message.id),
      );
      if (!node) return null;

      const nodeTop = node.getBoundingClientRect().top;
      const scrollTop = Math.min(
        Math.max(scroller.scrollTop + nodeTop - scrollerTop - 24, 0),
        maxScroll,
      );
      const previewText = truncatePromptText(message.content);

      return {
        id: message.id,
        index,
        scrollTop,
        previewText,
      };
    }).filter(Boolean);

    if (baseItems.length === 0) {
      setRailItems([]);
      setActivePromptId(null);
      return;
    }

    let activeIndex = 0;
    let nextActiveId = baseItems[0]?.id || null;
    for (const [itemIndex, item] of baseItems.entries()) {
      if (item.scrollTop <= activeLine) {
        nextActiveId = item.id;
        activeIndex = itemIndex;
      }
    }

    const maxVisibleCount = Math.max(Math.floor(railHeight / promptGap), 1);
    const visibleCount = Math.min(baseItems.length, maxVisibleCount);
    const visibleCenter = (visibleCount - 1) / 2;
    const maxStartIndex = Math.max(baseItems.length - visibleCount, 0);
    const startIndex = Math.min(
      Math.max(Math.round(activeIndex - visibleCenter), 0),
      maxStartIndex,
    );
    const visibleItems = baseItems.slice(startIndex, startIndex + visibleCount);

    const nextItems = visibleItems.map((item, visibleIndex) => ({
      ...item,
      top: railCenter + (visibleIndex - visibleCenter) * promptGap,
    }));

    setRailItems(nextItems);
    setActivePromptId(nextActiveId);
  }, [activeChatId, promptMessages, streamRef, visible]);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(measureRail);
  }, [measureRail]);

  useEffect(() => {
    scheduleMeasure();
  }, [messages, scheduleMeasure]);

  useEffect(() => {
    const scroller = streamRef.current;
    const rail = railRef.current;
    if (!visible || !scroller || !rail) return undefined;

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(scroller);
    observer.observe(rail);
    if (scroller.firstElementChild) {
      observer.observe(scroller.firstElementChild);
    }

    scroller.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [scheduleMeasure, streamRef, visible]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  if (!visible || promptMessages.length === 0) return null;

  function jumpToPrompt(item) {
    const scroller = streamRef.current;
    if (!scroller) return;

    const messageNode = Array.from(
      scroller.querySelectorAll('[data-message-role="user"]'),
    ).find((node) => node.dataset.messageId === String(item.id));
    if (!messageNode) return;

    const scrollerTop = scroller.getBoundingClientRect().top;
    const messageTop = messageNode.getBoundingClientRect().top;
    const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
    const scrollTop = Math.min(
      Math.max(scroller.scrollTop + messageTop - scrollerTop - 24, 0),
      maxScroll,
    );
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const nearbyPrompt = (
      Math.abs(scrollTop - scroller.scrollTop) <= scroller.clientHeight * 2
    );

    scroller.scrollTo({
      top: scrollTop,
      behavior: !reducedMotion && nearbyPrompt ? "smooth" : "auto",
    });
  }

  return (
    <nav className="prompt-nav-rail-wrap" aria-label="Prompt navigation">
      <div
        ref={railRef}
        className="prompt-nav-rail"
        onMouseLeave={() => {
          setPreviewPromptId(null);
        }}
      >
        {railItems.map((item) => {
          const active = item.id === activePromptId;
          const previewing = item.id === previewPromptId;

          return (
            <button
              key={item.id}
              type="button"
              aria-label={`Jump to prompt ${item.index + 1}: ${item.previewText}`}
              onClick={() => jumpToPrompt(item)}
              onMouseEnter={() => setPreviewPromptId(item.id)}
              onMouseLeave={() => setPreviewPromptId(null)}
              onFocus={() => setPreviewPromptId(item.id)}
              onBlur={() => setPreviewPromptId(null)}
              className={cx(
                "prompt-nav-tick",
                active && "is-active",
                previewing && "is-previewing",
              )}
              style={{ top: `${item.top}px` }}
            >
              <span aria-hidden="true" className="prompt-nav-line" />
              <span
                className={cx(
                  "prompt-nav-preview",
                  previewing && "is-open",
                )}
              >
                {item.previewText}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
