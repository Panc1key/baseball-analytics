"""SofaScore JSON 的保守標準化。

欄位結構可能變更，因此保留 raw JSON；解析器只抽取穩定且可解釋的最小欄位。
任何 statistics / rating 均標記為比賽中或賽後資料，不能用於同場初盤。
"""

from __future__ import annotations

from typing import Any


PARSER_VERSION = "sofascore-v1"


def _player_row(side: str, row: dict[str, Any]) -> dict[str, Any]:
    player = row.get("player") or {}
    return {
        "side": side,
        "player_source_id": str(player["id"]) if player.get("id") is not None else None,
        "player_name": player.get("name"),
        "position": row.get("position") or player.get("position"),
        "shirt_number": str(row["shirtNumber"]) if row.get("shirtNumber") is not None else None,
        "is_substitute": bool(row.get("substitute", False)),
        "has_match_statistics": bool(row.get("statistics") or row.get("rating") or row.get("averageRating")),
        "raw": row,
    }


def parse_lineups(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """取得兩隊球員名單；不以名稱推論是否為正式確認打線。"""
    rows: list[dict[str, Any]] = []
    for side in ("home", "away"):
        team = payload.get(side) or {}
        for player in team.get("players") or []:
            if isinstance(player, dict):
                rows.append(_player_row(side, player))
    return rows


def _walk_performer(value: Any, side: str | None = None, role: str | None = None) -> list[dict[str, Any]]:
    if isinstance(value, list):
        output: list[dict[str, Any]] = []
        for item in value:
            output.extend(_walk_performer(item, side=side, role=role))
        return output
    if not isinstance(value, dict):
        return []

    resolved_side = value.get("side") or side
    resolved_role = value.get("type") or value.get("label") or value.get("name") or role
    player = value.get("player")
    if isinstance(player, dict):
        return [{
            "side": resolved_side if resolved_side in ("home", "away") else None,
            "player_source_id": str(player["id"]) if player.get("id") is not None else None,
            "player_name": player.get("name"),
            "performer_role": str(resolved_role) if resolved_role else None,
            "raw": value,
        }]

    output: list[dict[str, Any]] = []
    for key, child in value.items():
        if key in {"home", "away"}:
            output.extend(_walk_performer(child, side=key, role=resolved_role))
        elif isinstance(child, (dict, list)):
            output.extend(_walk_performer(child, side=resolved_side, role=key))
    return output


def parse_top_performers(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Top performers 一律視為 postmatch / live 資料。"""
    return _walk_performer(payload)
