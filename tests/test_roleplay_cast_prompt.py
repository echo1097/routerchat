import unittest

from backend.roleplay.roleplayCharacterRows import castPromptBlock, normalizeCharacterKind


def character(name, kind="cast", **fields):
    return {
        "name": name,
        "kind": kind,
        "description": "",
        "appearance": "",
        "personality": "",
        "speech_style": "",
        **fields,
    }


class CastPromptTest(unittest.TestCase):
    def test_no_characters_adds_nothing(self):
        self.assertEqual(castPromptBlock([]), "")

    def test_cast_block_names_every_character_and_the_format(self):
        prompt = castPromptBlock(
            [
                character("Maya", description="runs the late shift", speech_style="all lowercase"),
                character("Jon", personality="dry"),
            ]
        )

        self.assertIn("Maya", prompt)
        self.assertIn("About: runs the late shift", prompt)
        self.assertIn("Voice: all lowercase", prompt)
        self.assertIn("Personality: dry", prompt)
        self.assertIn("Maya, Jon", prompt)

    def test_the_reply_rules_leave_the_length_to_the_scene(self):
        prompt = castPromptBlock([character("Maya"), character("Jon")])

        self.assertIn("as many as the moment calls for", prompt)
        self.assertNotIn("one to four", prompt)
        self.assertIn("can say nothing all turn", prompt)
        self.assertIn("Only the characters who would really be there answer", prompt)
        self.assertIn("Stay in character.", prompt)

    def test_a_reply_is_not_tied_to_a_text_message(self):
        prompt = castPromptBlock([character("Maya"), character("Jon")])

        self.assertIn("a paragraph of what they do, notice and feel", prompt)
        self.assertIn("Break a turn into separate lines", prompt)
        self.assertNotIn("text message", prompt)
        self.assertNotIn("No narrator voice, no stage directions", prompt)

    def test_the_user_character_is_off_limits(self):
        prompt = castPromptBlock(
            [character("Maya"), character("Alex", kind="user", description="night owl")]
        )

        self.assertIn("Alex is the person playing with you.", prompt)
        self.assertIn("Never write a line as Alex.", prompt)
        self.assertIn("About: night owl", prompt)

    def test_a_user_character_alone_still_introduces_them(self):
        prompt = castPromptBlock([character("Alex", kind="user")])

        self.assertIn("You are playing opposite Alex.", prompt)
        self.assertNotIn("How to reply:", prompt)

    def test_unknown_kinds_fall_back_to_the_cast(self):
        self.assertEqual(normalizeCharacterKind("narrator"), "cast")
        self.assertEqual(normalizeCharacterKind(None), "cast")
        self.assertEqual(normalizeCharacterKind("USER"), "user")


if __name__ == "__main__":
    unittest.main()
