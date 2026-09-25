import { useEffect } from "react";

function updateFades(bar) {
  const maxScroll = bar.scrollWidth - bar.clientWidth;
  const hasStart = maxScroll > 1 && bar.scrollLeft > 1;
  const hasEnd = maxScroll > 1 && bar.scrollLeft < maxScroll - 1;

  bar.toggleAttribute("data-fade-start", hasStart);
  bar.toggleAttribute("data-fade-end", hasEnd);
}

function revealActiveTab(bar) {
  const activeTab = bar.querySelector('[aria-selected="true"]');
  if (!activeTab) return;

  const edgeRoom = 32;
  const tabStart = activeTab.offsetLeft;
  const tabEnd = tabStart + activeTab.offsetWidth;
  const viewStart = bar.scrollLeft;
  const viewEnd = viewStart + bar.clientWidth;

  if (tabStart - edgeRoom < viewStart) {
    bar.scrollTo({ left: Math.max(0, tabStart - edgeRoom), behavior: "smooth" });
  } else if (tabEnd + edgeRoom > viewEnd) {
    bar.scrollTo({ left: tabEnd + edgeRoom - bar.clientWidth, behavior: "smooth" });
  }
}

export function useScrollFade(barRef, activeKey) {
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;

    bar.setAttribute("data-scroll-fade", "");
    updateFades(bar);

    function handleScroll() {
      updateFades(bar);
    }

    const observer = new ResizeObserver(() => updateFades(bar));
    observer.observe(bar);
    bar.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      observer.disconnect();
      bar.removeEventListener("scroll", handleScroll);
    };
  }, [barRef]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    revealActiveTab(bar);
    updateFades(bar);
  }, [barRef, activeKey]);
}
