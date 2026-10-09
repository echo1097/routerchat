import unittest

from backend.lorebook.chapterDelta import chapterDelta, lorebookProseForPrompt


class ChapterDeltaTest(unittest.TestCase):
    def test_an_unchanged_chapter_has_no_delta(self):
        text = "Mara opens the gate.\n\nRafe follows her."

        delta = chapterDelta(text, text)

        self.assertFalse(delta["changed"])
        self.assertEqual(delta["markedText"], text)
        self.assertEqual(delta["removed"], [])

    def test_an_edited_paragraph_is_marked_and_the_rest_is_left_alone(self):
        before = "Mara opens the gate.\n\nRafe follows her.\n\nThe bells ring."
        after = "Mara opens the gate.\n\nRafe waits outside.\n\nThe bells ring."

        delta = chapterDelta(before, after)

        self.assertTrue(delta["changed"])
        self.assertEqual(
            delta["markedText"],
            "Mara opens the gate.\n\n<<new>>Rafe waits outside.<</new>>\n\nThe bells ring.",
        )
        self.assertEqual(delta["removed"], [])

    def test_an_appended_paragraph_is_marked(self):
        before = "Mara opens the gate."
        after = "Mara opens the gate.\n\nShe steps through."

        delta = chapterDelta(before, after)

        self.assertEqual(
            delta["markedText"],
            "Mara opens the gate.\n\n<<new>>She steps through.<</new>>",
        )

    def test_a_removed_paragraph_is_listed(self):
        before = "Mara opens the gate.\n\nRafe follows her."
        after = "Mara opens the gate."

        delta = chapterDelta(before, after)

        self.assertTrue(delta["changed"])
        self.assertEqual(delta["markedText"], after)
        self.assertEqual(delta["removed"], ["Rafe follows her."])

    def test_the_first_run_sends_the_plain_chapter(self):
        self.assertEqual(
            lorebookProseForPrompt(None, "Mara opens the gate."),
            {"new_prose": "Mara opens the gate."},
        )

    def test_later_runs_send_markers_and_a_note(self):
        prompt = lorebookProseForPrompt("Mara opens the gate.", "Mara opens the gate.\n\nRafe follows.")

        self.assertIn("<<new>>Rafe follows.<</new>>", prompt["new_prose"])
        self.assertEqual(prompt["removed_prose"], [])
        self.assertIn("<<new>>", prompt["prose_note"])


if __name__ == "__main__":
    unittest.main()
