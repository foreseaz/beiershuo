"""Versioned local work, with one SQLite database per working library."""

import hashlib
import json
import os
import sqlite3
import tempfile
from pathlib import Path


def serialize(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":"))


def revision(value):
    return hashlib.sha256(serialize(value).encode()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(dir=path.parent, encoding="utf-8", mode="w", delete=False)
    try:
        with handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
        os.replace(handle.name, path)
    finally:
        Path(handle.name).unlink(missing_ok=True)


class Store:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS episodes (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS transcripts (
                episode_id TEXT PRIMARY KEY REFERENCES episodes(id),
                revision TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reviews (
                episode_id TEXT PRIMARY KEY REFERENCES episodes(id),
                transcript_revision TEXT NOT NULL,
                revision TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS summaries (
                moment_id TEXT PRIMARY KEY,
                episode_id TEXT NOT NULL REFERENCES episodes(id),
                approval_key TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS proposals (
                kind TEXT NOT NULL,
                key TEXT NOT NULL,
                proposal TEXT NOT NULL,
                decision TEXT,
                status TEXT NOT NULL DEFAULT 'proposed',
                published TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(kind, key)
            );
            CREATE TABLE IF NOT EXISTS jobs (
                kind TEXT NOT NULL,
                episode_id TEXT NOT NULL REFERENCES episodes(id),
                state TEXT NOT NULL,
                detail TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(kind, episode_id)
            );
        """)

        columns = {row["name"] for row in self.db.execute("PRAGMA table_info(proposals)")}
        if "published" not in columns:
            self.db.execute("ALTER TABLE proposals ADD COLUMN published TEXT")

    def close(self):
        self.db.close()

    def save_catalog(self, episodes):
        with self.db:
            self.db.executemany("""
                INSERT INTO episodes VALUES (?, ?)
                ON CONFLICT(id) DO UPDATE SET data=excluded.data
            """, [(episode["id"], serialize(episode)) for episode in episodes])

    def episodes(self):
        result = [json.loads(row["data"]) for row in self.db.execute("SELECT data FROM episodes")]
        return sorted(result, key=lambda episode: (episode["publishedAt"], episode["id"]))

    def selected_episodes(self, keys):
        episodes = self.episodes()
        if not keys:
            return episodes
        selected = {}
        for key in keys:
            token = key.lower().removeprefix("ep")
            candidates = [item for item in episodes if item["id"] == key or (
                token.isdecimal() and item.get("number") == int(token)
            )]
            if len(candidates) != 1:
                raise ValueError(f"Episode {key!r} has {len(candidates)} matches. Use its full GUID.")
            selected[candidates[0]["id"]] = candidates[0]
        return list(selected.values())

    def transcript(self, episode_id):
        row = self.db.execute("SELECT * FROM transcripts WHERE episode_id=?", (episode_id,)).fetchone()
        return {"revision": row["revision"], "data": json.loads(row["data"])} if row else None

    def transcripts(self):
        for row in self.db.execute("SELECT * FROM transcripts"):
            yield row["episode_id"], {"revision": row["revision"], "data": json.loads(row["data"])}

    def save_transcript(self, episode_id, data):
        with self.db:
            self.db.execute("""
                INSERT INTO transcripts VALUES (?, ?, ?)
                ON CONFLICT(episode_id) DO UPDATE SET revision=excluded.revision,data=excluded.data
            """, (episode_id, revision(data), serialize(data)))

    def review(self, episode_id):
        row = self.db.execute("SELECT * FROM reviews WHERE episode_id=?", (episode_id,)).fetchone()
        if row is None:
            return None
        return {
            "revision": row["revision"],
            "transcriptRevision": row["transcript_revision"],
            "data": json.loads(row["data"]),
        }

    def save_review(self, episode_id, transcript_revision, data):
        with self.db:
            row = self.db.execute("SELECT revision FROM transcripts WHERE episode_id=?", (episode_id,)).fetchone()
            if row is None or row["revision"] != transcript_revision:
                raise ValueError("The transcript changed during review. Rebuild the review sheet.")
            self.db.execute("""
                INSERT INTO reviews VALUES (?, ?, ?, ?)
                ON CONFLICT(episode_id) DO UPDATE SET
                    transcript_revision=excluded.transcript_revision,revision=excluded.revision,data=excluded.data
            """, (episode_id, transcript_revision, revision(data), serialize(data)))

    def summary(self, moment_id, approval_key):
        row = self.db.execute(
            "SELECT data FROM summaries WHERE moment_id=? AND approval_key=?", (moment_id, approval_key)
        ).fetchone()
        return json.loads(row["data"]) if row else None

    def save_summary(self, episode_id, moment_id, approval_key, data):
        with self.db:
            self.db.execute("""
                INSERT INTO summaries VALUES (?, ?, ?, ?)
                ON CONFLICT(moment_id) DO UPDATE SET approval_key=excluded.approval_key,data=excluded.data
            """, (moment_id, episode_id, approval_key, serialize(data)))

    def save_proposal(self, kind, key, proposal):
        """Store a model proposal. A new proposal sends the item back to review.

        `published` keeps the last approved decision, so the public snapshot
        keeps the previous version until the new proposal is approved.
        """
        with self.db:
            self.db.execute("""
                INSERT INTO proposals(kind,key,proposal) VALUES (?,?,?)
                ON CONFLICT(kind,key) DO UPDATE SET
                    proposal=excluded.proposal,decision=NULL,status='proposed',updated_at=CURRENT_TIMESTAMP
            """, (kind, key, serialize(proposal)))

    def proposals(self, kind):
        rows = self.db.execute("SELECT * FROM proposals WHERE kind=? ORDER BY key", (kind,))
        return {row["key"]: {
            "proposal": json.loads(row["proposal"]),
            "decision": json.loads(row["decision"]) if row["decision"] else None,
            "status": row["status"],
            "published": json.loads(row["published"]) if row["published"] else None,
            "updatedAt": row["updated_at"],
        } for row in rows}

    def decide(self, kind, key, status, decision):
        """Record a review. Approving publishes the decision; rejecting withdraws it."""
        if status not in ("proposed", "approved", "rejected"):
            raise ValueError(f"Unknown review status {status!r}")
        value = serialize(decision) if decision is not None else None
        with self.db:
            changed = self.db.execute("""
                UPDATE proposals SET status=?,decision=?,updated_at=CURRENT_TIMESTAMP,
                    published=CASE ? WHEN 'approved' THEN ? WHEN 'rejected' THEN NULL ELSE published END
                WHERE kind=? AND key=?
            """, (status, value, status, value, kind, key)).rowcount
        if not changed:
            raise ValueError(f"No {kind} proposal {key!r}")

    def job(self, kind, episode_id, state, detail=""):
        with self.db:
            self.db.execute("""
                INSERT INTO jobs(kind,episode_id,state,detail) VALUES (?,?,?,?)
                ON CONFLICT(kind,episode_id) DO UPDATE SET
                    state=excluded.state,detail=excluded.detail,updated_at=CURRENT_TIMESTAMP
            """, (kind, episode_id, state, detail))
