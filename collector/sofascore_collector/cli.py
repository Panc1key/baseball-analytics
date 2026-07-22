from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .browser import SeleniumSofaScoreClient
from .parser import PARSER_VERSION, parse_lineups, parse_top_performers
from .storage import CollectorStore, parse_iso


DEFAULT_DB = Path(__file__).resolve().parents[1] / "data" / "collector.db"
DEFAULT_EXPORTS = Path(__file__).resolve().parents[1] / "exports"


def endpoint_url(event_id: str, kind: str) -> str:
    paths = {
        "event": f"/api/v1/event/{event_id}",
        "lineups": f"/api/v1/event/{event_id}/lineups",
        "top-performers": f"/api/v1/event/baseball/{event_id}/top-performers",
        "statistics": f"/api/v1/event/{event_id}/statistics",
        "incidents": f"/api/v1/event/{event_id}/incidents",
    }
    path = paths[kind]
    return f"https://www.sofascore.com{path}"


def is_finished_payload(kind: str, payload: dict[str, Any]) -> bool:
    if kind == "event":
        return payload.get("event", {}).get("status", {}).get("type") == "finished"
    if kind != "lineups":
        return False
    return any(
        player.get("statistics")
        for side in ("home", "away")
        for player in payload.get(side, {}).get("players", [])
    )


def save_kind(
    store: CollectorStore,
    *,
    event_id: str,
    kind: str,
    payload: dict[str, Any],
    commence_at: datetime | None,
    captured_at: datetime | None = None,
    source_url: str | None = None,
) -> tuple[int, str]:
    # Top performers 的內容本質上是賽中／賽後表現；即使有人手動提供錯誤時間，
    # 也不允許將其輸出為同場 prematch。
    force_phase = (
        "postmatch"
        if kind in {"top-performers", "statistics", "incidents"} or is_finished_payload(kind, payload)
        else None
    )
    payload_id, phase = store.save_payload(
        source="sofascore",
        endpoint_kind=kind,
        event_id=event_id,
        source_url=source_url or endpoint_url(event_id, kind),
        payload=payload,
        captured_at=captured_at,
        commence_at=commence_at,
        parser_version=PARSER_VERSION,
        force_phase=force_phase,
    )
    if kind == "lineups":
        store.save_lineup_players(payload_id, parse_lineups(payload))
    elif kind == "top-performers":
        store.save_performers(payload_id, parse_top_performers(payload))
    elif kind in {"event", "statistics", "incidents"}:
        # 場次 metadata 原樣封存；模型端仍須依 captured_at 與欄位相位審核。
        pass
    else:
        raise ValueError(f"不支援的 endpoint kind: {kind}")
    return payload_id, phase


def add_common_event_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--commence-at", required=True, help="ISO 8601，例如 2026-07-20T07:20:00Z")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="可稽核的 SofaScore MLB 資料蒐集器")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite 路徑")
    commands = parser.add_subparsers(dest="command", required=True)

    import_json = commands.add_parser("import-json", help="匯入瀏覽器保存的 JSON response")
    add_common_event_args(import_json)
    import_json.add_argument(
        "--kind",
        choices=("event", "lineups", "top-performers", "statistics", "incidents"),
        required=True,
    )
    import_json.add_argument("--file", required=True)
    import_json.add_argument("--captured-at", help="未指定時使用目前 UTC 時間")

    browser = commands.add_parser("collect-browser", help="以標準 Selenium 讀取瀏覽器載入的 API")
    add_common_event_args(browser)
    browser.add_argument("--event-url", required=True)
    browser.add_argument("--headless", action="store_true")

    audit = commands.add_parser("audit", help="列出某場資料快照與相位")
    audit.add_argument("--event-id", required=True)

    export_node = commands.add_parser("export-node", help="匯出僅含 prematch 的 Node 交接檔")
    export_node.add_argument("--event-id", required=True)
    export_node.add_argument("--out-dir", default=str(DEFAULT_EXPORTS))
    return parser


def main() -> int:
    args = build_parser().parse_args()
    store = CollectorStore(args.db)
    try:
        if args.command == "import-json":
            payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
            payload_id, phase = save_kind(
                store,
                event_id=args.event_id,
                kind=args.kind,
                payload=payload,
                commence_at=parse_iso(args.commence_at),
                captured_at=parse_iso(args.captured_at) if args.captured_at else None,
            )
            print(json.dumps({"payloadId": payload_id, "phase": phase}, ensure_ascii=False))
            return 0

        if args.command == "collect-browser":
            client = SeleniumSofaScoreClient(headless=args.headless)
            payloads = client.collect_event(args.event_url, args.event_id)
            saved = [
                {
                    "kind": item.endpoint_kind,
                    "payloadId": save_kind(
                        store,
                        event_id=args.event_id,
                        kind=item.endpoint_kind,
                        payload=item.payload,
                        commence_at=parse_iso(args.commence_at),
                        source_url=item.url,
                    )[0],
                }
                for item in payloads
            ]
            print(json.dumps({"saved": saved}, ensure_ascii=False))
            return 0

        if args.command == "audit":
            print(json.dumps(store.audit(args.event_id), ensure_ascii=False, indent=2))
            return 0

        if args.command == "export-node":
            out_dir = Path(args.out_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            output = out_dir / f"sofascore-{args.event_id}-prematch.json"
            output.write_text(
                json.dumps(store.prematch_node_export(args.event_id), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(output)
            return 0
        raise RuntimeError(f"未知命令：{args.command}")
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
