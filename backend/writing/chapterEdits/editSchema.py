from typing import Any

CHAPTER_EDIT_SCHEMA_OPERATIONS = [
    "replaceBlock",
    "insertBeforeBlock",
    "insertAfterBlock",
    "appendToChapter",
]


def chapterEditOperationSchema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "operation": {
                "type": "string",
                "enum": CHAPTER_EDIT_SCHEMA_OPERATIONS,
            },
            "blockId": {
                "type": "string",
                "description": (
                    "The id of the block this edit targets, copied from the block map, such as "
                    "p_004. For appendToChapter use the id of the last block."
                ),
            },
            "endBlockId": {
                "type": "string",
                "description": (
                    "The id of the last block when replaceBlock rewrites several blocks in a "
                    "row. For a single block, and for every other operation, repeat blockId."
                ),
            },
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
        },
        "required": ["operation", "blockId", "endBlockId", "newText"],
    }


def chapterEditBatchSchema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "edits": {
                "type": "array",
                "minItems": 1,
                "items": chapterEditOperationSchema(),
            },
        },
        "required": ["edits"],
    }


def chapterEditResponseFormat() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "chapter_edit_batch",
            "strict": True,
            "schema": chapterEditBatchSchema(),
        },
    }
