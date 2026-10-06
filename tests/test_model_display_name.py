import unittest

from backend.core.utils import display_model_name


class ModelDisplayNameTests(unittest.TestCase):
    def testAnthropicIdsKeepTheDecimalPoint(self):
        cases = {
            "claude-sonnet-5-5": "Claude Sonnet 5.5",
            "claude-opus-5-5": "Claude Opus 5.5",
            "claude-fable-5-1": "Claude Fable 5.1",
            "claude-mythos-5-1": "Claude Mythos 5.1",
            "claude-opus-4-8": "Claude Opus 4.8",
            "claude-sonnet-4-6": "Claude Sonnet 4.6",
            "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
            "claude-sonnet-5": "Claude Sonnet 5",
        }
        for modelId, expected in cases.items():
            with self.subTest(modelId=modelId):
                self.assertEqual(display_model_name(modelId), expected)

    def testOpenRouterIdsAreUnchanged(self):
        cases = {
            "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
            "z-ai/glm-5.3": "Glm 5.3",
            "z-ai/glm-5.3-flash": "Glm 5.3 Flash",
            "openai/gpt-4-1106-preview": "Gpt 4 1106 Preview",
            "deepseek/deepseek-r1:free": "Deepseek R1",
            "": "Model",
        }
        for modelId, expected in cases.items():
            with self.subTest(modelId=modelId):
                self.assertEqual(display_model_name(modelId), expected)


if __name__ == "__main__":
    unittest.main()
