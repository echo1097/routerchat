from typing import Any

PROMPT_WIDTH = 264.0
PROMPT_HEIGHT = 110.0
IDEA_WIDTH = 260.0
IDEA_HEIGHT = 64.0
IDEA_GAP = 12.0
COLUMN_GAP = 72.0
BRANCH_CLEARANCE = 40.0
ROOT_ANCHOR_Y = 180.0

IDEAS_OFFSET_X = PROMPT_WIDTH + COLUMN_GAP
COLUMN_OFFSET_X = IDEA_WIDTH + COLUMN_GAP
PROMPT_ROW_OFFSET = IDEA_HEIGHT / 2


def ideas_block_height(ideaCount: int) -> float:
    count = max(1, ideaCount)
    return count * IDEA_HEIGHT + (count - 1) * IDEA_GAP


def brainstorm_idea_positions(
    promptX: float,
    promptY: float,
    ideaCount: int,
) -> list[tuple[float, float]]:
    centerY = promptY + PROMPT_ROW_OFFSET
    firstY = centerY - ideas_block_height(ideaCount) / 2
    ideaX = promptX + IDEAS_OFFSET_X
    return [
        (ideaX, firstY + index * (IDEA_HEIGHT + IDEA_GAP))
        for index in range(ideaCount)
    ]


def node_bounds(node: Any) -> tuple[float, float, float, float]:
    left = float(node["position_x"])
    top = float(node["position_y"])
    if node["node_type"] == "prompt":
        return left, top, left + PROMPT_WIDTH, top + PROMPT_HEIGHT
    return left, top, left + IDEA_WIDTH, top + IDEA_HEIGHT


def open_prompt_position(
    nodes: list[Any],
    promptX: float,
    desiredPromptY: float,
    ideaCount: int,
) -> tuple[float, float]:
    blockHalf = ideas_block_height(ideaCount) / 2
    topReach = max(PROMPT_ROW_OFFSET, blockHalf)
    bottomReach = max(PROMPT_HEIGHT - PROMPT_ROW_OFFSET, blockHalf)
    blockLeft = promptX - BRANCH_CLEARANCE
    blockRight = promptX + IDEAS_OFFSET_X + IDEA_WIDTH + BRANCH_CLEARANCE

    obstacles = [
        (top, bottom)
        for left, top, right, bottom in map(node_bounds, nodes)
        if left < blockRight and right > blockLeft
    ]

    desiredCenter = desiredPromptY + PROMPT_ROW_OFFSET
    candidateCenters = {desiredCenter}
    for top, bottom in obstacles:
        candidateCenters.add(top - BRANCH_CLEARANCE - bottomReach)
        candidateCenters.add(bottom + BRANCH_CLEARANCE + topReach)

    def slotIsOpen(centerY: float) -> bool:
        slotTop = centerY - topReach
        slotBottom = centerY + bottomReach
        return all(
            slotBottom + BRANCH_CLEARANCE <= top
            or slotTop - BRANCH_CLEARANCE >= bottom
            for top, bottom in obstacles
        )

    openCenters = [centerY for centerY in candidateCenters if slotIsOpen(centerY)]
    bestCenter = min(
        openCenters,
        key=lambda centerY: (
            abs(centerY - desiredCenter),
            0 if centerY >= desiredCenter else 1,
            centerY,
        ),
    )
    return promptX, bestCenter - PROMPT_ROW_OFFSET


def next_brainstorm_root_position(
    nodes: list[Any],
    ideaCount: int,
) -> tuple[float, float]:
    return open_prompt_position(nodes, 0.0, ROOT_ANCHOR_Y, ideaCount)


def next_brainstorm_branch_position(
    nodes: list[Any],
    selectedIdeas: list[Any],
    ideaCount: int,
) -> tuple[float, float]:
    promptX = max(float(idea["position_x"]) for idea in selectedIdeas) + COLUMN_OFFSET_X
    desiredPromptY = sum(float(idea["position_y"]) for idea in selectedIdeas) / len(selectedIdeas)
    return open_prompt_position(nodes, promptX, desiredPromptY, ideaCount)
