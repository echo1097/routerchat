from typing import Any

CHAPTER_EDIT_OPERATIONS = {
    "replaceBlock",
    "replaceBlockRange",
    "insertBeforeBlock",
    "insertAfterBlock",
    "appendToChapter",
}
CHAPTER_EDIT_INVALID_JSON = "chapter_edit_invalid_json"
CHAPTER_EDIT_INVALID_OPERATION = "chapter_edit_invalid_operation"
CHAPTER_EDIT_REVISION_MISMATCH = "chapter_edit_revision_mismatch"
CHAPTER_EDIT_TARGET_MISMATCH = "chapter_edit_target_mismatch"
CHAPTER_EDIT_CONFLICTING_EDITS = "chapter_edit_conflicting_edits"
CHAPTER_EDIT_TRUNCATED = "chapter_edit_truncated"
CHAPTER_REVISION_CONFLICT = "chapter_revision_conflict"


class ChapterEditError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


#a repair run never offers another repair, which is what keeps this from turning into a loop that quietly bills someone
REPAIRABLE_EDIT_CODES = {
    CHAPTER_EDIT_INVALID_JSON,
    CHAPTER_EDIT_INVALID_OPERATION,
    CHAPTER_EDIT_TARGET_MISMATCH,
    CHAPTER_EDIT_CONFLICTING_EDITS,
    CHAPTER_EDIT_TRUNCATED,
}


def repairable_error_event(code: str, message: str, is_repair: bool = False) -> dict[str, Any]:
    return {
        "code": code,
        "message": message,
        "repairable": code in REPAIRABLE_EDIT_CODES and not is_repair,
    }
