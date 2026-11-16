const betaNote = "Phone access is a beta feature and might have bugs. If something goes wrong, please report it on GitHub.";

export function BetaPill() {
  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        aria-describedby="phone-beta-note"
        className="inline-flex h-5 cursor-default items-center rounded-full bg-amber-300/15 px-2 text-[11px] font-semibold text-amber-200 focus:outline-none"
      >
        Beta
      </span>

      <span
        id="phone-beta-note"
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-20 mt-2 w-60 rounded-xl border border-white/10 bg-[#1f1f1f] px-3 py-2 text-pretty text-[12px] font-normal leading-[18px] tracking-normal text-neutral-300 opacity-0 shadow-lg transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        {betaNote}
      </span>
    </span>
  );
}
