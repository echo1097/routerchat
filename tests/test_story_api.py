import json
import os
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import backend.main as main
from backend.writing import (
    build_brainstorm_messages,
    build_story_messages,
    chapter_blocks,
    chapter_edit_response_format,
    effective_generation_mode,
    lorebook_history_label,
    parse_brainstorm_ideas,
    text_hash,
)


class StoryApiTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = main.DATA_DIR
        self.originalDbPath = main.DB_PATH
        main.DATA_DIR = Path(self.tempDir.name)
        main.DB_PATH = main.DATA_DIR / "routerchat-test.sqlite3"
        main.init_db()
        self.client = TestClient(main.app)

    def tearDown(self):
        main.DATA_DIR = self.originalDataDir
        main.DB_PATH = self.originalDbPath
        self.tempDir.cleanup()

    def streamChapterGeneration(self, story, chapter, output, revision=None, mode="edit", runId="run-test", complete=True):
        chunks = output if isinstance(output, list) else [output]
        requestBody = {}

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                for chunk in chunks:
                    yield f"data: {json.dumps({'choices': [{'delta': {'content': chunk}}]})}"
                if complete:
                    yield "data: [DONE]"

        class FakeLorebookResponse:
            status_code = 200

            def json(self):
                return {"choices": [{"message": {"content": '{"updates": []}'}}]}

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **kwargs):
                requestBody.update(kwargs.get("json") or {})
                return FakeResponse()

            async def post(self, *_args, **_kwargs):
                return FakeLorebookResponse()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.writing.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/chapters/{chapter['id']}/generate/stream",
                json={
                    "message": "edit the chapter",
                    "model": "test/model",
                    "write_generation_mode": mode,
                    "chapter_revision": revision if revision is not None else chapter["revision"],
                    "generation_run_id": runId,
                },
            )
        return response, requestBody

    def test_story_chapter_and_lorebook_crud(self):
        storyResponse = self.client.post(
            "/api/stories",
            json={"title": "Test Story", "synopsis": "a weird little test"},
        )
        self.assertEqual(storyResponse.status_code, 200)
        story = storyResponse.json()["story"]

        chapterResponse = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Chapter One"},
        )
        self.assertEqual(chapterResponse.status_code, 200)
        chapter = chapterResponse.json()["chapter"]

        saveResponse = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{chapter['id']}/content",
            json={"content": "this is the saved chapter text", "revision": chapter["revision"]},
        )
        self.assertEqual(saveResponse.status_code, 200)
        self.assertEqual(saveResponse.json()["chapter"]["word_count"], 6)

        loreResponse = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Mara",
                "category": "character",
                "description": "keeps finding doors",
                "aliases": ["Mara"],
                "tags": ["cast"],
                "metadata": {},
                "disabled": False,
            },
        )
        self.assertEqual(loreResponse.status_code, 200)
        self.assertEqual(loreResponse.json()["entry"]["name"], "Mara")

        entryUrl = f"/api/stories/{story['id']}/lorebook/{loreResponse.json()['entry']['id']}"
        disableResponse = self.client.patch(
            entryUrl,
            json={
                "name": "Mara",
                "category": "character",
                "description": "keeps finding doors",
                "aliases": ["Mara"],
                "tags": ["cast"],
                "metadata": {},
                "disabled": True,
            },
        )
        self.assertEqual(disableResponse.status_code, 200)
        self.assertTrue(disableResponse.json()["entry"]["disabled"])

        bundleResponse = self.client.get(f"/api/stories/{story['id']}")
        self.assertEqual(bundleResponse.status_code, 200)
        bundle = bundleResponse.json()
        self.assertEqual(bundle["story"]["title"], "Test Story")
        self.assertEqual(bundle["chapters"][0]["content"], "this is the saved chapter text")
        self.assertEqual(bundle["lorebook"][0]["category"], "character")
        self.assertTrue(bundle["lorebook"][0]["disabled"])

        enableResponse = self.client.patch(
            entryUrl,
            json={
                "name": "Mara",
                "category": "character",
                "description": "keeps finding doors",
                "aliases": ["Mara"],
                "tags": ["cast"],
                "metadata": {},
                "disabled": False,
            },
        )
        self.assertEqual(enableResponse.status_code, 200)
        self.assertFalse(enableResponse.json()["entry"]["disabled"])

        enabledBundle = self.client.get(f"/api/stories/{story['id']}").json()
        self.assertFalse(enabledBundle["lorebook"][0]["disabled"])

    def test_chapter_revisions_use_compare_and_swap_for_content_and_metadata(self):
        story = self.client.post("/api/stories", json={"title": "Revision Story"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "the old draft"},
        ).json()["chapter"]
        self.assertEqual(chapter["revision"], 0)

        saved = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{chapter['id']}/content",
            json={"content": "the newest draft", "revision": chapter["revision"]},
        )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["chapter"]["revision"], 1)

        stale = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{chapter['id']}/content",
            json={"content": "the stale draft", "revision": chapter["revision"]},
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"]["code"], "chapter_revision_conflict")
        self.assertEqual(stale.json()["detail"]["chapter"]["content"], "the newest draft")
        self.assertEqual(stale.json()["detail"]["chapter"]["revision"], 1)

        renamed = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{chapter['id']}",
            json={"title": "Renamed", "revision": 1},
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.json()["chapter"]["revision"], 2)

        staleMetadata = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{chapter['id']}",
            json={"disabled": True, "revision": 1},
        )
        self.assertEqual(staleMetadata.status_code, 409)
        bundle = self.client.get(f"/api/stories/{story['id']}").json()
        self.assertEqual(bundle["chapters"][0]["revision"], 2)
        self.assertEqual(bundle["chapters"][0]["title"], "Renamed")

    def test_content_save_requires_a_revision_and_updates_the_story_timestamp(self):
        story = self.client.post("/api/stories", json={"title": "Save Contract"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "first draft"},
        ).json()["chapter"]
        before = self.client.get(f"/api/stories/{story['id']}").json()["story"]["updated_at"]

        missing_revision = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{chapter['id']}/content",
            json={"content": "missing revision"},
        )
        self.assertEqual(missing_revision.status_code, 422)

        saved = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{chapter['id']}/content",
            json={"content": "saved draft", "revision": 0},
        )
        self.assertEqual(saved.status_code, 200)
        after = self.client.get(f"/api/stories/{story['id']}").json()["story"]["updated_at"]
        self.assertNotEqual(after, before)

    def test_empty_chapter_patch_returns_the_current_chapter(self):
        story = self.client.post("/api/stories", json={"title": "Patch Contract"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening"},
        ).json()["chapter"]

        response = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{chapter['id']}",
            json={},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()), {"chapter"})
        self.assertEqual(response.json()["chapter"]["id"], chapter["id"])
        self.assertEqual(response.json()["chapter"]["revision"], 0)

    def test_generation_requires_a_base_revision_and_request_model_has_no_redundant_fields(self):
        self.assertNotIn("chapter_content", main.StreamMessageRequest.model_fields)
        self.assertNotIn("previous_chapters", main.StreamMessageRequest.model_fields)

        story = self.client.post("/api/stories", json={"title": "Generation Contract"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening"},
        ).json()["chapter"]
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            response = self.client.post(
                f"/api/stories/{story['id']}/chapters/{chapter['id']}/generate/stream",
                json={"message": "continue", "model": "test/model"},
            )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "chapter_revision is required.")

    def test_empty_chapter_edit_request_generates_plain_prose(self):
        story = self.client.post("/api/stories", json={"title": "Blank Opening"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Chapter 1"},
        ).json()["chapter"]
        main.cache_models([{
            "id": "test/model",
            "name": "test model",
            "architecture": {"output_modalities": ["text"]},
            "supported_parameters": ["structured_outputs"],
        }])

        response, requestBody = self.streamChapterGeneration(
            story,
            chapter,
            "Rain pressed against the windows.",
            mode="edit",
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("response_format", requestBody)
        self.assertIn(
            "Return only the prose",
            "\n".join(message["content"] for message in requestBody["messages"]),
        )
        self.assertEqual(effective_generation_mode("edit", "  \n"), "new")

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("error", [event["type"] for event in events])
        self.assertIn("chapter_updated", [event["type"] for event in events])

        savedChapter = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(savedChapter["id"], chapter["id"])
        self.assertEqual(savedChapter["content"], "Rain pressed against the windows.")

    def test_story_scaffold_creates_both_records_or_neither(self):
        response = self.client.post(
            "/api/stories/with-initial-chapter",
            json={
                "title": "Atomic Story",
                "initial_chapter": {"title": "Chapter 1", "content": "opening words"},
            },
        )
        self.assertEqual(response.status_code, 200)
        scaffold = response.json()
        self.assertEqual(scaffold["chapter"]["story_id"], scaffold["story"]["id"])
        self.assertEqual(scaffold["chapter"]["content"], "opening words")
        self.assertEqual(scaffold["chapter"]["revision"], 0)

        with main.get_db() as conn:
            conn.execute(
                """
                CREATE TRIGGER reject_scaffold_chapter
                BEFORE INSERT ON chapters
                WHEN NEW.title = 'Rejected chapter'
                BEGIN
                  SELECT RAISE(ABORT, 'chapter insert failed');
                END
                """
            )

        failure_client = TestClient(main.app, raise_server_exceptions=False)
        failed = failure_client.post(
            "/api/stories/with-initial-chapter",
            json={
                "title": "Rolled back story",
                "initial_chapter": {"title": "Rejected chapter", "content": ""},
            },
        )
        self.assertEqual(failed.status_code, 500)
        with main.get_db() as conn:
            rows = conn.execute(
                "SELECT id FROM stories WHERE title = 'Rolled back story'"
            ).fetchall()
        self.assertEqual(rows, [])

    def test_chapter_revision_migration_adds_revision_to_legacy_schema(self):
        legacyPath = Path(self.tempDir.name) / "legacy.sqlite3"
        with sqlite3.connect(legacyPath) as conn:
            conn.execute(
                """
                CREATE TABLE chapters (
                  id TEXT PRIMARY KEY,
                  story_id TEXT NOT NULL,
                  title TEXT NOT NULL,
                  content TEXT NOT NULL,
                  word_count INTEGER NOT NULL DEFAULT 0,
                  order_index INTEGER NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )

        originalDbPath = main.DB_PATH
        main.DB_PATH = legacyPath
        try:
            main.init_db()
            with main.get_db() as conn:
                columns = {
                    row["name"] for row in conn.execute("PRAGMA table_info(chapters)").fetchall()
                }
                self.assertIn("revision", columns)
                self.assertIn("disabled", columns)
        finally:
            main.DB_PATH = originalDbPath

    def test_strict_edit_commits_full_chapter_update_event(self):
        story = self.client.post("/api/stories", json={"title": "Edit Contract"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "first paragraph\n\nlast paragraph"},
        ).json()["chapter"]
        operation = json.dumps({
            "operation": "replaceBlock",
            "chapterRevision": chapter["revision"],
            "blockId": "p_001",
            "expectedTextHash": text_hash("first paragraph"),
            "newText": "rewritten paragraph",
        })

        response, requestBody = self.streamChapterGeneration(story, chapter, operation)

        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines() if line]
        updateEvents = [event for event in events if event["type"] == "chapter_updated"]
        self.assertEqual(len(updateEvents), 1)
        updatedChapter = updateEvents[0]["value"]["chapter"]
        self.assertEqual(updatedChapter["content"], "rewritten paragraph\n\nlast paragraph")
        self.assertEqual(updatedChapter["revision"], 1)
        self.assertEqual(updateEvents[0]["runId"], "run-test")
        self.assertEqual(updateEvents[0]["storyId"], story["id"])
        self.assertEqual(updateEvents[0]["chapterId"], chapter["id"])
        self.assertEqual(updateEvents[0]["revision"], 1)
        self.assertEqual(self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]["content"], updatedChapter["content"])
        self.assertNotIn("response_format", requestBody)
        self.assertIn("lorebook", [event["type"] for event in events])

    def test_range_edit_commits_deleted_blocks_and_preserves_surrounding_text(self):
        story = self.client.post("/api/stories", json={"title": "Range Edit"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={
                "title": "Opening",
                "content": "keep before\n\nold one\n\n***\n\nold two\n\nkeep after",
            },
        ).json()["chapter"]
        operation = json.dumps({
            "operation": "replaceBlockRange",
            "chapterRevision": chapter["revision"],
            "startBlockId": "p_002",
            "startExpectedTextHash": text_hash("old one"),
            "endBlockId": "p_003",
            "endExpectedTextHash": text_hash("old two"),
            "newText": "rewritten section",
        })

        response, _ = self.streamChapterGeneration(story, chapter, operation)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        updateEvent = next(event for event in events if event["type"] == "chapter_updated")
        self.assertEqual(
            updateEvent["value"]["chapter"]["content"],
            "keep before\n\nrewritten section\n\nkeep after",
        )
        self.assertEqual(updateEvent["value"]["chapter"]["revision"], 1)
        self.assertEqual(updateEvent["value"]["deletedBlockIds"], ["p_002", "s_001", "p_003"])
        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["revision"], 1)
        self.assertEqual(persisted["content"], updateEvent["value"]["chapter"]["content"])

    def test_invalid_edit_output_is_stored_and_does_not_mutate_chapter(self):
        story = self.client.post("/api/stories", json={"title": "Invalid Edit"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "unchanged"},
        ).json()["chapter"]
        rawOutput = "here is the edit: {\"operation\": \"appendToChapter\"}"

        response, _ = self.streamChapterGeneration(story, chapter, rawOutput)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("chapter_updated", [event["type"] for event in events])
        self.assertNotIn("lorebook", [event["type"] for event in events])
        errorEvents = [event for event in events if event["type"] == "error"]
        self.assertEqual(errorEvents[0]["value"]["code"], "chapter_edit_invalid_json")
        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["content"], "unchanged")
        self.assertEqual(persisted["revision"], 0)
        with main.get_db() as conn:
            generation = conn.execute(
                "SELECT generated_text, error FROM story_generations WHERE chapter_id = ?",
                (chapter["id"],),
            ).fetchone()
        self.assertEqual(generation["generated_text"], rawOutput)
        self.assertTrue(generation["error"].startswith("chapter_edit_invalid_json"))

    def test_incomplete_stream_never_applies_partial_chapter_text(self):
        story = self.client.post("/api/stories", json={"title": "Incomplete Stream"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "saved text"},
        ).json()["chapter"]

        response, _ = self.streamChapterGeneration(
            story,
            chapter,
            "partial provider output",
            mode="new",
            complete=False,
        )

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("chapter_updated", [event["type"] for event in events])
        self.assertEqual(self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]["content"], "saved text")
        with main.get_db() as conn:
            generation = conn.execute(
                "SELECT generated_text, error FROM story_generations WHERE chapter_id = ?",
                (chapter["id"],),
            ).fetchone()
        self.assertEqual(generation["generated_text"], "partial provider output")
        self.assertEqual(generation["error"], "generation_incomplete_stream")

    def test_edit_revision_and_target_conflicts_fail_closed(self):
        story = self.client.post("/api/stories", json={"title": "Edit Conflicts"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "unchanged"},
        ).json()["chapter"]
        staleRevision = json.dumps({
            "operation": "appendToChapter",
            "chapterRevision": 9,
            "newText": "must not apply",
        })
        response, _ = self.streamChapterGeneration(story, chapter, staleRevision)
        staleEvents = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(
            [event["value"]["code"] for event in staleEvents if event["type"] == "error"],
            ["chapter_edit_revision_mismatch"],
        )

        changedTarget = json.dumps({
            "operation": "replaceBlock",
            "chapterRevision": chapter["revision"],
            "blockId": "p_001",
            "expectedTextHash": text_hash("different"),
            "newText": "must not apply",
        })
        response, _ = self.streamChapterGeneration(story, chapter, changedTarget)
        targetEvents = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(
            [event["value"]["code"] for event in targetEvents if event["type"] == "error"],
            ["chapter_edit_target_mismatch"],
        )
        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["content"], "unchanged")
        self.assertEqual(persisted["revision"], 0)

    def test_edit_generation_conflict_reloads_current_chapter_and_skips_update(self):
        story = self.client.post("/api/stories", json={"title": "Concurrent Edit"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "the base"},
        ).json()["chapter"]
        operation = json.dumps({
            "operation": "appendToChapter",
            "chapterRevision": 0,
            "newText": "generated text",
        })

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                yield f"data: {json.dumps({'choices': [{'delta': {'content': operation}}]})}"
                with main.get_db() as conn:
                    conn.execute(
                        "UPDATE chapters SET content = ?, word_count = ?, revision = revision + 1 WHERE id = ?",
                        ("manual text", 2, chapter["id"]),
                    )
                yield "data: [DONE]"

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **_kwargs):
                return FakeResponse()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.writing.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/chapters/{chapter['id']}/generate/stream",
                json={
                    "message": "append",
                    "model": "test/model",
                    "write_generation_mode": "edit",
                    "chapter_revision": 0,
                },
            )

        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("chapter_updated", [event["type"] for event in events])
        self.assertTrue(any(
            event["type"] == "error" and event["value"]["code"] == "chapter_revision_conflict"
            for event in events
        ))
        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["content"], "manual text")
        self.assertEqual(persisted["revision"], 1)

    def test_structured_output_is_only_sent_for_explicit_model_capability(self):
        story = self.client.post("/api/stories", json={"title": "Structured Output"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "the base"},
        ).json()["chapter"]
        output = json.dumps({
            "operation": "appendToChapter",
            "chapterRevision": 0,
            "newText": "more",
        })
        main.cache_models([{
            "id": "test/model",
            "name": "test model",
            "architecture": {"output_modalities": ["text"]},
            "supported_parameters": ["structured_outputs"],
        }])
        _, requestBody = self.streamChapterGeneration(story, chapter, output)
        self.assertEqual(requestBody["response_format"], chapter_edit_response_format())

    def test_generation_conflict_does_not_commit_or_emit_chapter_update(self):
        story = self.client.post("/api/stories", json={"title": "Generation Revision"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "the base"},
        ).json()["chapter"]

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                yield f"data: {json.dumps({'choices': [{'delta': {'content': 'the generated continuation'}}]})}"
                with main.get_db() as conn:
                    conn.execute(
                        """
                        UPDATE chapters
                        SET content = ?, word_count = ?, revision = revision + 1
                        WHERE id = ? AND story_id = ?
                        """,
                        ("the manual continuation", 3, chapter["id"], story["id"]),
                    )
                yield "data: [DONE]"

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **_kwargs):
                return FakeResponse()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.writing.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/chapters/{chapter['id']}/generate/stream",
                json={
                    "message": "continue the chapter",
                    "model": "test/model",
                    "write_generation_mode": "new",
                    "chapter_revision": 0,
                },
            )

        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines() if line]
        eventTypes = [event["type"] for event in events]
        self.assertNotIn("chapter_updated", eventTypes)
        conflictEvents = [event for event in events if event["type"] == "error"]
        self.assertTrue(any(event["value"]["code"] == "chapter_revision_conflict" for event in conflictEvents))
        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["content"], "the manual continuation")
        self.assertEqual(persisted["revision"], 1)

    def test_story_routes_are_registered_from_writing_module(self):
        def collectRoutes(routes):
            collectedRoutes = []
            for route in routes:
                collectedRoutes.append(route)
                originalRouter = getattr(route, "original_router", None)
                if originalRouter is not None:
                    collectedRoutes.extend(collectRoutes(originalRouter.routes))
            return collectedRoutes

        storyRoutes = [
            route
            for route in collectRoutes(main.app.routes)
            if getattr(route, "path", "").startswith("/api/stories")
        ]
        routeModules = {route.endpoint.__module__ for route in storyRoutes}

        self.assertTrue(storyRoutes)
        self.assertEqual(routeModules, {"backend.writing"})

    def test_openrouter_transport_failures_do_not_break_status_or_models_routes(self):
        transportError = main.HTTPException(
            status_code=502,
            detail="Could not reach OpenRouter.",
        )

        with patch.object(main, "read_openrouter_key", return_value="test-key"):
            with patch.object(main, "validate_key", side_effect=transportError):
                statusResponse = self.client.get("/api/settings/key-status")

            with patch.object(main, "fetch_models_from_openrouter", side_effect=transportError):
                modelsResponse = self.client.get("/api/models")

        self.assertEqual(statusResponse.status_code, 200)
        self.assertTrue(statusResponse.json()["has_key"])
        self.assertEqual(modelsResponse.status_code, 502)

    def test_model_reasoning_metadata_round_trips_and_drives_capabilities(self):
        mandatoryModel = main.normalize_model({
            "id": "test/mandatory",
            "name": "Mandatory model",
            "supported_parameters": ["reasoning"],
            "reasoning": {
                "supported_efforts": ["high", "medium"],
                "default_effort": "medium",
                "default_enabled": True,
                "mandatory": True,
            },
        })
        optionalModel = main.normalize_model({
            "id": "test/optional",
            "supported_parameters": ["reasoning"],
            "reasoning": {"mandatory": False},
        })
        instantModel = main.normalize_model({
            "id": "test/instant",
            "supported_parameters": [],
        })

        main.cache_models([mandatoryModel, optionalModel, instantModel])

        cachedModel = next(
            model for model in main.cached_models() if model["id"] == "test/mandatory"
        )
        self.assertTrue(cachedModel["reasoning"]["mandatory"])
        self.assertTrue(main.model_supports_reasoning("test/mandatory:nitro"))
        self.assertTrue(main.model_requires_reasoning("test/mandatory:nitro"))
        self.assertTrue(main.effective_thinking_enabled("test/mandatory", False))
        self.assertFalse(main.effective_thinking_enabled("test/optional", False))
        self.assertIsNone(main.enabled_reasoning_config("test/optional", False, "medium"))
        self.assertIsNone(main.enabled_reasoning_config("test/instant", True, "medium"))
        self.assertEqual(
            main.enabled_reasoning_config("test/mandatory", False, "high"),
            {"enabled": True, "exclude": False, "effort": "high"},
        )

        with patch.object(main, "read_openrouter_key", return_value=None):
            modelsResponse = self.client.get("/api/models")
        self.assertEqual(modelsResponse.headers["cache-control"], "no-store")
        responseModel = next(
            model for model in modelsResponse.json()["models"]
            if model["id"] == "test/mandatory"
        )
        self.assertTrue(responseModel["reasoning"]["mandatory"])

    def test_frontend_cache_headers_refresh_html_and_reuse_hashed_assets(self):
        htmlResponse = self.client.get("/")
        self.assertEqual(htmlResponse.status_code, 200)
        self.assertEqual(
            htmlResponse.headers["cache-control"], "no-store, max-age=0"
        )
        self.assertEqual(htmlResponse.headers["pragma"], "no-cache")

        assetPath = next((main.STATIC_DIR / "assets").glob("index-*.js"))
        assetResponse = self.client.get(f"/assets/{assetPath.name}")
        self.assertEqual(assetResponse.status_code, 200)
        self.assertEqual(
            assetResponse.headers["cache-control"],
            "public, max-age=31536000, immutable",
        )

    def test_mandatory_reasoning_is_enabled_for_chat_when_preference_is_off(self):
        main.cache_models([main.normalize_model({
            "id": "test/model",
            "supported_parameters": ["reasoning"],
            "reasoning": {"mandatory": True},
        })])
        chat = self.client.post(
            "/api/chats",
            json={"title": "Required reasoning", "model": "test/model"},
        ).json()["chat"]
        requestBody = {}

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                yield "data: [DONE]"

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **kwargs):
                requestBody.update(kwargs.get("json") or {})
                return FakeResponse()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.main.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/chats/{chat['id']}/messages/stream",
                json={
                    "message": "hello",
                    "model": "test/model",
                    "thinking_enabled": False,
                    "reasoning_effort": "high",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            requestBody["reasoning"],
            {"enabled": True, "exclude": False, "effort": "high"},
        )
        self.assertEqual(requestBody["reasoning_effort"], "high")
        self.assertNotIn("include_reasoning", requestBody)
        with main.get_db() as conn:
            savedChat = conn.execute(
                "SELECT thinking_enabled FROM chats WHERE id = ?", (chat["id"],)
            ).fetchone()
        self.assertFalse(bool(savedChat["thinking_enabled"]))
        loadedChat = self.client.get(f"/api/chats/{chat['id']}").json()["chat"]
        self.assertTrue(loadedChat["thinking_enabled"])

    def test_mandatory_reasoning_is_enabled_for_chapter_when_preference_is_off(self):
        main.cache_models([main.normalize_model({
            "id": "test/model",
            "supported_parameters": ["reasoning"],
            "reasoning": {"mandatory": True},
        })])
        story = self.client.post(
            "/api/stories", json={"title": "Required reasoning story"}
        ).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening"},
        ).json()["chapter"]

        response, requestBody = self.streamChapterGeneration(
            story, chapter, "the next paragraph", mode="new"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            requestBody["reasoning"],
            {"enabled": True, "exclude": False, "effort": "medium"},
        )

    def test_brainstorm_graph_persists_edits_viewport_and_cascade_deletion(self):
        story = self.client.post("/api/stories", json={"title": "Branch Test"}).json()["story"]
        now = main.utc_now()
        nodeIds = [str(uuid.uuid4()) for _ in range(4)]
        with main.get_db() as conn:
            for index, nodeId in enumerate(nodeIds):
                nodeType = "prompt" if index % 2 == 0 else "idea"
                conn.execute(
                    """
                    INSERT INTO brainstorm_nodes (
                      id, story_id, node_type, title, content, position_x,
                      position_y, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)
                    """,
                    (nodeId, story["id"], nodeType, f"node {index}", f"content {index}", index * 100, index * 20, now, now),
                )
            for sourceId, targetId in zip(nodeIds, nodeIds[1:]):
                conn.execute(
                    """
                    INSERT INTO brainstorm_edges (
                      id, story_id, source_node_id, target_node_id, created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (str(uuid.uuid4()), story["id"], sourceId, targetId, now),
                )

        graphResponse = self.client.get(f"/api/stories/{story['id']}/brainstorm")
        self.assertEqual(graphResponse.status_code, 200)
        self.assertEqual(len(graphResponse.json()["nodes"]), 4)

        editResponse = self.client.patch(
            f"/api/stories/{story['id']}/brainstorm/nodes/{nodeIds[1]}",
            json={"title": "Sharper turn", "content": "the door answers back", "position_x": 412.5},
        )
        self.assertEqual(editResponse.status_code, 200)
        self.assertEqual(editResponse.json()["node"]["title"], "Sharper turn")
        self.assertEqual(editResponse.json()["node"]["position_x"], 412.5)

        viewportResponse = self.client.patch(
            f"/api/stories/{story['id']}/brainstorm/viewport",
            json={"position_x": 24, "position_y": -18, "zoom": 0.8},
        )
        self.assertEqual(viewportResponse.status_code, 200)
        persistedViewport = self.client.get(f"/api/stories/{story['id']}/brainstorm").json()["viewport"]
        self.assertEqual(persistedViewport, {"x": 24.0, "y": -18.0, "zoom": 0.8})

        blockedDelete = self.client.delete(
            f"/api/stories/{story['id']}/brainstorm/nodes/{nodeIds[1]}"
        )
        self.assertEqual(blockedDelete.status_code, 409)

        cascadeDelete = self.client.delete(
            f"/api/stories/{story['id']}/brainstorm/nodes/{nodeIds[1]}?cascade=true"
        )
        self.assertEqual(cascadeDelete.status_code, 200)
        self.assertEqual(set(cascadeDelete.json()["deleted_node_ids"]), set(nodeIds[1:]))
        remaining = self.client.get(f"/api/stories/{story['id']}/brainstorm").json()
        self.assertEqual([node["id"] for node in remaining["nodes"]], [nodeIds[0]])
        self.assertEqual(remaining["edges"], [])

    def test_brainstorm_context_uses_all_chapters_enabled_lore_and_selected_branch(self):
        story = self.client.post(
            "/api/stories",
            json={"title": "Context Story", "synopsis": "a city that forgets"},
        ).json()["story"]
        firstChapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "First", "content": "the bells stop"},
        ).json()["chapter"]
        secondChapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Second", "content": "everyone wakes twice"},
        ).json()["chapter"]
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Mara", "category": "character", "description": "remembers every dawn"},
        )
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Secret", "category": "note", "description": "never include this", "disabled": True},
        )

        with main.get_db() as conn:
            storyRow = conn.execute("SELECT * FROM stories WHERE id = ?", (story["id"],)).fetchone()
            chapterRows = conn.execute(
                "SELECT * FROM chapters WHERE id IN (?, ?) ORDER BY order_index ASC",
                (firstChapter["id"], secondChapter["id"]),
            ).fetchall()
            loreRows = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY created_at ASC",
                (story["id"],),
            ).fetchall()
            branchRows = []

        messages = build_brainstorm_messages(
            storyRow,
            chapterRows,
            loreRows,
            branchRows,
            "what if the city notices",
        )
        context = messages[-2]["content"]
        self.assertIn("chapter 1: First\nthe bells stop", context)
        self.assertIn("chapter 2: Second\neveryone wakes twice", context)
        self.assertIn("Mara (character): remembers every dawn", context)
        self.assertNotIn("never include this", context)
        self.assertIn("this is a new root brainstorm", context)

    def test_story_context_excludes_disabled_lorebook_entries(self):
        story = self.client.post(
            "/api/stories",
            json={"title": "Writing Context Story"},
        ).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "First", "content": "the bells stop"},
        ).json()["chapter"]
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Mara", "category": "character", "description": "remembered"},
        )
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Secret", "category": "note", "description": "keep this out", "disabled": True},
        )

        with main.get_db() as conn:
            storyRow = conn.execute("SELECT * FROM stories WHERE id = ?", (story["id"],)).fetchone()
            chapterRow = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter["id"],)).fetchone()
            loreRows = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY created_at ASC",
                (story["id"],),
            ).fetchall()

        messages = build_story_messages(storyRow, chapterRow, loreRows, "continue", "")
        context = messages[-2]["content"]
        self.assertIn("Mara (character): remembered", context)
        self.assertNotIn("keep this out", context)

        editMessages = build_story_messages(
            storyRow,
            chapterRow,
            loreRows,
            "rewrite the opening",
            "",
            generation_mode="edit",
            blocks=chapter_blocks(chapterRow["content"]),
        )
        editContext = editMessages[-2]["content"]
        self.assertIn("chapter revision: 0", editContext)
        self.assertNotIn("startChar", editContext)
        self.assertNotIn("endChar", editContext)
        self.assertNotIn("replaceBlocks", editMessages[-3]["content"])

    def test_write_and_edit_requests_exclude_brainstorm_nodes(self):
        story = self.client.post(
            "/api/stories",
            json={"title": "Separate Brainstorm Context"},
        ).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "First", "content": "the actual chapter"},
        ).json()["chapter"]
        brainstormSentinel = "SENTINEL_BRAINSTORM_IDEA_MUST_STAY_OUT"

        with main.get_db() as conn:
            now = main.utc_now()
            conn.execute(
                """
                INSERT INTO brainstorm_nodes (
                  id, story_id, node_type, title, content, position_x, position_y,
                  status, created_at, updated_at
                ) VALUES (?, ?, 'idea', 'Secret idea', ?, 0, 0, 'complete', ?, ?)
                """,
                (str(uuid.uuid4()), story["id"], brainstormSentinel, now, now),
            )

        editOutput = json.dumps({
            "operation": "appendToChapter",
            "chapterRevision": 0,
            "newText": "edited text",
        })
        _, editRequest = self.streamChapterGeneration(story, chapter, editOutput, mode="edit")
        _, writeRequest = self.streamChapterGeneration(
            story,
            chapter,
            "written text",
            revision=1,
            mode="new",
            runId="run-write-context-test",
        )

        self.assertNotIn(brainstormSentinel, json.dumps(editRequest["messages"]))
        self.assertNotIn(brainstormSentinel, json.dumps(writeRequest["messages"]))

    def test_brainstorm_output_parser_accepts_a_single_complete_idea(self):
        parsed = parse_brainstorm_ideas(
            '{"ideas": ['
            '{"title": "one", "content": "first path"},'
            '{"title": "two", "content": "second path"},'
            '{"title": "three", "content": "third path"}'
            ']}'
        )
        self.assertEqual(len(parsed), 3)
        singleIdea = parse_brainstorm_ideas(
            '{"ideas": [{"title": "one", "content": "one complete path"}]}'
        )
        self.assertEqual(len(singleIdea), 1)
        with self.assertRaises(ValueError):
            parse_brainstorm_ideas('{"ideas": []}')

    def test_brainstorm_generation_saves_complete_branch_atomically(self):
        main.cache_models([main.normalize_model({
            "id": "test/model",
            "supported_parameters": ["reasoning"],
            "reasoning": {"mandatory": True},
        })])
        story = self.client.post("/api/stories", json={"title": "Stream Story"}).json()["story"]
        self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "the signal arrives at midnight"},
        )

        output = json.dumps({
            "ideas": [
                {"title": "answer it", "content": "Mara answers and hears her own voice."},
                {"title": "trace it", "content": "The signal leads beneath the abandoned station."},
                {"title": "broadcast it", "content": "They let the whole city hear the warning."},
            ]
        })
        requestBody = {}

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                yield f"data: {json.dumps({'choices': [{'delta': {'content': output}, 'finish_reason': 'stop'}]})}"
                yield "data: [DONE]"

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **kwargs):
                requestBody.update(kwargs.get("json") or {})
                return FakeResponse()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.writing.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/brainstorm/generate/stream",
                json={
                    "message": "how could the signal change everything",
                    "model": "test/model",
                    "max_tokens": 1000,
                    "selected_idea_ids": [],
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            requestBody["reasoning"],
            {"enabled": True, "exclude": False, "effort": "medium"},
        )
        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual([event["type"] for event in events], ["prompt", "ideas"])
        self.assertEqual(events[0]["value"]["node"]["position_x"], 0)
        self.assertEqual(events[0]["value"]["node"]["position_y"], 180)
        graph = self.client.get(f"/api/stories/{story['id']}/brainstorm").json()
        self.assertEqual(len(graph["nodes"]), 4)
        self.assertEqual(len(graph["edges"]), 3)
        self.assertEqual(
            [node["status"] for node in graph["nodes"] if node["node_type"] == "prompt"],
            ["complete"],
        )

    def test_malformed_brainstorm_generation_keeps_only_failed_prompt(self):
        story = self.client.post("/api/stories", json={"title": "Bad Stream"}).json()["story"]

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                chunk = {"choices": [{"delta": {"content": '{"ideas": []}'}, "finish_reason": "stop"}]}
                yield f"data: {json.dumps(chunk)}"
                yield "data: [DONE]"

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **_kwargs):
                return FakeResponse()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.writing.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/brainstorm/generate/stream",
                json={"message": "give me ideas", "model": "test/model", "selected_idea_ids": []},
            )

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual([event["type"] for event in events], ["prompt", "error"])
        graph = self.client.get(f"/api/stories/{story['id']}/brainstorm").json()
        self.assertEqual(len(graph["nodes"]), 1)
        self.assertEqual(graph["nodes"][0]["status"], "failed")
        self.assertEqual(graph["edges"], [])

    def test_lorebook_history_labels_describe_updates_and_timeline_changes(self):
        modelLabel = "Glm 5.2"

        self.assertEqual(
            lorebook_history_label(modelLabel, {"action": "update", "name": "Chloe"}),
            "Glm 5.2 updated Chloe in Lorebook",
        )
        self.assertEqual(
            lorebook_history_label(modelLabel, {"action": "create", "name": "The Blackwall"}),
            "Glm 5.2 added The Blackwall to Lorebook",
        )
        self.assertEqual(
            lorebook_history_label(modelLabel, {"action": "update", "name": "timeline"}),
            "Glm 5.2 updated Timeline",
        )

    def test_pinned_chats_are_ordered_and_temporary_chats_stay_hidden(self):
        first = self.client.post("/api/chats", json={"title": "First"}).json()["chat"]
        second = self.client.post("/api/chats", json={"title": "Second"}).json()["chat"]
        temporary = self.client.post(
            "/api/chats",
            json={"title": "Temporary", "temporary": True},
        ).json()["chat"]

        pinResponse = self.client.patch(
            f"/api/chats/{first['id']}",
            json={"pinned": True},
        )
        self.assertEqual(pinResponse.status_code, 200)
        self.assertTrue(pinResponse.json()["chat"]["pinned"])

        chats = self.client.get("/api/chats").json()["chats"]
        self.assertEqual([chat["id"] for chat in chats], [first["id"], second["id"]])
        self.assertNotIn(temporary["id"], [chat["id"] for chat in chats])

        with main.get_db() as conn:
            columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(chats)").fetchall()
            }
        self.assertIn("pinned", columns)

    def test_chat_import_and_export_preserve_pinned_state(self):
        created = self.client.post("/api/chats", json={"title": "Pinned export"}).json()["chat"]
        self.client.patch(f"/api/chats/{created['id']}", json={"pinned": True})

        exported = self.client.get(f"/api/chats/{created['id']}/export").json()
        self.assertTrue(exported["chats"][0]["pinned"])

        imported = self.client.post("/api/chats/import", json=exported)
        self.assertEqual(imported.status_code, 200)

        chats = self.client.get("/api/chats").json()["chats"]
        self.assertEqual(sum(chat["pinned"] for chat in chats), 2)

        legacyPayload = {
            "chats": [{"id": "legacy-chat", "title": "Legacy", "model": "test/model"}],
            "messages": [],
        }
        self.client.post("/api/chats/import", json=legacyPayload)
        legacy = self.client.get("/api/chats/legacy-chat").json()["chat"]
        self.assertFalse(legacy["pinned"])


if __name__ == "__main__":
    unittest.main()
