from typing import Any

COLUMN_OFFSET_X = 660


def next_brainstorm_root_position(
    nodes: list[Any],
    edges: list[Any],
    ideaCount: int,
) -> tuple[float, float]:
    rootX = 0.0
    anchorY = 180.0
    ideaGap = 210.0
    nodeHalfHeight = 130.0
    branchClearance = 80.0

    if not nodes:
        return rootX, anchorY

    childIdsBySource: dict[str, list[str]] = {}
    incomingIds: set[str] = set()
    nodesById = {str(node["id"]): node for node in nodes}
    for edge in edges:
        sourceId = str(edge["source_node_id"])
        targetId = str(edge["target_node_id"])
        if sourceId not in nodesById or targetId not in nodesById:
            continue
        childIdsBySource.setdefault(sourceId, []).append(targetId)
        incomingIds.add(targetId)

    occupiedBounds: list[tuple[float, float]] = []
    for rootNode in nodes:
        rootId = str(rootNode["id"])
        if rootId in incomingIds:
            continue

        branchIds = {rootId}
        pendingIds = [rootId]
        while pendingIds:
            currentId = pendingIds.pop()
            for childId in childIdsBySource.get(currentId, []):
                if childId in branchIds:
                    continue
                branchIds.add(childId)
                pendingIds.append(childId)

        branchY = [float(nodesById[nodeId]["position_y"]) for nodeId in branchIds]
        occupiedBounds.append((
            min(branchY) - nodeHalfHeight,
            max(branchY) + nodeHalfHeight,
        ))

    if not occupiedBounds:
        return rootX, anchorY

    newBranchHalfHeight = ((max(1, ideaCount) - 1) * ideaGap / 2) + nodeHalfHeight
    candidateY = {anchorY}
    for lowerBound, upperBound in occupiedBounds:
        candidateY.add(upperBound + branchClearance + newBranchHalfHeight)
        candidateY.add(lowerBound - branchClearance - newBranchHalfHeight)

    def slotIsOpen(centerY: float) -> bool:
        nextLower = centerY - newBranchHalfHeight
        nextUpper = centerY + newBranchHalfHeight
        return all(
            nextUpper + branchClearance <= lowerBound
            or nextLower - branchClearance >= upperBound
            for lowerBound, upperBound in occupiedBounds
        )

    openSlots = [centerY for centerY in candidateY if slotIsOpen(centerY)]
    bestY = min(
        openSlots,
        key=lambda centerY: (
            abs(centerY - anchorY),
            0 if centerY >= anchorY else 1,
            centerY,
        ),
    )
    return rootX, bestY
