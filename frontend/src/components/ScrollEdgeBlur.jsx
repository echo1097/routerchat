import { useCallback, useEffect, useState } from "react";
import { cx } from "../uiShared.js";

export function useScrollEdges(scrollRef, watchKeys = []) {
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    const bottomOffset = element.scrollHeight - element.clientHeight - element.scrollTop;
    const next = { top: element.scrollTop > 2, bottom: bottomOffset > 2 };

    setEdges((current) => (
      current.top === next.top && current.bottom === next.bottom ? current : next
    ));
  }, [scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;

    const frame = requestAnimationFrame(measure);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);

    resizeObserver?.observe(element);
    for (const child of element.children) resizeObserver?.observe(child);
    element.addEventListener("scroll", measure, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, [measure, scrollRef, ...watchKeys]);

  return edges;
}

export function ScrollEdgeBlur({ edge = "top", visible, tone, size, className }) {
  const style = {};
  if (tone) style["--edge-tone"] = tone;
  if (size) style["--edge-size"] = `${size}px`;

  return (
    <div
      aria-hidden="true"
      className={cx("scroll-edge-blur", `is-${edge}`, visible && "is-visible", className)}
      style={style}
    >
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
