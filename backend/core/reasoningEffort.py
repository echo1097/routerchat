from typing import Annotated, Any, Literal

from pydantic import BeforeValidator


ReasoningEffort = Literal["low", "medium", "high", "max", "xhigh"]


def coerce_reasoning_effort(value: Any) -> ReasoningEffort:
    if value == "xhigh":
        return "max"
    return value if value in {"low", "medium", "high", "max"} else "medium"


LenientReasoningEffort = Annotated[ReasoningEffort, BeforeValidator(coerce_reasoning_effort)]
