import { ArrowLeft, Maximize, Minus, Plus } from "lucide-react";
import { CONTROL_MOTION, cx } from "../uiShared.js";

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export default function BrainstormBar({
  storyTitle,
  promptCount,
  ideaCount,
  tidyDisabled,
  onBack,
  onTidy,
  onZoomIn,
  onZoomOut,
  onFit,
}) {
  return (
    <header className="brainstorm-bar">
      <button
        type="button"
        onClick={onBack}
        className={cx("brainstorm-round-button", CONTROL_MOTION)}
        aria-label="Back to chapter"
        title="Back to chapter"
      >
        <ArrowLeft size={17} />
      </button>

      <div className="brainstorm-bar-title">
        <h1>Brainstorm</h1>
        {storyTitle && <span>{storyTitle}</span>}
      </div>

      <div className="brainstorm-bar-tools">
        {promptCount > 0 && (
          <span className="brainstorm-bar-count tabular-nums">
            {countLabel(promptCount, "prompt", "prompts")} · {countLabel(ideaCount, "idea", "ideas")}
          </span>
        )}
        <button
          type="button"
          onClick={onTidy}
          disabled={tidyDisabled}
          className={cx("brainstorm-bar-pill", CONTROL_MOTION)}
          title="Lay out every prompt and idea so nothing overlaps"
        >
          Tidy up
        </button>
        <div className="brainstorm-zoom">
          <button type="button" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out">
            <Minus size={15} />
          </button>
          <button type="button" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in">
            <Plus size={15} />
          </button>
          <button type="button" onClick={onFit} aria-label="Fit everything" title="Fit everything">
            <Maximize size={14} />
          </button>
        </div>
      </div>
    </header>
  );
}
