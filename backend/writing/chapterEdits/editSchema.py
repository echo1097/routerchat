from typing import Any


def chapter_edit_operation_schema() -> dict[str, Any]:
    operationFields = {
        "operation": {"type": "string"},
        "blockId": {"type": "string", "minLength": 1},
        "anchorText": {"type": "string", "minLength": 1},
        "newText": {
            "type": "array",
            "minItems": 1,
            "items": {"type": "string"},
            "description": (
                "The replacement prose as chapter Markdown, one array entry per paragraph, in "
                "the order they should appear. Two paragraphs means two entries. Write each "
                "entry as ordinary text with no line breaks inside it and never write \\n."
            ),
        },
    }

    def variant(operationType: str, requiredFields: list[str]) -> dict[str, Any]:
        #properties come from this variants own required list, otherwise the schema advertises fields the validator will not take
        return {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                **{field: operationFields[field] for field in requiredFields},
                "operation": {"const": operationType},
            },
            "required": requiredFields,
        }

    rangeFields = {
        "startBlockId": {"type": "string", "minLength": 1},
        "startAnchorText": {"type": "string", "minLength": 1},
        "endBlockId": {"type": "string", "minLength": 1},
        "endAnchorText": {"type": "string", "minLength": 1},
    }

    return {
        "type": "object",
        "oneOf": [
            variant(
                "replaceBlock",
                ["operation", "blockId", "anchorText", "newText"],
            ),
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "newText": operationFields["newText"],
                    **rangeFields,
                    "operation": {"const": "replaceBlockRange"},
                },
                "required": [
                    "operation",
                    "startBlockId",
                    "startAnchorText",
                    "endBlockId",
                    "endAnchorText",
                    "newText",
                ],
            },
            variant(
                "insertBeforeBlock",
                ["operation", "blockId", "anchorText", "newText"],
            ),
            variant(
                "insertAfterBlock",
                ["operation", "blockId", "anchorText", "newText"],
            ),
            variant("appendToChapter", ["operation", "newText"]),
        ],
    }


def chapter_edit_batch_schema() -> dict[str, Any]:
    #chapterRevision lives on the envelope now, one statement of it instead of one per edit that can disagree with its neighbours
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "chapterRevision": {"type": "integer", "minimum": 0},
            "edits": {
                "type": "array",
                "minItems": 1,
                "items": chapter_edit_operation_schema(),
            },
        },
        "required": ["chapterRevision", "edits"],
    }


def chapter_edit_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "chapter_edit_batch",
            "strict": True,
            "schema": chapter_edit_batch_schema(),
        },
    }
