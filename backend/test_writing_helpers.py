import sys
import types
import unittest


sys.modules.setdefault("httpx", types.SimpleNamespace())
sys.modules.setdefault("fastapi", types.SimpleNamespace(APIRouter=object, HTTPException=Exception))
sys.modules.setdefault(
    "fastapi.responses",
    types.SimpleNamespace(StreamingResponse=object),
)

try:
    import pydantic  # noqa: F401
except ModuleNotFoundError:
    sys.modules.setdefault(
        "pydantic",
        types.SimpleNamespace(
            BaseModel=object,
            Field=lambda default=None, **_kwargs: default,
        ),
    )

from backend.writing import (
    append_chapter_text,
    apply_chapter_operation,
    chapter_blocks,
    effective_generation_mode,
)


class ChapterBlockTests(unittest.TestCase):
    def test_empty_chapter_has_no_blocks(self):
        self.assertEqual(chapter_blocks(""), [])

    def test_four_paragraphs_are_one_based(self):
        blocks = chapter_blocks("one\n\ntwo\n\nthree\n\nfour")

        self.assertEqual([block["blockId"] for block in blocks], ["p_001", "p_002", "p_003", "p_004"])
        self.assertEqual([block["index"] for block in blocks], [1, 2, 3, 4])

    def test_multiple_blank_lines_split_paragraphs(self):
        blocks = chapter_blocks("one\n\n\n\ntwo")

        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[1]["text"], "two")

    def test_scene_break_does_not_increment_paragraphs(self):
        blocks = chapter_blocks("one\n\n***\n\ntwo")

        self.assertEqual([block["blockId"] for block in blocks], ["p_001", "s_001", "p_002"])
        self.assertEqual(blocks[1]["type"], "sceneBreak")


class ChapterOperationTests(unittest.TestCase):
    def test_replace_block_removes_original_text(self):
        content = "one\n\ntwo\n\nthree\n\nfour"
        block = chapter_blocks(content)[3]

        result = apply_chapter_operation(
            content,
            {
                "operation": "replaceBlock",
                "blockId": block["blockId"],
                "expectedTextHash": block["textHash"],
                "newText": "four rewritten",
            },
        )

        self.assertEqual(result["content"], "one\n\ntwo\n\nthree\n\nfour rewritten")
        self.assertNotIn("\n\nfour\n", result["content"])

    def test_replace_blocks_removes_span(self):
        content = "one\n\ntwo\n\nthree\n\nfour"
        blocks = chapter_blocks(content)

        result = apply_chapter_operation(
            content,
            {
                "operation": "replaceBlocks",
                "blockIds": ["p_002", "p_003"],
                "expectedTextHashes": {
                    "p_002": blocks[1]["textHash"],
                    "p_003": blocks[2]["textHash"],
                },
                "newBlocks": [{"text": "two and three rewritten"}],
            },
        )

        self.assertEqual(result["content"], "one\n\ntwo and three rewritten\n\nfour")

    def test_hash_mismatch_fails(self):
        content = "one\n\ntwo"

        with self.assertRaises(ValueError):
            apply_chapter_operation(
                content,
                {
                    "operation": "replaceBlock",
                    "blockId": "p_002",
                    "expectedTextHash": "bad",
                    "newText": "new",
                },
            )

    def test_invalid_block_id_fails(self):
        content = "one\n\ntwo"

        with self.assertRaises(ValueError):
            apply_chapter_operation(
                content,
                {
                    "operation": "replaceBlock",
                    "blockId": "p_999",
                    "expectedTextHash": "bad",
                    "newText": "new",
                },
            )

    def test_insert_after_preserves_target(self):
        content = "one\n\ntwo"
        block = chapter_blocks(content)[0]

        result = apply_chapter_operation(
            content,
            {
                "operation": "insertAfterBlock",
                "blockId": block["blockId"],
                "expectedTextHash": block["textHash"],
                "newText": "between",
            },
        )

        self.assertEqual(result["content"], "one\n\nbetween\n\ntwo")

    def test_append_text_fallback_keeps_plain_prose_visible(self):
        result = append_chapter_text("one", "two")

        self.assertEqual(result["content"], "one\n\ntwo")
        self.assertEqual(result["operation"], "appendToChapter")

    def test_blank_chapter_uses_new_mode_even_when_edit_requested(self):
        self.assertEqual(effective_generation_mode("edit", ""), "new")
        self.assertEqual(effective_generation_mode("edit", "existing"), "edit")


if __name__ == "__main__":
    unittest.main()
