from __future__ import annotations

from backend.core.database import get_db
from backend.core.migrations import (
    clean_lorebook_categories,
    ensure_brainstorm_generation_columns,
    ensure_chapter_context_column,
    ensure_chapter_history_columns,
    ensure_chapter_revision_column,
    ensure_chat_folder_column,
    ensure_chat_settings_columns,
    ensure_lorebook_revision_column,
    ensure_lorebook_run_usage_columns,
    ensure_message_order_column,
    ensure_message_source_column,
    ensure_message_usage_columns,
    ensure_story_settings_columns,
    ensureCachedTokenColumns,
    ensureGenerationSettledColumn,
)
from backend.lorebook.lorebookUsage import ensureLorebookUsageTable
from backend.transcription.transcriptionUsage import ensureTranscriptionUsageTable


def init_db() -> None:
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS chats (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              model TEXT NOT NULL,
              system_prompt TEXT NOT NULL,
              temperature REAL NOT NULL,
              max_tokens INTEGER NOT NULL,
              thinking_enabled INTEGER NOT NULL,
              reasoning_effort TEXT NOT NULL DEFAULT 'medium',
              web_search_enabled INTEGER NOT NULL DEFAULT 0,
              temporary INTEGER NOT NULL DEFAULT 0,
              pinned INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_folders (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              chat_id TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              reasoning TEXT,
              sources TEXT,
              model TEXT,
              finish_reason TEXT,
              error TEXT,
              message_order INTEGER,
              created_at TEXT NOT NULL,
              FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS favicons (
              domain TEXT PRIMARY KEY,
              mime TEXT,
              image BLOB,
              fetched_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attachments (
              id TEXT PRIMARY KEY,
              chat_id TEXT,
              message_id TEXT,
              story_id TEXT,
              filename TEXT NOT NULL,
              mime TEXT NOT NULL,
              kind TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,
              stored_path TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS attachments_chat_idx
              ON attachments(chat_id);

            CREATE INDEX IF NOT EXISTS attachments_message_idx
              ON attachments(message_id);

            CREATE INDEX IF NOT EXISTS attachments_story_idx
              ON attachments(story_id);

            CREATE TABLE IF NOT EXISTS models_cache (
              id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              fetched_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tos_acceptances (
              id TEXT PRIMARY KEY,
              tos_hash TEXT NOT NULL,
              tos_date TEXT,
              accepted_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stories (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              author TEXT NOT NULL,
              language TEXT NOT NULL,
              synopsis TEXT NOT NULL,
              model TEXT NOT NULL,
              system_prompt TEXT NOT NULL,
              temperature REAL NOT NULL,
              max_tokens INTEGER NOT NULL,
              thinking_enabled INTEGER NOT NULL,
              reasoning_effort TEXT NOT NULL DEFAULT 'medium',
              temporary INTEGER NOT NULL DEFAULT 0,
              lorebook_auto INTEGER NOT NULL DEFAULT 0,
              lorebook_model TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chapters (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              word_count INTEGER NOT NULL DEFAULT 0,
              revision INTEGER NOT NULL DEFAULT 0,
              order_index INTEGER NOT NULL,
              disabled INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS lorebook_entries (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              name TEXT NOT NULL,
              category TEXT NOT NULL,
              description TEXT NOT NULL,
              aliases_json TEXT NOT NULL,
              tags_json TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 0,
              disabled INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS story_generations (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              chapter_id TEXT NOT NULL,
              prompt TEXT NOT NULL,
              generated_text TEXT NOT NULL,
              model TEXT,
              finish_reason TEXT,
              error TEXT,
              generation_id TEXT,
              prompt_tokens INTEGER,
              completion_tokens INTEGER,
              reasoning_tokens INTEGER,
              total_tokens INTEGER,
              cost REAL,
              provider_name TEXT,
              generation_time REAL,
              latency REAL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
              FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS lorebook_update_runs (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              chapter_id TEXT NOT NULL,
              generation_id TEXT,
              openrouter_generation_id TEXT,
              raw_output TEXT NOT NULL,
              applied_updates_json TEXT NOT NULL,
              rejected_updates_json TEXT NOT NULL DEFAULT '[]',
              cost REAL,
              error TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
              FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
              FOREIGN KEY(generation_id) REFERENCES story_generations(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS chapter_history_entries (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              chapter_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              label TEXT NOT NULL,
              detail TEXT NOT NULL DEFAULT '',
              entry_order INTEGER NOT NULL,
              kind TEXT,
              words_added INTEGER,
              words_removed INTEGER,
              cost REAL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
              FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS brainstorm_nodes (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              node_type TEXT NOT NULL,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              position_x REAL NOT NULL DEFAULT 0,
              position_y REAL NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'complete',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS brainstorm_edges (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              source_node_id TEXT NOT NULL,
              target_node_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
              FOREIGN KEY(source_node_id) REFERENCES brainstorm_nodes(id) ON DELETE CASCADE,
              FOREIGN KEY(target_node_id) REFERENCES brainstorm_nodes(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS brainstorm_viewports (
              story_id TEXT PRIMARY KEY,
              position_x REAL NOT NULL DEFAULT 0,
              position_y REAL NOT NULL DEFAULT 0,
              zoom REAL NOT NULL DEFAULT 1,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS brainstorm_generations (
              id TEXT PRIMARY KEY,
              story_id TEXT NOT NULL,
              prompt_node_id TEXT NOT NULL,
              prompt TEXT NOT NULL,
              reasoning TEXT,
              duration_ms REAL,
              model TEXT NOT NULL,
              finish_reason TEXT,
              error TEXT,
              generation_id TEXT,
              prompt_tokens INTEGER,
              completion_tokens INTEGER,
              reasoning_tokens INTEGER,
              total_tokens INTEGER,
              cost REAL,
              provider_name TEXT,
              generation_time REAL,
              latency REAL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(story_id) REFERENCES stories(id) ON DELETE CASCADE,
              FOREIGN KEY(prompt_node_id) REFERENCES brainstorm_nodes(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_brainstorm_nodes_story
            ON brainstorm_nodes(story_id, created_at);

            CREATE INDEX IF NOT EXISTS idx_brainstorm_edges_story
            ON brainstorm_edges(story_id, created_at);

            CREATE INDEX IF NOT EXISTS idx_tos_acceptances_hash
            ON tos_acceptances(tos_hash);
            """
        )
        ensure_chat_folder_column(conn)
        ensure_message_order_column(conn)
        ensure_message_usage_columns(conn)
        ensure_chat_settings_columns(conn)
        ensure_story_settings_columns(conn)
        ensureGenerationSettledColumn(conn)
        ensure_chapter_context_column(conn)
        ensure_chapter_revision_column(conn)
        ensure_lorebook_revision_column(conn)
        ensure_message_source_column(conn)
        ensure_brainstorm_generation_columns(conn)
        ensure_chapter_history_columns(conn)
        ensure_lorebook_run_usage_columns(conn)
        ensureLorebookUsageTable(conn)
        ensureTranscriptionUsageTable(conn)
        ensureCachedTokenColumns(conn)
        clean_lorebook_categories(conn)
