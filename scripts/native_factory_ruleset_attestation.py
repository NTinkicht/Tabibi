#!/usr/bin/env python3
"""Fail-closed, owner-authenticated no-bypass ruleset attestation.

A scoped workflow token may see required branch rules without bypass_actors.
Only an authenticated, unedited owner statement bound to the *current* ruleset
updated_at is accepted as a missing-field substitute. An explicit nonempty
bypass list always blocks. The normal strict policy remains authoritative.
"""
from __future__ import annotations

import re
from datetime import datetime

REPO = "NTinkicht/Tabibi"
ISSUE = 11
OWNER = "NTinkicht"
MARKER = re.compile(
    r"<!-- TABIBI_L4_NO_BYPASS_V1 "
    r"repo=(NTinkicht/Tabibi) ruleset=([1-9][0-9]*) "
    r"updated=([0-9T:.+-]+) bypass=none -->"
)


def _instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("RULESET_TIMESTAMP_MISSING_ZONE")
    return parsed


def validate_owner_attestation(comment: dict, detail: dict, summary: dict) -> bool:
    if not all(isinstance(x, dict) for x in (comment, detail, summary)):
        return False
    source = (comment.get("user") or {}).get("login")
    body = comment.get("body")
    if (
        source != OWNER
        or not isinstance(body, str)
        or comment.get("created_at") != comment.get("updated_at")
        or str(comment.get("issue_url") or "")
        != f"https://api.github.com/repos/{REPO}/issues/{ISSUE}"
    ):
        return False
    matches = MARKER.findall(body)
    if len(matches) != 1 or body.count("TABIBI_L4_NO_BYPASS_V1") != 1:
        return False
    repo, number, updated, bypass = (*matches[0], "none")
    if (
        repo != REPO
        or bypass != "none"
        or str(detail.get("id")) != number
        or str(summary.get("id")) != number
        or detail.get("updated_at") != updated
        or summary.get("updated_at") != updated
        or detail.get("source") != REPO
        or detail.get("source_type") != "Repository"
        or detail.get("enforcement") != "active"
        or detail.get("target") != "branch"
    ):
        return False
    try:
        owner_time = _instant(comment["created_at"])
        ruleset_time = _instant(updated)
        return owner_time >= ruleset_time
    except (KeyError, TypeError, ValueError):
        return False


def authorized_ruleset_detail(
    detail: dict, summary: dict, comments: list[dict]
) -> dict | None:
    """Never override an explicit bypass; only fill a permission-omitted field."""
    if not isinstance(detail, dict) or not isinstance(summary, dict):
        return None
    if detail.get("id") != summary.get("id"):
        return None
    if "bypass_actors" in detail:
        return detail if detail["bypass_actors"] == [] else None
    if not isinstance(comments, list):
        return None
    if not any(validate_owner_attestation(c, detail, summary) for c in comments):
        return None
    return {**detail, "bypass_actors": []}
