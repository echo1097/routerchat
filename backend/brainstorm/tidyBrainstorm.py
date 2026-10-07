from typing import Any

from backend.brainstorm.brainstormLayout import (
    brainstormIdeaPositions,
    nextBrainstormBranchPosition,
    nextBrainstormRootPosition,
)


def tidyBrainstormPositions(
    nodes: list[Any],
    edges: list[Any],
) -> dict[str, tuple[float, float]]:
    nodesById = {str(node["id"]): node for node in nodes}
    childIdsBySource: dict[str, list[str]] = {}
    parentIdsByTarget: dict[str, list[str]] = {}
    for edge in edges:
        sourceId = str(edge["source_node_id"])
        targetId = str(edge["target_node_id"])
        if sourceId not in nodesById or targetId not in nodesById:
            continue
        childIdsBySource.setdefault(sourceId, []).append(targetId)
        parentIdsByTarget.setdefault(targetId, []).append(sourceId)

    positions: dict[str, tuple[float, float]] = {}
    placedNodes: list[dict[str, Any]] = []
    placedById: dict[str, dict[str, Any]] = {}

    def place(nodeId: str, nodeType: str, x: float, y: float) -> None:
        placedNode = {
            "id": nodeId,
            "node_type": nodeType,
            "position_x": x,
            "position_y": y,
        }
        positions[nodeId] = (x, y)
        placedNodes.append(placedNode)
        placedById[nodeId] = placedNode

    def placeRound(promptId: str) -> None:
        ideaIds = [
            childId
            for childId in childIdsBySource.get(promptId, [])
            if nodesById[childId]["node_type"] == "idea" and childId not in placedById
        ]
        parentIdeas = [
            placedById[parentId]
            for parentId in parentIdsByTarget.get(promptId, [])
            if parentId in placedById
        ]

        if parentIdeas:
            promptX, promptY = nextBrainstormBranchPosition(placedNodes, parentIdeas, len(ideaIds))
        else:
            promptX, promptY = nextBrainstormRootPosition(placedNodes, len(ideaIds))

        place(promptId, "prompt", promptX, promptY)
        for ideaId, (ideaX, ideaY) in zip(ideaIds, brainstormIdeaPositions(promptX, promptY, len(ideaIds))):
            place(ideaId, "idea", ideaX, ideaY)

    def parentsArePlaced(promptId: str) -> bool:
        return all(parentId in placedById for parentId in parentIdsByTarget.get(promptId, []))

    pendingPromptIds = [str(node["id"]) for node in nodes if node["node_type"] == "prompt"]
    while pendingPromptIds:
        readyIds = [promptId for promptId in pendingPromptIds if parentsArePlaced(promptId)]
        nextId = readyIds[0] if readyIds else pendingPromptIds[0]
        placeRound(nextId)
        pendingPromptIds.remove(nextId)

    for node in nodes:
        nodeId = str(node["id"])
        if nodeId in positions:
            continue
        x, y = nextBrainstormRootPosition(placedNodes, 1)
        place(nodeId, str(node["node_type"]), x, y)

    return positions
