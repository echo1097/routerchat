import { useEffect, useRef, useState } from "react";
import { useScrollFade } from "../components/useScrollFade.js";

export const WIDE_LAYOUT_QUERY = "(min-width: 900px)";

export function fitTextarea(textarea) {
  const scroller = textarea.closest(".lorebook-entry-scroll");
  const scrollTop = scroller?.scrollTop ?? 0;

  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;

  if (scroller) scroller.scrollTop = scrollTop;
}

export function useWideLayout() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_LAYOUT_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(WIDE_LAYOUT_QUERY);

    function handleChange(event) {
      setWide(event.matches);
    }

    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return wide;
}

export function useSlidingTabs(activeCategory, tabCount, active = true) {
  const tabsRef = useRef(null);
  const pillRef = useRef(null);
  const measuredRef = useRef(false);

  useScrollFade(tabsRef, activeCategory);

  useEffect(() => {
    const tabsBar = tabsRef.current;
    const pill = pillRef.current;

    if (!active) {
      measuredRef.current = false;
      return undefined;
    }

    if (!tabsBar || !pill) return undefined;

    function movePill(animate) {
      const activeTab = tabsBar.querySelector('[aria-selected="true"]');
      if (!activeTab) return;

      if (!animate) {
        const previousTransition = pill.style.transition;
        pill.style.transition = "none";
        pill.style.transform = `translateX(${activeTab.offsetLeft}px)`;
        pill.style.width = `${activeTab.offsetWidth}px`;
        void pill.offsetWidth;
        pill.style.transition = previousTransition;
        return;
      }

      pill.style.transform = `translateX(${activeTab.offsetLeft}px)`;
      pill.style.width = `${activeTab.offsetWidth}px`;
    }

    requestAnimationFrame(() => {
      movePill(measuredRef.current);
      measuredRef.current = true;
    });

    function handleWindowResize() {
      movePill(false);
    }

    let observedOnce = false;
    const observer = new ResizeObserver(() => {
      if (!observedOnce) {
        observedOnce = true;
        return;
      }

      movePill(true);
    });

    observer.observe(tabsBar);
    window.addEventListener("resize", handleWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [activeCategory, tabCount, active]);

  return { tabsRef, pillRef };
}
