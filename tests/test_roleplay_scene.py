import unittest

from backend.roleplay.buildRoleplayMessages import withAuthorNote
from backend.roleplay.roleplayCharacterRows import castPromptBlock
from backend.roleplay.roleplayMacros import expandMacros


def character(name, kind="cast", **fields):
    return {
        "name": name,
        "kind": kind,
        "description": "",
        "appearance": "",
        "personality": "",
        "speech_style": "",
        "greeting": "",
        "example_dialogue": "",
        **fields,
    }


class MacroTest(unittest.TestCase):
    def test_char_and_user_expand(self):
        self.assertEqual(
            expandMacros("{{char}} waits for {{user}}", "Maya", "Alex"),
            "Maya waits for Alex",
        )

    def test_spacing_and_case_are_forgiven(self):
        self.assertEqual(expandMacros("{{ CHAR }}", "Maya", "Alex"), "Maya")

    def test_missing_names_fall_back(self):
        self.assertEqual(expandMacros("{{char}} and {{user}}"), "the character and you")

    def test_empty_text_stays_empty(self):
        self.assertEqual(expandMacros(""), "")


class ScenePromptTest(unittest.TestCase):
    def test_the_scenario_leads_the_prompt(self):
        prompt = castPromptBlock(
            [character("Maya"), character("Alex", kind="user")],
            scenario="A diner at 3am. {{user}} has not slept.",
        )

        self.assertTrue(prompt.startswith("The scene"))
        self.assertIn("A diner at 3am. Alex has not slept.", prompt)

    def test_a_scenario_alone_is_still_worth_sending(self):
        prompt = castPromptBlock([], scenario="The power is out.")

        self.assertIn("The power is out.", prompt)
        self.assertNotIn("How to reply:", prompt)

    def test_example_dialogue_is_marked_as_reference(self):
        prompt = castPromptBlock(
            [
                character(
                    "Maya",
                    example_dialogue="{{user}}: you ok?\n{{char}}: define ok",
                ),
                character("Alex", kind="user"),
            ]
        )

        self.assertIn("Never replay these as the scene", prompt)
        self.assertIn("Alex: you ok?", prompt)
        self.assertIn("Maya: define ok", prompt)

    def test_no_example_block_without_examples(self):
        self.assertNotIn("for reference only", castPromptBlock([character("Maya")]))

    def test_character_fields_expand_macros(self):
        prompt = castPromptBlock(
            [
                character("Maya", description="{{char}} avoids {{user}}"),
                character("Alex", kind="user"),
            ]
        )

        self.assertIn("About: Maya avoids Alex", prompt)


class AuthorNoteTest(unittest.TestCase):
    def setUp(self):
        self.turns = [
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"},
            {"role": "user", "content": "c"},
        ]

    def test_the_note_lands_near_the_end(self):
        withNote = withAuthorNote(self.turns, "she is lying", "Alex")

        self.assertEqual([message["role"] for message in withNote],
                         ["user", "system", "assistant", "user"])
        self.assertIn("she is lying", withNote[1]["content"])

    def test_no_note_changes_nothing(self):
        self.assertEqual(withAuthorNote(self.turns, "   ", "Alex"), self.turns)

    def test_a_short_thread_still_takes_the_note(self):
        withNote = withAuthorNote([{"role": "user", "content": "a"}], "hold the tension", "Alex")

        self.assertEqual([message["role"] for message in withNote], ["system", "user"])


if __name__ == "__main__":
    unittest.main()
