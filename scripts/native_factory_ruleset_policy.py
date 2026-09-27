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
    required_integration_id: int = 15368,
) -> bool:
    """Require active, non-bypassable, publisher-bound PR/check enforcement."""
    if (
        not isinstance(ruleset, dict)
        or ruleset.get("enforcement") != "active"
        or not applies_to_branch(
            ruleset, branch, default_branch=default_branch
        )
    ):
        return False
    bypass = ruleset.get("bypass_actors")
    if not isinstance(bypass, list) or bypass:
        return False

    rule_types: set[str] = set()
    status_params: dict | None = None
    pr_params: dict | None = None
    for rule in ruleset.get("rules") or []:
        if not isinstance(rule, dict):
            return False
        kind = rule.get("type")
        if isinstance(kind, str):
            rule_types.add(kind)
        if kind == "required_status_checks":
            params = rule.get("parameters")
            if not isinstance(params, dict):
                return False
            status_params = params
        elif kind == "pull_request":
            params = rule.get("parameters")
            if not isinstance(params, dict):
                return False
            pr_params = params

    if status_params is None or pr_params is None:
        return False
    if status_params.get("strict_required_status_checks_policy") is not True:
        return False
    if (
        int(pr_params.get("required_approving_review_count") or 0) < 1
        or pr_params.get("dismiss_stale_reviews_on_push") is not True
        or pr_params.get("require_last_push_approval") is not True
    ):
        return False

    specs = status_params.get("required_status_checks")
    if not isinstance(specs, list):
        return False
    required = set(required_checks)
    for context in required:
        if not any(
            isinstance(item, dict)
            and item.get("context") == context
            and item.get("integration_id") == required_integration_id
            for item in specs
        ):
            return False

    return {
        "pull_request",
        "required_status_checks",
        "deletion",
        "non_fast_forward",
    }.issubset(rule_types)

