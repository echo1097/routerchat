import json
import unittest

from backend.writing import (
    CHAPTER_EDIT_CONFLICTING_EDITS,
    CHAPTER_EDIT_INVALID_FORMAT,
    CHAPTER_EDIT_INVALID_JSON,
    CHAPTER_EDIT_INVALID_OPERATION,
    CHAPTER_EDIT_REVISION_MISMATCH,
    CHAPTER_EDIT_TARGET_MISMATCH,
    CHAPTER_EDIT_TRUNCATED,
    ChapterEditError,
    apply_chapter_edits,
    apply_chapter_operation,
    block_map_for_prompt,
    chapter_blocks,
    chapter_edit_operation_schema,
    parse_chapter_edit_batch,
    parse_chapter_operation,
    validate_chapter_operation,
    word_diff_counts,
)


class WordDiffCountsTest(unittest.TestCase):
    def test_appended_paragraph_counts_its_words(self):
        self.assertEqual(word_diff_counts("one two", "one two\n\nthree four five"), (3, 0))

    def test_deleted_paragraph_counts_its_words(self):
        self.assertEqual(word_diff_counts("one two\n\nthree four", "one two"), (0, 2))

    def test_one_swapped_word_scores_one_not_the_whole_paragraph(self):
        #the whole reason for words, under line counting both of these scored +1 -1
        paragraph = "the cat sat quietly on the warm stone wall"
        tweaked = "the cat sat quietly on the cold stone wall"
        self.assertEqual(word_diff_counts(paragraph, tweaked), (1, 1))

        rewritten = "a dog barked loudly beneath a broken wooden fence"
        added, removed = word_diff_counts(paragraph, rewritten)
        self.assertGreater(added, 5)
        self.assertGreater(removed, 5)

    def test_identical_text_is_a_no_op(self):
        self.assertEqual(word_diff_counts("one two", "one two"), (0, 0))

    def test_blank_line_churn_alone_changes_nothing(self):
        #paragraph spacing shifting around is not an edit and should not inflate the counts
        self.assertEqual(word_diff_counts("one\n\ntwo", "one\n\n\n\ntwo\n"), (0, 0))

    def test_common_words_are_not_written_off_as_noise(self):
        #difflib autojunk would discard "the" on longer text and undercount, this guards that it stays off
        before = " ".join(["the"] * 40)
        after = " ".join(["the"] * 40 + ["and"])
        self.assertEqual(word_diff_counts(before, after), (1, 0))

    def test_empty_sides_count_every_word(self):
        self.assertEqual(word_diff_counts("", "one two\n\nthree"), (3, 0))
        self.assertEqual(word_diff_counts("one two\n\nthree", ""), (0, 3))

    def test_none_is_treated_as_empty(self):
        self.assertEqual(word_diff_counts(None, "one"), (1, 0))


class ChapterEditBatchTest(unittest.TestCase):
    def setUp(self):
        self.content = "one alpha\n\ntwo bravo\n\nthree charlie\n\nfour delta"
        self.blocks = chapter_blocks(self.content)

    def edit(self, index, newText):
        block = self.blocks[index]
        return {
            "operation": "replaceBlock",
            "blockId": block["blockId"],
            "anchorText": block["anchorText"],
            "newText": newText,
        }

    def batch(self, *edits, revision=7):
        return {"chapterRevision": revision, "edits": list(edits)}

    def assertErrorCode(self, callback, code):
        with self.assertRaises(ChapterEditError) as context:
            callback()
        self.assertEqual(context.exception.code, code)

    def test_two_distant_edits_leave_the_middle_untouched(self):
        #the entire reason this exists, before it the model had to sweep 1 through 4 and retype the middle from memory
        result = apply_chapter_edits(
            self.content,
            self.batch(self.edit(0, "one EDITED"), self.edit(3, "four EDITED")),
            baseRevision=7,
        )
        self.assertEqual(
            result["content"],
            "one EDITED\n\ntwo bravo\n\nthree charlie\n\nfour EDITED",
        )

    def test_order_in_the_array_does_not_matter(self):
        forwards = apply_chapter_edits(
            self.content,
            self.batch(self.edit(0, "A"), self.edit(2, "B"), self.edit(3, "C")),
            baseRevision=7,
        )
        backwards = apply_chapter_edits(
            self.content,
            self.batch(self.edit(3, "C"), self.edit(2, "B"), self.edit(0, "A")),
            baseRevision=7,
        )
        self.assertEqual(forwards["content"], backwards["content"])
        self.assertEqual(forwards["content"], "A\n\ntwo bravo\n\nB\n\nC")

    def test_mixed_operations_apply_against_one_snapshot(self):
        insert = {
            "operation": "insertAfterBlock",
            "blockId": self.blocks[0]["blockId"],
            "anchorText": self.blocks[0]["anchorText"],
            "newText": "inserted line",
        }
        result = apply_chapter_edits(
            self.content, self.batch(insert, self.edit(3, "four EDITED")), baseRevision=7
        )
        self.assertEqual(
            result["content"],
            "one alpha\n\ninserted line\n\ntwo bravo\n\nthree charlie\n\nfour EDITED",
        )

    def test_single_newlines_in_generated_prose_become_paragraph_breaks(self):
        result = apply_chapter_edits(
            self.content,
            self.batch(self.edit(1, "first new paragraph\nsecond new paragraph")),
            baseRevision=7,
        )

        self.assertIn(
            "first new paragraph\n\nsecond new paragraph",
            result["content"],
        )
        self.assertEqual(
            result["edits"][0]["appliedText"],
            "first new paragraph\n\nsecond new paragraph",
        )

    def test_generated_prose_normalizes_line_endings_and_extra_blank_lines(self):
        result = apply_chapter_edits(
            self.content,
            self.batch(self.edit(1, "first paragraph  \r\n\r\n\r\nsecond paragraph")),
            baseRevision=7,
        )

        self.assertIn("first paragraph\n\nsecond paragraph", result["content"])

    def test_markdown_list_lines_stay_in_one_list(self):
        result = apply_chapter_edits(
            self.content,
            self.batch(self.edit(1, "- first item\n- second item")),
            baseRevision=7,
        )

        self.assertIn("- first item\n- second item", result["content"])

    def test_code_fence_whitespace_is_left_alone(self):
        code = "```text\nFirst.Second\n\n\nlast line\n```"
        result = apply_chapter_edits(
            self.content,
            self.batch(self.edit(1, code)),
            baseRevision=7,
        )

        self.assertIn(code, result["content"])

    def test_sentences_joined_without_a_space_are_rejected(self):
        malformed = self.edit(1, "The door closed.She heard the lock turn.")

        self.assertErrorCode(
            lambda: apply_chapter_edits(
                self.content,
                self.batch(malformed),
                baseRevision=7,
            ),
            CHAPTER_EDIT_INVALID_FORMAT,
        )

    def test_a_long_unbroken_response_gets_paragraph_breaks(self):
        sentences = [
            f"Sentence {index} carries enough ordinary words to resemble generated prose."
            for index in range(40)
        ]
        result = apply_chapter_edits(
            self.content,
            self.batch(self.edit(1, " ".join(sentences))),
            baseRevision=7,
        )

        appliedText = result["edits"][0]["appliedText"]
        self.assertIn("\n\n", appliedText)
        self.assertEqual(appliedText.replace("\n\n", " "), " ".join(sentences))

    def test_a_long_run_on_sentence_is_still_rejected(self):
        malformed = self.edit(1, " ".join(["word"] * 301))

        self.assertErrorCode(
            lambda: apply_chapter_edits(self.content, self.batch(malformed), baseRevision=7),
            CHAPTER_EDIT_INVALID_FORMAT,
        )

    def test_partial_mode_keeps_valid_edits_and_reports_malformed_prose(self):
        result = apply_chapter_edits(
            self.content,
            self.batch(
                self.edit(0, "one rewritten"),
                self.edit(2, "This broke.Then it got worse."),
            ),
            baseRevision=7,
            partial=True,
        )

        self.assertEqual(
            result["content"],
            "one rewritten\n\ntwo bravo\n\nthree charlie\n\nfour delta",
        )
        self.assertEqual(result["rejected"][0]["code"], CHAPTER_EDIT_INVALID_FORMAT)

    def test_two_edits_on_the_same_block_are_rejected(self):
        self.assertErrorCode(
            lambda: apply_chapter_edits(
                self.content,
                self.batch(self.edit(1, "first"), self.edit(1, "second")),
                baseRevision=7,
            ),
            CHAPTER_EDIT_CONFLICTING_EDITS,
        )

    def test_a_range_overlapping_another_edit_is_rejected(self):
        spanning = {
            "operation": "replaceBlockRange",
            "startBlockId": self.blocks[0]["blockId"],
            "startAnchorText": self.blocks[0]["anchorText"],
            "endBlockId": self.blocks[2]["blockId"],
            "endAnchorText": self.blocks[2]["anchorText"],
            "newText": "swept",
        }
        self.assertErrorCode(
            lambda: apply_chapter_edits(
                self.content, self.batch(spanning, self.edit(1, "clash")), baseRevision=7
            ),
            CHAPTER_EDIT_CONFLICTING_EDITS,
        )

    def test_two_appends_are_rejected(self):
        append = {"operation": "appendToChapter", "newText": "tail"}
        self.assertErrorCode(
            lambda: apply_chapter_edits(
                self.content, self.batch(append, dict(append)), baseRevision=7
            ),
            CHAPTER_EDIT_CONFLICTING_EDITS,
        )

    def badAnchorEdit(self, newText="orphan"):
        return {
            "operation": "replaceBlock",
            "blockId": "p_999",
            "anchorText": "a sentence that appears nowhere in this chapter at all",
            "newText": newText,
        }

    def test_partial_keeps_the_good_edits_and_reports_the_bad_one(self):
        #the whole point of flaw 3, one bad anchor used to take three good edits down with it
        result = apply_chapter_edits(
            self.content,
            self.batch(self.edit(0, "one EDITED"), self.badAnchorEdit(), self.edit(3, "four EDITED")),
            baseRevision=7,
            partial=True,
        )

        self.assertEqual(
            result["content"],
            "one EDITED\n\ntwo bravo\n\nthree charlie\n\nfour EDITED",
        )
        self.assertEqual(len(result["edits"]), 2)
        self.assertEqual(len(result["rejected"]), 1)
        self.assertEqual(result["rejected"][0]["code"], CHAPTER_EDIT_TARGET_MISMATCH)
        self.assertEqual(result["rejected"][0]["operation"]["newText"], "orphan")

    def test_partial_still_fails_when_nothing_survives(self):
        self.assertErrorCode(
            lambda: apply_chapter_edits(
                self.content,
                self.batch(self.badAnchorEdit(), self.badAnchorEdit("also orphan")),
                baseRevision=7,
                partial=True,
            ),
            CHAPTER_EDIT_TARGET_MISMATCH,
        )

    def test_partial_lets_the_first_claim_on_a_block_win(self):
        result = apply_chapter_edits(
            self.content,
            self.batch(self.edit(1, "first"), self.edit(1, "second")),
            baseRevision=7,
            partial=True,
        )

        self.assertIn("first", result["content"])
        self.assertNotIn("second", result["content"])
        self.assertEqual(result["rejected"][0]["code"], CHAPTER_EDIT_CONFLICTING_EDITS)

    def test_partial_keeps_the_first_append_and_drops_the_second(self):
        append = {"operation": "appendToChapter", "newText": "tail"}
        result = apply_chapter_edits(
            self.content,
            self.batch(append, {"operation": "appendToChapter", "newText": "second tail"}),
            baseRevision=7,
            partial=True,
        )

        self.assertTrue(result["content"].endswith("four delta\n\ntail"))
        self.assertEqual(result["rejected"][0]["code"], CHAPTER_EDIT_CONFLICTING_EDITS)

    def test_partial_leaves_a_clean_batch_with_nothing_rejected(self):
        result = apply_chapter_edits(
            self.content,
            self.batch(self.edit(0, "one EDITED")),
            baseRevision=7,
            partial=True,
        )
        self.assertEqual(result["rejected"], [])

    def test_an_empty_edits_array_is_rejected(self):
        self.assertErrorCode(
            lambda: apply_chapter_edits(self.content, self.batch(), baseRevision=7),
            CHAPTER_EDIT_INVALID_OPERATION,
        )

    def test_envelope_revision_must_match(self):
        self.assertErrorCode(
            lambda: apply_chapter_edits(
                self.content, self.batch(self.edit(0, "x"), revision=6), baseRevision=7
            ),
            CHAPTER_EDIT_REVISION_MISMATCH,
        )

    def test_a_leftover_revision_on_an_edit_is_tolerated(self):
        noisy = {**self.edit(0, "one EDITED"), "chapterRevision": 7}
        result = apply_chapter_edits(self.content, self.batch(noisy), baseRevision=7)
        self.assertTrue(result["content"].startswith("one EDITED"))

    def test_a_bare_single_operation_still_parses(self):
        raw = json.dumps({
            "operation": "replaceBlock",
            "chapterRevision": 7,
            "blockId": self.blocks[0]["blockId"],
            "anchorText": self.blocks[0]["anchorText"],
            "newText": "one EDITED",
        })
        batch = parse_chapter_edit_batch(raw)
        self.assertEqual(batch["chapterRevision"], 7)
        self.assertEqual(len(batch["edits"]), 1)
        result = apply_chapter_edits(self.content, batch, baseRevision=7)
        self.assertTrue(result["content"].startswith("one EDITED"))

    def test_the_envelope_shape_parses(self):
        raw = json.dumps({
            "chapterRevision": 7,
            "edits": [self.edit(0, "one EDITED"), self.edit(3, "four EDITED")],
        })
        result = apply_chapter_edits(self.content, parse_chapter_edit_batch(raw), baseRevision=7)
        self.assertEqual(
            result["content"],
            "one EDITED\n\ntwo bravo\n\nthree charlie\n\nfour EDITED",
        )

    def test_a_batch_cut_off_mid_array_keeps_the_complete_edits(self):
        raw = json.dumps({
            "chapterRevision": 7,
            "edits": [self.edit(0, "one EDITED"), self.edit(3, "four EDITED")],
        })
        #chopped partway through the second edit, exactly what max_tokens does
        truncated = raw[:raw.rindex("four EDITED") + 4]

        batch = parse_chapter_edit_batch(truncated)
        self.assertTrue(batch["truncated"])
        self.assertEqual(batch["chapterRevision"], 7)
        self.assertEqual(len(batch["edits"]), 1)

        result = apply_chapter_edits(self.content, batch, baseRevision=7, partial=True)
        self.assertTrue(result["content"].startswith("one EDITED"))

    def test_a_batch_cut_off_before_any_edit_closed_is_still_an_error(self):
        self.assertErrorCode(
            lambda: parse_chapter_edit_batch('{"chapterRevision": 7, "edits": [{"operation": "repl'),
            CHAPTER_EDIT_TRUNCATED,
        )

    def test_a_wrong_block_id_is_recovered_from_the_anchor(self):
        #the quoted prose is the stronger signal, the model only got its own bookkeeping wrong
        misfiled = {**self.edit(2, "three EDITED"), "blockId": "p_001"}
        result = apply_chapter_edits(self.content, self.batch(misfiled), baseRevision=7, partial=True)

        self.assertEqual(result["rejected"], [])
        self.assertEqual(
            result["content"],
            "one alpha\n\ntwo bravo\n\nthree EDITED\n\nfour delta",
        )

    def test_an_anchor_that_could_be_two_blocks_is_not_guessed_at(self):
        content = "the same line here\n\nsomething else entirely\n\nthe same line here"
        blocks = chapter_blocks(content)
        ambiguous = {
            "operation": "replaceBlock",
            "blockId": "p_009",
            "anchorText": blocks[0]["anchorText"],
            "newText": "guessed",
        }
        self.assertErrorCode(
            lambda: apply_chapter_edits(
                content, self.batch(ambiguous), baseRevision=7, partial=True
            ),
            CHAPTER_EDIT_TARGET_MISMATCH,
        )

    def test_the_schema_no_longer_advertises_fields_the_validator_refuses(self):
        variants = {
            variant["properties"]["operation"]["const"]: set(variant["properties"])
            for variant in chapter_edit_operation_schema()["oneOf"]
        }
        self.assertEqual(variants["appendToChapter"], {"operation", "newText"})
        self.assertNotIn("blockId", variants["replaceBlockRange"])
        for name, properties in variants.items():
            self.assertEqual(
                properties,
                set(next(
                    variant["required"]
                    for variant in chapter_edit_operation_schema()["oneOf"]
                    if variant["properties"]["operation"]["const"] == name
                )),
            )


class SingleNewlineBlockGranularityTest(unittest.TestCase):
    #prose pasted or imported without blank lines between paragraphs used to collapse into one giant block
    def test_single_newline_paragraphs_do_not_collapse_into_one_block(self):
        content = (
            "first paragraph line\n"
            "second paragraph line\n"
            "third paragraph line"
        )
        blocks = chapter_blocks(content)
        self.assertEqual(
            [block["text"] for block in blocks],
            ["first paragraph line", "second paragraph line", "third paragraph line"],
        )

    def test_editing_one_single_newline_block_leaves_its_neighbours_untouched(self):
        content = (
            "first paragraph line\n"
            "second paragraph line\n"
            "third paragraph line"
        )
        blocks = chapter_blocks(content)
        edit = {
            "operation": "replaceBlock",
            "chapterRevision": 3,
            "blockId": blocks[1]["blockId"],
            "anchorText": blocks[1]["anchorText"],
            "newText": "second paragraph line EDITED",
        }
        result = apply_chapter_edits(
            content, {"chapterRevision": 3, "edits": [edit]}, baseRevision=3
        )
        self.assertEqual(
            result["content"],
            "first paragraph line\nsecond paragraph line EDITED\nthird paragraph line",
        )

    def test_scene_break_is_detected_across_single_newlines(self):
        content = "before text here\n***\nafter text here"
        blocks = chapter_blocks(content)
        self.assertEqual(
            [block["type"] for block in blocks],
            ["paragraph", "sceneBreak", "paragraph"],
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
        self.assertEqual(self.firstBlock["anchorText"], "first paragraph")
        promptBlock = block_map_for_prompt(self.blocks)[0]
        #the map has to advertise the same field name the operation must send back
        self.assertEqual(
            set(promptBlock),
            {"blockId", "type", "index", "anchorText"},
        )
        self.assertEqual(promptBlock["anchorText"], self.firstBlock["anchorText"])

    def test_a_long_block_gets_a_word_trimmed_anchor(self):
        #the advertised anchor has to be copyable, so it never ends halfway through a word
        content = " ".join(["sentence"] * 40)
        block = chapter_blocks(content)[0]
        self.assertLess(len(block["anchorText"]), len(content))
        self.assertTrue(content.startswith(block["anchorText"]))
        self.assertFalse(block["anchorText"].endswith("sent"))

        operation = self.operation(
            "replaceBlock",
            blockId=block["blockId"],
            anchorText=block["anchorText"],
            newText="rewritten",
        )
        self.assertEqual(
            apply_chapter_operation(content, operation, baseRevision=7)["content"],
            "rewritten",
        )

    def test_anchor_field_nickname_is_accepted_instead_of_being_discarded(self):
        #exactly what qwen sent: right block, right revision, good prose, one shortened field name
        operation = {
            "operation": "replaceBlock",
            "chapterRevision": 7,
            "blockId": self.firstBlock["blockId"],
            "anchor": self.firstBlock["anchorText"],
            "newText": "rewritten paragraph",
        }
        result = apply_chapter_operation(self.content, operation, baseRevision=7)
        self.assertEqual(result["content"], "rewritten paragraph\n\n***\n\nlast paragraph")

    def test_range_anchor_nicknames_are_accepted(self):
        content = "before\n\nreplace one\n\nreplace two"
        blocks = chapter_blocks(content)
        operation = {
            "operation": "replaceBlockRange",
            "chapterRevision": 7,
            "startBlockId": blocks[1]["blockId"],
            "startAnchor": blocks[1]["anchorText"],
            "endBlockId": blocks[2]["blockId"],
            "endAnchor": blocks[2]["anchorText"],
            "newText": "merged",
        }
        result = apply_chapter_operation(content, operation, baseRevision=7)
        self.assertEqual(result["content"], "before\n\nmerged")

    def test_a_wrong_anchor_still_fails_under_the_nickname(self):
        #tolerating the nickname must not tolerate a bad value
        operation = {
            "operation": "replaceBlock",
            "chapterRevision": 7,
            "blockId": self.firstBlock["blockId"],
            "anchor": "something else entirely, from a different chapter",
            "newText": "rewritten paragraph",
        }
        self.assertErrorCode(
            lambda: apply_chapter_operation(self.content, operation, baseRevision=7),
            CHAPTER_EDIT_TARGET_MISMATCH,
        )

    def test_the_real_field_name_wins_when_both_are_sent(self):
        operation = {
            "operation": "replaceBlock",
            "chapterRevision": 7,
            "blockId": self.firstBlock["blockId"],
            "anchorText": self.firstBlock["anchorText"],
            "anchor": "stale nonsense from an older draft entirely",
            "newText": "rewritten paragraph",
        }
        result = apply_chapter_operation(self.content, operation, baseRevision=7)
        self.assertEqual(result["content"], "rewritten paragraph\n\n***\n\nlast paragraph")

    def test_a_leftover_hash_field_is_ignored_rather_than_fatal(self):
        #the hashes are gone but a model that learned the old shape should not lose a generation over it
        operation = {
            "operation": "replaceBlock",
            "chapterRevision": 7,
            "blockId": self.firstBlock["blockId"],
            "anchorText": self.firstBlock["anchorText"],
            "expectedTextHash": "0" * 64,
            "newText": "rewritten paragraph",
        }
        result = apply_chapter_operation(self.content, operation, baseRevision=7)
        self.assertEqual(result["content"], "rewritten paragraph\n\n***\n\nlast paragraph")

    def test_a_retyped_anchor_still_matches(self):
        #models reflow whitespace and straighten quotes when they retype instead of copying, none of that is a real mismatch
        content = "she said “not tonight” and turned away—slowly\n\nlast paragraph"
        blocks = chapter_blocks(content)
        operation = self.operation(
            "replaceBlock",
            blockId=blocks[0]["blockId"],
            anchorText='she said  "not tonight"  and turned away-slowly',
            newText="rewritten",
        )
        result = apply_chapter_operation(content, operation, baseRevision=7)
        self.assertEqual(result["content"], "rewritten\n\nlast paragraph")

    def test_a_too_short_anchor_is_rejected_before_it_can_match_anything(self):
        #"the" would match half the chapter, an anchor that weak is not a check at all
        content = "the long opening paragraph that goes on for a while\n\nlast paragraph"
        blocks = chapter_blocks(content)
        operation = self.operation(
            "replaceBlock",
            blockId=blocks[0]["blockId"],
            anchorText="the long",
            newText="rewritten",
        )
        self.assertErrorCode(
            lambda: apply_chapter_operation(content, operation, baseRevision=7),
            CHAPTER_EDIT_INVALID_OPERATION,
        )

    def test_replace_block(self):
        operation = self.operation(
            "replaceBlock",
            blockId=self.firstBlock["blockId"],
            anchorText=self.firstBlock["anchorText"],
            newText="rewritten paragraph",
        )
        result = apply_chapter_operation(self.content, operation, baseRevision=7)
        self.assertEqual(result["content"], "rewritten paragraph\n\n***\n\nlast paragraph")
        self.assertEqual(result["deletedBlockIds"], ["p_001"])
        self.assertEqual(result["insertedBlockIds"], ["p_001"])

    def test_replace_block_range_deletes_all_inclusive_blocks(self):
        content = "before\n\nreplace one\n\n***\n\nreplace two\n\nafter"
        blocks = chapter_blocks(content)
        operation = self.operation(
            "replaceBlockRange",
            startBlockId=blocks[1]["blockId"],
            startAnchorText=blocks[1]["anchorText"],
            endBlockId=blocks[3]["blockId"],
            endAnchorText=blocks[3]["anchorText"],
            newText="rewritten middle",
        )

        result = apply_chapter_operation(content, operation, baseRevision=7)

        self.assertEqual(result["content"], "before\n\nrewritten middle\n\nafter")
        self.assertEqual(result["deletedBlockIds"], ["p_002", "s_001", "p_003"])

    def test_replace_block_range_can_replace_through_final_block(self):
        content = "keep this\n\nold ending one\n\nold ending two"
        blocks = chapter_blocks(content)
        operation = self.operation(
            "replaceBlockRange",
            startBlockId=blocks[1]["blockId"],
            startAnchorText=blocks[1]["anchorText"],
            endBlockId=blocks[-1]["blockId"],
            endAnchorText=blocks[-1]["anchorText"],
            newText="new ending",
        )

        result = apply_chapter_operation(content, operation, baseRevision=7)

        self.assertEqual(result["content"], "keep this\n\nnew ending")

    def test_replace_block_range_rejects_invalid_targets_and_order(self):
        blocks = self.blocks
        reversedRange = self.operation(
            "replaceBlockRange",
            startBlockId=blocks[2]["blockId"],
            startAnchorText=blocks[2]["anchorText"],
            endBlockId=blocks[0]["blockId"],
            endAnchorText=blocks[0]["anchorText"],
            newText="replacement",
        )
        changedAnchor = {**reversedRange, "startAnchorText": "text that is nowhere in this chapter"}
        unknownBlock = {**reversedRange, "startBlockId": "p_999"}

        self.assertErrorCode(
            lambda: apply_chapter_operation(self.content, reversedRange, baseRevision=7),
            CHAPTER_EDIT_TARGET_MISMATCH,
        )
        self.assertErrorCode(
            lambda: apply_chapter_operation(self.content, changedAnchor, baseRevision=7),
            CHAPTER_EDIT_TARGET_MISMATCH,
        )
        self.assertErrorCode(
            lambda: apply_chapter_operation(self.content, unknownBlock, baseRevision=7),
            CHAPTER_EDIT_TARGET_MISMATCH,
        )

    def test_replace_block_range_drops_a_stray_field_instead_of_dying_on_it(self):
        operation = self.operation(
            "replaceBlockRange",
            startBlockId="p_001",
            startAnchorText="first paragraph",
            endBlockId="p_002",
            endAnchorText="last paragraph",
            newText="replacement",
            extra=True,
        )

        parsed = parse_chapter_operation(json.dumps(operation))
        self.assertNotIn("extra", validate_chapter_operation(parsed))

    def test_replace_block_range_still_needs_every_required_field(self):
        operation = self.operation(
            "replaceBlockRange",
            startBlockId="p_001",
            startAnchorText="first paragraph",
            newText="replacement",
        )

        self.assertErrorCode(
            lambda: validate_chapter_operation(parse_chapter_operation(json.dumps(operation))),
            CHAPTER_EDIT_INVALID_OPERATION,
        )

    def test_scene_break_can_be_replaced(self):
        operation = self.operation(
            "replaceBlock",
            blockId=self.sceneBlock["blockId"],
            anchorText=self.sceneBlock["anchorText"],
            newText="a quiet turn",
        )
        result = apply_chapter_operation(self.content, operation, baseRevision=7)
        self.assertIn("first paragraph\n\na quiet turn\n\nlast paragraph", result["content"])

    def test_insert_operations_use_target_anchor(self):
        before = self.operation(
            "insertBeforeBlock",
            blockId=self.lastBlock["blockId"],
            anchorText=self.lastBlock["anchorText"],
            newText="new setup\n\nsecond setup",
        )
        after = self.operation(
            "insertAfterBlock",
            blockId=self.firstBlock["blockId"],
            anchorText=self.firstBlock["anchorText"],
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

    def test_parser_digs_the_json_out_of_whatever_the_model_wrapped_it_in(self):
        raw = (
            '{"operation":"appendToChapter","chapterRevision":7,'
            '"newText":"continue"}'
        )
        expected = {
            "operation": "appendToChapter",
            "chapterRevision": 7,
            "newText": "continue",
        }
        self.assertEqual(parse_chapter_operation(raw), expected)
        self.assertEqual(parse_chapter_operation("```json\n" + raw + "\n```"), expected)
        self.assertEqual(parse_chapter_operation("here is the edit: " + raw), expected)
        self.assertEqual(parse_chapter_operation(raw + "\n\nlet me know what you think"), expected)

    def test_parser_still_rejects_output_with_no_object_in_it(self):
        self.assertErrorCode(lambda: parse_chapter_operation("[]"), CHAPTER_EDIT_INVALID_OPERATION)
        self.assertErrorCode(lambda: parse_chapter_operation("no json here at all"), CHAPTER_EDIT_INVALID_JSON)
        self.assertErrorCode(lambda: parse_chapter_operation("   "), CHAPTER_EDIT_INVALID_JSON)

    def test_parser_rejects_legacy_shapes_and_invalid_fields(self):
        cases = [
            {"type": "appendToChapter", "chapterRevision": 7, "newText": "x"},
            {"operation": "replaceBlocks", "chapterRevision": 7, "newText": "x"},
            {"operation": "appendToChapter", "chapterRevision": 7, "newText": ""},
            {"operation": "appendToChapter", "chapterRevision": True, "newText": "x"},
        ]
        for operation in cases:
            self.assertErrorCode(
                lambda operation=operation: parse_chapter_operation(json.dumps(operation)),
                CHAPTER_EDIT_INVALID_OPERATION,
            )

    def test_a_stray_field_no_longer_bins_the_whole_edit(self):
        #the schema advertised blockId on appendToChapter while the validator called it unsupported, so a legal response could still be thrown away
        operation = {
            "operation": "appendToChapter",
            "chapterRevision": 7,
            "newText": "x",
            "blockId": "p_001",
            "extra": True,
        }
        validated = validate_chapter_operation(parse_chapter_operation(json.dumps(operation)))
        self.assertEqual(set(validated), {"operation", "chapterRevision", "newText"})

    def test_target_validation_rejects_missing_and_changed_targets(self):
        missingAnchor = self.operation(
            "replaceBlock",
            blockId=self.firstBlock["blockId"],
            anchorText="",
            newText="replacement",
        )
        changedAnchor = self.operation(
            "replaceBlock",
            blockId=self.firstBlock["blockId"],
            anchorText="a different paragraph altogether",
            newText="replacement",
        )
        unknownBlock = self.operation(
            "replaceBlock",
            blockId="p_999",
            anchorText="a different paragraph altogether",
            newText="replacement",
        )
        self.assertErrorCode(lambda: parse_chapter_operation(json.dumps(missingAnchor)), CHAPTER_EDIT_INVALID_OPERATION)
        self.assertErrorCode(
            lambda: apply_chapter_operation(self.content, changedAnchor, baseRevision=7),
            CHAPTER_EDIT_TARGET_MISMATCH,
        )
        self.assertErrorCode(
            lambda: apply_chapter_operation(self.content, unknownBlock, baseRevision=7),
            CHAPTER_EDIT_TARGET_MISMATCH,
        )


if __name__ == "__main__":
    unittest.main()
