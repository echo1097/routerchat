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
from backend.brainstorm import (
    brainstorm_response_format,
    build_brainstorm_messages,
    next_brainstorm_root_position,
    parse_brainstorm_ideas,
)
from backend.lorebook import (
    lorebook_history_label,
    lorebook_update_response_format,
    normalize_timeline_description,
)
from backend.local_access import create_secret_file
from backend.writing import (
    build_story_messages,
    chapter_blocks,
    chapter_edit_response_format,
    effective_generation_mode,
)


#the lorebook update streams now, so the fakes hand back an sse style response instead of one json blob
def fakeLorebookStream(
    content,
    reasoning="",
    complete=True,
    finishReason=None,
):
    class FakeLorebookStreamResponse:
        status_code = 200
        headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def aiter_lines(self):
            if reasoning:
                yield f"data: {json.dumps({'choices': [{'delta': {'reasoning': reasoning}}]})}"
            yield f"data: {json.dumps({'choices': [{'delta': {'content': content}}]})}"
            if finishReason:
                yield f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': finishReason}]})}"
            if complete:
                yield "data: [DONE]"

    return FakeLorebookStreamResponse()


def acceptCurrentTos():
    #every /api route is behind the tos gate now, so a fresh test db needs an acceptance row or everything 403s
    tos = main.load_tos()
    if not tos:
        raise RuntimeError("TOS.md is missing, restore it before running the tests")
    main.record_tos_acceptance(tos["hash"], tos["date"])


class StoryApiTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = main.DATA_DIR
        self.originalDbPath = main.DB_PATH
        main.DATA_DIR = Path(self.tempDir.name)
        main.DB_PATH = main.DATA_DIR / "routerchat-test.sqlite3"
        self.baseUrl = "http://127.0.0.1:8000"
        self.apiSecretPath = main.DATA_DIR / "run" / "api-secret"
        self.apiSecret = create_secret_file(self.apiSecretPath)
        self.localAccessEnvironment = patch.dict(
            os.environ,
            {
                "ROUTERCHAT_API_SECRET_FILE": str(self.apiSecretPath),
                "ROUTERCHAT_BASE_URL": self.baseUrl,
                "ROUTERCHAT_TRUSTED_ORIGINS": self.baseUrl,
            },
        )
        self.localAccessEnvironment.start()
        main.reset_local_access_config()
        main.init_db()
        acceptCurrentTos()
        self.client = TestClient(
            main.app,
            base_url=self.baseUrl,
            headers={"Origin": self.baseUrl, "Sec-Fetch-Site": "same-origin"},
        )
        bootstrapResponse = self.client.post(
            "/api/bootstrap",
            data={"secret": self.apiSecret},
            headers={"Origin": "null", "Sec-Fetch-Site": "cross-site"},
            follow_redirects=False,
        )
        if bootstrapResponse.status_code != 303:
            raise RuntimeError("test client could not bootstrap local API access")

    def tearDown(self):
        self.client.close()
        main.reset_local_access_config()
        self.localAccessEnvironment.stop()
        main.DATA_DIR = self.originalDataDir
        main.DB_PATH = self.originalDbPath
        self.tempDir.cleanup()

    def test_history_column_migration_upgrades_an_old_table_and_is_idempotent(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        #the shape this table had before diff stats and cost existed
        conn.execute(
            """
            CREATE TABLE chapter_history_entries (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              chapter_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              label TEXT NOT NULL,
              detail TEXT NOT NULL DEFAULT '',
              entry_order INTEGER NOT NULL,
              created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO chapter_history_entries VALUES ('e1','s1','c1','r1','User prompt','hi',0,'now')"
        )

        main.ensure_chapter_history_columns(conn)
        main.ensure_chapter_history_columns(conn) #running twice must not blow up or duplicate anything

        columns = [row["name"] for row in conn.execute("PRAGMA table_info(chapter_history_entries)")]
        self.assertEqual(columns.count("words_added"), 1)
        self.assertEqual(columns.count("words_removed"), 1)
        self.assertEqual(columns.count("cost"), 1)

        #history written before the upgrade stays readable and reads as unknown, not as zero
        row = conn.execute("SELECT * FROM chapter_history_entries WHERE id = 'e1'").fetchone()
        self.assertIsNone(row["words_added"])
        self.assertIsNone(row["cost"])
        conn.close()

    def test_history_kind_migration_backfills_old_rows_and_is_idempotent(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        #the shape this table had before kind existed
        conn.execute(
            """
            CREATE TABLE chapter_history_entries (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              chapter_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              label TEXT NOT NULL,
              detail TEXT NOT NULL DEFAULT '',
              entry_order INTEGER NOT NULL,
              created_at TEXT NOT NULL
            )
            """
        )
        oldLabels = [
            "User prompt",
            "Glm 5.2 thought for 8 seconds",
            "Glm 5.2 wrote for 24 seconds",
            "Glm 5.2 could not apply the edit",
            "Glm 5.2 added Pip to Lorebook",
            "Glm 5.2 updated Pip in Lorebook",
            "Glm 5.2 updated Timeline",
            "Glm 5.2 removed Mara from Lorebook",
            "Glm 5.2 finished editing Lorebook after 4 seconds",
            "Glm 5.2 found no Lorebook changes after 2 seconds",
        ]
        for index, label in enumerate(oldLabels):
            conn.execute(
                "INSERT INTO chapter_history_entries VALUES (?,'s1','c1','r1',?,'',?,'now')",
                (f"e{index}", label, index),
            )

        main.ensure_chapter_history_columns(conn)
        main.ensure_chapter_history_columns(conn) #twice, must not blow up or double apply

        columns = [row["name"] for row in conn.execute("PRAGMA table_info(chapter_history_entries)")]
        self.assertEqual(columns.count("kind"), 1)

        kinds = [
            row["kind"]
            for row in conn.execute("SELECT kind FROM chapter_history_entries ORDER BY entry_order")
        ]
        self.assertEqual(
            kinds,
            [
                "prompt",
                "thinking",
                "write",
                "write_failed",
                "lore_create",
                "lore_update",
                "lore_update",
                "lore_hide",
                "lore_summary",
                "lore_summary",
            ],
        )
        conn.close()

    def test_brainstorm_root_layout_reuses_the_nearest_open_slot(self):
        firstRoot = {"id": "root-1", "position_y": 180}
        firstIdeas = [
            {"id": "idea-1", "position_y": -30},
            {"id": "idea-2", "position_y": 180},
            {"id": "idea-3", "position_y": 390},
        ]
        firstNodes = [firstRoot, *firstIdeas]
        firstEdges = [
            {"source_node_id": "root-1", "target_node_id": idea["id"]}
            for idea in firstIdeas
        ]

        self.assertEqual(next_brainstorm_root_position([], [], 3), (0.0, 180.0))
        secondPosition = next_brainstorm_root_position(firstNodes, firstEdges, 3)
        self.assertEqual(secondPosition, (0.0, 940.0))

        secondRoot = {"id": "root-2", "position_y": secondPosition[1]}
        secondIdeas = [
            {"id": "idea-4", "position_y": secondPosition[1] - 210},
            {"id": "idea-5", "position_y": secondPosition[1]},
            {"id": "idea-6", "position_y": secondPosition[1] + 210},
        ]
        secondNodes = [secondRoot, *secondIdeas]
        secondEdges = [
            {"source_node_id": "root-2", "target_node_id": idea["id"]}
            for idea in secondIdeas
        ]
        allNodes = [*firstNodes, *secondNodes]
        allEdges = [*firstEdges, *secondEdges]

        thirdPosition = next_brainstorm_root_position(allNodes, allEdges, 3)
        self.assertEqual(thirdPosition, (0.0, -580.0))
        reusedPosition = next_brainstorm_root_position(secondNodes, secondEdges, 3)
        self.assertEqual(reusedPosition, (0.0, 180.0))

    def streamChapterGeneration(
        self,
        story,
        chapter,
        output,
        revision=None,
        mode="edit",
        runId="run-test",
        complete=True,
        lorebookUpdates=None,
        repairContext=None,
        finishReason=None,
        lorebookReasoning="",
        lorebookComplete=True,
        lorebookFinishReason=None,
    ):
        chunks = output if isinstance(output, list) else [output]
        requestBody = {}
        lorebookCalls = []
        nextLorebookUpdates = list(lorebookUpdates or [])
        if lorebookUpdates is not None:
            summaryDescription = f"summary for {chapter['title']}"
            self.client.post(
                f"/api/stories/{story['id']}/lorebook",
                json={
                    "name": chapter["title"],
                    "category": "synopsis",
                    "description": summaryDescription,
                    "metadata": {"chapter_id": chapter["id"]},
                },
            )
            nextLorebookUpdates.append(
                {
                    "action": "update",
                    "name": chapter["title"],
                    "category": "synopsis",
                    "description": summaryDescription,
                }
            )
        lorebookContent = json.dumps({"updates": nextLorebookUpdates})

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
                if finishReason:
                    #a provider that ends the connection right after its last real chunk, no trailing [DONE] line
                    yield f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': finishReason}]})}"
                if complete:
                    yield "data: [DONE]"

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **kwargs):
                body = kwargs.get("json") or {}
                #the lorebook pass streams too now, and it only ever runs after the chapter one, so order tells them apart
                if requestBody:
                    lorebookCalls.append(body)
                    return fakeLorebookStream(
                        lorebookContent,
                        lorebookReasoning,
                        complete=lorebookComplete,
                        finishReason=lorebookFinishReason,
                    )
                requestBody.update(body)
                return FakeResponse()

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.writing.httpx.AsyncClient", FakeClient
        ), patch(
            "backend.lorebook.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/chapters/{chapter['id']}/generate/stream",
                json={
                    "message": "edit the chapter",
                    "model": "test/model",
                    "write_generation_mode": mode,
                    "chapter_revision": revision if revision is not None else chapter["revision"],
                    "generation_run_id": runId,
                    "repair_context": repairContext,
                },
            )
        #hung off self so the ten existing two-value call sites keep working
        self.lastLorebookCalls = lorebookCalls
        return response, requestBody

    def callLorebookUpdate(self, story, chapter, updates=None, rawOutput=None):
        calls = []
        if rawOutput is None:
            summaryDescription = f"summary for {chapter.get('title', 'Chapter')}"
            self.client.post(
                f"/api/stories/{story['id']}/lorebook",
                json={
                    "name": chapter.get("title", "Chapter"),
                    "category": "synopsis",
                    "description": summaryDescription,
                    "metadata": {"chapter_id": chapter["id"]},
                },
            )
            nextUpdates = [
                *(updates or []),
                {
                    "action": "update",
                    "name": chapter.get("title", "Chapter"),
                    "category": "synopsis",
                    "description": summaryDescription,
                },
            ]
            content = json.dumps({"updates": nextUpdates})
        else:
            content = rawOutput

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **kwargs):
                calls.append(kwargs.get("json") or {})
                return fakeLorebookStream(content)

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.lorebook.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/lorebook/update",
                json={"chapter_id": chapter["id"]},
            )
        return response, calls

    def callLorebookUpdateWithStreamState(
        self,
        story,
        chapter,
        rawOutput,
        *,
        complete,
        finishReason=None,
        streaming=False,
    ):
        requestBody = {}

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **kwargs):
                requestBody.update(kwargs.get("json") or {})
                return fakeLorebookStream(
                    rawOutput,
                    complete=complete,
                    finishReason=finishReason,
                )

        endpoint = "update/stream" if streaming else "update"
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.lorebook.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/lorebook/{endpoint}",
                json={"chapter_id": chapter["id"]},
            )
        return response, requestBody

    def callBrainstormWithStreamState(
        self,
        story,
        rawOutput,
        *,
        ideaCount=3,
        complete=True,
        finishReason="stop",
        supportedParameters=None,
    ):
        modelId = "test/brainstorm-guards"
        main.cache_models([main.normalize_model({
            "id": modelId,
            "supported_parameters": list(supportedParameters or []),
        })])
        requestBody = {}

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                yield f"data: {json.dumps({'choices': [{'delta': {'content': rawOutput}}]})}"
                if finishReason:
                    yield f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': finishReason}]})}"
                if complete:
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
            "backend.brainstorm.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/brainstorm/generate/stream",
                json={
                    "message": "give me paths",
                    "model": modelId,
                    "brainstorm_idea_count": ideaCount,
                    "selected_idea_ids": [],
                },
            )
        return response, requestBody

    def callTimelineRepair(
        self,
        story,
        currentTimeline,
        rawOutput,
        reasoning="",
        complete=True,
        beforeDone=None,
    ):
        requestBody = {}

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                if reasoning:
                    chunk = {"choices": [{"delta": {"reasoning": reasoning}}]}
                    yield f"data: {json.dumps(chunk)}"
                contentChunk = {
                    "choices": [
                        {
                            "delta": {"content": rawOutput},
                            "finish_reason": "stop",
                        }
                    ]
                }
                yield f"data: {json.dumps(contentChunk)}"
                if beforeDone:
                    beforeDone()
                if complete:
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
            "backend.lorebook.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/lorebook/timeline/repair/stream",
                json={"current_timeline": currentTimeline},
            )
        return response, requestBody

    def callLorebookGenerate(self, story, payload, rawOutput):
        requestBody = {}

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                chunk = {"choices": [{"delta": {"content": rawOutput}, "finish_reason": "stop"}]}
                yield f"data: {json.dumps(chunk)}"
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
            "backend.lorebook_generate.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/lorebook/generate/stream",
                json=payload,
            )
        return response, requestBody

    def callLorebookRepair(self, story, rawOutput):
        requestBody = {}

        class FakeResponse:
            status_code = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def aiter_lines(self):
                chunk = {"choices": [{"delta": {"content": rawOutput}, "finish_reason": "stop"}]}
                yield f"data: {json.dumps(chunk)}"
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
            "backend.lorebook_repair.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/lorebook/repair/stream"
            )
        return response, requestBody

    def storyWithChapter(self, title, content):
        story = self.client.post("/api/stories", json={"title": title}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Chapter 1", "content": content},
        ).json()["chapter"]
        return story, chapter

    def lorebookRow(self, story, name):
        with main.get_db() as conn:
            return conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? AND lower(name) = lower(?)",
                (story["id"], name),
            ).fetchone()

    def test_manual_lorebook_update_applies_entries_and_records_the_run(self):
        story, chapter = self.storyWithChapter("Manual Lore", "Chloe walked the long hall.")

        response, calls = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "create",
                    "name": "Chloe",
                    "category": "character",
                    "description": "walks the long hall",
                }
            ],
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual([update["action"] for update in payload["applied"]], ["create"])
        self.assertIsNone(payload["error"])
        self.assertEqual(len(calls), 1)
        self.assertIn("Chloe", [entry["name"] for entry in payload["entries"]])

        labels = [entry["label"] for entry in payload["history"]]
        self.assertTrue(any(label.endswith("added Chloe to Lorebook") for label in labels))
        self.assertIn("finished editing Lorebook after", labels[-1])

        with main.get_db() as conn:
            run = conn.execute(
                "SELECT * FROM lorebook_update_runs WHERE story_id = ?", (story["id"],)
            ).fetchone()
            historyCount = conn.execute(
                "SELECT COUNT(*) AS total FROM chapter_history_entries WHERE chapter_id = ?",
                (chapter["id"],),
            ).fetchone()["total"]
        self.assertIsNotNone(run)
        self.assertIsNone(run["generation_id"])
        self.assertEqual(historyCount, len(payload["history"]))

    def test_targeted_lorebook_update_changes_only_requested_text_and_lists(self):
        story, chapter = self.storyWithChapter(
            "Targeted Lore",
            "Kael's hair had turned black before he reached the south gate.",
        )
        kael = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Kael",
                "category": "character",
                "description": "Kael has red hair. He guards the north gate.",
                "aliases": ["The Knight"],
                "tags": ["northwatch"],
            },
        ).json()["entry"]
        summary = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": chapter["title"],
                "category": "synopsis",
                "description": "Kael begins his journey.",
                "metadata": {"chapter_id": chapter["id"]},
            },
        ).json()["entry"]
        timeline = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Timeline",
                "category": "timeline",
                "description": "- Kael guards the north gate\n- Dawn arrives",
            },
        ).json()["entry"]

        rawOutput = json.dumps({
            "updates": [
                {
                    "action": "edit",
                    "entryId": kael["id"],
                    "entryRevision": kael["revision"],
                    "operations": [
                        {
                            "operation": "replaceText",
                            "field": "description",
                            "oldText": "red hair",
                            "newText": "black hair",
                        },
                        {
                            "operation": "addItems",
                            "field": "aliases",
                            "values": ["The Grey"],
                        },
                        {
                            "operation": "removeItems",
                            "field": "tags",
                            "values": ["northwatch"],
                        },
                    ],
                },
                {
                    "action": "edit",
                    "entryId": summary["id"],
                    "entryRevision": summary["revision"],
                    "operations": [
                        {
                            "operation": "replaceText",
                            "field": "description",
                            "oldText": "begins his journey",
                            "newText": "leaves through the south gate",
                        }
                    ],
                },
                {
                    "action": "edit",
                    "entryId": timeline["id"],
                    "entryRevision": timeline["revision"],
                    "operations": [
                        {
                            "operation": "replaceText",
                            "field": "description",
                            "oldText": "- Kael guards the north gate",
                            "newText": "- Kael leaves through the south gate",
                        }
                    ],
                },
            ]
        })
        response, calls = self.callLorebookUpdate(story, chapter, rawOutput=rawOutput)

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["skipped"], [])
        entries = {entry["name"]: entry for entry in payload["entries"]}
        self.assertEqual(
            entries["Kael"]["description"],
            "Kael has black hair. He guards the north gate.",
        )
        self.assertEqual(entries["Kael"]["aliases"], ["The Knight", "The Grey"])
        self.assertEqual(entries["Kael"]["tags"], [])
        self.assertEqual(entries["Kael"]["revision"], kael["revision"] + 1)
        self.assertEqual(
            entries[chapter["title"]]["description"],
            "Kael leaves through the south gate.",
        )
        self.assertEqual(entries[chapter["title"]]["revision"], summary["revision"] + 1)
        self.assertEqual(entries[chapter["title"]]["metadata"], {"chapter_id": chapter["id"]})
        self.assertEqual(
            entries["Timeline"]["description"],
            "- Kael leaves through the south gate\n- Dawn arrives",
        )
        modelContext = json.loads(calls[0]["messages"][1]["content"])["existing_lorebook"]
        kaelContext = next(entry for entry in modelContext if entry["entryId"] == kael["id"])
        self.assertEqual(kaelContext["entryRevision"], kael["revision"])

    def test_targeted_lorebook_update_applies_valid_operations_and_records_bad_ones(self):
        story, chapter = self.storyWithChapter("Partial Lore", "Kael returned at dusk.")
        kael = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Kael",
                "category": "character",
                "description": "red cloak, red boots",
            },
        ).json()["entry"]
        summary = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": chapter["title"],
                "category": "synopsis",
                "description": "Kael returned.",
                "metadata": {"chapter_id": chapter["id"]},
            },
        ).json()["entry"]
        timeline = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Timeline", "category": "timeline", "description": "- Kael left"},
        ).json()["entry"]
        rawOutput = json.dumps({
            "updates": [
                {
                    "action": "edit",
                    "entryId": kael["id"],
                    "entryRevision": kael["revision"],
                    "operations": [
                        {
                            "operation": "replaceText",
                            "field": "description",
                            "oldText": "red",
                            "newText": "black",
                        },
                        {
                            "operation": "appendText",
                            "field": "description",
                            "newText": "He returned at dusk.",
                        },
                    ],
                },
                {"action": "keep", "entryId": summary["id"], "entryRevision": summary["revision"]},
                {"action": "keep", "entryId": timeline["id"], "entryRevision": timeline["revision"]},
            ]
        })
        response, _ = self.callLorebookUpdate(story, chapter, rawOutput=rawOutput)

        payload = response.json()
        self.assertEqual(len(payload["applied"]), 1)
        self.assertEqual(len(payload["skipped"]), 1)
        self.assertEqual(payload["skipped"][0]["operationIndex"], 0)
        kaelAfter = next(entry for entry in payload["entries"] if entry["id"] == kael["id"])
        self.assertEqual(kaelAfter["description"], "red cloak, red boots\n\nHe returned at dusk.")
        self.assertIn("1 targeted lorebook edit was skipped", payload["history"][-1]["detail"])
        with main.get_db() as conn:
            run = conn.execute(
                "SELECT rejected_updates_json FROM lorebook_update_runs WHERE story_id = ?",
                (story["id"],),
            ).fetchone()
        self.assertEqual(len(json.loads(run["rejected_updates_json"])), 1)

    def test_targeted_lorebook_update_skips_a_stale_revision(self):
        story, chapter = self.storyWithChapter("Stale Lore", "Kael changed again.")
        kael = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Kael", "category": "character", "description": "old fact"},
        ).json()["entry"]
        summary = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": chapter["title"],
                "category": "synopsis",
                "description": "Kael changed.",
                "metadata": {"chapter_id": chapter["id"]},
            },
        ).json()["entry"]
        timeline = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Timeline", "category": "timeline", "description": "- Kael changed"},
        ).json()["entry"]
        rawOutput = json.dumps({
            "updates": [
                {
                    "action": "edit",
                    "entryId": kael["id"],
                    "entryRevision": kael["revision"] + 1,
                    "operations": [{
                        "operation": "replaceText",
                        "field": "description",
                        "oldText": "old fact",
                        "newText": "new fact",
                    }],
                },
                {"action": "keep", "entryId": summary["id"], "entryRevision": summary["revision"]},
                {"action": "keep", "entryId": timeline["id"], "entryRevision": timeline["revision"]},
            ]
        })
        response, _ = self.callLorebookUpdate(story, chapter, rawOutput=rawOutput)

        payload = response.json()
        self.assertEqual(payload["applied"], [])
        self.assertEqual(payload["skipped"][0]["code"], "lorebook_revision_conflict")
        self.assertEqual(self.lorebookRow(story, "Kael")["description"], "old fact")

    def test_targeted_lorebook_update_creates_and_excludes_entries(self):
        story, chapter = self.storyWithChapter("Create and Exclude", "The wall fell.")
        wall = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Old wall", "category": "location", "description": "still standing"},
        ).json()["entry"]
        summary = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": chapter["title"],
                "category": "synopsis",
                "description": "The wall fell.",
                "metadata": {"chapter_id": chapter["id"]},
            },
        ).json()["entry"]
        timeline = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Timeline", "category": "timeline", "description": "- The wall fell"},
        ).json()["entry"]
        rawOutput = json.dumps({
            "updates": [
                {
                    "action": "create",
                    "name": "Wall stone",
                    "category": "item",
                    "description": "A stone recovered from the fallen wall.",
                    "aliases": [],
                    "tags": ["relic"],
                    "metadata": {},
                },
                {"action": "exclude", "entryId": wall["id"], "entryRevision": wall["revision"]},
                {"action": "keep", "entryId": summary["id"], "entryRevision": summary["revision"]},
                {"action": "keep", "entryId": timeline["id"], "entryRevision": timeline["revision"]},
            ]
        })
        response, _ = self.callLorebookUpdate(story, chapter, rawOutput=rawOutput)

        payload = response.json()
        self.assertEqual(payload["skipped"], [])
        self.assertIn("Wall stone", [entry["name"] for entry in payload["entries"]])
        self.assertEqual(self.lorebookRow(story, "Old wall")["disabled"], 1)

    def test_lorebook_update_requires_one_summary_before_applying_any_changes(self):
        story, chapter = self.storyWithChapter("Summary Guard", "Mara opens the red gate.")

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            rawOutput=json.dumps({
                "updates": [
                    {
                        "action": "create",
                        "name": "Mara",
                        "category": "character",
                        "description": "opens the red gate",
                    }
                ]
            }),
        )

        payload = response.json()
        self.assertIn("exactly one chapter summary", payload["error"])
        self.assertEqual(payload["applied"], [])
        self.assertIsNone(self.lorebookRow(story, "Mara"))

    def test_lorebook_update_structured_output_follows_model_capability(self):
        supportedModel = "test/lorebook-structured"
        unsupportedModel = "test/lorebook-plain"
        main.cache_models([
            main.normalize_model({
                "id": supportedModel,
                "supported_parameters": ["structured_outputs"],
            }),
            main.normalize_model({
                "id": unsupportedModel,
                "supported_parameters": [],
            }),
        ])
        story, chapter = self.storyWithChapter("Lorebook Schema", "Mara opens the gate.")

        self.client.patch(
            f"/api/stories/{story['id']}",
            json={"model": supportedModel},
        )
        _, supportedCalls = self.callLorebookUpdate(story, chapter, updates=[])
        self.assertEqual(
            supportedCalls[0]["response_format"],
            lorebook_update_response_format(),
        )

        self.client.patch(
            f"/api/stories/{story['id']}",
            json={"model": unsupportedModel},
        )
        _, unsupportedCalls = self.callLorebookUpdate(story, chapter, updates=[])
        self.assertNotIn("response_format", unsupportedCalls[0])

    def test_lorebook_update_rejects_truncated_and_incomplete_streams_without_changes(self):
        cases = [
            (
                "truncated",
                "length",
                "The lorebook update hit the model token limit before it finished.",
            ),
            (
                "incomplete",
                "stop",
                "The lorebook update ended before the provider completed the stream.",
            ),
        ]

        for label, finishReason, expectedError in cases:
            with self.subTest(label=label):
                story, chapter = self.storyWithChapter(
                    f"Lorebook {label}",
                    "Mara opens the red gate.",
                )
                rawOutput = json.dumps({
                    "updates": [
                        {
                            "action": "create",
                            "name": "Mara",
                            "category": "character",
                            "description": "opens the red gate",
                        },
                        {
                            "action": "create",
                            "name": chapter["title"],
                            "category": "synopsis",
                            "description": "Mara opens the red gate.",
                        },
                    ]
                })
                response, _ = self.callLorebookUpdateWithStreamState(
                    story,
                    chapter,
                    rawOutput,
                    complete=False,
                    finishReason=finishReason,
                )

                payload = response.json()
                self.assertEqual(payload["error"], expectedError)
                self.assertEqual(payload["applied"], [])
                self.assertIsNone(self.lorebookRow(story, "Mara"))
                with main.get_db() as conn:
                    run = conn.execute(
                        "SELECT * FROM lorebook_update_runs WHERE story_id = ?",
                        (story["id"],),
                    ).fetchone()
                self.assertEqual(run["error"], expectedError)
                self.assertEqual(json.loads(run["applied_updates_json"]), [])

    def test_streaming_and_automatic_lorebook_updates_keep_incomplete_output_atomic(self):
        story, chapter = self.storyWithChapter(
            "Incomplete streamed lore",
            "Mara opens the red gate.",
        )
        rawOutput = json.dumps({
            "updates": [
                {
                    "action": "create",
                    "name": "Mara",
                    "category": "character",
                    "description": "opens the red gate",
                },
                {
                    "action": "create",
                    "name": chapter["title"],
                    "category": "synopsis",
                    "description": "Mara opens the red gate.",
                },
            ]
        })
        streamResponse, _ = self.callLorebookUpdateWithStreamState(
            story,
            chapter,
            rawOutput,
            complete=False,
            finishReason="stop",
            streaming=True,
        )
        events = [json.loads(line) for line in streamResponse.text.splitlines() if line]
        completed = next(event["value"] for event in events if event["type"] == "complete")
        self.assertIn("ended before the provider completed", completed["error"])
        self.assertIsNone(self.lorebookRow(story, "Mara"))

        autoStory, autoChapter = self.storyWithChapter("Incomplete auto lore", "")
        self.client.patch(
            f"/api/stories/{autoStory['id']}",
            json={"lorebook_auto": True},
        )
        chapterResponse, _ = self.streamChapterGeneration(
            autoStory,
            autoChapter,
            "Rafe lights the bone lantern.",
            mode="new",
            lorebookUpdates=[
                {
                    "action": "create",
                    "name": "Bone lantern",
                    "category": "item",
                    "description": "lit by Rafe",
                }
            ],
            lorebookComplete=False,
            lorebookFinishReason="stop",
        )
        chapterEvents = [
            json.loads(line) for line in chapterResponse.text.splitlines() if line
        ]
        lorebookResult = next(
            event["value"] for event in chapterEvents if event["type"] == "lorebook"
        )
        self.assertIn("ended before the provider completed", lorebookResult["error"])
        self.assertIsNone(self.lorebookRow(autoStory, "Bone lantern"))

    def test_chapter_summaries_use_links_across_duplicate_titles_rename_hide_and_delete(self):
        story, firstChapter = self.storyWithChapter("Linked Summaries", "Mara opens the gate.")
        secondChapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": firstChapter["title"], "content": "Rafe closes the gate."},
        ).json()["chapter"]

        for chapter, description in [
            (firstChapter, "Mara opens the gate."),
            (secondChapter, "Rafe closes the gate."),
        ]:
            response, _ = self.callLorebookUpdate(
                story,
                chapter,
                rawOutput=json.dumps({
                    "updates": [
                        {
                            "action": "create",
                            "name": "model picked the wrong name",
                            "category": "synopsis",
                            "description": description,
                        }
                    ]
                }),
            )
            self.assertIsNone(response.json()["error"])

        summaries = [
            entry
            for entry in self.client.get(f"/api/stories/{story['id']}/lorebook").json()["entries"]
            if entry["category"] == "synopsis"
        ]
        self.assertEqual(len(summaries), 2)
        self.assertEqual(
            {entry["metadata"]["chapter_id"] for entry in summaries},
            {firstChapter["id"], secondChapter["id"]},
        )

        renamed = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{firstChapter['id']}",
            json={"title": "The Red Gate", "revision": firstChapter["revision"]},
        ).json()["chapter"]
        firstSummary = next(
            entry for entry in summaries if entry["metadata"]["chapter_id"] == firstChapter["id"]
        )
        renamedSummary = self.client.get(
            f"/api/stories/{story['id']}/lorebook"
        ).json()["entries"]
        renamedSummary = next(entry for entry in renamedSummary if entry["id"] == firstSummary["id"])
        self.assertEqual(renamedSummary["name"], renamed["title"])

        hidden = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{firstChapter['id']}",
            json={"disabled": True, "revision": renamed["revision"]},
        ).json()["chapter"]
        stillVisible = self.client.get(
            f"/api/stories/{story['id']}/lorebook"
        ).json()["entries"]
        self.assertFalse(next(entry for entry in stillVisible if entry["id"] == firstSummary["id"])["disabled"])

        self.client.delete(f"/api/stories/{story['id']}/chapters/{hidden['id']}")
        remaining = self.client.get(f"/api/stories/{story['id']}/lorebook").json()["entries"]
        self.assertNotIn(firstSummary["id"], [entry["id"] for entry in remaining])
        self.assertEqual(
            [entry["metadata"]["chapter_id"] for entry in remaining if entry["category"] == "synopsis"],
            [secondChapter["id"]],
        )

    def test_lorebook_update_claims_one_legacy_summary_by_chapter_title(self):
        story, chapter = self.storyWithChapter("Legacy Summary", "Mara crosses the bridge.")
        legacy = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": chapter["title"],
                "category": "synopsis",
                "description": "old recap",
            },
        ).json()["entry"]

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            rawOutput=json.dumps({
                "updates": [
                    {
                        "action": "create",
                        "name": chapter["title"],
                        "category": "synopsis",
                        "description": "Mara crosses the bridge.",
                    }
                ]
            }),
        )

        self.assertIsNone(response.json()["error"])
        saved = self.client.get(f"/api/stories/{story['id']}/lorebook").json()["entries"]
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]["id"], legacy["id"])
        self.assertEqual(saved[0]["metadata"], {"chapter_id": chapter["id"]})

    def test_standalone_summary_generation_uses_the_selected_visible_chapter(self):
        story, chapter = self.storyWithChapter(
            "Generated Summary",
            "Mara finds the key and opens the observatory.",
        )
        rawOutput = json.dumps({
            "name": "wrong model name",
            "description": "Mara finds a key and opens the observatory.",
            "aliases": [],
            "notes": "",
        })

        response, requestBody = self.callLorebookGenerate(
            story,
            {"category": "synopsis", "chapter_id": chapter["id"]},
            rawOutput,
        )

        events = [json.loads(line) for line in response.text.splitlines() if line]
        completed = next(event["value"] for event in events if event["type"] == "complete")
        self.assertEqual(completed["entry"]["name"], chapter["title"])
        self.assertEqual(completed["entry"]["metadata"], {"chapter_id": chapter["id"]})
        prompt = json.loads(requestBody["messages"][-1]["content"])
        self.assertEqual(prompt["chapter"]["id"], chapter["id"])
        self.assertEqual(prompt["chapter"]["title"], chapter["title"])
        self.assertEqual(prompt["chapter"]["content"], chapter["content"])
        self.assertNotIn("author_brief", prompt)

    def test_standalone_summary_generation_rejects_unavailable_chapters(self):
        story, chapter = self.storyWithChapter("Summary Validation", "visible prose")
        blankChapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Blank", "content": ""},
        ).json()["chapter"]
        hiddenChapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Hidden", "content": "secret prose"},
        ).json()["chapter"]
        hiddenChapter = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{hiddenChapter['id']}",
            json={"disabled": True, "revision": hiddenChapter["revision"]},
        ).json()["chapter"]
        otherStory, otherChapter = self.storyWithChapter("Other Story", "other prose")
        rawOutput = json.dumps({
            "name": "unused",
            "description": "unused",
            "aliases": [],
            "notes": "",
        })

        for payload, status in [
            ({"category": "synopsis"}, 422),
            ({"category": "synopsis", "chapter_id": blankChapter["id"]}, 422),
            ({"category": "synopsis", "chapter_id": hiddenChapter["id"]}, 404),
            ({"category": "synopsis", "chapter_id": otherChapter["id"]}, 404),
            ({"category": "character", "brief": ""}, 422),
        ]:
            response, _ = self.callLorebookGenerate(story, payload, rawOutput)
            self.assertEqual(response.status_code, status)

        self.assertNotEqual(story["id"], otherStory["id"])
        self.assertTrue(chapter["content"])

    def test_lorebook_rebuild_regenerates_visible_summaries_and_preserves_hidden_ones(self):
        story, visibleChapter = self.storyWithChapter("Summary Rebuild", "Mara opens the gate.")
        blankChapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Blank", "content": ""},
        ).json()["chapter"]
        hiddenChapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Hidden", "content": "Rafe waits outside."},
        ).json()["chapter"]
        hiddenChapter = self.client.patch(
            f"/api/stories/{story['id']}/chapters/{hiddenChapter['id']}",
            json={"disabled": True, "revision": hiddenChapter["revision"]},
        ).json()["chapter"]

        hiddenSummary = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": hiddenChapter["title"],
                "category": "synopsis",
                "description": "Rafe waits outside.",
                "metadata": {"chapter_id": hiddenChapter["id"]},
            },
        ).json()["entry"]
        blankSummary = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": blankChapter["title"],
                "category": "synopsis",
                "description": "stale blank summary",
                "metadata": {"chapter_id": blankChapter["id"]},
            },
        ).json()["entry"]
        rawOutput = json.dumps({
            "entries": [
                {
                    "name": "Timeline",
                    "category": "timeline",
                    "description": "- Mara opens the gate",
                    "aliases": [],
                }
            ],
            "summaries": {
                visibleChapter["id"]: {
                    "name": "wrong model name",
                    "description": "Mara opens the gate.",
                }
            },
        })

        response, requestBody = self.callLorebookRepair(story, rawOutput)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(events[-1]["type"], "complete")
        prompt = json.loads(requestBody["messages"][-1]["content"])
        self.assertEqual([chapter["id"] for chapter in prompt["visible_chapters"]], [visibleChapter["id"]])
        saved = events[-1]["value"]["entries"]
        self.assertIn(hiddenSummary["id"], [entry["id"] for entry in saved])
        self.assertNotIn(blankSummary["id"], [entry["id"] for entry in saved])
        visibleSummary = next(
            entry
            for entry in saved
            if entry["metadata"].get("chapter_id") == visibleChapter["id"]
        )
        self.assertEqual(visibleSummary["name"], visibleChapter["title"])

    def test_invalid_rebuild_summaries_preserve_the_existing_lorebook(self):
        story, chapter = self.storyWithChapter("Safe Summary Rebuild", "Mara waits.")
        existing = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Mara", "category": "character", "description": "waits"},
        ).json()["entry"]
        rawOutput = json.dumps({
            "entries": [
                {
                    "name": "Timeline",
                    "category": "timeline",
                    "description": "- Mara waits",
                    "aliases": [],
                }
            ],
            "summaries": {},
        })

        response, _ = self.callLorebookRepair(story, rawOutput)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(events[-1]["value"]["code"], "lorebook_repair_invalid")
        savedIds = [
            entry["id"]
            for entry in self.client.get(f"/api/stories/{story['id']}/lorebook").json()["entries"]
        ]
        self.assertIn(existing["id"], savedIds)
        self.assertTrue(chapter["content"])

    def test_timeline_repair_streams_reasoning_and_rebuilds_from_visible_story(self):
        modelId = "test/timeline-repair"
        main.cache_models([
            main.normalize_model({
                "id": modelId,
                "name": "Timeline repair model",
                "supported_parameters": ["reasoning", "structured_outputs"],
                "reasoning": {"mandatory": False},
            })
        ])
        story = self.client.post(
            "/api/stories",
            json={
                "title": "Repair Story",
                "model": modelId,
                "thinking_enabled": False,
                "reasoning_effort": "high",
            },
        ).json()["story"]
        firstChapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "Mara opens the red gate."},
        ).json()["chapter"]
        hiddenChapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Hidden", "content": "never include this chapter"},
        ).json()["chapter"]
        self.client.patch(
            f"/api/stories/{story['id']}/chapters/{hiddenChapter['id']}",
            json={"disabled": True},
        )
        timeline = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Timeline",
                "category": "timeline",
                "description": "- The old gate stayed closed",
            },
        ).json()["entry"]

        rawOutput = json.dumps({
            "timeline": "Mara opens the red gate\n- Mara crosses the threshold",
        })
        response, requestBody = self.callTimelineRepair(
            story,
            "- unsaved timeline context",
            rawOutput,
            reasoning="Check the chapters in order.",
        )

        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(
            [event["type"] for event in events],
            ["status", "reasoning", "status", "complete"],
        )
        self.assertEqual(events[0]["value"], "rebuilding")
        self.assertEqual(events[1]["value"], "Check the chapters in order.")
        #the writing status is what flips the modal header from Thinking to Writing
        self.assertEqual(events[2]["value"], "writing")
        self.assertGreater(events[-1]["value"]["duration_ms"], 0)
        self.assertEqual(events[-1]["value"]["entry"]["id"], timeline["id"])
        self.assertEqual(
            events[-1]["value"]["entry"]["description"],
            "- Mara opens the red gate\n- Mara crosses the threshold",
        )

        prompt = json.loads(requestBody["messages"][-1]["content"])
        self.assertEqual(prompt["current_timeline"], "- unsaved timeline context")
        self.assertEqual(
            prompt["visible_chapters"],
            [{"title": firstChapter["title"], "content": firstChapter["content"]}],
        )
        self.assertNotIn("never include this chapter", requestBody["messages"][-1]["content"])
        self.assertEqual(
            requestBody["reasoning"],
            {"enabled": True, "exclude": False, "effort": "high"},
        )
        self.assertEqual(
            requestBody["response_format"]["json_schema"]["name"],
            "timeline_repair",
        )

        savedTimeline = self.lorebookRow(story, "Timeline")
        self.assertEqual(
            savedTimeline["description"],
            "- Mara opens the red gate\n- Mara crosses the threshold",
        )

    def test_timeline_repair_failure_and_conflict_preserve_the_saved_timeline(self):
        story, _ = self.storyWithChapter("Safe Repair", "Mara waits at the gate.")
        timeline = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Timeline",
                "category": "timeline",
                "description": "- original timeline",
            },
        ).json()["entry"]

        invalidResponse, _ = self.callTimelineRepair(
            story,
            timeline["description"],
            json.dumps({"timeline": ""}),
        )
        invalidEvents = [
            json.loads(line) for line in invalidResponse.text.splitlines() if line
        ]
        self.assertEqual(invalidEvents[-1]["type"], "error")
        self.assertEqual(invalidEvents[-1]["value"]["code"], "timeline_repair_invalid")
        self.assertEqual(self.lorebookRow(story, "Timeline")["description"], "- original timeline")

        incompleteResponse, _ = self.callTimelineRepair(
            story,
            timeline["description"],
            json.dumps({"timeline": "- incomplete replacement"}),
            complete=False,
        )
        incompleteEvents = [
            json.loads(line) for line in incompleteResponse.text.splitlines() if line
        ]
        self.assertEqual(incompleteEvents[-1]["type"], "error")
        self.assertEqual(incompleteEvents[-1]["value"]["code"], "timeline_repair_incomplete")
        self.assertEqual(self.lorebookRow(story, "Timeline")["description"], "- original timeline")

        def changeTimeline():
            with main.get_db() as conn:
                conn.execute(
                    "UPDATE lorebook_entries SET description = ?, updated_at = ? WHERE id = ?",
                    ("- newer manual edit", main.utc_now(), timeline["id"]),
                )

        conflictResponse, _ = self.callTimelineRepair(
            story,
            timeline["description"],
            json.dumps({"timeline": "- generated replacement"}),
            beforeDone=changeTimeline,
        )
        conflictEvents = [
            json.loads(line) for line in conflictResponse.text.splitlines() if line
        ]
        self.assertEqual(conflictEvents[-1]["type"], "error")
        self.assertEqual(conflictEvents[-1]["value"]["code"], "timeline_repair_conflict")
        self.assertEqual(self.lorebookRow(story, "Timeline")["description"], "- newer manual edit")

    def test_timeline_repair_creates_an_enabled_timeline_without_changing_a_hidden_one(self):
        story, _ = self.storyWithChapter("Hidden Timeline", "The bells ring at dawn.")
        hiddenTimeline = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Timeline",
                "category": "timeline",
                "description": "- private old timeline",
                "disabled": True,
            },
        ).json()["entry"]

        response, _ = self.callTimelineRepair(
            story,
            hiddenTimeline["description"],
            json.dumps({"timeline": "- The bells ring at dawn"}),
        )
        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(events[-1]["type"], "complete")
        self.assertNotEqual(events[-1]["value"]["entry"]["id"], hiddenTimeline["id"])

        entries = self.client.get(f"/api/stories/{story['id']}/lorebook").json()["entries"]
        self.assertEqual(len(entries), 2)
        hiddenSaved = next(entry for entry in entries if entry["id"] == hiddenTimeline["id"])
        enabledSaved = next(entry for entry in entries if entry["id"] != hiddenTimeline["id"])
        self.assertTrue(hiddenSaved["disabled"])
        self.assertEqual(hiddenSaved["description"], "- private old timeline")
        self.assertFalse(enabledSaved["disabled"])
        self.assertEqual(enabledSaved["description"], "- The bells ring at dawn")

    def test_timeline_repair_splits_bullets_a_model_crammed_onto_one_line(self):
        story, _ = self.storyWithChapter(
            "Crammed Timeline",
            "Mossy slipped through the gate. Mossy found the stream.",
        )
        crammed = "- Mossy slips through the garden gate.  - Mossy finds the babbling stream."

        response, _ = self.callTimelineRepair(
            story,
            "- old timeline",
            json.dumps({"timeline": crammed}),
        )
        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(events[-1]["type"], "complete")
        self.assertEqual(
            events[-1]["value"]["entry"]["description"],
            "- Mossy slips through the garden gate.\n- Mossy finds the babbling stream.",
        )
        self.assertEqual(
            self.lorebookRow(story, "Timeline")["description"],
            "- Mossy slips through the garden gate.\n- Mossy finds the babbling stream.",
        )

    def test_timeline_normalizer_leaves_good_bullets_and_spaced_hyphens_alone(self):
        multiline = "- 2341, 03:17: ISB arrests Lilac Thorne\n- 2341, 04:00: Lilac steals a code cylinder"
        self.assertEqual(normalize_timeline_description(multiline), multiline)

        #one real event that happens to hold a date range must not get chopped at the hyphen
        dateRange = "- 2341 - 2350: the long war grinds on across the outer colonies"
        self.assertEqual(normalize_timeline_description(dateRange), dateRange)

        prose = "- The war lasted from 2341 - 2350 and ended very badly indeed"
        self.assertEqual(normalize_timeline_description(prose), prose)

        #no sentence endings to go on, but three markers on one line is past being prose
        self.assertEqual(
            normalize_timeline_description("* alpha event happens * beta event happens * gamma event happens"),
            "- alpha event happens\n- beta event happens\n- gamma event happens",
        )

    def test_timeline_repair_rejects_empty_visible_story_content(self):
        story, chapter = self.storyWithChapter("Empty Repair", "")
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            response = self.client.post(
                f"/api/stories/{story['id']}/lorebook/timeline/repair/stream",
                json={"current_timeline": "- old"},
            )
        self.assertEqual(response.status_code, 422)
        self.assertIn("visible in context", response.json()["detail"])
        self.assertEqual(chapter["content"], "")

    def test_manual_lorebook_update_records_line_counts_and_puts_cost_on_the_summary(self):
        story, chapter = self.storyWithChapter("Lore Stats", "Chloe walked the long hall.")

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "create",
                    "name": "Chloe",
                    "category": "character",
                    "description": "walks the long hall\nkeeps to herself",
                }
            ],
        )

        payload = response.json()
        #"category: character" + the two description lines + "alias: Chloe"
        self.assertEqual(payload["applied"][0]["wordsAdded"], 11)
        self.assertEqual(payload["applied"][0]["wordsRemoved"], 0)

        entryRow, summaryRow = payload["history"]
        self.assertEqual(entryRow["words_added"], 11)
        self.assertEqual(entryRow["words_removed"], 0)
        #one api call means one cost and it belongs on the closing line, never smeared across the entries
        self.assertIsNone(entryRow["cost"])
        #the closing line carries the run totals the same way the run header carries the cost subtotal
        self.assertEqual(summaryRow["words_added"], 11)
        self.assertEqual(summaryRow["words_removed"], 0)

    def test_manual_lorebook_update_counts_removed_lines_on_a_delete(self):
        story, chapter = self.storyWithChapter("Lore Removal", "Mara was never real.")
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Mara",
                "category": "character",
                "description": "first line\nsecond line\nthird line",
            },
        )

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[{"action": "delete", "name": "Mara"}],
        )

        payload = response.json()
        #"category: character" plus the three two-word description lines
        self.assertEqual(payload["applied"][0]["wordsRemoved"], 8)
        self.assertEqual(payload["applied"][0]["wordsAdded"], 0)
        self.assertEqual(payload["history"][0]["words_removed"], 8)

    def test_lorebook_alias_only_change_still_reports_a_diff(self):
        story, chapter = self.storyWithChapter("Alias Only", "Kael rode north.")
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Kael",
                "category": "character",
                "description": "a knight",
                "aliases": ["Kae"],
            },
        )

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "update",
                    "name": "Kael",
                    "category": "character",
                    "description": "a knight",
                    "aliases": ["Kae", "The Knight"],
                }
            ],
        )

        payload = response.json()
        #description is untouched, only "alias: The Knight" arrived, and that still has to read as an edit
        self.assertEqual(payload["applied"][0]["wordsAdded"], 3)
        self.assertEqual(payload["applied"][0]["wordsRemoved"], 0)
        self.assertEqual(payload["history"][0]["words_added"], 3)

    def seedKael(self, story):
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Kael",
                "category": "character",
                "description": "a knight of the north",
                "aliases": ["The Knight", "Kae"],
                "tags": ["protagonist", "noble"],
                "metadata": {"affiliation": "Northwatch"},
            },
        )

    def test_a_description_only_update_keeps_aliases_tags_and_metadata(self):
        story, chapter = self.storyWithChapter("Field Merge", "Kael lost his sword.")
        self.seedKael(story)

        #the shape the model actually sends, description only, no mention of the other fields
        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "update",
                    "name": "Kael",
                    "category": "character",
                    "description": "a knight of the north who lost his sword",
                }
            ],
        )

        self.assertEqual([update["action"] for update in response.json()["applied"]], ["update"])
        entry = [e for e in response.json()["entries"] if e["name"] == "Kael"][0]
        self.assertEqual(entry["description"], "a knight of the north who lost his sword")
        #silence about a field is not permission to erase it
        self.assertEqual(entry["aliases"], ["The Knight", "Kae"])
        self.assertEqual(entry["tags"], ["protagonist", "noble"])
        self.assertEqual(entry["metadata"], {"affiliation": "Northwatch"})

    def test_null_or_malformed_fields_are_treated_as_unmentioned(self):
        story, chapter = self.storyWithChapter("Field Merge Null", "Kael lost his sword.")
        self.seedKael(story)

        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Ignore", "category": "note", "description": "filler"},
        )
        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "update",
                    "name": "Kael",
                    "category": "character",
                    "description": "a knight of the north who lost his sword",
                    "aliases": None,
                    "tags": "protagonist",
                    "metadata": None,
                }
            ],
        )

        entry = [e for e in response.json()["entries"] if e["name"] == "Kael"][0]
        self.assertEqual(entry["aliases"], ["The Knight", "Kae"])
        self.assertEqual(entry["tags"], ["protagonist", "noble"])
        self.assertEqual(entry["metadata"], {"affiliation": "Northwatch"})

    def test_empty_lists_are_no_opinion_not_a_request_to_wipe(self):
        story, chapter = self.storyWithChapter("Field Merge Empty", "Kael lost his sword.")
        self.seedKael(story)

        #this is the real shape models send, the system prompt hands them a template with aliases:[] tags:[] metadata:{} and they echo it back every time
        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "update",
                    "name": "Kael",
                    "category": "character",
                    "description": "a knight of the north who lost his sword",
                    "aliases": [],
                    "tags": [],
                    "metadata": {},
                }
            ],
        )

        entry = [e for e in response.json()["entries"] if e["name"] == "Kael"][0]
        self.assertEqual(entry["description"], "a knight of the north who lost his sword")
        self.assertEqual(entry["aliases"], ["The Knight", "Kae"])
        self.assertEqual(entry["tags"], ["protagonist", "noble"])
        self.assertEqual(entry["metadata"], {"affiliation": "Northwatch"})

    def test_a_non_empty_list_still_replaces_the_field(self):
        story, chapter = self.storyWithChapter("Field Merge Replace", "They call Kael the Grey now.")
        self.seedKael(story)

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "update",
                    "name": "Kael",
                    "category": "character",
                    "description": "a knight of the north",
                    "aliases": ["The Grey"],
                }
            ],
        )

        entry = [e for e in response.json()["entries"] if e["name"] == "Kael"][0]
        #a real value is a real instruction, only emptiness is ignored
        self.assertEqual(entry["aliases"], ["The Grey"])
        self.assertEqual(entry["tags"], ["protagonist", "noble"])

    def test_lorebook_update_that_changes_nothing_is_not_recorded(self):
        story, chapter = self.storyWithChapter("No Op", "Kael rode north.")
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Kael", "category": "character", "description": "a knight"},
        )

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "update",
                    "name": "Kael",
                    "category": "character",
                    "description": "a knight",
                    "aliases": [],
                }
            ],
        )

        payload = response.json()
        #claiming an update that changed nothing left a bare row in the history with no diff to show
        self.assertEqual(payload["applied"], [])
        labels = [entry["label"] for entry in payload["history"]]
        self.assertEqual(len(labels), 1)
        self.assertIn("found no Lorebook changes after", labels[0])

    def test_manual_lorebook_update_skips_a_blank_chapter(self):
        story, chapter = self.storyWithChapter("Empty Chapter", "   ")

        response, calls = self.callLorebookUpdate(story, chapter, updates=[])

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["skipped"])
        self.assertEqual(payload["applied"], [])
        self.assertEqual(payload["history"], []) #no model call ran so there is nothing to log
        self.assertEqual(calls, [])

    def test_manual_lorebook_update_stream_reports_thinking_before_the_entries(self):
        story, chapter = self.storyWithChapter("Streamed Lore", "Rafe carried a bone lantern.")
        content = json.dumps({
            "updates": [
                {
                    "action": "create",
                    "name": "Bone lantern",
                    "category": "item",
                    "description": "carried by Rafe",
                },
                {
                    "action": "create",
                    "name": chapter["title"],
                    "category": "synopsis",
                    "description": "Rafe carries a bone lantern.",
                },
            ]
        })

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            def stream(self, *_args, **_kwargs):
                return fakeLorebookStream(content, "weighing whether the lantern matters")

        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.lorebook.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/lorebook/update/stream",
                json={"chapter_id": chapter["id"]},
            )

        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines() if line]
        eventTypes = [event["type"] for event in events]
        self.assertIn("reasoning", eventTypes)
        self.assertLess(eventTypes.index("reasoning"), eventTypes.index("complete"))

        reasoning = "".join(event["value"] for event in events if event["type"] == "reasoning")
        self.assertEqual(reasoning, "weighing whether the lantern matters")

        completed = next(event["value"] for event in events if event["type"] == "complete")
        self.assertIsNone(completed["error"])
        self.assertEqual(
            [entry["name"] for entry in completed["applied"]],
            ["Bone lantern", chapter["title"]],
        )
        self.assertIn("Bone lantern", [entry["name"] for entry in completed["entries"]])

    def test_auto_lorebook_update_streams_its_thinking_through_the_chapter_run(self):
        story, chapter = self.storyWithChapter("Auto Lore", "")
        self.client.patch(f"/api/stories/{story['id']}", json={"lorebook_auto": True})

        response, _ = self.streamChapterGeneration(
            story,
            chapter,
            "Rafe lit the bone lantern.",
            mode="new",
            lorebookUpdates=[
                {
                    "action": "create",
                    "name": "Bone lantern",
                    "category": "item",
                    "description": "lit by Rafe",
                }
            ],
            lorebookReasoning="deciding what is durable here",
        )

        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines() if line]
        lorebookThinking = "".join(
            event["value"] for event in events if event["type"] == "lorebook_reasoning"
        )
        self.assertEqual(lorebookThinking, "deciding what is durable here")

        #the chapter's own reasoning stays a separate event so the ui can swap between them
        eventTypes = [event["type"] for event in events]
        self.assertLess(eventTypes.index("lorebook_start"), eventTypes.index("lorebook_reasoning"))
        self.assertLess(eventTypes.index("lorebook_reasoning"), eventTypes.index("lorebook"))

    def test_manual_lorebook_update_corrects_an_entry_the_model_calls_new(self):
        story, chapter = self.storyWithChapter("Contradiction", "Chloe's hair was black as pitch.")
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Chloe", "category": "character", "description": "red hair"},
        )

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "create",
                    "name": "Chloe",
                    "category": "character",
                    "description": "black hair",
                }
            ],
        )

        self.assertEqual([update["action"] for update in response.json()["applied"]], ["update"])
        self.assertEqual(self.lorebookRow(story, "Chloe")["description"], "black hair")

    def test_a_hidden_entry_is_untouchable_and_the_model_starts_a_fresh_one(self):
        story, chapter = self.storyWithChapter("Disabled Entry", "Mara returned to the wall.")
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Mara",
                "category": "character",
                "description": "stale",
                "disabled": True,
            },
        )

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "create",
                    "name": "Mara",
                    "category": "character",
                    "description": "returned to the wall",
                }
            ],
        )

        #hidden means invisible, so the model cannot land on it and writes a new entry instead
        self.assertEqual([update["action"] for update in response.json()["applied"]], ["create"])
        with main.get_db() as conn:
            rows = conn.execute(
                "SELECT description, disabled FROM lorebook_entries WHERE story_id = ? AND lower(name) = 'mara' ORDER BY disabled",
                (story["id"],),
            ).fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual((rows[0]["description"], rows[0]["disabled"]), ("returned to the wall", 0))
        #the hidden one is byte identical, the model never reached it
        self.assertEqual((rows[1]["description"], rows[1]["disabled"]), ("stale", 1))

    def test_a_hidden_entry_cannot_be_hidden_again(self):
        story, chapter = self.storyWithChapter("Already Hidden", "Mara is gone.")
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Mara",
                "category": "character",
                "description": "stale",
                "disabled": True,
            },
        )

        response, _ = self.callLorebookUpdate(
            story, chapter, updates=[{"action": "delete", "name": "Mara"}]
        )

        payload = response.json()
        self.assertEqual(payload["applied"], [])
        labels = [entry["label"] for entry in payload["history"]]
        self.assertEqual(len(labels), 1)
        self.assertIn("found no Lorebook changes after", labels[0])

    def test_a_hidden_timeline_does_not_block_a_new_one(self):
        story, chapter = self.storyWithChapter("Hidden Timeline", "Mara crossed the wall.")
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Timeline",
                "category": "timeline",
                "description": "- old chronology",
                "disabled": True,
            },
        )

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[
                {
                    "action": "update",
                    "name": "Timeline",
                    "category": "timeline",
                    "description": "- Mara crossed the wall",
                }
            ],
        )

        self.assertEqual([update["action"] for update in response.json()["applied"]], ["create"])
        with main.get_db() as conn:
            rows = conn.execute(
                "SELECT description, disabled FROM lorebook_entries WHERE story_id = ? AND lower(name) = 'timeline' ORDER BY disabled",
                (story["id"],),
            ).fetchall()
        #the singleton rule applies to what the model can see, the hidden one keeps its old chronology
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["description"], "- Mara crossed the wall")
        self.assertEqual(rows[1]["description"], "- old chronology")

    def test_hiding_an_entry_reads_as_excluded_from_context(self):
        story, chapter = self.storyWithChapter("Hide Wording", "Mara was never real.")
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Mara", "category": "character", "description": "first\nsecond"},
        )

        response, _ = self.callLorebookUpdate(
            story, chapter, updates=[{"action": "delete", "name": "Mara"}]
        )

        payload = response.json()
        hideRow, summaryRow = payload["history"]
        #nothing was deleted so the label names the include/exclude toggle that undoes it
        self.assertTrue(hideRow["label"].endswith("excluded Mara from context"))
        self.assertEqual(hideRow["kind"], "lore_hide")
        self.assertEqual(summaryRow["kind"], "lore_summary")
        #a hide moves no content, so it stays out of the run totals
        self.assertEqual(summaryRow["words_added"], 0)
        self.assertEqual(summaryRow["words_removed"], 0)

    def test_manual_lorebook_update_soft_deletes_retired_entries(self):
        story, chapter = self.storyWithChapter("Retired Lore", "The Blackwall had been torn down.")
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "The Blackwall", "category": "location", "description": "still stands"},
        )

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[{"action": "delete", "name": "The Blackwall", "category": "location"}],
        )

        payload = response.json()
        self.assertEqual([update["action"] for update in payload["applied"]], ["delete"])
        self.assertTrue(any(
            entry["label"].endswith("excluded The Blackwall from context")
            for entry in payload["history"]
        ))

        row = self.lorebookRow(story, "The Blackwall")
        self.assertIsNotNone(row)
        self.assertEqual(row["disabled"], 1)
        self.assertEqual(row["description"], "still stands")

        with main.get_db() as conn:
            storyRow = conn.execute(
                "SELECT * FROM stories WHERE id = ?", (story["id"],)
            ).fetchone()
            chapterRow = conn.execute(
                "SELECT * FROM chapters WHERE id = ?", (chapter["id"],)
            ).fetchone()
            loreRows = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ?", (story["id"],)
            ).fetchall()

        context = build_story_messages(storyRow, chapterRow, loreRows, "continue", "")[-2]["content"]
        self.assertNotIn("still stands", context)

    def test_manual_lorebook_update_refuses_to_delete_the_timeline(self):
        story, chapter = self.storyWithChapter("Timeline Guard", "Nothing much happened.")
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Timeline", "category": "timeline", "description": "- the bells rang"},
        )

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[{"action": "delete", "name": "Timeline", "category": "timeline"}],
        )

        self.assertEqual(response.json()["applied"], [])
        self.assertEqual(self.lorebookRow(story, "Timeline")["disabled"], 0)

    def test_manual_lorebook_update_ignores_a_delete_for_an_unknown_name(self):
        story, chapter = self.storyWithChapter("Unknown Delete", "A quiet afternoon.")

        response, _ = self.callLorebookUpdate(
            story,
            chapter,
            updates=[{"action": "delete", "name": "Nobody", "category": "character"}],
        )

        payload = response.json()
        self.assertEqual(payload["applied"], [])
        self.assertEqual([entry["category"] for entry in payload["entries"]], ["synopsis"])

        #a run that changes nothing still belongs in the log
        labels = [entry["label"] for entry in payload["history"]]
        self.assertEqual(len(labels), 1)
        self.assertIn("found no Lorebook changes after", labels[0])

    def test_manual_lorebook_update_rejects_a_missing_chapter(self):
        story, _ = self.storyWithChapter("Missing Chapter", "text")

        response, _ = self.callLorebookUpdate(story, {"id": str(uuid.uuid4())})

        self.assertEqual(response.status_code, 404)

    def test_lorebook_auto_defaults_off_and_round_trips_through_patch(self):
        story, _ = self.storyWithChapter("Auto Setting", "text")
        self.assertFalse(story["lorebook_auto"])

        patched = self.client.patch(
            f"/api/stories/{story['id']}", json={"lorebook_auto": True}
        )
        self.assertEqual(patched.status_code, 200)
        self.assertTrue(patched.json()["story"]["lorebook_auto"])

        self.assertTrue(self.client.get(f"/api/stories/{story['id']}").json()["story"]["lorebook_auto"])
        with main.get_db() as conn:
            row = conn.execute(
                "SELECT lorebook_auto FROM stories WHERE id = ?", (story["id"],)
            ).fetchone()
        self.assertEqual(row["lorebook_auto"], 1)

    def test_write_history_entry_records_the_chapter_word_diff(self):
        story, chapter = self.storyWithChapter("Diff Stats", "Chloe waited by the gate.")

        response, _ = self.streamChapterGeneration(
            story, chapter, "She crossed the bridge at dusk.", mode="new"
        )

        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines() if line]
        wrote = [
            event["value"]
            for event in events
            if event["type"] == "history" and "wrote for" in event["value"]["label"]
        ][0]

        #"She crossed the bridge at dusk." arrives whole and nothing is lost
        self.assertEqual(wrote["words_added"], 6)
        self.assertEqual(wrote["words_removed"], 0)

        prompt = [
            event["value"]
            for event in events
            if event["type"] == "history" and event["value"]["label"] == "User prompt"
        ][0]
        self.assertIsNone(prompt["words_added"])

    def test_write_history_scores_a_replacement_by_words_not_whole_paragraphs(self):
        story, chapter = self.storyWithChapter(
            "Replace Stats", "first paragraph\n\nsecond paragraph"
        )
        blocks = chapter_blocks(chapter["content"])
        operation = {
            "operation": "replaceBlock",
            "chapterRevision": chapter["revision"],
            "blockId": blocks[1]["blockId"],
            "anchorText": blocks[1]["anchorText"],
            "newText": "second paragraph rewritten",
        }

        response, _ = self.streamChapterGeneration(story, chapter, json.dumps(operation))

        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines() if line]
        wrote = [
            event["value"]
            for event in events
            if event["type"] == "history" and "wrote for" in event["value"]["label"]
        ][0]
        #one word was appended to the paragraph, so it scores 1 rather than the whole paragraph twice over
        self.assertEqual((wrote["words_added"], wrote["words_removed"]), (1, 0))

    def test_generation_leaves_the_lorebook_alone_when_updates_are_manual(self):
        story, chapter = self.storyWithChapter("Manual Mode", "Chloe waited by the gate.")

        response, _ = self.streamChapterGeneration(
            story, chapter, "She crossed the bridge at dusk.", mode="new"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.lastLorebookCalls, [])

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("lorebook", [event["type"] for event in events])
        labels = [
            event["value"]["label"] for event in events if event["type"] == "history"
        ]
        self.assertFalse(any("Lorebook" in label for label in labels))

    def test_generation_updates_the_lorebook_when_updates_are_auto(self):
        story, chapter = self.storyWithChapter("Auto Mode", "Chloe waited by the gate.")
        self.client.patch(f"/api/stories/{story['id']}", json={"lorebook_auto": True})

        response, _ = self.streamChapterGeneration(
            story,
            chapter,
            "She crossed the bridge at dusk.",
            mode="new",
            lorebookUpdates=[
                {
                    "action": "create",
                    "name": "Chloe",
                    "category": "character",
                    "description": "waits by the gate",
                }
            ],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.lastLorebookCalls), 1)

        #auto sends the whole saved chapter, not just the sentence that was generated
        prose = json.loads(self.lastLorebookCalls[0]["messages"][-1]["content"])["new_prose"]
        self.assertIn("Chloe waited by the gate.", prose)
        self.assertIn("She crossed the bridge at dusk.", prose)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertIn("lorebook", [event["type"] for event in events])
        labels = [
            event["value"]["label"] for event in events if event["type"] == "history"
        ]
        self.assertTrue(any(label.endswith("added Chloe to Lorebook") for label in labels))
        self.assertTrue(any("finished editing Lorebook after" in label for label in labels))

        entries = self.client.get(f"/api/stories/{story['id']}/lorebook").json()["entries"]
        self.assertIn("Chloe", [entry["name"] for entry in entries])

        with main.get_db() as conn:
            run = conn.execute(
                "SELECT * FROM lorebook_update_runs WHERE story_id = ?", (story["id"],)
            ).fetchone()
        self.assertIsNotNone(run["generation_id"]) #an auto run is tied to the generation that caused it

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

    def test_lorebook_revisions_use_compare_and_swap(self):
        story = self.client.post("/api/stories", json={"title": "Lore Revision"}).json()["story"]
        entry = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Mara", "category": "character", "description": "old fact"},
        ).json()["entry"]
        self.assertEqual(entry["revision"], 0)

        saved = self.client.patch(
            f"/api/stories/{story['id']}/lorebook/{entry['id']}",
            json={**entry, "description": "new fact", "revision": 0},
        )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["entry"]["revision"], 1)

        stale = self.client.patch(
            f"/api/stories/{story['id']}/lorebook/{entry['id']}",
            json={**entry, "description": "stale fact", "revision": 0},
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"]["code"], "lorebook_revision_conflict")
        self.assertEqual(stale.json()["detail"]["entry"]["description"], "new fact")

    def test_lorebook_revision_migration_is_idempotent(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            CREATE TABLE lorebook_entries (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL
            )
            """
        )
        main.ensure_lorebook_revision_column(conn)
        main.ensure_lorebook_revision_column(conn)
        columns = [row["name"] for row in conn.execute("PRAGMA table_info(lorebook_entries)")]
        self.assertEqual(columns.count("revision"), 1)
        conn.close()

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

        failure_client = TestClient(
            main.app,
            base_url=self.baseUrl,
            headers={"Origin": self.baseUrl, "Sec-Fetch-Site": "same-origin"},
            raise_server_exceptions=False,
        )
        failure_client.cookies.update(self.client.cookies)
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
            "anchorText": "first paragraph",
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
        self.assertNotIn("lorebook", [event["type"] for event in events])

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
            "startAnchorText": "old one",
            "endBlockId": "p_003",
            "endAnchorText": "old two",
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
        self.assertEqual(updateEvent["value"]["edits"][0]["deletedBlockIds"], ["p_002", "s_001", "p_003"])
        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["revision"], 1)
        self.assertEqual(persisted["content"], updateEvent["value"]["chapter"]["content"])

    def test_a_partly_bad_batch_commits_the_good_edits_and_offers_a_repair(self):
        story = self.client.post("/api/stories", json={"title": "Partial Edit"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "first line\n\nsecond line\n\nthird line"},
        ).json()["chapter"]
        batch = json.dumps({
            "chapterRevision": chapter["revision"],
            "edits": [
                {
                    "operation": "replaceBlock",
                    "blockId": "p_001",
                    "anchorText": "first line",
                    "newText": "first rewritten",
                },
                {
                    "operation": "replaceBlock",
                    "blockId": "p_002",
                    "anchorText": "a line that is nowhere in this chapter",
                    "newText": "never lands",
                },
            ],
        })

        response, _ = self.streamChapterGeneration(story, chapter, batch)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        updateEvent = next(event for event in events if event["type"] == "chapter_updated")
        self.assertEqual(
            updateEvent["value"]["chapter"]["content"],
            "first rewritten\n\nsecond line\n\nthird line",
        )
        self.assertEqual(len(updateEvent["value"]["edits"]), 1)
        self.assertEqual(len(updateEvent["value"]["rejected"]), 1)
        self.assertTrue(updateEvent["value"]["repairable"])
        self.assertNotIn("never lands", updateEvent["value"]["chapter"]["content"])

        #the good edit is committed before anyone is asked about a retry, so declining can never cost it
        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["revision"], 1)
        self.assertEqual(persisted["content"], "first rewritten\n\nsecond line\n\nthird line")

    def test_a_truncated_batch_reports_itself_even_though_nothing_was_rejected(self):
        #found by hand against a real model: the complete edits applied silently and the run looked clean, because the edits it never got to write were never rejects to count
        story = self.client.post("/api/stories", json={"title": "Truncated"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "first line\n\nsecond line\n\nthird line"},
        ).json()["chapter"]
        full = json.dumps({
            "chapterRevision": chapter["revision"],
            "edits": [
                {
                    "operation": "replaceBlock",
                    "blockId": "p_001",
                    "anchorText": "first line",
                    "newText": "first rewritten",
                },
                {
                    "operation": "replaceBlock",
                    "blockId": "p_002",
                    "anchorText": "second line",
                    "newText": "second rewritten",
                },
            ],
        })
        cutOff = full[:full.rindex("second rewritten") + 6]

        response, _ = self.streamChapterGeneration(story, chapter, cutOff)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        updateEvent = next(event for event in events if event["type"] == "chapter_updated")
        self.assertEqual(updateEvent["value"]["rejected"], [])
        self.assertTrue(updateEvent["value"]["truncated"])
        self.assertTrue(updateEvent["value"]["repairable"])
        self.assertEqual(len(updateEvent["value"]["edits"]), 1)
        self.assertEqual(
            updateEvent["value"]["chapter"]["content"],
            "first rewritten\n\nsecond line\n\nthird line",
        )

        historyEvents = [event for event in events if event["type"] == "history"]
        historyLabels = [event["value"]["label"] for event in historyEvents]
        self.assertTrue(any(label.endswith("applied 1 edit before the token limit") for label in historyLabels))
        self.assertFalse(any("1 edits" in label for label in historyLabels))

    def test_a_repair_run_sends_the_failure_back_and_never_offers_another(self):
        story = self.client.post("/api/stories", json={"title": "Repair"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "first line\n\nsecond line"},
        ).json()["chapter"]
        repairContext = {
            "previous_output": "{\"operation\": \"appendToChapter\"}",
            "errors": ["missing fields: newText"],
            "failed_edits": [{"operation": "appendToChapter"}],
            "applied_count": 1,
        }

        response, requestBody = self.streamChapterGeneration(
            story,
            chapter,
            "still not json",
            repairContext=repairContext,
        )

        prompts = "\n".join(message["content"] for message in requestBody["messages"])
        self.assertIn("could not be applied", prompts)
        self.assertIn("missing fields: newText", prompts)
        self.assertIn("1 of your edits did apply", prompts)
        self.assertIn(repairContext["previous_output"], prompts)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        errorEvent = next(event for event in events if event["type"] == "error")
        #a repair that fails again is the end of the road, otherwise this loops and quietly bills someone
        self.assertFalse(errorEvent["value"]["repairable"])

    def test_invalid_edit_output_is_stored_and_does_not_mutate_chapter(self):
        story = self.client.post("/api/stories", json={"title": "Invalid Edit"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "unchanged"},
        ).json()["chapter"]
        #the prose wrapper is no longer fatal, this one dies on the genuinely missing newText instead
        rawOutput = "here is the edit: {\"operation\": \"appendToChapter\"}"

        response, _ = self.streamChapterGeneration(story, chapter, rawOutput)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("chapter_updated", [event["type"] for event in events])
        self.assertNotIn("lorebook", [event["type"] for event in events])
        errorEvents = [event for event in events if event["type"] == "error"]
        self.assertEqual(errorEvents[0]["value"]["code"], "chapter_edit_invalid_operation")
        self.assertTrue(errorEvents[0]["value"]["repairable"])
        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["content"], "unchanged")
        self.assertEqual(persisted["revision"], 0)
        with main.get_db() as conn:
            generation = conn.execute(
                "SELECT generated_text, error FROM story_generations WHERE chapter_id = ?",
                (chapter["id"],),
            ).fetchone()
        self.assertEqual(generation["generated_text"], rawOutput)
        self.assertTrue(generation["error"].startswith("chapter_edit_invalid_operation"))

    def test_malformed_edit_prose_is_repaired_and_saved(self):
        story = self.client.post("/api/stories", json={"title": "Malformed Edit"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "The room was quiet."},
        ).json()["chapter"]
        rawOutput = json.dumps({
            "chapterRevision": chapter["revision"],
            "edits": [{
                "operation": "replaceBlock",
                "blockId": "p_001",
                "anchorText": "The room was quiet.",
                "newText": ["The room went dark.She reached for the lamp."],
            }],
        })

        response, _ = self.streamChapterGeneration(story, chapter, rawOutput)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("error", [event["type"] for event in events])

        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["content"], "The room went dark. She reached for the lamp.")
        self.assertEqual(persisted["revision"], 1)

    def test_paragraph_array_edits_are_saved_with_blank_lines_between_them(self):
        story = self.client.post("/api/stories", json={"title": "Paragraph Array"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "The room was quiet."},
        ).json()["chapter"]
        rawOutput = json.dumps({
            "chapterRevision": chapter["revision"],
            "edits": [{
                "operation": "replaceBlock",
                "blockId": "p_001",
                "anchorText": "The room was quiet.",
                "newText": ["The room went dark.", "She reached for the lamp."],
            }],
        })

        response, _ = self.streamChapterGeneration(story, chapter, rawOutput)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("error", [event["type"] for event in events])

        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["content"], "The room went dark.\n\nShe reached for the lamp.")

    def test_long_unbroken_edit_prose_is_split_into_paragraphs_before_saving(self):
        story = self.client.post("/api/stories", json={"title": "Paragraph Backup"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "The room was quiet."},
        ).json()["chapter"]
        prose = " ".join(
            f"Sentence {index} carries enough ordinary words to resemble generated prose."
            for index in range(40)
        )
        rawOutput = json.dumps({
            "chapterRevision": chapter["revision"],
            "edits": [{
                "operation": "replaceBlock",
                "blockId": "p_001",
                "anchorText": "The room was quiet.",
                "newText": prose,
            }],
        })

        response, _ = self.streamChapterGeneration(story, chapter, rawOutput)

        events = [json.loads(line) for line in response.text.splitlines() if line]
        updateEvent = next(event for event in events if event["type"] == "chapter_updated")
        savedContent = updateEvent["value"]["chapter"]["content"]
        self.assertIn("\n\n", savedContent)
        self.assertEqual(savedContent.replace("\n\n", " "), prose)
        self.assertEqual(updateEvent["value"]["chapter"]["revision"], 1)

    def test_incomplete_stream_saves_partial_chapter_text_in_new_mode(self):
        #a dropped connection still has good prose in it in append mode, so it gets kept instead of thrown away
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
        self.assertNotIn("error", [event["type"] for event in events])
        updateEvent = next(event for event in events if event["type"] == "chapter_updated")
        self.assertEqual(
            updateEvent["value"]["chapter"]["content"],
            "saved text\n\npartial provider output",
        )
        self.assertTrue(updateEvent["value"]["truncated"])
        self.assertFalse(updateEvent["value"]["repairable"])

        historyEvents = [event for event in events if event["type"] == "history"]
        historyLabels = [event["value"]["label"] for event in historyEvents]
        self.assertTrue(any(label.endswith("before the connection dropped") for label in historyLabels))
        self.assertFalse(any("could not" in label for label in historyLabels))

        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["content"], "saved text\n\npartial provider output")
        with main.get_db() as conn:
            generation = conn.execute(
                "SELECT generated_text, error FROM story_generations WHERE chapter_id = ?",
                (chapter["id"],),
            ).fetchone()
        self.assertEqual(generation["generated_text"], "partial provider output")
        self.assertEqual(generation["error"], "generation_incomplete_stream")

    def test_a_finish_reason_without_a_done_line_still_completes_the_stream(self):
        #some providers drop the connection right after their last real chunk and never send the trailing [DONE] line
        story = self.client.post("/api/stories", json={"title": "No Done Line"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": ""},
        ).json()["chapter"]

        response, _ = self.streamChapterGeneration(
            story,
            chapter,
            "a full chapter's worth of prose",
            mode="new",
            complete=False,
            finishReason="stop",
        )

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("error", [event["type"] for event in events])
        updateEvent = next(event for event in events if event["type"] == "chapter_updated")
        self.assertEqual(updateEvent["value"]["chapter"]["content"], "a full chapter's worth of prose")
        self.assertFalse(updateEvent["value"]["truncated"])
        with main.get_db() as conn:
            generation = conn.execute(
                "SELECT finish_reason, error FROM story_generations WHERE chapter_id = ?",
                (chapter["id"],),
            ).fetchone()
        self.assertEqual(generation["finish_reason"], "stop")
        self.assertIsNone(generation["error"])

    def test_incomplete_stream_saves_the_paragraphs_the_edit_had_finished(self):
        #a dropped connection used to throw away every finished paragraph, one real run lost 140,982 characters that way
        story = self.client.post("/api/stories", json={"title": "Salvaged Edit"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "first line"},
        ).json()["chapter"]

        response, _ = self.streamChapterGeneration(
            story,
            chapter,
            "{\"chapterRevision\": 0, \"edits\": [{\"operation\": \"appendToChapter\", "
            "\"newText\": [\"A finished paragraph.\", \"Another finished one.\", \"And a third still be",
            mode="edit",
            complete=False,
        )

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("error", [event["type"] for event in events])
        updateEvent = next(event for event in events if event["type"] == "chapter_updated")
        self.assertEqual(
            updateEvent["value"]["chapter"]["content"],
            "first line\n\nA finished paragraph.\n\nAnother finished one.",
        )
        self.assertTrue(updateEvent["value"]["truncated"])
        self.assertTrue(updateEvent["value"]["repairable"])
        self.assertNotIn("still be", updateEvent["value"]["chapter"]["content"])

        historyLabels = [
            event["value"]["label"] for event in events if event["type"] == "history"
        ]
        self.assertTrue(any(label.endswith("before the run stopped") for label in historyLabels))

        persisted = self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]
        self.assertEqual(persisted["revision"], 1)
        self.assertEqual(
            persisted["content"],
            "first line\n\nA finished paragraph.\n\nAnother finished one.",
        )

    def test_incomplete_stream_still_fails_closed_when_no_prose_arrived(self):
        #nothing usable had streamed yet, so there is nothing to salvage and the run has to stay a failure
        story = self.client.post("/api/stories", json={"title": "Incomplete Edit Stream"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "unchanged"},
        ).json()["chapter"]

        response, _ = self.streamChapterGeneration(
            story,
            chapter,
            "{\"chapterRevision\": 0, \"edits\": [{\"operation\": \"appendToChapter\"",
            mode="edit",
            complete=False,
        )

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertNotIn("chapter_updated", [event["type"] for event in events])
        errorEvents = [event for event in events if event["type"] == "error"]
        #being told the response was cut off beats being told the stream ended, and it is the one that offers a retry
        self.assertEqual(errorEvents[0]["value"]["code"], "chapter_edit_truncated")
        self.assertTrue(errorEvents[0]["value"]["repairable"])
        self.assertEqual(self.client.get(f"/api/stories/{story['id']}").json()["chapters"][0]["content"], "unchanged")
        with main.get_db() as conn:
            generation = conn.execute(
                "SELECT error FROM story_generations WHERE chapter_id = ?",
                (chapter["id"],),
            ).fetchone()
        self.assertTrue(generation["error"].startswith("chapter_edit_truncated"))

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
            "anchorText": "a totally different paragraph",
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

    def test_story_routes_are_registered_from_feature_modules(self):
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

        #story features own their routes, main only wires the pieces together
        self.assertTrue(storyRoutes)
        self.assertEqual(
            routeModules,
            {
                "backend.writing",
                "backend.brainstorm",
                "backend.lorebook",
                "backend.lorebook_repair",
                "backend.lorebook_generate",
            },
        )

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

    def test_openrouter_headers_use_the_public_routerchat_identity(self):
        self.assertEqual(
            main.headers_for_key("test-key"),
            {
                "Authorization": "Bearer test-key",
                "HTTP-Referer": "https://echo1097.github.io/get-routerchat/",
                "X-OpenRouter-Title": "RouterChat",
                "X-Title": "RouterChat",
            },
        )

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
        self.assertEqual(
            main.enabled_reasoning_config("test/mandatory", False, "xhigh"),
            {"enabled": True, "exclude": False, "effort": "high"},
        )
        self.assertEqual(main.coerce_reasoning_effort("xhigh"), "max")
        self.assertEqual(
            main.resolved_reasoning_effort("test/mandatory", "low"), "medium"
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

    def test_multi_line_lorebook_entries_stay_nested_in_context(self):
        story = self.client.post("/api/stories", json={"title": "Nested Lore"}).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "First", "content": "the bells stop"},
        ).json()["chapter"]
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Timeline",
                "category": "timeline",
                "description": "- the bells rang\n- Chloe left the hall",
            },
        )
        self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={"name": "Chloe", "category": "character", "description": "A smith."},
        )

        with main.get_db() as conn:
            storyRow = conn.execute("SELECT * FROM stories WHERE id = ?", (story["id"],)).fetchone()
            chapterRow = conn.execute(
                "SELECT * FROM chapters WHERE id = ?", (chapter["id"],)
            ).fetchone()
            loreRows = conn.execute(
                "SELECT * FROM lorebook_entries WHERE story_id = ? ORDER BY created_at ASC",
                (story["id"],),
            ).fetchall()

        context = build_story_messages(storyRow, chapterRow, loreRows, "continue", "")[-2]["content"]

        #every top level bullet must be a real entry, timeline bullets stay indented under theirs
        topLevel = [
            line for line in context.splitlines()
            if line.startswith("- ") and "(" in line and "):" in line
        ]
        self.assertEqual(len(topLevel), 2)
        self.assertIn("  - Chloe left the hall", context)
        self.assertNotIn("\n- Chloe left the hall", context)

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
        with self.assertRaisesRegex(ValueError, "must be an object"):
            parse_brainstorm_ideas('{"ideas": ["not an idea"]}')
        with self.assertRaisesRegex(ValueError, "must include a title and content"):
            parse_brainstorm_ideas('{"ideas": [{"title": "missing content"}]}')

    def test_brainstorm_schema_requires_the_exact_requested_count(self):
        schema = brainstorm_response_format(7)["json_schema"]["schema"]
        ideas = schema["properties"]["ideas"]

        self.assertEqual(ideas["minItems"], 7)
        self.assertEqual(ideas["maxItems"], 7)
        self.assertFalse(schema["additionalProperties"])
        self.assertFalse(ideas["items"]["additionalProperties"])
        self.assertEqual(ideas["items"]["required"], ["title", "content"])

    def test_brainstorm_rejects_truncated_and_incomplete_streams_without_ideas(self):
        output = json.dumps({
            "ideas": [
                {"title": "one", "content": "first path"},
                {"title": "two", "content": "second path"},
                {"title": "three", "content": "third path"},
            ]
        })
        cases = [
            (
                "truncated",
                "length",
                "Brainstorm generation hit the model token limit before it finished.",
            ),
            (
                "incomplete",
                "stop",
                "Brainstorm generation ended before the provider completed the stream.",
            ),
        ]

        for label, finishReason, expectedError in cases:
            with self.subTest(label=label):
                story = self.client.post(
                    "/api/stories",
                    json={"title": f"Brainstorm {label}"},
                ).json()["story"]
                response, _ = self.callBrainstormWithStreamState(
                    story,
                    output,
                    complete=False,
                    finishReason=finishReason,
                )
                events = [json.loads(line) for line in response.text.splitlines() if line]
                self.assertEqual(events[-1], {"type": "error", "value": expectedError})

                graph = self.client.get(f"/api/stories/{story['id']}/brainstorm").json()
                self.assertEqual(len(graph["nodes"]), 1)
                self.assertEqual(graph["nodes"][0]["status"], "failed")
                self.assertEqual(graph["edges"], [])
                with main.get_db() as conn:
                    run = conn.execute(
                        "SELECT * FROM brainstorm_generations WHERE story_id = ?",
                        (story["id"],),
                    ).fetchone()
                self.assertEqual(run["finish_reason"], finishReason)
                self.assertEqual(run["error"], expectedError)

    def test_brainstorm_plain_model_rejects_extra_ideas_instead_of_slicing(self):
        story = self.client.post(
            "/api/stories",
            json={"title": "Too many ideas"},
        ).json()["story"]
        output = json.dumps({
            "ideas": [
                {"title": str(index), "content": f"path {index}"}
                for index in range(4)
            ]
        })
        response, requestBody = self.callBrainstormWithStreamState(
            story,
            output,
            ideaCount=3,
            supportedParameters=[],
        )

        self.assertNotIn("response_format", requestBody)
        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(
            events[-1],
            {
                "type": "error",
                "value": "Brainstorm output returned 4 ideas instead of 3.",
            },
        )
        graph = self.client.get(f"/api/stories/{story['id']}/brainstorm").json()
        self.assertEqual(len(graph["nodes"]), 1)
        self.assertEqual(graph["nodes"][0]["status"], "failed")
        self.assertEqual(graph["edges"], [])

    def test_brainstorm_generation_saves_complete_branch_atomically(self):
        main.cache_models([main.normalize_model({
            "id": "test/model",
            "supported_parameters": ["reasoning", "structured_outputs"],
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
                yield f"data: {json.dumps({'choices': [{'delta': {'reasoning': 'First inspect the signal. '}}]})}"
                yield f"data: {json.dumps({'choices': [{'delta': {'reasoning_content': 'Then split the outcomes.'}}]})}"
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
            "backend.brainstorm.httpx.AsyncClient", FakeClient
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
        self.assertEqual(requestBody["response_format"], brainstorm_response_format(3))
        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(
            [event["type"] for event in events],
            ["prompt", "reasoning", "reasoning", "working", "ideas"],
        )
        self.assertEqual(events[0]["value"]["node"]["position_x"], 0)
        self.assertEqual(events[0]["value"]["node"]["position_y"], 180)
        self.assertEqual(
            events[0]["value"]["node"]["generation_phase"],
            "thinking",
        )
        graph = self.client.get(f"/api/stories/{story['id']}/brainstorm").json()
        self.assertEqual(len(graph["nodes"]), 4)
        self.assertEqual(len(graph["edges"]), 3)
        self.assertEqual(
            [node["status"] for node in graph["nodes"] if node["node_type"] == "prompt"],
            ["complete"],
        )
        savedPrompt = next(
            node for node in graph["nodes"] if node["node_type"] == "prompt"
        )
        self.assertEqual(
            savedPrompt["reasoning"],
            "First inspect the signal. Then split the outcomes.",
        )
        self.assertGreater(savedPrompt["duration_ms"], 0)
        self.assertGreater(events[-1]["value"]["duration_ms"], 0)
        self.assertTrue(all(
            node["reasoning"] is None
            for node in graph["nodes"]
            if node["node_type"] == "idea"
        ))

        selectedIdea = next(
            node for node in graph["nodes"] if node["node_type"] == "idea"
        )
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch(
            "backend.brainstorm.httpx.AsyncClient", FakeClient
        ):
            branchResponse = self.client.post(
                f"/api/stories/{story['id']}/brainstorm/generate/stream",
                json={
                    "message": "branch from this idea",
                    "model": "test/model",
                    "max_tokens": 1000,
                    "selected_idea_ids": [selectedIdea["id"]],
                },
            )

        branchEvents = [
            json.loads(line) for line in branchResponse.text.splitlines() if line
        ]
        branchPrompt = branchEvents[0]["value"]["node"]
        self.assertEqual(
            branchPrompt["position_x"],
            selectedIdea["position_x"] + 390,
        )
        self.assertEqual(branchPrompt["position_y"], selectedIdea["position_y"])

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
            "backend.brainstorm.httpx.AsyncClient", FakeClient
        ):
            response = self.client.post(
                f"/api/stories/{story['id']}/brainstorm/generate/stream",
                json={"message": "give me ideas", "model": "test/model", "selected_idea_ids": []},
            )

        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(
            [event["type"] for event in events],
            ["prompt", "working", "error"],
        )
        self.assertEqual(
            events[0]["value"]["node"]["generation_phase"],
            "working",
        )
        graph = self.client.get(f"/api/stories/{story['id']}/brainstorm").json()
        self.assertEqual(len(graph["nodes"]), 1)
        self.assertEqual(graph["nodes"][0]["status"], "failed")
        self.assertIsNone(graph["nodes"][0]["reasoning"])
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
        self.assertEqual(
            lorebook_history_label(modelLabel, {"action": "delete", "name": "The Blackwall"}),
            "Glm 5.2 excluded The Blackwall from context",
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

    def test_story_export_and_import_preserve_the_portable_workspace(self):
        story = self.client.post(
            "/api/stories",
            json={
                "title": "Portable story",
                "author": "Echo",
                "synopsis": "A story worth moving.",
                "model": "test/model",
                "lorebook_auto": True,
            },
        ).json()["story"]
        chapter = self.client.post(
            f"/api/stories/{story['id']}/chapters",
            json={"title": "Opening", "content": "one two three"},
        ).json()["chapter"]
        lorebook = self.client.post(
            f"/api/stories/{story['id']}/lorebook",
            json={
                "name": "Mara",
                "category": "character",
                "description": "The protagonist.",
                "aliases": ["Captain Mara"],
                "tags": ["lead"],
            },
        ).json()["entry"]

        now = "2026-02-03T04:05:06+00:00"
        with main.get_db() as conn:
            conn.execute(
                "UPDATE lorebook_entries SET revision = 7 WHERE id = ?",
                (lorebook["id"],),
            )
            conn.execute(
                """
                INSERT INTO chapter_history_entries (
                  id, story_id, chapter_id, run_id, label, detail, entry_order,
                  kind, words_added, words_removed, cost, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "history-source",
                    story["id"],
                    chapter["id"],
                    "run-source",
                    "User prompt",
                    "Make it stormier",
                    0,
                    "user_prompt",
                    3,
                    1,
                    0.42,
                    now,
                ),
            )
            conn.execute(
                """
                INSERT INTO brainstorm_nodes (
                  id, story_id, node_type, title, content, position_x,
                  position_y, status, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("node-a", story["id"], "prompt", "Question", "What if?", 10, 20, "complete", now, now),
            )
            conn.execute(
                """
                INSERT INTO brainstorm_nodes (
                  id, story_id, node_type, title, content, position_x,
                  position_y, status, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("node-b", story["id"], "idea", "Answer", "A storm.", 300, 20, "complete", now, now),
            )
            conn.execute(
                """
                INSERT INTO brainstorm_edges (
                  id, story_id, source_node_id, target_node_id, created_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                ("edge-source", story["id"], "node-a", "node-b", now),
            )
            conn.execute(
                """
                INSERT INTO brainstorm_viewports (
                  story_id, position_x, position_y, zoom, updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (story["id"], 42, -18, 1.4, now),
            )

        exportResponse = self.client.get(f"/api/stories/{story['id']}/export")
        self.assertEqual(exportResponse.status_code, 200)
        archive = exportResponse.json()
        self.assertEqual(archive["schema"], "routerchat.story.v1")
        self.assertEqual(archive["story"]["title"], "Portable story")
        self.assertNotIn("temporary", archive["story"])
        self.assertEqual(archive["chapters"][0]["content"], "one two three")
        self.assertEqual(archive["lorebook"][0]["id"], lorebook["id"])
        self.assertEqual(archive["lorebook"][0]["revision"], 7)
        self.assertEqual(archive["chapter_history"][0]["words_added"], 3)
        self.assertNotIn("cost", archive["chapter_history"][0])
        self.assertNotIn("reasoning", archive["brainstorm"]["nodes"][0])
        self.assertEqual(archive["brainstorm"]["viewport"], {"x": 42, "y": -18, "zoom": 1.4})
        self.assertNotIn("generations", archive)

        firstImport = self.client.post("/api/stories/import", json=archive)
        secondImport = self.client.post("/api/stories/import", json=archive)
        self.assertEqual(firstImport.status_code, 200)
        self.assertEqual(secondImport.status_code, 200)
        imported = firstImport.json()
        self.assertNotEqual(imported["story_id"], story["id"])
        self.assertNotEqual(imported["first_chapter_id"], chapter["id"])

        importedBundle = self.client.get(f"/api/stories/{imported['story_id']}").json()
        self.assertEqual(importedBundle["story"]["title"], "Portable story")
        self.assertFalse(importedBundle["story"]["temporary"])
        self.assertEqual(importedBundle["chapters"][0]["word_count"], 3)
        self.assertEqual(importedBundle["chapters"][0]["history"][0]["detail"], "Make it stormier")
        self.assertIsNone(importedBundle["chapters"][0]["history"][0]["cost"])
        self.assertEqual(importedBundle["lorebook"][0]["name"], "Mara")
        self.assertEqual(importedBundle["lorebook"][0]["revision"], 7)

        importedGraph = self.client.get(
            f"/api/stories/{imported['story_id']}/brainstorm"
        ).json()
        self.assertEqual(len(importedGraph["nodes"]), 2)
        self.assertEqual(len(importedGraph["edges"]), 1)
        importedNodeIds = {node["id"] for node in importedGraph["nodes"]}
        self.assertTrue(importedNodeIds.isdisjoint({"node-a", "node-b"}))
        self.assertIn(importedGraph["edges"][0]["source_node_id"], importedNodeIds)
        self.assertIn(importedGraph["edges"][0]["target_node_id"], importedNodeIds)
        self.assertEqual(importedGraph["viewport"], {"x": 42, "y": -18, "zoom": 1.4})

        stories = self.client.get("/api/stories").json()["stories"]
        self.assertEqual(sum(item["title"] == "Portable story" for item in stories), 3)

    def test_story_import_rejects_invalid_archives_without_creating_a_story(self):
        baseArchive = {
            "schema": "routerchat.story.v1",
            "story": {"id": "story-source", "title": "Bad import"},
            "chapters": [],
            "chapter_history": [],
            "lorebook": [],
            "brainstorm": {"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}},
        }
        before = len(self.client.get("/api/stories").json()["stories"])

        unsupported = self.client.post(
            "/api/stories/import",
            json={**baseArchive, "schema": "routerchat.story.v99"},
        )
        self.assertEqual(unsupported.status_code, 422)

        duplicateChapter = {
            "id": "chapter-source",
            "story_id": "story-source",
            "title": "One",
        }
        duplicateResponse = self.client.post(
            "/api/stories/import",
            json={**baseArchive, "chapters": [duplicateChapter, duplicateChapter]},
        )
        self.assertEqual(duplicateResponse.status_code, 422)
        self.assertIn("duplicate chapter IDs", duplicateResponse.json()["detail"])

        orphanedEdgeResponse = self.client.post(
            "/api/stories/import",
            json={
                **baseArchive,
                "brainstorm": {
                    "nodes": [],
                    "edges": [{
                        "id": "edge-source",
                        "story_id": "story-source",
                        "source_node_id": "missing-a",
                        "target_node_id": "missing-b",
                    }],
                    "viewport": {"x": 0, "y": 0, "zoom": 1},
                },
            },
        )
        self.assertEqual(orphanedEdgeResponse.status_code, 422)
        self.assertIn("orphaned brainstorm edge", orphanedEdgeResponse.json()["detail"])

        after = len(self.client.get("/api/stories").json()["stories"])
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
