import { useRef, useState, useEffect } from "react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { Search, X } from "lucide-react";

export function SearchClearField({ value, onChange, placeholder }) {
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const mirrorRef = useRef(null);
  const placeholderRef = useRef(null);
  const glowRef = useRef(null);
  const [isClearing, setIsClearing] = useState(false);
  const clearingRef = useRef(false);
  const frameRef = useRef(null);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  function readNumber(name, fallback) {
    const value = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(name),
    );
    return Number.isFinite(value) ? value : fallback;
  }

  function clearSearch() {
    if (!value || clearingRef.current) return;
    const wrap = wrapRef.current;
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    const phold = placeholderRef.current;
    const glow = glowRef.current;
    if (!wrap || !input || !mirror || !phold || !glow) {
      onChange("");
      return;
    }

    clearingRef.current = true;
    setIsClearing(true);
    mirror.textContent = value.replace(/ /g, "\u00a0");
    wrap.classList.add("is-clearing");
    onChange("");

    const total = readNumber("--clear-dur", 1000);
    const outDur = readNumber("--clear-out-dur", 400);
    const inDur = readNumber("--clear-in-dur", 400);
    const outFly = readNumber("--clear-out-fly", 12);
    const inFly = readNumber("--clear-in-fly", 12);
    const blur = readNumber("--clear-blur", 2);
    const glowDelay = readNumber("--glow-delay", 50);
    const glowPeakAt = readNumber("--glow-peak-at", 0.15);
    const glowOpacity = readNumber("--glow-opacity", 0.85);

    glow.style.background = "radial-gradient(ellipse 70% 18px at 50% 100%, rgba(255,255,255,0.22), transparent)";
    phold.style.transform = `translateY(-${inFly}px)`;
    phold.style.opacity = "0.9";
    phold.style.filter = `blur(${blur}px)`;

    const start = performance.now();
    function tick(now) {
      const elapsed = now - start;
      const outProgress = Math.min(1, elapsed / outDur);
      const inProgress = Math.min(1, elapsed / inDur);
      const easedOut = 1 - Math.pow(1 - outProgress, 3);
      const easedIn = 1 - Math.pow(1 - inProgress, 3);

      mirror.style.transform = `translateY(${(easedOut * outFly).toFixed(1)}px)`;
      mirror.style.opacity = (1 - easedOut).toFixed(3);
      mirror.style.filter = `blur(${(easedOut * blur).toFixed(1)}px)`;
      phold.style.transform = `translateY(${(-inFly + easedIn * inFly).toFixed(1)}px)`;
      phold.style.opacity = (0.9 + easedIn * 0.1).toFixed(3);
      phold.style.filter = `blur(${(blur - easedIn * blur).toFixed(1)}px)`;

      let nextGlow = 0;
      if (elapsed > glowDelay) {
        const glowProgress = Math.min(1, (elapsed - glowDelay) / Math.max(1, total - glowDelay));
        nextGlow = glowProgress < glowPeakAt
          ? glowProgress / glowPeakAt
          : 1 - (glowProgress - glowPeakAt) / (1 - glowPeakAt);
      }
      glow.style.opacity = (nextGlow * glowOpacity).toFixed(3);

      if (elapsed < total) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }

      frameRef.current = null;
      wrap.classList.remove("is-clearing");
      setIsClearing(false);
      [mirror, phold, glow].forEach((node) => {
        node.removeAttribute("style");
      });
      mirror.textContent = "";
      clearingRef.current = false;
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
    }

    frameRef.current = requestAnimationFrame(tick);
  }

  return (
    <div
      ref={wrapRef}
      className={cx(
        "cloud-search t-clear flex h-10 items-center gap-2 rounded-xl bg-black/20 px-3 text-neutral-500 shadow-[var(--shadow-border)] transition-[background-color,box-shadow] duration-150 ease-out focus-within:bg-black/25 focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.16)]",
        value && "has-value",
        isClearing && "is-clearing",
      )}
    >
      <Search size={15} className="relative z-[4] shrink-0" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        data-1p-ignore="true"
        className="relative z-[4] min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none placeholder:text-transparent"
      />
      <div ref={mirrorRef} className="t-clear-mirror" aria-hidden="true">
        {value}
      </div>
      <div ref={placeholderRef} className="t-clear-placeholder" aria-hidden="true">
        {placeholder}
      </div>
      <div ref={glowRef} className="t-clear-glow" aria-hidden="true" />
      <button
        type="button"
        aria-label="Clear chat search"
        onMouseDown={(event) => event.preventDefault()}
        onClick={clearSearch}
        className={cx(
          "t-clear-btn relative z-[4] grid h-7 w-7 shrink-0 place-items-center rounded-full text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
          CONTROL_MOTION,
          !value && "pointer-events-none opacity-0",
        )}
      >
        <X size={13} />
      </button>
    </div>
  );
}
