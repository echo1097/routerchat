import { useEffect, useRef, useState } from "react";

//swap a short status label in place, blur out the old word then blur the new one back in, the timing
//comes from --text-swap-dur so css owns the feel
export function useTextSwap(text) {
  const [shownText, setShownText] = useState(text);
  const textRef = useRef(null);

  useEffect(() => {
    if (text === shownText) return undefined;

    const node = textRef.current;
    if (!node) {
      setShownText(text); //nothing on screen to animate, so dont let the label go stale
      return undefined;
    }

    const runTime = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--text-swap-dur"),
    ) || 150;

    node.classList.add("is-exit");
    const timeoutId = window.setTimeout(() => {
      setShownText(text);
      node.classList.remove("is-exit");
      node.classList.add("is-enter-start");
      void node.offsetHeight; // reflow tax, thrilling stuff
      node.classList.remove("is-enter-start");
    }, runTime);

    return () => window.clearTimeout(timeoutId);
  }, [shownText, text]);

  return { shownText, textRef };
}
