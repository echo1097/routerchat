import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND } from "lexical";
import { Bold, Italic, RemoveFormatting } from "lucide-react";
import { cx, CONTROL_MOTION } from "../uiShared.js";

const EDGE_PADDING = 8;

//the flip decision has to happen before the toolbar has ever painted, so the height is a known constant rather than a measurement
const TOOLBAR_HEIGHT = 34;
const TOOLBAR_GAP = 10;

const HIDDEN_STATE = {
  visible: false,
  placement: "top",
  top: 0,
  left: 0,
  bold: false,
  italic: false,
};

//the update listener runs on every keystroke, so an unchanged toolbar has to keep its old state object or the whole editor re-renders as you type
function sameToolbarState(previous, next) {
  return (
    previous.visible === next.visible &&
    previous.placement === next.placement &&
    previous.top === next.top &&
    previous.left === next.left &&
    previous.bold === next.bold &&
    previous.italic === next.italic
  );
}

//the sticky canvas header lays a blurred veil over the top of the scroller, so a toolbar drawn into that band reads as clipping through it
function readCeiling(anchor) {
  const scroller = anchor.closest(".write-canvas-scroll");
  if (!scroller) return 0;

  const header = scroller.querySelector(".write-canvas-header");
  const scrollerTop = scroller.getBoundingClientRect().top;

  return header ? Math.max(header.getBoundingClientRect().bottom, scrollerTop) : scrollerTop;
}

function readSelectionRect() {
  const domSelection = window.getSelection();
  if (!domSelection || domSelection.rangeCount === 0) return null;

  const range = domSelection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  //a collapsed or freshly torn down range reports an empty box, which would pin the toolbar to the top left corner
  if (rect.width === 0 && rect.height === 0) return null;

  return rect;
}

export default function ChapterFormatToolbar({ anchorRef, readOnly }) {
  const [editor] = useLexicalComposerContext();
  const toolbarRef = useRef(null);
  const [state, setState] = useState(HIDDEN_STATE);

  const commitState = useCallback((next) => {
    setState((previous) => (sameToolbarState(previous, next) ? previous : next));
  }, []);

  const syncToolbar = useCallback(() => {
    const anchor = anchorRef.current;

    if (!anchor || readOnly || !editor.isEditable()) {
      commitState(HIDDEN_STATE);
      return;
    }

    const selection = $getSelection();

    if (!$isRangeSelection(selection) || selection.isCollapsed()) {
      commitState(HIDDEN_STATE);
      return;
    }

    if (!selection.getTextContent().trim()) {
      commitState(HIDDEN_STATE);
      return;
    }

    const selectionRect = readSelectionRect();
    if (!selectionRect) {
      commitState(HIDDEN_STATE);
      return;
    }

    //both rects are viewport relative, so the difference stays correct no matter how far the canvas has scrolled
    const anchorRect = anchor.getBoundingClientRect();
    const roomAbove = selectionRect.top - readCeiling(anchor);
    const placement = roomAbove < TOOLBAR_HEIGHT + TOOLBAR_GAP ? "bottom" : "top";
    const edge = placement === "bottom" ? selectionRect.bottom : selectionRect.top;

    commitState({
      visible: true,
      placement,
      top: edge - anchorRect.top,
      left: selectionRect.left - anchorRect.left + selectionRect.width / 2,
      bold: selection.hasFormat("bold"),
      italic: selection.hasFormat("italic"),
    });
  }, [anchorRef, commitState, editor, readOnly]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(syncToolbar);
    });
  }, [editor, syncToolbar]);

  useEffect(() => {
    if (readOnly) commitState(HIDDEN_STATE);
  }, [commitState, readOnly]);

  //the measured width is only known after the toolbar paints, so keeping it inside the canvas runs as a follow up pass
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const toolbar = toolbarRef.current;

    if (!state.visible || !anchor || !toolbar) return;

    const halfWidth = toolbar.offsetWidth / 2;
    const minLeft = halfWidth + EDGE_PADDING;
    const maxLeft = anchor.clientWidth - halfWidth - EDGE_PADDING;
    const clampedLeft = Math.min(Math.max(state.left, minLeft), Math.max(minLeft, maxLeft));

    toolbar.style.left = `${clampedLeft}px`;
  }, [anchorRef, state]);

  const keepSelection = useCallback((event) => {
    event.preventDefault();
  }, []);

  const applyFormat = useCallback(
    (format) => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
    },
    [editor],
  );

  const clearFormat = useCallback(() => {
    if (state.bold) editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
    if (state.italic) editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic");
  }, [editor, state.bold, state.italic]);

  if (!state.visible) return null;

  const isPlain = !state.bold && !state.italic;

  return (
    <div
      ref={toolbarRef}
      className="chapter-format-toolbar"
      data-placement={state.placement}
      role="toolbar"
      aria-label="Text formatting"
      style={{ top: `${state.top}px`, left: `${state.left}px` }}
      onMouseDown={keepSelection}
    >
      <ToolbarButton active={isPlain} label="Normal" onClick={clearFormat}>
        <RemoveFormatting className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      </ToolbarButton>

      <ToolbarButton active={state.bold} label="Bold" onClick={() => applyFormat("bold")}>
        <Bold className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden="true" />
      </ToolbarButton>

      <ToolbarButton active={state.italic} label="Italic" onClick={() => applyFormat("italic")}>
        <Italic className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden="true" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({ active, label, onClick, children }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "inline-flex h-7 w-7 items-center justify-center rounded-md focus:outline-none",
        active
          ? "bg-white/[0.10] text-neutral-100"
          : "text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100",
        CONTROL_MOTION,
      )}
    >
      {children}
    </button>
  );
}
