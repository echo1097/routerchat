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
import { CONTROL_MOTION, cx } from "../uiShared.js";

function PromptNode({ data }) {
  const failed = data.status === "failed" || data.status === "cancelled";

  return (
    <article className={cx("brainstorm-node brainstorm-prompt-node", failed && "is-failed")}>
      <Handle type="target" position={Position.Left} className="brainstorm-handle" />
      <div className="brainstorm-node-eyebrow">
        <span>{failed ? data.status : data.status === "generating" ? "Thinking" : "Prompt"}</span>
        <div className="brainstorm-node-actions nodrag">
          {failed && (
            <button type="button" onClick={data.onRetry} aria-label="Retry prompt" title="Retry prompt">
              <RotateCcw size={15} />
            </button>
          )}
          <button type="button" onClick={data.onDelete} aria-label="Delete prompt" title="Delete prompt">
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <p className="nowheel">{data.content}</p>
      {data.status === "generating" && <div className="brainstorm-thinking-line" aria-hidden="true" />}
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
          <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Idea title" />
          <textarea
            className="nowheel"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            aria-label="Idea details"
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
              <button type="button" onClick={data.onDelete} aria-label="Delete idea" title="Delete idea">
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
  reasoning,
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

  const descendantsByNode = useMemo(() => {
    const childMap = new Map();
    graphEdges.forEach((edge) => {
      const children = childMap.get(edge.source_node_id) || [];
      children.push(edge.target_node_id);
      childMap.set(edge.source_node_id, children);
    });
    return childMap;
  }, [graphEdges]);

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

  useEffect(() => {
    setNodes(graphNodes.map((node) => ({
      id: node.id,
      type: node.node_type,
      position: { x: node.position_x, y: node.position_y },
      selected: selectedIdeaIds.includes(node.id),
      data: {
        ...node,
        onSave: (changes) => onUpdateNode(node.id, changes),
        onDelete: () => deleteNode(node.id),
        onRetry: () => retryPrompt(node),
      },
    })));
  }, [deleteNode, graphNodes, onUpdateNode, retryPrompt, selectedIdeaIds, setNodes]);

  useEffect(() => {
    setEdges(graphEdges.map((edge) => ({
      id: edge.id,
      source: edge.source_node_id,
      target: edge.target_node_id,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(255,255,255,0.2)" },
      style: { stroke: "rgba(255,255,255,0.16)", strokeWidth: 1.5 },
    })));
  }, [graphEdges, setEdges]);

  useEffect(() => {
    if (!flowInstance || viewportAppliedRef.current) return;
    flowInstance.setViewport(viewport, { duration: 0 });
    viewportAppliedRef.current = true;
  }, [flowInstance, viewport]);

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
        {reasoning && isStreaming && <div className="brainstorm-status">Thinking through the branch</div>}
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
          <Background color="rgba(255,255,255,0.07)" gap={28} size={1} />
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
                <button type="button" className="brainstorm-selection-pill" onClick={() => setSelectedIdeaIds([])}>
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
