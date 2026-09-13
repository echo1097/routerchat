import { useLayoutEffect, useRef, useState } from "react";

export function useCompactComposer(value, maxHeight = 126) {
  const textareaRef = useRef(null);
  const composerSurfaceRef = useRef(null);
  const leftControlsRef = useRef(null);
  const rightControlsRef = useRef(null);
  const measureRef = useRef(null);
  const [isMultiline, setIsMultiline] = useState(false);
  const isCompact = !isMultiline;

  useLayoutEffect(() => {
    function measureLines() {
      const textarea = textareaRef.current;
      const measure = measureRef.current;
      const surface = composerSurfaceRef.current;
      if (!textarea || !measure || !surface) return;

      const textStyle = getComputedStyle(textarea);
      const controlSpacing = parseFloat(getComputedStyle(surface).getPropertyValue("--compact-spacing"));
      const controlsWidth = leftControlsRef.current.offsetWidth + rightControlsRef.current.offsetWidth;
      const compactWidth = Math.max(24, surface.clientWidth - controlsWidth - controlSpacing);
      measure.style.width = compactWidth + "px";
      measure.style.font = textStyle.font;
      measure.style.letterSpacing = textStyle.letterSpacing;
      measure.textContent = value + "\u200b";
      setIsMultiline(measure.scrollHeight > parseFloat(textStyle.lineHeight) + 1);
    }

    measureLines();
    let measureFrame;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(measureFrame);
      measureFrame = requestAnimationFrame(measureLines);
    });
    [composerSurfaceRef.current, leftControlsRef.current, rightControlsRef.current].forEach((element) => {
      if (element) observer.observe(element);
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(measureFrame);
    };
  }, [value]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    function resizeTextarea() {
      textarea.style.height = "auto";
      const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = `${nextHeight}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    }

    resizeTextarea();
    let lastWidth = textarea.clientWidth;
    let resizeFrame;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === lastWidth) return;
      lastWidth = textarea.clientWidth;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resizeTextarea);
    });
    observer.observe(textarea);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
    };
  }, [maxHeight, isCompact, value]);

  return { textareaRef, composerSurfaceRef, leftControlsRef, rightControlsRef, measureRef, isCompact };
}
