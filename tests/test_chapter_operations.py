import json
import unittest

from backend.writing import (
    CHAPTER_EDIT_INVALID_JSON,
    CHAPTER_EDIT_INVALID_OPERATION,
    CHAPTER_EDIT_REVISION_MISMATCH,
    CHAPTER_EDIT_TARGET_MISMATCH,
    ChapterEditError,
    apply_chapter_operation,
    block_map_for_prompt,
    chapter_blocks,
    parse_chapter_operation,
    text_hash,
)


class ChapterOperationTest(unittest.TestCase):
    def setUp(self):
        self.content = "first paragraph\n\n***\n\nlast paragraph"
        self.blocks = chapter_blocks(self.content)
        self.firstBlock = self.blocks[0]
        self.sceneBlock = self.blocks[1]
        self.lastBlock = self.blocks[2]

    def assertErrorCode(self, callback, code):
        with self.assertRaises(ChapterEditError) as context:
            callback()
        self.assertEqual(context.exception.code, code)

    def operation(self, operationType, **fields):
        return {
            "operation": operationType,
            "chapterRevision": 7,
            **fields,
        }

    def test_block_ids_and_prompt_map_are_deterministic_and_compact(self):
        self.assertEqual(
            [block["blockId"] for block in self.blocks],
            ["p_001", "s_001", "p_002"],
        )
        self.assertEqual(self.firstBlock["textHash"], text_hash("first paragraph"))
        promptBlock = block_map_for_prompt(self.blocks)[0]
        self.assertEqual(
            set(promptBlock),
            {"blockId", "type", "index", "preview", "textHash"},
        )

    def test_replace_block(self):
        operation = self.operation(
            "replaceBlock",
            blockId=self.firstBlock["blockId"],
            expectedTextHash=self.firstBlock["textHash"],
            newText="rewritten paragraph",
        )
        result = apply_chapter_operation(self.content, operation, baseRevision=7)
        self.assertEqual(result["content"], "rewritten paragraph\n\n***\n\nlast paragraph")
        self.assertEqual(result["deletedBlockIds"], ["p_001"])
        self.assertEqual(result["insertedBlockIds"], ["p_001"])

    def test_scene_break_can_be_replaced(self):
        operation = self.operation(
            "replaceBlock",
            blockId=self.sceneBlock["blockId"],
            expectedTextHash=self.sceneBlock["textHash"],
            newText="a quiet turn",
        )
        result = apply_chapter_operation(self.content, operation, baseRevision=7)
        self.assertIn("first paragraph\n\na quiet turn\n\nlast paragraph", result["content"])

    def test_insert_operations_use_target_hash(self):
        before = self.operation(
            "insertBeforeBlock",
            blockId=self.lastBlock["blockId"],
            expectedTextHash=self.lastBlock["textHash"],
            newText="new setup\n\nsecond setup",
        )
        after = self.operation(
            "insertAfterBlock",
            blockId=self.firstBlock["blockId"],
            expectedTextHash=self.firstBlock["textHash"],
            newText="new follow-up",
        )
        self.assertIn("second setup\n\nlast paragraph", apply_chapter_operation(self.content, before)["content"])
        self.assertIn("first paragraph\n\nnew follow-up\n\n***", apply_chapter_operation(self.content, after)["content"])

    def test_append_is_revision_bound(self):
        operation = self.operation("appendToChapter", newText="final paragraph")
        result = apply_chapter_operation(self.content, operation, baseRevision=7)
        self.assertTrue(result["content"].endswith("last paragraph\n\nfinal paragraph"))
        self.assertErrorCode(
            lambda: apply_chapter_operation(self.content, operation, baseRevision=8),
            CHAPTER_EDIT_REVISION_MISMATCH,
        )

    def test_parser_requires_exact_canonical_json(self):
        raw = (
            '{"operation":"appendToChapter","chapterRevision":7,'
            '"newText":"continue"}'
        )
        self.assertEqual(parse_chapter_operation(raw), {
            "operation": "appendToChapter",
            "chapterRevision": 7,
            "newText": "continue",
        })
        self.assertErrorCode(lambda: parse_chapter_operation("```json\n" + raw + "\n```"), CHAPTER_EDIT_INVALID_JSON)
        self.assertErrorCode(lambda: parse_chapter_operation("here is the edit: " + raw), CHAPTER_EDIT_INVALID_JSON)
        self.assertErrorCode(lambda: parse_chapter_operation("[]"), CHAPTER_EDIT_INVALID_OPERATION)

    def test_parser_rejects_legacy_shapes_and_invalid_fields(self):
        cases = [
            {"type": "appendToChapter", "chapterRevision": 7, "newText": "x"},
            {"operation": "replaceBlocks", "chapterRevision": 7, "newText": "x"},
            {"operation": "appendToChapter", "chapterRevision": 7, "newText": "x", "extra": True},
            {"operation": "appendToChapter", "chapterRevision": 7, "newText": ""},
            {"operation": "appendToChapter", "chapterRevision": True, "newText": "x"},
        ]
        for operation in cases:
            self.assertErrorCode(
                lambda operation=operation: parse_chapter_operation(json.dumps(operation)),
                CHAPTER_EDIT_INVALID_OPERATION,
            )

    def test_target_validation_rejects_missing_and_changed_targets(self):
        missingHash = self.operation(
            "replaceBlock",
            blockId=self.firstBlock["blockId"],
            expectedTextHash="",
            newText="replacement",
        )
        changedHash = self.operation(
            "replaceBlock",
            blockId=self.firstBlock["blockId"],
            expectedTextHash=text_hash("different"),
            newText="replacement",
        )
        unknownBlock = self.operation(
            "replaceBlock",
            blockId="p_999",
            expectedTextHash=text_hash("different"),
            newText="replacement",
        )
        self.assertErrorCode(lambda: parse_chapter_operation(json.dumps(missingHash)), CHAPTER_EDIT_INVALID_OPERATION)
        self.assertErrorCode(
            lambda: apply_chapter_operation(self.content, changedHash, baseRevision=7),
            CHAPTER_EDIT_TARGET_MISMATCH,
        )
        self.assertErrorCode(
            lambda: apply_chapter_operation(self.content, unknownBlock, baseRevision=7),
            CHAPTER_EDIT_TARGET_MISMATCH,
        )


if __name__ == "__main__":
    unittest.main()
