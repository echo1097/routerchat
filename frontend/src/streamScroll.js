import { useCallback, useEffect, useRef } from "react";

//follow the bottom of a streaming box until the reader scrolls up, then leave them alone until they
//come back down, lives here so the lorebook can use the same feel as write mode
export function useRafScroller(streamRef, followThreshold = 120) {
  const followRef = useRef(true);
  const rafRef = useRef(null);
  const touchYRef = useRef(null);
  const lastScrollTopRef = useRef(null);

  const isNearBottom = useCallback(() => {
    const node = streamRef.current;
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight < followThreshold;
  }, [followThreshold, streamRef]);

  const cancelScrollFrame = useCallback(() => {
    if (!rafRef.current) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const pauseAutoFollow = useCallback(() => {
    followRef.current = false;
    cancelScrollFrame();
  }, [cancelScrollFrame]);

  const markUserScroll = useCallback(() => {
    const node = streamRef.current;
    if (!node) return;

    const lastScrollTop = lastScrollTopRef.current;
    const movedUp = typeof lastScrollTop === "number" && node.scrollTop < lastScrollTop - 1;
    if (movedUp) {
      followRef.current = false;
    } else if (isNearBottom()) {
      followRef.current = true;
    }
    lastScrollTopRef.current = node.scrollTop;
  }, [isNearBottom, streamRef]);

  const markWheelIntent = useCallback(
    (event) => {
      if (event.deltaY < 0) pauseAutoFollow();
    },
    [pauseAutoFollow],
  );

  const markTouchStart = useCallback((event) => {
    touchYRef.current = event.touches?.[0]?.clientY ?? null;
  }, []);

  const markTouchMove = useCallback(
    (event) => {
      const nextY = event.touches?.[0]?.clientY;
      if (typeof nextY !== "number" || typeof touchYRef.current !== "number") return;
      if (nextY > touchYRef.current) pauseAutoFollow();
      touchYRef.current = nextY;
    },
    [pauseAutoFollow],
  );

  const scrollToBottom = useCallback(
    (force = false) => {
      if (!force && !followRef.current) return;
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (!force && !followRef.current) return;
        const node = streamRef.current;
        if (node) {
          node.scrollTop = node.scrollHeight;
          lastScrollTopRef.current = node.scrollTop;
        }
      });
    },
    [streamRef],
  );

  const startFollowing = useCallback(() => {
    followRef.current = true;
    scrollToBottom(true);
  }, [scrollToBottom]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return {
    isNearBottom,
    markUserScroll,
    markWheelIntent,
    markTouchStart,
    markTouchMove,
    scrollToBottom,
    startFollowing,
    followRef,
  };
}
