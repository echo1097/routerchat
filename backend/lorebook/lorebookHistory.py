from typing import Any

from backend.lorebook.lorebookRows import format_duration


def lorebook_update_kind(update: dict[str, Any]) -> str:
    action = str(update.get("action") or "").lower()
    if action == "delete":
        return "lore_hide"
    return "lore_create" if action == "create" else "lore_update"


def lorebook_history_label(model_label: str, update: dict[str, Any]) -> str:
    name = str(update.get("name") or "entry").strip() or "entry"
    action = str(update.get("action") or "").lower()
    #nothing is deleted here, disabled just drops it from context, and the wording matches the include/exclude toggle that undoes it
    if action == "delete":
        return f"{model_label} excluded {name} from context"
    if name.casefold() == "timeline":
        return f"{model_label} updated Timeline"

    action = "added" if action == "create" else "updated"
    destination = "in" if action == "updated" else "to"
    return f"{model_label} {action} {name} {destination} Lorebook"


def lorebook_run_history_actions(
    model_label: str,
    applied: list[dict[str, Any]],
    duration_ms: float,
    cost: float | None = None,
    skipped: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    #a quiet run is still a run, so both endings get a line instead of pretending nothing happened
    actions = [
        {
            "label": lorebook_history_label(model_label, update),
            "kind": lorebook_update_kind(update),
            "words_added": update.get("wordsAdded"),
            "words_removed": update.get("wordsRemoved"),
            "cost": None,
            "detail": "",
        }
        for update in applied
    ]
    if applied:
        summary = f"{model_label} finished editing Lorebook after {format_duration(duration_ms)}"
        #run totals, same idea as the cost subtotal on the run header. hides sit out because nothing was written, the text just left context
        changed = [update for update in applied if lorebook_update_kind(update) != "lore_hide"]
        totalAdded = sum(int(update.get("wordsAdded") or 0) for update in changed)
        totalRemoved = sum(int(update.get("wordsRemoved") or 0) for update in changed)
    else:
        summary = f"{model_label} found no Lorebook changes after {format_duration(duration_ms)}"
        totalAdded = None
        totalRemoved = None

    #one api call means one cost, so it rides on the closing line instead of being faked across every entry
    actions.append(
        {
            "label": summary,
            "kind": "lore_summary",
            "words_added": totalAdded,
            "words_removed": totalRemoved,
            "cost": cost,
            "detail": (
                f"{len(skipped)} targeted lorebook {'edit was' if len(skipped) == 1 else 'edits were'} skipped."
                if skipped
                else ""
            ),
        }
    )
    return actions
