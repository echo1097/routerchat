//stop turning main.jsx into even more of a dumping ground than it already is will eventually pull everthing out of there but today is not that day

export function cx(...classes) {
  return classes.filter(Boolean).join(" ");
}

export const CONTROL_MOTION =
  "transition-[background-color,border-color,box-shadow,color,scale] duration-150 ease-out active:scale-[0.96]";

export const PROMPT_BAR_CONTROL_MOTION =
  "transition-[background-color,border-color,box-shadow,color,scale] duration-[220ms] ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.96]";

export const SOFT_SURFACE =
  "shadow-[var(--shadow-border)] hover:shadow-[var(--shadow-border-hover)]";

export const FADE_MOTION = "transition-opacity duration-150 ease-out";
