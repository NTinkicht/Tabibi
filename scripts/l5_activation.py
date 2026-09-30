#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from l5_recovery import plan_recovery

SHA40 = re.compile(r"^[0-9a-f]{40}$")
SAFE_MUTATIONS = {
    "REMEDIATE_SAME_PR_CI": "retry_ci",
    "DISPATCH_ELIGIBLE_NONAUTHOR_REVIEW": "dispatch_review",
    "FAILOVER_TO_ELIGIBLE_NONAUTHOR_REVIEWER": "dispatch_review",
    "REMEDIATE_SAME_PR_REVIEW": "remediate_review",
    "AWAIT_AUTHORIZED_EXPECTED_HEAD_MERGE": "merge_expected_head",
    "PLAN_REPLENISH_READY_WU": "reserve_next_wu",
}


def _required_bool(row: dict[str, Any], key: str) -> bool:
    value = row.get(key)
    if type(value) is not bool:
        raise ValueError(f"L5_ACTIVATION_{key.upper()}_UNKNOWN")
    return value


def _sha(row: dict[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not SHA40.fullmatch(value):
        raise ValueError(f"L5_ACTIVATION_{key.upper()}_INVALID")
    return value


def _token(plan: dict[str, Any], snapshot: dict[str, Any]) -> str:
    material = {
        "event_key": plan.get("event_key"),
        "next_action": plan.get("next_action"),
        "repository": snapshot.get("repository"),
        "issue": snapshot.get("issue"),
        "canonical_pr": snapshot.get("canonical_pr"),
        "head_sha": snapshot.get("head_sha"),
        "base_sha": snapshot.get("base_sha"),
        "selected_issue": plan.get("selected_issue"),
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def authorize_mutation(
    snapshot: dict[str, Any], *, prior_mutation_tokens: set[str] | None = None
) -> dict[str, Any]:
    if not isinstance(snapshot, dict):
        raise ValueError("L5_ACTIVATION_SNAPSHOT_INVALID")

    emergency = _required_bool(snapshot, "emergency_stop")
    human_only = _required_bool(snapshot, "human_only")
    blocked = _required_bool(snapshot, "blocked")
    if emergency or human_only or blocked:
        return {"authorized": False, "reason": "HARD_BOUNDARY", "mutation_allowed": False}

    if snapshot.get("release_go_no_go") is True:
        return {"authorized": False, "reason": "RELEASE_GO_NO_GO_HUMAN_ONLY", "mutation_allowed": False}
    if snapshot.get("destructive_production") is True:
        return {"authorized": False, "reason": "DESTRUCTIVE_PRODUCTION_HUMAN_ONLY", "mutation_allowed": False}
    if snapshot.get("spend_required") is True:
        return {"authorized": False, "reason": "SPEND_HUMAN_ONLY", "mutation_allowed": False}
    if snapshot.get("secret_scope_change") is True:
        return {"authorized": False, "reason": "SECRET_SCOPE_HUMAN_ONLY", "mutation_allowed": False}
    if snapshot.get("security_control_weakening") is True:
        return {"authorized": False, "reason": "SECURITY_CONTROL_HUMAN_ONLY", "mutation_allowed": False}

    plan = plan_recovery(snapshot, prior_event_keys=set(snapshot.get("prior_event_keys", [])))
    action = plan.get("next_action")
    if action not in SAFE_MUTATIONS:
        return {
            "authorized": False,
            "reason": "ACTION_NOT_MUTATION_WHITELISTED",
            "planned_action": action,
            "mutation_allowed": False,
        }

    head = _sha(snapshot, "head_sha")
    base = _sha(snapshot, "base_sha")
    if _required_bool(snapshot, "head_current") is not True or _required_bool(snapshot, "base_current") is not True:
        return {"authorized": False, "reason": "STALE_HEAD_OR_BASE", "mutation_allowed": False}

    token = _token(plan, snapshot)
    if token in (prior_mutation_tokens or set()):
        return {
            "authorized": False,
            "reason": "REPLAY_NOOP",
            "mutation_token": token,
            "mutation_allowed": False,
        }

    mutation = SAFE_MUTATIONS[action]
    result: dict[str, Any] = {
        "authorized": True,
        "reason": "AUTHORIZED",
        "mutation_allowed": True,
        "mutation": mutation,
        "mutation_token": token,
        "expected_head_sha": head,
        "expected_base_sha": base,
        "canonical_pr": snapshot.get("canonical_pr"),
        "issue": snapshot.get("issue"),
    }

    if mutation == "merge_expected_head":
        if plan.get("status") != "READY":
            raise ValueError("L5_ACTIVATION_MERGE_PLAN_NOT_READY")
        if snapshot.get("ci") != "SUCCESS" or snapshot.get("review") != "PASS":
            raise ValueError("L5_ACTIVATION_MERGE_EVIDENCE_NOT_PASS")
        if _required_bool(snapshot, "unresolved_threads"):
            raise ValueError("L5_ACTIVATION_UNRESOLVED_THREADS")
        if snapshot.get("mergeable") is not True:
            raise ValueError("L5_ACTIVATION_NOT_MERGEABLE")

    if mutation == "reserve_next_wu":
        selected = plan.get("selected_issue")
        if type(selected) is not int or selected < 1:
            raise ValueError("L5_ACTIVATION_SELECTED_ISSUE_INVALID")
        result["selected_issue"] = selected

    return result


def selftest() -> None:
    h, b = "a" * 40, "b" * 40
    s = {
        "repository": "NTinkicht/Tabibi", "issue": 565, "canonical_pr": 999,
        "active_prs": [999], "head_sha": h, "base_sha": b,
        "head_current": True, "base_current": True, "implementation_complete": True,
        "emergency_stop": False, "human_only": False, "blocked": False,
        "merged": False, "verified": False, "verified_head_sha": None,
        "verified_base_sha": None, "ci": "SUCCESS", "ci_head_sha": h,
        "ci_base_sha": b, "review": "PASS", "review_head_sha": h,
        "review_base_sha": b, "reviewer_actor": "claude",
        "material_authors": ["chatgpt"], "material_authors_head_sha": h,
        "review_eligible": True, "unresolved_threads": False, "mergeable": True,
        "retry_count": 0, "retry_action": None, "event_id": "activate-1",
        "ready_candidates": [], "prior_event_keys": [],
    }
    allowed = authorize_mutation(s)
    assert allowed["mutation"] == "merge_expected_head" and allowed["mutation_allowed"] is True
    assert authorize_mutation(s, prior_mutation_tokens={allowed["mutation_token"]})["reason"] == "REPLAY_NOOP"
    assert authorize_mutation({**s, "emergency_stop": True})["mutation_allowed"] is False
    assert authorize_mutation({**s, "human_only": True})["mutation_allowed"] is False
    print("l5_activation selftest PASS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--input", type=Path)
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return 0
    if args.input is None:
        raise SystemExit("--input is required unless --selftest is used")
    snapshot = json.loads(args.input.read_text(encoding="utf-8"))
    prior = set(snapshot.get("prior_mutation_tokens", []))
    print(json.dumps(authorize_mutation(snapshot, prior_mutation_tokens=prior), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
