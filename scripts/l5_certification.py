#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from typing import Any

from l5_recovery import MAX_RETRIES, journal_record, plan_recovery


@dataclass(frozen=True)
class Scenario:
    name: str
    patch: dict[str, Any]
    expected_action: str
    expected_status: str | None = None


def base_snapshot() -> dict[str, Any]:
    head, base = "a" * 40, "b" * 40
    return {
        "repository": "NTinkicht/Tabibi",
        "issue": 563,
        "canonical_pr": 900,
        "active_prs": [900],
        "head_sha": head,
        "base_sha": base,
        "head_current": True,
        "base_current": True,
        "implementation_complete": True,
        "emergency_stop": False,
        "human_only": False,
        "blocked": False,
        "merged": False,
        "verified": False,
        "verified_head_sha": None,
        "verified_base_sha": None,
        "ci": "SUCCESS",
        "ci_head_sha": head,
        "ci_base_sha": base,
        "review": "PASS",
        "review_head_sha": head,
        "review_base_sha": base,
        "reviewer_actor": "mistral-vibe",
        "material_authors": ["chatgpt"],
        "material_authors_head_sha": head,
        "review_eligible": True,
        "unresolved_threads": False,
        "mergeable": True,
        "retry_count": 0,
        "retry_action": None,
        "event_id": "cert-base",
        "ready_candidates": [],
    }


def scenario_matrix() -> list[Scenario]:
    return [
        Scenario("ci-red", {"ci": "FAILURE", "event_id": "cert-ci-red"}, "REMEDIATE_SAME_PR_CI"),
        Scenario("ci-pending", {"ci": "PENDING", "event_id": "cert-ci-pending"}, "RUN_OR_RECONCILE_EXACT_HEAD_CI"),
        Scenario("review-outage", {"review": "OUTAGE", "event_id": "cert-review-outage"}, "FAILOVER_TO_ELIGIBLE_NONAUTHOR_REVIEWER"),
        Scenario("self-review", {"reviewer_actor": "chatgpt", "event_id": "cert-self-review"}, "DISPATCH_ELIGIBLE_NONAUTHOR_REVIEW"),
        Scenario("stale-head", {"head_current": False, "event_id": "cert-stale-head"}, "RECONCILE_HEAD_BASE"),
        Scenario("stale-base", {"base_current": False, "event_id": "cert-stale-base"}, "RECONCILE_HEAD_BASE"),
        Scenario("duplicate-stream", {"active_prs": [900, 901], "event_id": "cert-duplicate"}, "DUPLICATE_STREAM_RECONCILIATION_REQUIRED", "BLOCKED"),
        Scenario("emergency-stop", {"emergency_stop": True, "event_id": "cert-stop"}, "EMERGENCY_STOP_HOLD", "BLOCKED"),
        Scenario("human-only", {"human_only": True, "event_id": "cert-human"}, "HUMAN_OR_POLICY_BLOCKED", "BLOCKED"),
        Scenario("merge-ready", {"event_id": "cert-ready"}, "AWAIT_AUTHORIZED_EXPECTED_HEAD_MERGE", "READY"),
    ]


def run_certification() -> dict[str, Any]:
    evidence: list[dict[str, Any]] = []
    for scenario in scenario_matrix():
        snapshot = {**base_snapshot(), **scenario.patch}
        plan = plan_recovery(snapshot)
        assert plan["next_action"] == scenario.expected_action, scenario.name
        if scenario.expected_status is not None:
            assert plan["status"] == scenario.expected_status, scenario.name
        assert plan["mutation_allowed"] is False, scenario.name
        record = journal_record(snapshot, plan)
        assert record["mutation_allowed"] is False, scenario.name
        evidence.append({"scenario": scenario.name, "plan": plan, "journal": record})

    replay_snapshot = {**base_snapshot(), "ci": "FAILURE", "event_id": "cert-replay"}
    first = plan_recovery(replay_snapshot)
    replay = plan_recovery(replay_snapshot, prior_event_keys={first["event_key"]})
    assert replay["status"] == "REPLAY_NOOP"
    assert replay["next_action"] == "NONE_ALREADY_RECORDED"

    exhausted = {
        **base_snapshot(),
        "ci": "FAILURE",
        "retry_count": MAX_RETRIES,
        "retry_action": "CI",
        "event_id": "cert-exhausted",
    }
    exhausted_plan = plan_recovery(exhausted)
    assert exhausted_plan["status"] == "BLOCKED"
    assert exhausted_plan["next_action"] == "RETRY_BUDGET_EXHAUSTED"

    held = {
        **base_snapshot(),
        "ci": "FAILURE",
        "emergency_stop": True,
        "retry_count": 2,
        "retry_action": "CI",
        "event_id": "cert-hold-budget",
    }
    held_plan = plan_recovery(held)
    assert held_plan["status"] == "BLOCKED"
    assert held_plan["retry_count"] == 2
    assert held_plan["retry_action"] == "CI"

    merged = {
        **base_snapshot(),
        "active_prs": [],
        "merged": True,
        "verified": False,
        "event_id": "cert-verify",
    }
    verify_plan = plan_recovery(merged)
    assert verify_plan["next_action"] == "VERIFY_MERGED_RESULT"

    verified = {
        **merged,
        "verified": True,
        "verified_head_sha": "a" * 40,
        "verified_base_sha": "b" * 40,
        "event_id": "cert-replenish",
        "ready_candidates": [
            {"issue": 700, "ready": True, "blocked": False, "human_only": False, "conflict_safe": False},
            {"issue": 701, "ready": True, "blocked": False, "human_only": False, "conflict_safe": True},
        ],
    }
    replenish = plan_recovery(verified)
    assert replenish["next_action"] == "PLAN_REPLENISH_READY_WU"
    assert replenish["selected_issue"] == 701

    lost_response = copy.deepcopy(replay_snapshot)
    lost_first = plan_recovery(lost_response)
    lost_second = plan_recovery(lost_response, prior_event_keys={lost_first["event_key"]})
    assert lost_second["status"] == "REPLAY_NOOP"

    return {
        "certified": True,
        "mutation_allowed": False,
        "scenario_count": len(evidence) + 6,
        "scenarios": evidence,
    }


def main() -> int:
    report = run_certification()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
