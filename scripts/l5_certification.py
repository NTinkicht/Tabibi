#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from l5_recovery import (
    MAX_RETRIES,
    _prior_event_keys,
    journal_record,
    plan_recovery,
)


@dataclass(frozen=True)
class Scenario:
    name: str
    patch: dict[str, Any]
    expected_action: str
    expected_status: str | None = None


def _require(condition: bool, name: str) -> None:
    if not condition:
        raise RuntimeError(f"L5_CERTIFICATION_FAILED:{name}")


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
    checks: list[str] = []

    def checked(name: str, condition: bool) -> None:
        _require(condition, name)
        checks.append(name)

    for scenario in scenario_matrix():
        snapshot = {**base_snapshot(), **scenario.patch}
        plan = plan_recovery(snapshot)
        checked(f"{scenario.name}:action", plan["next_action"] == scenario.expected_action)
        if scenario.expected_status is not None:
            checked(f"{scenario.name}:status", plan["status"] == scenario.expected_status)
        checked(f"{scenario.name}:plan-read-only", plan["mutation_allowed"] is False)
        record = journal_record(snapshot, plan)
        checked(f"{scenario.name}:journal-read-only", record["mutation_allowed"] is False)
        evidence.append({"scenario": scenario.name, "plan": plan, "journal": record})

    replay_snapshot = {**base_snapshot(), "ci": "FAILURE", "event_id": "cert-replay"}
    first = plan_recovery(replay_snapshot)
    replay = plan_recovery(replay_snapshot, prior_event_keys={first["event_key"]})
    checked("replay:noop", replay["status"] == "REPLAY_NOOP" and replay["next_action"] == "NONE_ALREADY_RECORDED")
    checked("replay:read-only", replay["mutation_allowed"] is False)
    replay_record = journal_record(replay_snapshot, replay)
    checked("replay:journal-read-only", replay_record["mutation_allowed"] is False)

    lost_first = plan_recovery(replay_snapshot)
    lost_second = plan_recovery(replay_snapshot)
    checked("lost-response:deterministic-key", lost_first["event_key"] == lost_second["event_key"])
    checked("lost-response:deterministic-plan", lost_first == lost_second)
    persisted = {**replay_snapshot, "prior_event_keys": [lost_first["event_key"]]}
    persisted_replay = plan_recovery(persisted, prior_event_keys=_prior_event_keys(persisted))
    checked("lost-response:persisted-replay", persisted_replay["status"] == "REPLAY_NOOP")

    for scope, patch in (
        ("CI", {"ci": "FAILURE"}),
        ("REVIEW", {"review": "OUTAGE"}),
        ("STREAM", {"head_current": False}),
    ):
        snap = {**base_snapshot(), **patch, "retry_count": MAX_RETRIES, "retry_action": scope, "event_id": f"cert-exhaust-{scope.lower()}"}
        plan = plan_recovery(snap)
        checked(f"retry-exhaustion:{scope}", plan["status"] == "BLOCKED" and plan["next_action"] == "RETRY_BUDGET_EXHAUSTED")

    reset_plan = plan_recovery({**base_snapshot(), "ci": "FAILURE", "retry_count": MAX_RETRIES, "retry_action": "REVIEW", "event_id": "cert-scope-reset"})
    checked("retry-scope:progress-reset", reset_plan["retry_count"] == 0 and reset_plan["retry_count_after"] == 1 and reset_plan["retry_action_after"] == "CI")

    hold_patches = (
        ("emergency", {"emergency_stop": True}),
        ("human", {"human_only": True}),
        ("blocked", {"blocked": True}),
        ("duplicate", {"active_prs": [900, 901]}),
    )
    for name, patch in hold_patches:
        for count in (2, MAX_RETRIES):
            snap = {**base_snapshot(), "ci": "FAILURE", **patch, "retry_count": count, "retry_action": "CI", "event_id": f"cert-hold-{name}-{count}"}
            plan = plan_recovery(snap)
            checked(f"hold:{name}:{count}", plan["status"] == "BLOCKED" and plan["retry_count"] == count and plan["retry_action"] == "CI")

    merged = {**base_snapshot(), "active_prs": [], "merged": True, "verified": False, "event_id": "cert-verify"}
    checked("verification:required", plan_recovery(merged)["next_action"] == "VERIFY_MERGED_RESULT")
    lingering = {**merged, "active_prs": [900], "event_id": "cert-lingering-pr"}
    checked("verification:lingering-pr", plan_recovery(lingering)["next_action"] == "RECONCILE_POST_MERGE_STREAM_STATE")
    bad_verified = {**merged, "verified": True, "verified_head_sha": "c" * 40, "verified_base_sha": "b" * 40, "event_id": "cert-bad-verified"}
    checked("verification:exact-bound", plan_recovery(bad_verified)["next_action"] == "RECONCILE_VERIFIED_MERGE_EVIDENCE")

    verified = {**merged, "verified": True, "verified_head_sha": "a" * 40, "verified_base_sha": "b" * 40}
    idle = plan_recovery({**verified, "event_id": "cert-idle", "ready_candidates": [
        {"issue": 800, "ready": False, "blocked": False, "human_only": False, "conflict_safe": True},
        {"issue": 801, "ready": True, "blocked": True, "human_only": False, "conflict_safe": True},
        {"issue": 802, "ready": True, "blocked": False, "human_only": True, "conflict_safe": True},
        {"issue": 803, "ready": True, "blocked": False, "human_only": False, "conflict_safe": False},
    ]})
    checked("replenishment:idle-ineligible", idle["status"] == "IDLE" and idle["next_action"] == "IDLE_NO_CONFLICT_SAFE_READY_WORK")
    select = plan_recovery({**verified, "event_id": "cert-select", "ready_candidates": [
        {"issue": 705, "ready": True, "blocked": False, "human_only": False, "conflict_safe": True},
        {"issue": 701, "ready": True, "blocked": False, "human_only": False, "conflict_safe": True},
        {"issue": 703, "ready": True, "blocked": False, "human_only": False, "conflict_safe": True},
    ]})
    checked("replenishment:deterministic-lowest", select["next_action"] == "PLAN_REPLENISH_READY_WU" and select["selected_issue"] == 701)

    unmergeable = plan_recovery({**base_snapshot(), "mergeable": False, "event_id": "cert-unmergeable"})
    checked("merge-gate:mergeability", unmergeable["next_action"] == "RECONCILE_MERGEABILITY")
    threads = plan_recovery({**base_snapshot(), "unresolved_threads": True, "event_id": "cert-threads"})
    checked("merge-gate:threads", threads["next_action"] == "REMEDIATE_SAME_PR_REVIEW")

    mutation_allowed = any(
        item["plan"].get("mutation_allowed") is not False
        or item["journal"].get("mutation_allowed") is not False
        for item in evidence
    ) or replay.get("mutation_allowed") is not False or replay_record.get("mutation_allowed") is not False
    checked("certification:no-mutation", not mutation_allowed)

    return {
        "certified": True,
        "mutation_allowed": mutation_allowed,
        "scenario_count": len(checks),
        "checks": checks,
        "scenarios": evidence,
    }


def main() -> int:
    report = run_certification()
    _require(report["certified"] is True and report["mutation_allowed"] is False, "final-verdict")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
