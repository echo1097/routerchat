import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { ArrowLeft, Check, ChevronDown, Copy, Edit3, RefreshCw, Square, Trash2, X } from "lucide-react";
import "@xyflow/react/dist/style.css";
import "./StoryBrainstorm.css";
import ThinkingContent from "../ThinkingContent.jsx";
import { CONTROL_MOTION, cx } from "../uiShared.js";

function brainstormDurationLabel(node) {
  let durationMs = Number(node.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    const createdAt = Date.parse(node.created_at || "");
    const updatedAt = Date.parse(node.updated_at || "");
    durationMs = Number.isFinite(createdAt) && Number.isFinite(updatedAt)
      ? updatedAt - createdAt
      : 0;
  }

  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

// same edge treatment the model picker uses: the fade only shows on the side that still has content
function NodeText({ className, children }) {
  const scrollRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);

  function updateEdges(element) {
    const bottomOffset = element.scrollHeight - element.clientHeight - element.scrollTop;
    setScrolled(element.scrollTop > 2);
    setHasMoreBelow(bottomOffset > 2);
  }

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const frame = requestAnimationFrame(() => updateEdges(node));
    return () => cancelAnimationFrame(frame);
  }, [children]);

  return (
    <div className="brainstorm-scroll">
      <p
        ref={scrollRef}
        className={className}
        onScroll={(event) => updateEdges(event.currentTarget)}
      >
        {children}
      </p>
      <div
        aria-hidden="true"
        className={cx("brainstorm-scroll-fade is-top", scrolled && "is-visible")}
      />
      <div
        aria-hidden="true"
        className={cx("brainstorm-scroll-fade is-bottom", hasMoreBelow && "is-visible")}
      />
    </div>
  );
}

function useCopyAction(getText) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef(null);

  useEffect(() => () => window.clearTimeout(resetRef.current), []);

  async function copy() {
    await navigator.clipboard.writeText(getText());
    setCopied(true);
    window.clearTimeout(resetRef.current);
    resetRef.current = window.setTimeout(() => setCopied(false), 1600);
  }

  return [copied, copy];
}

function PromptNode({ data }) {
  const failed = data.status === "failed" || data.status === "cancelled";
  const actionsLocked = Boolean(data.operationInProgress);
  const isGenerating = data.status === "generating";
  const isThinking = isGenerating && data.generation_phase === "thinking";
  const isWorking = isGenerating && data.generation_phase === "working";
  const isWaiting = isGenerating && !isThinking && !isWorking;
  const hasThinking = Boolean(data.reasoning) || isThinking;
  const showPlainStatus = (isWaiting || isWorking) && !hasThinking;
  const plainStatusLabel = isWaiting ? "Working" : "Writing";
  let operationLabel = "Thinking";
  if (isWorking) operationLabel = "Writing";
  if (data.status === "complete") {
    operationLabel = `Finished in ${brainstormDurationLabel(data)}`;
  }
  const [thinkingOpen, setThinkingOpen] = useState(isThinking);
  let thinkingAriaLabel = thinkingOpen ? "Collapse thinking" : "Expand thinking";
  if (isWorking) thinkingAriaLabel = "Writing in progress";
  if (isThinking) thinkingAriaLabel = "Thinking in progress";
  const thinkingScrollRef = useRef(null);
  const followThinkingRef = useRef(true);
  const [copied, copyPrompt] = useCopyAction(() => data.content);

  useEffect(() => {
    if (isThinking) {
      followThinkingRef.current = true;
      setThinkingOpen(true);
      return;
    }

    if (isWorking) {
      setThinkingOpen(false);
      return;
    }

    if (!isGenerating) setThinkingOpen(false);
  }, [isGenerating, isThinking, isWorking]);

  useEffect(() => {
    const scrollNode = thinkingScrollRef.current;
    if (!thinkingOpen || !scrollNode || !followThinkingRef.current) return;
    scrollNode.scrollTop = scrollNode.scrollHeight;
  }, [data.reasoning, thinkingOpen]);

  return (
    <article className={cx("brainstorm-node brainstorm-prompt-node", failed && "is-failed")}>
      {data.hasIncomingEdge && (
        <Handle type="target" position={Position.Left} className="brainstorm-handle" />
      )}
      <div className="brainstorm-node-eyebrow">
        <span>{failed ? data.status : "Your prompt"}</span>
        <div className="brainstorm-node-actions nodrag">
          <button
            type="button"
            onClick={copyPrompt}
            aria-label="Copy prompt"
            title={copied ? "Copied" : "Copy prompt"}
          >
            {copied ? <Check size={17} /> : <Copy size={17} />}
          </button>
          <button
            type="button"
            onClick={data.onRetry}
            disabled={actionsLocked || data.generateDisabled}
            aria-label="Regenerate prompt"
            title={data.generateDisabled ? "Add an API key to regenerate" : "Regenerate prompt"}
          >
            <RefreshCw size={17} />
          </button>
          <button
            type="button"
            onClick={data.onDelete}
            disabled={actionsLocked}
            aria-label="Delete prompt"
            title="Delete prompt"
          >
            <Trash2 size={17} />
          </button>
        </div>
      </div>
      <NodeText className="brainstorm-prompt-content nowheel">{data.content}</NodeText>
      {showPlainStatus && (
        <div className="brainstorm-writing-status">
          <span className="brainstorm-thinking-label t-shimmer" data-text={plainStatusLabel}>
            {plainStatusLabel}
          </span>
        </div>
      )}
      {hasThinking && (
        <div
          className={cx("brainstorm-thinking nodrag nopan", thinkingOpen && "is-open")}
        >
          <button
            type="button"
            className="brainstorm-thinking-trigger nodrag nopan"
            onClick={() => {
              if (isGenerating) return;
              followThinkingRef.current = true;
              setThinkingOpen((open) => !open);
            }}
            disabled={isGenerating}
            aria-expanded={thinkingOpen}
            aria-label={thinkingAriaLabel}
          >
            <span
              className={cx("brainstorm-thinking-label", isGenerating && "t-shimmer")}
              data-text={isGenerating ? operationLabel : undefined}
            >
              {operationLabel}
            </span>
            {!isGenerating && <ChevronDown size={14} aria-hidden="true" />}
          </button>
          <div
            className="brainstorm-thinking-panel"
            aria-hidden={!thinkingOpen}
            inert={thinkingOpen ? undefined : ""}
          >
            <div
              ref={thinkingScrollRef}
              className="brainstorm-thinking-content nodrag nopan nowheel"
              onScroll={(event) => {
                const node = event.currentTarget;
                const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
                followThinkingRef.current = distanceFromBottom < 24;
              }}
            >
              <ThinkingContent>{data.reasoning}</ThinkingContent>
            </div>
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="brainstorm-handle" />
    </article>
  );
}

function IdeaNode({ data, selected }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(data.title);
  const [content, setContent] = useState(data.content);
  const [copied, copyIdea] = useCopyAction(() => `${data.title}\n-\n${data.content}`);

  useEffect(() => {
    if (editing) return;
    setTitle(data.title);
    setContent(data.content);
  }, [data.content, data.title, editing]);

  async function saveEdit() {
    const nextTitle = title.trim();
    const nextContent = content.trim();
    if (!nextTitle || !nextContent) return;
    await data.onSave({ title: nextTitle, content: nextContent });
    setEditing(false);
  }

  return (
    <article className={cx("brainstorm-node brainstorm-idea-node", selected && "is-selected")}>
      <Handle type="target" position={Position.Left} className="brainstorm-handle" />
      {editing ? (
        <div className="brainstorm-edit-form nodrag">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Idea title"
            data-1p-ignore="true"
          />
          <textarea
            className="nowheel"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            aria-label="Idea details"
            data-1p-ignore="true"
            rows={5}
          />
          <div className="brainstorm-edit-actions">
            <button type="button" onClick={() => setEditing(false)} aria-label="Cancel edit">
              <X size={16} />
            </button>
            <button type="button" onClick={saveEdit} aria-label="Save idea">
              <Check size={16} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="brainstorm-node-eyebrow">
            <span>Idea</span>
            <div className="brainstorm-node-actions nodrag">
              <button
                type="button"
                onClick={copyIdea}
                aria-label="Copy idea"
                title={copied ? "Copied" : "Copy idea"}
              >
                {copied ? <Check size={17} /> : <Copy size={17} />}
              </button>
              <button type="button" onClick={() => setEditing(true)} aria-label="Edit idea" title="Edit idea">
                <Edit3 size={17} />
              </button>
              <button
                type="button"
                onClick={data.onDelete}
                disabled={data.operationInProgress}
                aria-label="Delete idea"
                title="Delete idea"
              >
                <Trash2 size={17} />
              </button>
            </div>
          </div>
          <h2>{data.title}</h2>
          <NodeText className="brainstorm-idea-content nowheel">{data.content}</NodeText>
        </>
      )}
      <Handle type="source" position={Position.Right} className="brainstorm-handle" />
    </article>
  );
}

function brainstormEdgePath(sourceX, sourceY, targetX, targetY) {
  const deltaX = targetX - sourceX;
  const deltaY = targetY - sourceY;
  const spanX = Math.max(Math.abs(deltaX), 1);
  const spanY = Math.abs(deltaY);
  const reach = Math.hypot(deltaX, deltaY) || 1;

  const leadOut = Math.min(spanX * 0.75, reach * 0.45);
  const aimX = sourceX + (deltaX / reach) * leadOut;
  const aimY = sourceY + (deltaY / reach) * leadOut;

  const leadIn = Math.min(Math.max(spanX * 0.6, spanY * 0.35), spanX * 0.95);

  return `M ${sourceX},${sourceY} C ${aimX},${aimY} ${targetX - leadIn},${targetY} ${targetX},${targetY}`;
}

function BrainstormEdge({ id, sourceX, sourceY, targetX, targetY, style }) {
  const path = brainstormEdgePath(sourceX, sourceY, targetX, targetY);

  return <BaseEdge id={id} path={path} style={style} />;
}

const nodeTypes = {
  prompt: PromptNode,
  idea: IdeaNode,
};

const edgeTypes = {
  branch: BrainstormEdge,
};

export default function StoryBrainstorm({
  story,
  graphNodes,
  graphEdges,
  viewport,
  prompt,
  setPrompt,
  isStreaming,
  disabled,
  modelLabel,
  thinkingEnabled,
  thinkingStateLabel,
  reasoningRequired,
  contextMeter,
  onBack,
  onGenerate,
  onStop,
  onOpenSettings,
  onToggleThinking,
  onUpdateNode,
  onDeleteNode,
  onUpdateViewport,
  onConfirm,
}) {
  const [selectedIdeaIds, setSelectedIdeaIds] = useState([]);
  const [ideaCount, setIdeaCount] = useState(3);
  const [ideaMenuOpen, setIdeaMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [flowInstance, setFlowInstance] = useState(null);
  const viewportAppliedRef = useRef(false);
  const textareaRef = useRef(null);
  const ideaMenuRef = useRef(null);
  const modelMenuRef = useRef(null);
  const previousNodeIdsRef = useRef(null);
  const pendingFrameRef = useRef(false);
  const nodeOperationInProgress = isStreaming || graphNodes.some(
    (node) => node.status === "generating",
  );

  const descendantsByNode = useMemo(() => {
    const childMap = new Map();
    graphEdges.forEach((edge) => {
      const children = childMap.get(edge.source_node_id) || [];
      children.push(edge.target_node_id);
      childMap.set(edge.source_node_id, children);
    });
    return childMap;
  }, [graphEdges]);

  const incomingNodeIds = useMemo(
    () => new Set(graphEdges.map((edge) => edge.target_node_id)),
    [graphEdges],
  );

  const graphNodeIdsKey = useMemo(
    () => graphNodes.map((node) => node.id).sort().join("|"),
    [graphNodes],
  );

  const deleteNode = useCallback((nodeId) => {
    const hasDescendants = (descendantsByNode.get(nodeId) || []).length > 0;
    onDeleteNode(nodeId, hasDescendants);
  }, [descendantsByNode, onDeleteNode]);

  const retryPrompt = useCallback(async (node) => {
    if (disabled || nodeOperationInProgress) return;

    const parentIds = graphEdges
      .filter((edge) => edge.target_node_id === node.id)
      .map((edge) => edge.source_node_id);
    const hasDescendants = (descendantsByNode.get(node.id) || []).length > 0;

    const runPrompt = async () => {
      const completed = await onGenerate(node.content, parentIds);

      if (!completed) {
        setPrompt(node.content);
        return;
      }

      await onDeleteNode(node.id, hasDescendants, true);
    };

    if (!hasDescendants) {
      await runPrompt();
      return;
    }

    onConfirm({
      title: "Regenerate this prompt?",
      body: "Your current branch stays until new ideas are ready. After a successful generation, this prompt and everything branched from it are replaced. This cannot be undone.",
      confirmLabel: "Regenerate",
      busyLabel: "Regenerating",
      closeOnConfirm: true,
      onConfirm: runPrompt,
    });
  }, [
    descendantsByNode,
    disabled,
    graphEdges,
    nodeOperationInProgress,
    onConfirm,
    onDeleteNode,
    onGenerate,
    setPrompt,
  ]);

  const nodeDataDeps = useMemo(
    () => ({ deleteNode, retryPrompt, onUpdateNode, incomingNodeIds, nodeOperationInProgress, disabled }),
    [deleteNode, disabled, incomingNodeIds, nodeOperationInProgress, onUpdateNode, retryPrompt],
  );

  // Reuse the React Flow node objects instead of rebuilding them. They carry `measured`, and a
  // node without it renders as `visibility: hidden` until the resize observer catches up, which
  // during streaming drops the node out of hit testing on every token.
  useEffect(() => {
    setNodes((currentNodes) => {
      const currentById = new Map(currentNodes.map((node) => [node.id, node]));
      return graphNodes.map((graphNode) => {
        const existing = currentById.get(graphNode.id);

        // mid-drag the stored position is stale by definition, so leave the node alone entirely or
        // we yank it back to where it started on every streamed token
        const beingDragged = Boolean(existing?.dragging);
        if (
          existing
          && existing.data.deps === nodeDataDeps
          && existing.data.source === graphNode
          && (beingDragged || (
            existing.position.x === graphNode.position_x
            && existing.position.y === graphNode.position_y
          ))
        ) {
          return existing;
        }

        return {
          ...existing,
          id: graphNode.id,
          type: graphNode.node_type,
          position: beingDragged
            ? existing.position
            : { x: graphNode.position_x, y: graphNode.position_y },
          selected: existing?.selected ?? false,
          // keyed off status, not the client-only generation_phase, so the lock survives a bundle
          // reload or a stuck generating row
          draggable: !nodeOperationInProgress,
          data: {
            ...graphNode,
            source: graphNode,
            deps: nodeDataDeps,
            hasIncomingEdge: incomingNodeIds.has(graphNode.id),
            operationInProgress: nodeOperationInProgress,
            generateDisabled: disabled,
            onSave: (changes) => onUpdateNode(graphNode.id, changes),
            onDelete: () => deleteNode(graphNode.id),
            onRetry: () => retryPrompt(graphNode),
          },
        };
      });
    });
  }, [
    deleteNode,
    disabled,
    graphNodes,
    incomingNodeIds,
    nodeDataDeps,
    nodeOperationInProgress,
    onUpdateNode,
    retryPrompt,
    setNodes,
  ]);

  useEffect(() => {
    setEdges(graphEdges.map((edge) => ({
      id: edge.id,
      source: edge.source_node_id,
      target: edge.target_node_id,
      type: "branch",
      style: {
        stroke: "#ffffff",
        strokeWidth: 1.5,
        strokeLinecap: "round",
      },
    })));
  }, [graphEdges, setEdges]);

  useEffect(() => {
    if (!flowInstance || viewportAppliedRef.current) return;
    flowInstance.setViewport(viewport, { duration: 0 });
    viewportAppliedRef.current = true;
  }, [flowInstance, viewport]);

  useEffect(() => {
    const liveIdeaIds = new Set(
      graphNodes
        .filter((node) => node.node_type === "idea")
        .map((node) => node.id),
    );
    setSelectedIdeaIds((currentIds) => {
      const nextIds = currentIds.filter((nodeId) => liveIdeaIds.has(nodeId));
      return nextIds.length === currentIds.length ? currentIds : nextIds;
    });
  }, [graphNodes]);

  useEffect(() => {
    if (previousNodeIdsRef.current === null) {
      previousNodeIdsRef.current = graphNodeIdsKey;
      return;
    }
    if (previousNodeIdsRef.current === graphNodeIdsKey) return;

    previousNodeIdsRef.current = graphNodeIdsKey;
    pendingFrameRef.current = true;
  }, [graphNodeIdsKey]);

  useEffect(() => {
    if (!flowInstance || !pendingFrameRef.current) return;

    const renderedNodeIdsKey = nodes.map((node) => node.id).sort().join("|");
    if (renderedNodeIdsKey !== graphNodeIdsKey) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reducedMotion ? 0 : 250;
    if (nodes.length === 0) {
      pendingFrameRef.current = false;
      void flowInstance.setViewport({ x: 0, y: 0, zoom: 1 }, { duration });
      return;
    }

    const nodesMeasured = nodes.every(
      (node) => Number(node.measured?.width) > 0 && Number(node.measured?.height) > 0,
    );
    if (!nodesMeasured) return;

    pendingFrameRef.current = false;
    void flowInstance.fitView({
      nodes: nodes.map((node) => ({ id: node.id })),
      padding: {
        top: "120px",
        right: "56px",
        bottom: "190px",
        left: "56px",
      },
      minZoom: 0.25,
      maxZoom: 1.1,
      duration,
      interpolate: "smooth",
    });
  }, [flowInstance, graphNodeIdsKey, nodes]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = 126;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [prompt]);

  useEffect(() => {
    function closeModelMenu(event) {
      if (event.key === "Escape") {
        setIdeaMenuOpen(false);
        setModelMenuOpen(false);
      }
    }

    function closeModelMenuOnOutsidePress(event) {
      if (!ideaMenuRef.current?.contains(event.target)) setIdeaMenuOpen(false);
      if (!modelMenuRef.current?.contains(event.target)) setModelMenuOpen(false);
    }

    document.addEventListener("keydown", closeModelMenu);
    document.addEventListener("pointerdown", closeModelMenuOnOutsidePress);
    return () => {
      document.removeEventListener("keydown", closeModelMenu);
      document.removeEventListener("pointerdown", closeModelMenuOnOutsidePress);
    };
  }, []);

  function submitPrompt(event) {
    event?.preventDefault();
    if (isStreaming) {
      onStop();
      return;
    }
    if (!prompt.trim() || disabled) return;
    onGenerate(prompt.trim(), selectedIdeaIds, ideaCount);
  }

  const handleSelectionChange = useCallback(({ nodes: selectedNodes }) => {
    const nextIds = selectedNodes
      .filter((node) => node.type === "idea")
      .map((node) => node.id)
      .sort();
    setSelectedIdeaIds((currentIds) => {
      const currentSorted = [...currentIds].sort();
      const unchanged = currentSorted.length === nextIds.length
        && currentSorted.every((nodeId, index) => nodeId === nextIds[index]);
      return unchanged ? currentIds : nextIds;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIdeaIds([]);
    setNodes((currentNodes) => currentNodes.map((node) => (
      node.selected ? { ...node, selected: false } : node
    )));
  }, [setNodes]);

  return (
    <section data-tour="write-brainstorm" className="brainstorm-workspace">
      <header className="brainstorm-header">
        <div>
          <button type="button" onClick={onBack} className={cx("brainstorm-back-button", CONTROL_MOTION)}>
            <ArrowLeft size={15} />
            Back to chapter
          </button>
          <div className="brainstorm-story-title">{story.title}</div>
          <h1>Brainstorm</h1>
        </div>
      </header>

      <div className="brainstorm-canvas" aria-label="Story brainstorm canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={setFlowInstance}
          onNodeDragStop={(_, node) => onUpdateNode(node.id, {
            position_x: node.position.x,
            position_y: node.position.y,
          })}
          onSelectionChange={handleSelectionChange}
          onMoveEnd={(_, nextViewport) => onUpdateViewport(nextViewport)}
          selectionOnDrag
          panOnScroll
          multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          minZoom={0.25}
          maxZoom={1.8}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="rgba(255,255,255,0.045)" gap={28} size={1} />
          <Controls position="top-right" showInteractive={false} />
        </ReactFlow>

        {graphNodes.length === 0 && (
          <div className="brainstorm-empty" aria-hidden="true">
            <h2>Start anywhere</h2>
            <p>Ask how the story could continue, explore a character choice, or test a stranger direction.</p>
          </div>
        )}
      </div>

      <form className="brainstorm-composer" onSubmit={submitPrompt}>
        <div className="brainstorm-composer-surface">
          <textarea
            className="nowheel"
            ref={textareaRef}
            value={prompt}
            rows={1}
            data-1p-ignore="true"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) submitPrompt(event);
            }}
            placeholder={selectedIdeaIds.length ? "Branch from the selected ideas" : "How could we continue the story?"}
            aria-label="Brainstorm prompt"
          />
          <div className="brainstorm-composer-controls">
            <div className="brainstorm-composer-left">
              <div className="brainstorm-branch-count" ref={ideaMenuRef}>
                <button
                  type="button"
                  className="brainstorm-branch-trigger"
                  onClick={() => {
                    setIdeaMenuOpen((open) => !open);
                    setModelMenuOpen(false);
                  }}
                  aria-expanded={ideaMenuOpen}
                  aria-haspopup="dialog"
                  aria-label={`New ideas: ${ideaCount}`}
                >
                  <span className="brainstorm-branch-label">New ideas</span>
                  <span className="brainstorm-branch-value tabular-nums">{ideaCount}</span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={cx("brainstorm-model-chevron", ideaMenuOpen && "is-open")}
                  />
                </button>
                {ideaMenuOpen && (
                  <div
                    className="brainstorm-branch-menu"
                    role="dialog"
                    aria-label="Choose the number of new ideas"
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setIdeaMenuOpen(false);
                        ideaMenuRef.current?.querySelector("button")?.focus();
                      }
                    }}
                  >
                    <div className="brainstorm-branch-menu-heading">
                      <span className="brainstorm-branch-menu-title">New ideas</span>
                    </div>
                    <div className="brainstorm-branch-slider-row">
                      <input
                        type="range"
                        className="brainstorm-branch-slider"
                        min={1}
                        max={8}
                        step={1}
                        value={ideaCount}
                        autoFocus
                        aria-label="Number of new ideas"
                        aria-valuetext={`${ideaCount} ${ideaCount === 1 ? "idea" : "ideas"}`}
                        style={{ "--idea-progress": `calc(${16 - ((ideaCount - 1) / 7) * 32}px + ${((ideaCount - 1) / 7) * 100}%)` }}
                        onChange={(event) => setIdeaCount(Number(event.target.value))}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            setIdeaMenuOpen(false);
                            ideaMenuRef.current?.querySelector("button")?.focus();
                          }
                        }}
                      />
                      <div className="brainstorm-branch-slider-labels" aria-hidden="true">
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => (
                          <span
                            key={count}
                            className={count === ideaCount ? "is-active" : undefined}
                            style={{ left: `${((count - 1) / 7) * 100}%` }}
                          >
                            {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {selectedIdeaIds.length > 0 && (
                <button type="button" className="brainstorm-selection-pill" onClick={clearSelection}>
                  <span className="tabular-nums">{selectedIdeaIds.length}</span> selected
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="brainstorm-composer-right">
              {contextMeter}
              <div className="brainstorm-model-control" ref={modelMenuRef}>
                <button
                  type="button"
                  className="brainstorm-model-button"
                  onClick={() => setModelMenuOpen((open) => !open)}
                  aria-expanded={modelMenuOpen}
                  aria-haspopup="menu"
                >
                  <span className="brainstorm-model-name">{modelLabel}</span>
                  <span className="brainstorm-thinking-state">
                    <span>{thinkingStateLabel}</span>
                  </span>
                  <ChevronDown
                    size={14}
                    className={cx("brainstorm-model-chevron", modelMenuOpen && "is-open")}
                  />
                </button>
                {modelMenuOpen && (
                  <div className="brainstorm-model-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onOpenSettings();
                        setModelMenuOpen(false);
                      }}
                    >
                      <span>Settings</span>
                      <span>{modelLabel}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={thinkingEnabled ? "is-active" : undefined}
                      disabled={reasoningRequired}
                      onClick={() => {
                        onToggleThinking();
                        setModelMenuOpen(false);
                      }}
                    >
                      <span>Thinking</span>
                      <span>
                        <span>{reasoningRequired ? "Required" : thinkingEnabled ? "On" : "Off"}</span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
              <button
                type="submit"
                className="brainstorm-send-button"
                disabled={!isStreaming && (disabled || !prompt.trim())}
                aria-label={isStreaming ? "Stop brainstorming" : "Send brainstorm prompt"}
              >
                {isStreaming ? <Square size={13} /> : <i className="fi fi-rr-arrow-small-up send-arrow-icon" />}
              </button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
