"""SQLite 封存層：原始回應永遠先保存，再產生可審計的標準化列。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_payloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  endpoint_kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  commence_at TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('prematch', 'live', 'postmatch')),
  source_url TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, endpoint_kind, event_id, captured_at, payload_sha256)
);

CREATE INDEX IF NOT EXISTS idx_payloads_event_time
  ON source_payloads(event_id, captured_at);

CREATE TABLE IF NOT EXISTS lineup_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_id INTEGER NOT NULL REFERENCES source_payloads(id),
  side TEXT NOT NULL CHECK (side IN ('home', 'away')),
  player_source_id TEXT,
  player_name TEXT,
  position TEXT,
  shirt_number TEXT,
  is_substitute INTEGER,
  has_match_statistics INTEGER NOT NULL DEFAULT 0,
  raw_player_json TEXT NOT NULL,
  UNIQUE(payload_id, side, player_source_id, player_name)
);

CREATE TABLE IF NOT EXISTS postmatch_performers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_id INTEGER NOT NULL REFERENCES source_payloads(id),
  side TEXT,
  player_source_id TEXT,
  player_name TEXT,
  performer_role TEXT,
  raw_performer_json TEXT NOT NULL
);
"""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(value: str | datetime | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def classify_phase(captured_at: datetime, commence_at: datetime | None) -> str:
    if commence_at is None:
        return "postmatch"
    if captured_at < commence_at:
        return "prematch"
    # 結果型 endpoint 絕不因「剛開賽」被標為可回灌的 prematch。
    return "live"


class CollectorStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(SCHEMA)

    def close(self) -> None:
        self.connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self.connection
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

    def save_payload(
        self,
        *,
        source: str,
        endpoint_kind: str,
        event_id: str,
        source_url: str,
        payload: dict[str, Any],
        captured_at: datetime | None = None,
        commence_at: datetime | None = None,
        parser_version: str = "v1",
        force_phase: str | None = None,
    ) -> tuple[int, str]:
        captured = captured_at or utc_now()
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        phase = force_phase or classify_phase(captured, commence_at)

        with self.transaction() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO source_payloads
                  (source, endpoint_kind, event_id, captured_at, commence_at, phase,
                   source_url, payload_sha256, payload_json, parser_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source,
                    endpoint_kind,
                    str(event_id),
                    iso(captured),
                    iso(commence_at),
                    phase,
                    source_url,
                    digest,
                    canonical,
                    parser_version,
                ),
            )
            if cursor.rowcount:
                return int(cursor.lastrowid), phase
            existing = conn.execute(
                """
                SELECT id, phase FROM source_payloads
                WHERE source = ? AND endpoint_kind = ? AND event_id = ?
                  AND captured_at = ? AND payload_sha256 = ?
                """,
                (source, endpoint_kind, str(event_id), iso(captured), digest),
            ).fetchone()
            if not existing:
                raise RuntimeError("payload insert failed without existing record")
            return int(existing["id"]), str(existing["phase"])

    def save_lineup_players(self, payload_id: int, lineup_rows: list[dict[str, Any]]) -> None:
        with self.transaction() as conn:
            conn.executemany(
                """
                INSERT OR REPLACE INTO lineup_players
                  (payload_id, side, player_source_id, player_name, position, shirt_number,
                   is_substitute, has_match_statistics, raw_player_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        payload_id,
                        row["side"],
                        row.get("player_source_id"),
                        row.get("player_name"),
                        row.get("position"),
                        row.get("shirt_number"),
                        int(bool(row.get("is_substitute"))),
                        int(bool(row.get("has_match_statistics"))),
                        json.dumps(row["raw"], ensure_ascii=False, sort_keys=True),
                    )
                    for row in lineup_rows
                ],
            )

    def save_performers(self, payload_id: int, performer_rows: list[dict[str, Any]]) -> None:
        with self.transaction() as conn:
            conn.executemany(
                """
                INSERT INTO postmatch_performers
                  (payload_id, side, player_source_id, player_name, performer_role, raw_performer_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        payload_id,
                        row.get("side"),
                        row.get("player_source_id"),
                        row.get("player_name"),
                        row.get("performer_role"),
                        json.dumps(row["raw"], ensure_ascii=False, sort_keys=True),
                    )
                    for row in performer_rows
                ],
            )

    def audit(self, event_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """
            SELECT id, endpoint_kind, captured_at, commence_at, phase, source_url,
                   payload_sha256, parser_version
            FROM source_payloads
            WHERE event_id = ?
            ORDER BY captured_at ASC, id ASC
            """,
            (str(event_id),),
        ).fetchall()
        return [dict(row) for row in rows]

    def prematch_node_export(self, event_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """
            SELECT p.id, p.endpoint_kind, p.captured_at, p.commence_at, p.source_url,
                   p.event_id, p.payload_sha256, p.parser_version, p.payload_json
            FROM source_payloads p
            WHERE p.event_id = ? AND p.phase = 'prematch'
            ORDER BY p.captured_at ASC, p.id ASC
            """,
            (str(event_id),),
        ).fetchall()
        return [
            {
                "payloadId": row["id"],
                "sourceEventId": row["event_id"],
                "endpointKind": row["endpoint_kind"],
                "capturedAt": row["captured_at"],
                "commenceAt": row["commence_at"],
                "sourceUrl": row["source_url"],
                "payloadSha256": row["payload_sha256"],
                "parserVersion": row["parser_version"],
                "payload": json.loads(row["payload_json"]),
            }
            for row in rows
        ]
