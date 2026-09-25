from __future__ import annotations

import sqlite3

from backend.core.database import next_message_order


def ensureCachedTokenColumns(conn: sqlite3.Connection) -> None:
    for table in ("messages", "story_generations", "brainstorm_generations"):
        existingColumns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if "cached_tokens" not in existingColumns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN cached_tokens INTEGER")


def ensureGenerationSettledColumn(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"] for row in conn.execute("PRAGMA table_info(story_generations)").fetchall()
    }
    if "settled" not in existingColumns:
        conn.execute("ALTER TABLE story_generations ADD COLUMN settled INTEGER NOT NULL DEFAULT 0")


def ensure_chat_settings_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(chats)").fetchall()
    }
    if "reasoning_effort" not in existing_columns:
        conn.execute(
            "ALTER TABLE chats ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'"
        )
    if "temporary" not in existing_columns:
        conn.execute("ALTER TABLE chats ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0")
    if "pinned" not in existing_columns:
        conn.execute("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
    if "web_search_enabled" not in existing_columns:
        conn.execute(
            "ALTER TABLE chats ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0"
        )


def ensure_message_source_column(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(messages)").fetchall()
    }
    if "sources" not in existing_columns:
        conn.execute("ALTER TABLE messages ADD COLUMN sources TEXT")


def ensure_chat_folder_column(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(chats)").fetchall()
    }
    if "folder_id" not in existing_columns:
        conn.execute("ALTER TABLE chats ADD COLUMN folder_id TEXT")

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chats_folder ON chats(folder_id, updated_at DESC)"
    )


def ensure_story_settings_columns(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"] for row in conn.execute("PRAGMA table_info(stories)").fetchall()
    }
    if "temporary" not in existingColumns:
        conn.execute("ALTER TABLE stories ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0")
    if "lorebook_auto" not in existingColumns:
        conn.execute("ALTER TABLE stories ADD COLUMN lorebook_auto INTEGER NOT NULL DEFAULT 0")
    if "lorebook_model" not in existingColumns:
        #blank means the author never picked one, so the story's own model keeps doing the lorebook work
        conn.execute("ALTER TABLE stories ADD COLUMN lorebook_model TEXT NOT NULL DEFAULT ''")


def ensure_chapter_context_column(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"] for row in conn.execute("PRAGMA table_info(chapters)").fetchall()
    }
    if "disabled" not in existingColumns:
        conn.execute("ALTER TABLE chapters ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0")


def ensure_chapter_revision_column(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"] for row in conn.execute("PRAGMA table_info(chapters)").fetchall()
    }
    if "revision" not in existingColumns:
        conn.execute(
            "ALTER TABLE chapters ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
        )


def ensure_lorebook_revision_column(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"] for row in conn.execute("PRAGMA table_info(lorebook_entries)").fetchall()
    }
    if "revision" not in existingColumns:
        conn.execute(
            "ALTER TABLE lorebook_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
        )


def ensure_brainstorm_generation_columns(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(brainstorm_generations)").fetchall()
    }
    if "reasoning" not in existingColumns:
        conn.execute("ALTER TABLE brainstorm_generations ADD COLUMN reasoning TEXT")
    if "duration_ms" not in existingColumns:
        conn.execute("ALTER TABLE brainstorm_generations ADD COLUMN duration_ms REAL")


def ensure_chapter_history_columns(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(chapter_history_entries)").fetchall()
    }
    #these briefly shipped counting lines, rename rather than re-add so the counts already recorded survive
    if "lines_added" in existingColumns and "words_added" not in existingColumns:
        conn.execute(
            "ALTER TABLE chapter_history_entries RENAME COLUMN lines_added TO words_added"
        )
        existingColumns.add("words_added")
    if "lines_removed" in existingColumns and "words_removed" not in existingColumns:
        conn.execute(
            "ALTER TABLE chapter_history_entries RENAME COLUMN lines_removed TO words_removed"
        )
        existingColumns.add("words_removed")

    #nullable on purpose, history written before this feature has no numbers and a zero would be a lie
    if "words_added" not in existingColumns:
        conn.execute("ALTER TABLE chapter_history_entries ADD COLUMN words_added INTEGER")
    if "words_removed" not in existingColumns:
        conn.execute("ALTER TABLE chapter_history_entries ADD COLUMN words_removed INTEGER")
    if "cost" not in existingColumns:
        conn.execute("ALTER TABLE chapter_history_entries ADD COLUMN cost REAL")
    if "kind" not in existingColumns:
        conn.execute("ALTER TABLE chapter_history_entries ADD COLUMN kind TEXT")
        backfill_chapter_history_kinds(conn)


def backfill_chapter_history_kinds(conn: sqlite3.Connection) -> None:
    #one time pass so old rows stop leaning on the label text forever, ordered so the lorebook ones dont steal each others patterns
    rules = [
        ("prompt", "label = 'User prompt'"),
        ("thinking", "label LIKE '% thought for %'"),
        ("write", "label LIKE '% wrote for %'"),
        ("write_failed", "label LIKE '% could not apply the edit'"),
        (
            "lore_summary",
            "(label LIKE '%finished editing Lorebook after %'"
            " OR label LIKE '%found no Lorebook changes after %')",
        ),
        ("lore_hide", "label LIKE '% from Lorebook'"),
        ("lore_create", "label LIKE '% to Lorebook'"),
        ("lore_update", "(label LIKE '% in Lorebook' OR label LIKE '% updated Timeline')"),
    ]
    for kind, condition in rules:
        conn.execute(
            f"UPDATE chapter_history_entries SET kind = ? WHERE kind IS NULL AND {condition}",
            (kind,),
        )


def ensure_lorebook_run_usage_columns(conn: sqlite3.Connection) -> None:
    existingColumns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(lorebook_update_runs)").fetchall()
    }
    #generation_id was already taken by the story_generations fk so the openrouter one needs its own name
    if "openrouter_generation_id" not in existingColumns:
        conn.execute(
            "ALTER TABLE lorebook_update_runs ADD COLUMN openrouter_generation_id TEXT"
        )
    if "cost" not in existingColumns:
        conn.execute("ALTER TABLE lorebook_update_runs ADD COLUMN cost REAL")
    if "rejected_updates_json" not in existingColumns:
        conn.execute(
            "ALTER TABLE lorebook_update_runs ADD COLUMN rejected_updates_json TEXT NOT NULL DEFAULT '[]'"
        )


def clean_lorebook_categories(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        UPDATE lorebook_entries
        SET category = 'note'
        WHERE lower(category) = 'starting scenario'
        """
    )


def ensure_message_order_column(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(messages)").fetchall()
    }
    if "message_order" not in existing_columns:
        conn.execute("ALTER TABLE messages ADD COLUMN message_order INTEGER")

    chatRows = conn.execute(
        """
        SELECT DISTINCT chat_id FROM messages
        WHERE message_order IS NULL
        ORDER BY chat_id ASC
        """
    ).fetchall()
    for chatRow in chatRows:
        messageRows = conn.execute(
            """
            SELECT rowid FROM messages
            WHERE chat_id = ? AND message_order IS NULL
            ORDER BY created_at ASC, rowid ASC
            """,
            (chatRow["chat_id"],),
        ).fetchall()
        nextOrder = next_message_order(conn, chatRow["chat_id"])
        for offset, messageRow in enumerate(messageRows):
            conn.execute(
                "UPDATE messages SET message_order = ? WHERE rowid = ?",
                (nextOrder + offset, messageRow["rowid"]),
            )


def ensure_message_usage_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(messages)").fetchall()
    }
    usage_columns = {
        "generation_id": "TEXT",
        "prompt_tokens": "INTEGER",
        "completion_tokens": "INTEGER",
        "reasoning_tokens": "INTEGER",
        "total_tokens": "INTEGER",
        "cost": "REAL",
        "provider_name": "TEXT",
        "generation_time": "REAL",
        "latency": "REAL",
    }
    for column, column_type in usage_columns.items():
        if column not in existing_columns:
            conn.execute(f"ALTER TABLE messages ADD COLUMN {column} {column_type}")
