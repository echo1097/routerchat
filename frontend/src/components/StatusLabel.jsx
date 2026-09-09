import { useTextSwap } from "../textSwap.js";
import { cx } from "../uiShared.js";

export function StatusLabel({ label, shimmering }) {
  const { shownText, textRef } = useTextSwap(label);

  return (
    <span
      ref={textRef}
      className={cx("t-text-swap", shimmering && "t-shimmer")}
      data-text={shownText}
    >
      {shownText}
    </span>
  );
}
