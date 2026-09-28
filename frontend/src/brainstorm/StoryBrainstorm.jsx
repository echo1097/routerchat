import { useCompactComposer } from "../composer/useCompactComposer.js";
import { VoiceInput } from "../transcription/VoiceInput.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BaseEdge,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { ChevronDown, Square, X } from "lucide-react";
import "@xyflow/react/dist/style.css";
import "./StoryBrainstorm.css";
import { cx } from "../uiShared.js";
import BrainstormBar from "./BrainstormBar.jsx";
import IdeaNode from "./IdeaNode.jsx";
import IdeaPane from "./IdeaPane.jsx";
import PromptNode from "./PromptNode.jsx";
import { brainstormEdgePath } from "./brainstormShared.jsx";

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

const FIT_PADDING = {
  top: "40px",
  right: "56px",
  bottom: "150px",
  left: "56px",
};

const NARROW_FIT_PADDING = {
  top: "24px",
  right: "16px",
  bottom: "120px",
  left: "16px",
};

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
  onTidy,
  onConfirm,
}) {
  const [branchIdeaIds, setBranchIdeaIds] = useState([]);
  const [readingId, setReadingId] = useState(null);
  const [paneIdeaId, setPaneIdeaId] = useState(null);
  const [ideaCount, setIdeaCount] = useState(3);
  const [ideaMenuOpen, setIdeaMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [flowInstance, setFlowInstance] = useState(null);
  const viewportAppliedRef = useRef(false);
  const { textareaRef, composerSurfaceRef, leftControlsRef, rightControlsRef, measureRef, isCompact } = useCompactComposer(prompt);
  const ideaMenuRef = useRef(null);
  const modelMenuRef = useRef(null);
  const previousNodeIdsRef = useRef(null);
  const pendingFrameRef = useRef(false);
  const nodeOperationInProgress = isStreaming || graphNodes.some(
    (node) => node.status === "generating",
  );


  const nodesById = useMemo(
    () => new Map(graphNodes.map((node) => [node.id, node])),
    [graphNodes],
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

  const promptIdByIdea = useMemo(() => {
    const promptIds = new Map();
    graphEdges.forEach((edge) => {
      const source = nodesById.get(edge.source_node_id);
      const target = nodesById.get(edge.target_node_id);
      if (source?.node_type === "prompt" && target?.node_type === "idea") {
        promptIds.set(target.id, source.id);
      }
    });
    return promptIds;
  }, [graphEdges, nodesById]);

  const graphNodeIdsKey = useMemo(
    () => graphNodes.map((node) => node.id).sort().join("|"),
    [graphNodes],
  );

  const paneIdea = paneIdeaId ? nodesById.get(paneIdeaId) : null;
  const panePrompt = paneIdea ? nodesById.get(promptIdByIdea.get(paneIdea.id)) : null;

  const paneSiblings = useMemo(() => {
    if (!panePrompt) return paneIdea ? [paneIdea] : [];
    return (descendantsByNode.get(panePrompt.id) || [])
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node) => node?.node_type === "idea")
      .sort((first, second) => first.position_y - second.position_y);
  }, [descendantsByNode, nodesById, paneIdea, panePrompt]);

  const paneIndex = paneIdea ? paneSiblings.findIndex((node) => node.id === paneIdea.id) : -1;

  const openIdea = useCallback((ideaId) => {
    setReadingId(ideaId);
    setPaneIdeaId(ideaId);
  }, []);

  const closePane = useCallback(() => {
    setReadingId(null);
  }, []);

  const toggleBranch = useCallback((ideaId) => {
    setBranchIdeaIds((currentIds) => (
      currentIds.includes(ideaId)
        ? currentIds.filter((nodeId) => nodeId !== ideaId)
        : [...currentIds, ideaId]
    ));
  }, []);

  useEffect(() => {
    if (readingId && !nodesById.has(readingId)) setReadingId(null);
  }, [nodesById, readingId]);


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
    () => ({ deleteNode, retryPrompt, incomingNodeIds, nodeOperationInProgress, disabled }),
    [deleteNode, disabled, incomingNodeIds, nodeOperationInProgress, retryPrompt],
  );


  // Reuse the React Flow node objects instead of rebuilding them. They carry `measured`, and a
  // node without it renders as `visibility: hidden` until the resize observer catches up, which
  // during streaming drops the node out of hit testing on every token.
  useEffect(() => {
    setNodes((currentNodes) => {
      const currentById = new Map(currentNodes.map((node) => [node.id, node]));
      return graphNodes.map((graphNode) => {
        const existing = currentById.get(graphNode.id);
        const isReading = graphNode.id === readingId;
        const isBranch = branchIdeaIds.includes(graphNode.id);

        // mid-drag the stored position is stale by definition, so leave the node alone entirely or
        // we yank it back to where it started on every streamed token
        const beingDragged = Boolean(existing?.dragging);
        if (
          existing
          && existing.data.deps === nodeDataDeps
          && existing.data.source === graphNode
          && existing.data.isReading === isReading
          && existing.data.isBranch === isBranch
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
          selectable: false,
          // keyed off status, not the client-only generation_phase, so the lock survives a bundle
          // reload or a stuck generating row
          draggable: !nodeOperationInProgress,
          data: {
            ...graphNode,
            source: graphNode,
            deps: nodeDataDeps,
            isReading,
            isBranch,
            hasIncomingEdge: incomingNodeIds.has(graphNode.id),
            operationInProgress: nodeOperationInProgress,
            generateDisabled: disabled,
            onDelete: () => deleteNode(graphNode.id),
            onRetry: () => retryPrompt(graphNode),
          },
        };
      });
    });
  }, [
    branchIdeaIds,
    deleteNode,
    disabled,
    graphNodes,
    incomingNodeIds,
    nodeDataDeps,
    nodeOperationInProgress,
    readingId,
    retryPrompt,
    setNodes,
  ]);

  useEffect(() => {
    const litIds = new Set(branchIdeaIds);
    if (readingId) litIds.add(readingId);

    setEdges(graphEdges.map((edge) => {
      const lit = litIds.has(edge.source_node_id) || litIds.has(edge.target_node_id);
      return {
        id: edge.id,
        source: edge.source_node_id,
        target: edge.target_node_id,
        type: "branch",
        selectable: false,
        style: {
          stroke: lit ? "rgba(255, 255, 255, 0.52)" : "rgba(255, 255, 255, 0.16)",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          transition: "stroke 200ms ease-out",
        },
      };
    }));
  }, [branchIdeaIds, graphEdges, readingId, setEdges]);


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
    setBranchIdeaIds((currentIds) => {
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

  const latestRoundIds = useMemo(() => {
    const latestPrompt = graphNodes.filter((node) => node.node_type === "prompt").at(-1);
    if (!latestPrompt) return [];
    return [latestPrompt.id, ...(descendantsByNode.get(latestPrompt.id) || [])];
  }, [descendantsByNode, graphNodes]);

  const fitAll = useCallback((duration) => {
    if (!flowInstance) return;
    const narrowCanvas = window.matchMedia("(max-width: 720px)").matches;
    const focusIds = narrowCanvas ? latestRoundIds : [];
    void flowInstance.fitView({
      nodes: focusIds.length ? focusIds.map((id) => ({ id })) : undefined,
      padding: narrowCanvas ? NARROW_FIT_PADDING : FIT_PADDING,
      minZoom: 0.25,
      maxZoom: 1.1,
      duration,
      interpolate: "smooth",
    });
  }, [flowInstance, latestRoundIds]);

  useEffect(() => {
    if (!flowInstance || !pendingFrameRef.current) return;

    const renderedNodeIdsKey = nodes.map((node) => node.id).sort().join("|");
    if (renderedNodeIdsKey !== graphNodeIdsKey) return;

    const duration = prefersReducedMotion() ? 0 : 250;
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
    fitAll(duration);
  }, [fitAll, flowInstance, graphNodeIdsKey, nodes]);


  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key !== "Escape") return;
      setIdeaMenuOpen(false);
      setModelMenuOpen(false);
      setReadingId(null);
    }

    function closeMenusOnOutsidePress(event) {
      if (!ideaMenuRef.current?.contains(event.target)) setIdeaMenuOpen(false);
      if (!modelMenuRef.current?.contains(event.target)) setModelMenuOpen(false);
    }

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeMenusOnOutsidePress);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeMenusOnOutsidePress);
    };
  }, []);


  async function generateFromComposer(text) {
    const completed = await onGenerate(text, branchIdeaIds, ideaCount);
    if (completed) setBranchIdeaIds([]);
  }

  function submitPrompt(event) {
    event?.preventDefault();
    if (isStreaming) {
      onStop();
      return;
    }
    if (!prompt.trim() || disabled) return;
    generateFromComposer(prompt.trim());
  }

  async function tidyCanvas() {
    if (tidying || nodeOperationInProgress) return;
    setTidying(true);
    try {
      pendingFrameRef.current = true;
      await onTidy();
    } finally {
      setTidying(false);
    }
  }

  function handleNodeClick(event, node) {
    if (node.type !== "idea") return;
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      toggleBranch(node.id);
      return;
    }
    openIdea(node.id);
  }

  function handleCanvasKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const nodeElement = event.target.closest?.(".react-flow__node-idea");
    if (!nodeElement || nodeElement !== event.target) return;
    event.preventDefault();
    openIdea(nodeElement.dataset.id);
  }

  const zoomDuration = prefersReducedMotion() ? 0 : 200;
  const branchIdeas = branchIdeaIds.map((nodeId) => nodesById.get(nodeId)).filter(Boolean);
  let placeholder = "How could we continue the story?";
  if (branchIdeas.length === 1) placeholder = "Ask something about this idea";
  if (branchIdeas.length > 1) placeholder = "Ask something about these ideas";

  return (
    <section data-tour="write-brainstorm" className="brainstorm-workspace">
      <BrainstormBar
        storyTitle={story?.title}
        tidyDisabled={tidying || nodeOperationInProgress || graphNodes.length === 0}
        onBack={onBack}
        onTidy={tidyCanvas}
        onZoomIn={() => flowInstance?.zoomIn({ duration: zoomDuration })}
        onZoomOut={() => flowInstance?.zoomOut({ duration: zoomDuration })}
        onFit={() => fitAll(prefersReducedMotion() ? 0 : 250)}
      />

      <div className="brainstorm-body">
        <div className="brainstorm-main">
          <div
            className="brainstorm-canvas"
            aria-label="Story brainstorm canvas"
            onKeyDown={handleCanvasKeyDown}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onInit={setFlowInstance}
              onNodeClick={handleNodeClick}
              onNodeDragStop={(_, node) => onUpdateNode(node.id, {
                position_x: node.position.x,
                position_y: node.position.y,
              })}
              onMoveEnd={(_, nextViewport) => onUpdateViewport(nextViewport)}
              elementsSelectable={false}
              panOnScroll
              minZoom={0.25}
              maxZoom={1.8}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="rgba(255,255,255,0.05)" gap={28} size={1} />
            </ReactFlow>

            {graphNodes.length === 0 && (
              <div className="brainstorm-empty" aria-hidden="true">
                <h2>Start anywhere</h2>
                <p>Ask how the story could continue, explore a character choice, or test a stranger direction.</p>
              </div>
            )}
          </div>

          <form className="brainstorm-composer" onSubmit={submitPrompt}>
            {branchIdeas.length > 0 && (
              <div className="brainstorm-branch-strip">
                <span className="brainstorm-branch-strip-label">Branching from</span>
                {branchIdeas.map((idea) => (
                  <button
                    key={idea.id}
                    type="button"
                    className="brainstorm-branch-chip"
                    onClick={() => toggleBranch(idea.id)}
                    aria-label={`Stop branching from ${idea.title}`}
                    title="Stop branching from this idea"
                  >
                    <span>{idea.title}</span>
                    <X size={13} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}

            <div ref={composerSurfaceRef} className={cx("brainstorm-composer-surface voice-surface adaptive-composer", isCompact && "compact-composer")}>
              <div ref={measureRef} aria-hidden="true" className="composer-measure" />
              <div className="composer-input">
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
                  placeholder={placeholder}
                  aria-label="Brainstorm prompt"
                />
              </div>
              <div className="brainstorm-composer-controls composer-controls">
                <div ref={leftControlsRef} className="brainstorm-composer-left composer-left">
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
                        <div className="brainstorm-branch-menu-title">New ideas</div>
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
                </div>
                <div ref={rightControlsRef} className="brainstorm-composer-right composer-right">
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
                  <VoiceInput contextKey={story?.id} value={prompt} setValue={setPrompt} onSubmit={(text) => generateFromComposer(text)} disabled={disabled || isStreaming} />
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
        </div>

        <IdeaPane
          open={Boolean(readingId)}
          idea={paneIdea}
          siblingIndex={paneIndex}
          siblingCount={paneSiblings.length}
          isBranch={paneIdea ? branchIdeaIds.includes(paneIdea.id) : false}
          operationInProgress={nodeOperationInProgress}
          onPrevious={() => paneSiblings[paneIndex - 1] && openIdea(paneSiblings[paneIndex - 1].id)}
          onNext={() => paneSiblings[paneIndex + 1] && openIdea(paneSiblings[paneIndex + 1].id)}
          onClose={closePane}
          onToggleBranch={() => paneIdea && toggleBranch(paneIdea.id)}
          onSave={(changes) => onUpdateNode(paneIdea.id, changes)}
          onDelete={() => paneIdea && deleteNode(paneIdea.id)}
        />
      </div>
    </section>
  );
}
