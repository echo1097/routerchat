import { cx, CONTROL_MOTION } from "./uiShared.js";

// styled to match the temp chat toggle right next to it, same circle,
// same motion, just a different icon and it kicks off the guided tour
function HelpTourButton({ onClick }) {
  return (
    <button
      type="button"
      aria-label="Start help tour"
      title="Start help tour"
      onClick={onClick}
      className={cx(
        "pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full text-[17px] leading-none text-zinc-400 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        CONTROL_MOTION,
      )}
    >
      <i className="fi fi-rs-interrogation" aria-hidden="true" />
    </button>
  );
}

export default HelpTourButton;
