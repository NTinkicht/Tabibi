#!/usr/bin/env python3
"""Pure fail-closed GitHub ruleset policy for Tabibi L4 native merge."""
from __future__ import annotations

import re
from typing import Iterable


def _pattern_regex(pattern: str) -> re.Pattern[str] | None:
    if any(ch in pattern for ch in "[]{}"):
        return None
    out=["^"]
    i=0
    while i < len(pattern):
        ch=pattern[i]
        if ch=="*":
            if i+1 < len(pattern) and pattern[i+1]=="*":
                while i+1 < len(pattern) and pattern[i+1]=="*":
                    i += 1
                out.append(".*")
            else:
                out.append("[^/]*")
        elif ch=="?":
            out.append("[^/]")
        else:
            out.append(re.escape(ch))
        i += 1
    out.append("$")
    return re.compile("".join(out))


def _matches(
    pattern: str, branch: str, *, default_branch: str | None
) -> bool | None:
    if pattern == "~ALL":
        return True
    if pattern == "~DEFAULT_BRANCH":
        return default_branch is not None and branch == default_branch
    if pattern.startswith("~"):
        return None
    regex=_pattern_regex(pattern)
    if regex is None:
        return None
    return bool(regex.fullmatch(branch) or regex.fullmatch(f"refs/heads/{branch}"))


def applies_to_branch(
    ruleset: dict, branch: str, *, default_branch: str | None
) -> bool:
    conditions=ruleset.get("conditions") or {}
    ref_name=conditions.get("ref_name") or {}
    includes=[str(v) for v in (ref_name.get("include") or [])]
    excludes=[str(v) for v in (ref_name.get("exclude") or [])]
    for pattern in excludes:
        matched=_matches(pattern, branch, default_branch=default_branch)
        if matched is None or matched:
            return False
    if not includes:
        return True
    matched_any=False
    for pattern in includes:
        matched=_matches(pattern, branch, default_branch=default_branch)
        if matched is None:
            return False
        matched_any = matched_any or matched
    return matched_any


def strict_ruleset_enforces(
    ruleset: dict,
    *,
    branch: str,
    required_checks: Iterable[str],
    default_branch: str | None,
) -> bool:
    """Require active, non-bypassable, strict PR/check enforcement for branch."""
    if (
        not isinstance(ruleset, dict)
        or ruleset.get("enforcement") != "active"
        or not applies_to_branch(
            ruleset, branch, default_branch=default_branch
        )
    ):
        return False
    bypass=ruleset.get("bypass_actors")
    if not isinstance(bypass, list) or bypass:
        return False

    rule_types=set()
    strict=False
    pull_request_fresh_review=False
    contexts=set()
    for rule in ruleset.get("rules") or []:
        if not isinstance(rule, dict):
            return False
        kind=rule.get("type")
        if isinstance(kind, str):
            rule_types.add(kind)
        if kind=="pull_request":
            params=rule.get("parameters")
            pull_request_fresh_review = bool(
                isinstance(params, dict)
                and type(params.get("required_approving_review_count")) is int
                and params["required_approving_review_count"] >= 1
                and params.get("dismiss_stale_reviews_on_push") is True
                and params.get("require_last_push_approval") is True
                and params.get("required_review_thread_resolution") is True
            )
        if kind=="required_status_checks":
            params=rule.get("parameters") or {}
            strict = params.get("strict_required_status_checks_policy") is True
            specs=params.get("required_status_checks")
            if not isinstance(specs, list):
                return False
            contexts.update(
                str(item.get("context"))
                for item in specs
                if isinstance(item, dict) and item.get("context")
            )

    required=set(required_checks)
    return bool(
        {"pull_request","required_status_checks","deletion","non_fast_forward"}
        .issubset(rule_types)
        and pull_request_fresh_review
        and strict
        and required.issubset(contexts)
    )
