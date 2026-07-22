import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from sofascore_collector.cli import save_kind
from sofascore_collector.storage import CollectorStore


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = CollectorStore(Path(self.temp.name) / "collector.db")
        self.commence_at = datetime(2026, 7, 20, 7, 20, tzinfo=timezone.utc)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_prematch_lineup_is_exported_with_audit_metadata(self):
        payload_id, phase = save_kind(
            self.store,
            event_id="15506787",
            kind="lineups",
            payload={
                "home": {"players": [{"player": {"id": 1, "name": "Home Starter"}, "substitute": False}]},
                "away": {"players": [{"player": {"id": 2, "name": "Away Starter"}, "substitute": True}]},
            },
            commence_at=self.commence_at,
            captured_at=datetime(2026, 7, 20, 6, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(phase, "prematch")
        self.assertGreater(payload_id, 0)
        exported = self.store.prematch_node_export("15506787")
        self.assertEqual(len(exported), 1)
        self.assertEqual(exported[0]["endpointKind"], "lineups")
        self.assertEqual(exported[0]["payload"]["home"]["players"][0]["player"]["name"], "Home Starter")

    def test_top_performers_are_never_exported_as_prematch(self):
        payload_id, phase = save_kind(
            self.store,
            event_id="15506787",
            kind="top-performers",
            payload={"home": [{"player": {"id": 1, "name": "Pitcher"}}]},
            commence_at=self.commence_at,
            captured_at=datetime(2026, 7, 20, 6, 0, tzinfo=timezone.utc),
        )

        self.assertGreater(payload_id, 0)
        self.assertEqual(phase, "postmatch")
        self.assertEqual(self.store.prematch_node_export("15506787"), [])

    def test_raw_payload_hash_makes_duplicate_import_idempotent(self):
        payload = {"home": {"players": []}, "away": {"players": []}}
        captured = datetime(2026, 7, 20, 6, 0, tzinfo=timezone.utc)
        first_id, _ = save_kind(
            self.store,
            event_id="15506787",
            kind="lineups",
            payload=payload,
            commence_at=self.commence_at,
            captured_at=captured,
        )
        second_id, _ = save_kind(
            self.store,
            event_id="15506787",
            kind="lineups",
            payload=json.loads(json.dumps(payload)),
            commence_at=self.commence_at,
            captured_at=captured,
        )
        self.assertEqual(first_id, second_id)


if __name__ == "__main__":
    unittest.main()
