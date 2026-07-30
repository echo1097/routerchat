import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { ArrowLeft, Check, ChevronDown, Edit3, RotateCcw, Square, Trash2, X } from "lucide-react";
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

function PromptNode({ data }) {
  const failed = data.status === "failed" || data.status === "cancelled";
  const actionsLocked = Boolean(data.operationInProgress);
  const isGenerating = data.status === "generating";
  const isThinking = isGenerating && data.generation_phase === "thinking";
  const isWorking = isGenerating && data.generation_phase === "working";
  const hasThinking = Boolean(data.reasoning) || isThinking;
  const showWritingStatus = isWorking && !hasThinking;
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
          {failed && !actionsLocked && (
            <button type="button" onClick={data.onRetry} aria-label="Retry prompt" title="Retry prompt">
              <RotateCcw size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={data.onDelete}
            disabled={actionsLocked}
            aria-label="Delete prompt"
            title="Delete prompt"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <p className="brainstorm-prompt-content nowheel">{data.content}</p>
      {showWritingStatus && (
        <div className="brainstorm-writing-status">
          <span className="brainstorm-thinking-label t-shimmer" data-text="Writing">
            Writing
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
              {data.reasoning ? (
                <ThinkingContent>{data.reasoning}</ThinkingContent>
              ) : (
                <span className="brainstorm-thinking-waiting">Waiting for the model</span>
              )}
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
              <button type="button" onClick={() => setEditing(true)} aria-label="Edit idea" title="Edit idea">
                <Edit3 size={15} />
              </button>
              <button
                type="button"
                onClick={data.onDelete}
                disabled={data.operationInProgress}
                aria-label="Delete idea"
                title="Delete idea"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
          <h2>{data.title}</h2>
          <p className="nowheel">{data.content}</p>
        </>
      )}
      <Handle type="source" position={Position.Right} className="brainstorm-handle" />
    </article>
  );
}

const nodeTypes = {
  prompt: PromptNode,
  idea: IdeaNode,
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
    const parentIds = graphEdges
      .filter((edge) => edge.target_node_id === node.id)
      .map((edge) => edge.source_node_id);
    await onDeleteNode(node.id, false, true);
    onGenerate(node.content, parentIds);
  }, [graphEdges, onDeleteNode, onGenerate]);

  const nodeDataDeps = useMemo(
    () => ({ deleteNode, retryPrompt, onUpdateNode, incomingNodeIds, nodeOperationInProgress }),
    [deleteNode, incomingNodeIds, nodeOperationInProgress, onUpdateNode, retryPrompt],
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
            onSave: (changes) => onUpdateNode(graphNode.id, changes),
            onDelete: () => deleteNode(graphNode.id),
            onRetry: () => retryPrompt(graphNode),
          },
        };
      });
    });
  }, [
    deleteNode,
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
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(255,255,255,0.16)" },
      style: { stroke: "rgba(255,255,255,0.12)", strokeWidth: 1.25 },
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
              <div
                className="t-acc brainstorm-branch-count"
                data-open={ideaMenuOpen}
                ref={ideaMenuRef}
              >
                <button
                  type="button"
                  className="t-acc-head brainstorm-branch-trigger"
                  onClick={() => {
                    setIdeaMenuOpen((open) => !open);
                    setModelMenuOpen(false);
                  }}
                  aria-expanded={ideaMenuOpen}
                  aria-haspopup="menu"
                >
                  <span>New ideas</span>
                  <span className="tabular-nums">{ideaCount}</span>
                  <span className="t-acc-chevron brainstorm-branch-chevron">
                    <ChevronDown size={14} aria-hidden="true" />
                  </span>
                </button>
                <div className="t-acc-panel brainstorm-branch-panel">
                  <div className="t-acc-panel-inner brainstorm-branch-menu" role="menu">
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={ideaCount === count}
                        className={ideaCount === count ? "is-active" : undefined}
                        key={count}
                        onClick={() => {
                          setIdeaCount(count);
                          setIdeaMenuOpen(false);
                        }}
                      >
                        <span>{count}</span>
                        <span>{count === 1 ? "idea" : "ideas"}</span>
                      </button>
                    ))}
                  </div>
                </div>
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
                    <span>{thinkingEnabled ? "Thinking" : "Instant"}</span>
                    {reasoningRequired && <span className="brainstorm-thinking-required">Required</span>}
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
                        <span>{thinkingEnabled ? "On" : "Off"}</span>
                        {reasoningRequired && <span className="brainstorm-thinking-required">Required</span>}
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
