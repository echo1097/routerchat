from __future__ import annotations

from backend.attachments.attachmentCleanup import (
    delete_attachments_for_story,
    delete_orphaned_attachments,
)
from backend.core.database import get_db


def delete_temporary_items() -> None:
    with get_db() as conn:
        conn.execute(
            """
            DELETE FROM messages
            WHERE chat_id IN (SELECT id FROM chats WHERE temporary = 1)
            """
        )
        conn.execute("DELETE FROM chats WHERE temporary = 1")
        delete_orphaned_attachments(conn)
        temporaryStoryIds = [
            row["id"]
            for row in conn.execute("SELECT id FROM stories WHERE temporary = 1").fetchall()
        ]
        for storyId in temporaryStoryIds:
            delete_attachments_for_story(conn, storyId)
            conn.execute("DELETE FROM brainstorm_generations WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM brainstorm_edges WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM brainstorm_nodes WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM brainstorm_viewports WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM lorebook_update_runs WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM story_generations WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM lorebook_entries WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM chapters WHERE story_id = ?", (storyId,))
            conn.execute("DELETE FROM stories WHERE id = ?", (storyId,))
