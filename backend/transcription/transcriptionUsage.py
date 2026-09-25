


def ensureTranscriptionUsageTable(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS transcription_usage (
            id TEXT PRIMARY KEY,
            model TEXT NOT NULL,
            generation_id TEXT,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            reasoning_tokens INTEGER,
            total_tokens INTEGER,
            audio_seconds REAL,
            cost REAL,
            created_at TEXT NOT NULL
        )
    """)
