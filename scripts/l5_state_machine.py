#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

SHA40 = re.compile(r"^[0-9a-f]{40}$")
PASSING_REVIEWS = {"PASS", "PASS_WITH_MINOR_FINDINGS"}
MAX_RETRIES = 3
RETRY_SCOPES = frozenset({"STREAM", "CI", "REVIEW", "MERGE_READY", "VERIFY"})
RECOVERY_ACTION_SCOPES = {
    "START_CANONICAL_STREAM": "STREAM",
    "RECONCILE_CANONICAL_PR": "STREAM",
    "CONTINUE_IMPLEMENTATION": "STREAM",
    "RECONCILE_HEAD_BASE": "STREAM",
    "RECONCILE_EXACT_REFS": "STREAM",
    "RUN_OR_RECONCILE_EXACT_HEAD_CI": "CI",
    "RECONCILE_EXACT_HEAD_CI_EVIDENCE": "CI",
    "REMEDIATE_SAME_PR_CI": "CI",
    "DISPATCH_ELIGIBLE_NONAUTHOR_REVIEW": "REVIEW",
    "FAILOVER_TO_ELIGIBLE_NONAUTHOR_REVIEWER": "REVIEW",
    "RECONCILE_EXACT_HEAD_REVIEW_EVIDENCE": "REVIEW",
    "RECONCILE_REVIEWER_IDENTITY": "REVIEW",
    "RECONCILE_MATERIAL_AUTHORSHIP": "REVIEW",
    "REMEDIATE_SAME_PR_REVIEW": "REVIEW",
    "RECONCILE_MERGEABILITY": "MERGE_READY",
    "VERIFY_MERGED_RESULT": "VERIFY",
    "RECONCILE_VERIFIED_MERGE_EVIDENCE": "VERIFY",
    "RECONCILE_POST_MERGE_STREAM_STATE": "VERIFY",
}


def _required_text(evidence: dict, key: str) -> str:
    value = evidence.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"L5_STATE_MISSING_{key.upper()}")
    return value.strip()


def _required_bool(evidence: dict, key: str) -> bool:
    value = evidence.get(key)
    if type(value) is not bool:
        raise ValueError(f"L5_STATE_{key.upper()}_UNKNOWN")
    return value


def _valid_sha(value: object) -> bool:
    return isinstance(value, str) and bool(SHA40.fullmatch(value))


def _bound_exact_refs(evidence: dict, prefix: str, head: str, base: str) -> bool:
    return evidence.get(f"{prefix}_head_sha") == head and evidence.get(f"{prefix}_base_sha") == base


def reduce_evidence(evidence: dict) -> dict:
    if not isinstance(evidence, dict):
        raise ValueError("L5_STATE_EVIDENCE_INVALID")
    repository = _required_text(evidence, "repository")
    issue = evidence.get("issue")
    if type(issue) is not int or issue < 1:
        raise ValueError("L5_STATE_ISSUE_INVALID")
    emergency_stop = _required_bool(evidence, "emergency_stop")
    human_only = _required_bool(evidence, "human_only")
    blocked = _required_bool(evidence, "blocked")
    merged = _required_bool(evidence, "merged")
    verified = _required_bool(evidence, "verified")
    canonical_pr = evidence.get("canonical_pr")
    if "active_prs" not in evidence:
        raise ValueError("L5_STATE_ACTIVE_PRS_UNKNOWN")
    active_prs = evidence["active_prs"]
    if not isinstance(active_prs, list) or not all(type(v) is int and v > 0 for v in active_prs):
        raise ValueError("L5_STATE_ACTIVE_PRS_INVALID")
    if len(set(active_prs)) != len(active_prs):
        raise ValueError("L5_STATE_ACTIVE_PRS_DUPLICATE")
    result = {"repository": repository, "issue": issue, "canonical_pr": canonical_pr, "state": "SELECTED", "next_action": "START_CANONICAL_STREAM", "mutation_allowed": False}
    if emergency_stop:
        result.update(next_action="EMERGENCY_STOP_HOLD"); return result
    if human_only or blocked:
        result.update(next_action="HUMAN_OR_POLICY_BLOCKED"); return result
    if len(active_prs) > 1:
        result.update(next_action="DUPLICATE_STREAM_RECONCILIATION_REQUIRED"); return result
    if canonical_pr is None:
        if merged:
            result.update(state="VERIFYING", next_action="RECONCILE_CANONICAL_PR")
        elif active_prs:
            result.update(next_action="RECONCILE_CANONICAL_PR")
        return result
    if type(canonical_pr) is not int or canonical_pr < 1:
        raise ValueError("L5_STATE_CANONICAL_PR_INVALID")
    if not merged and active_prs != [canonical_pr]:
        result.update(state="IMPLEMENTING", next_action="RECONCILE_CANONICAL_PR"); return result
    if merged and active_prs:
        result.update(state="VERIFYING", next_action="RECONCILE_POST_MERGE_STREAM_STATE"); return result
    head, base = evidence.get("head_sha"), evidence.get("base_sha")
    if not _valid_sha(head) or not _valid_sha(base):
        result.update(state="IMPLEMENTING", next_action="RECONCILE_EXACT_REFS"); return result
    if _required_bool(evidence, "head_current") is not True or _required_bool(evidence, "base_current") is not True:
        result.update(state="IMPLEMENTING", next_action="RECONCILE_HEAD_BASE"); return result
    if merged:
        if not verified:
            result.update(state="VERIFYING", next_action="VERIFY_MERGED_RESULT"); return result
        if not _bound_exact_refs(evidence, "verified", head, base):
            result.update(state="VERIFYING", next_action="RECONCILE_VERIFIED_MERGE_EVIDENCE"); return result
        result.update(state="COMPLETE", next_action="REPLENISH_NEXT_READY_WU"); return result
    if _required_bool(evidence, "implementation_complete") is not True:
        result.update(state="IMPLEMENTING", next_action="CONTINUE_IMPLEMENTATION"); return result
    ci = evidence.get("ci", "UNKNOWN")
    if ci in {"FAILURE", "CANCELLED", "TIMED_OUT"}:
        result.update(state="REMEDIATING", next_action="REMEDIATE_SAME_PR_CI"); return result
    if ci != "SUCCESS":
        result.update(state="TESTING", next_action="RUN_OR_RECONCILE_EXACT_HEAD_CI"); return result
    if not _bound_exact_refs(evidence, "ci", head, base):
        result.update(state="TESTING", next_action="RECONCILE_EXACT_HEAD_CI_EVIDENCE"); return result
    review = evidence.get("review", "UNKNOWN")
    unresolved_threads = _required_bool(evidence, "unresolved_threads")
    if review in {"CHANGES_REQUESTED", "FINDINGS"} or unresolved_threads:
        result.update(state="REMEDIATING", next_action="REMEDIATE_SAME_PR_REVIEW"); return result
    if review == "OUTAGE":
        result.update(state="REVIEWING", next_action="FAILOVER_TO_ELIGIBLE_NONAUTHOR_REVIEWER"); return result
    if review not in PASSING_REVIEWS:
        result.update(state="REVIEWING", next_action="DISPATCH_ELIGIBLE_NONAUTHOR_REVIEW"); return result
    if not _bound_exact_refs(evidence, "review", head, base):
        result.update(state="REVIEWING", next_action="RECONCILE_EXACT_HEAD_REVIEW_EVIDENCE"); return result
    reviewer, authors = evidence.get("reviewer_actor"), evidence.get("material_authors")
    if not isinstance(reviewer, str) or not reviewer.strip():
        result.update(state="REVIEWING", next_action="RECONCILE_REVIEWER_IDENTITY"); return result
    if not isinstance(authors, list) or not authors or not all(isinstance(a, str) and a.strip() for a in authors):
        result.update(state="REVIEWING", next_action="RECONCILE_MATERIAL_AUTHORSHIP"); return result
    if evidence.get("material_authors_head_sha") != head:
        result.update(state="REVIEWING", next_action="RECONCILE_MATERIAL_AUTHORSHIP"); return result
    if _required_bool(evidence, "review_eligible") is not True or reviewer.strip().lower() in {a.strip().lower() for a in authors}:
        result.update(state="REVIEWING", next_action="DISPATCH_ELIGIBLE_NONAUTHOR_REVIEW"); return result
    if evidence.get("mergeable") is not True:
        result.update(state="REMEDIATING", next_action="RECONCILE_MERGEABILITY"); return result
    result.update(state="MERGE_READY", next_action="AWAIT_AUTHORIZED_EXPECTED_HEAD_MERGE")
    return result


def _event_key(snapshot: dict[str, Any]) -> str:
    event_id = snapshot.get("event_id")
    if not isinstance(event_id, str) or not event_id.strip():
        raise ValueError("L5_RECOVERY_EVENT_ID_INVALID")
    material = {"repository": snapshot.get("repository"), "issue": snapshot.get("issue"), "canonical_pr": snapshot.get("canonical_pr"), "head_sha": snapshot.get("head_sha"), "base_sha": snapshot.get("base_sha"), "event_id": event_id.strip()}
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _retry_state(snapshot: dict[str, Any], action: str) -> tuple[int, str | None]:
    count = snapshot.get("retry_count", 0)
    if type(count) is not int or count < 0:
        raise ValueError("L5_RECOVERY_RETRY_COUNT_INVALID")
    persisted = snapshot.get("retry_action")
    if persisted is not None and (not isinstance(persisted, str) or persisted not in RETRY_SCOPES):
        raise ValueError("L5_RECOVERY_RETRY_ACTION_INVALID")
    if count > 0 and persisted is None:
        raise ValueError("L5_RECOVERY_RETRY_ACTION_REQUIRED")
    current = RECOVERY_ACTION_SCOPES.get(action)
    if current is None:
        return count, persisted
    return (count if persisted == current else 0), persisted


def _eligible_ready_candidates(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    rows = snapshot.get("ready_candidates", [])
    if not isinstance(rows, list):
        raise ValueError("L5_RECOVERY_READY_CANDIDATES_INVALID")
    eligible, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("L5_RECOVERY_READY_CANDIDATE_INVALID")
        issue = row.get("issue")
        if type(issue) is not int or issue < 1 or issue in seen:
            raise ValueError("L5_RECOVERY_READY_CANDIDATE_ID_INVALID")
        seen.add(issue)
        if _required_bool(row, "ready") and not _required_bool(row, "blocked") and not _required_bool(row, "human_only") and _required_bool(row, "conflict_safe"):
            eligible.append(row)
    return sorted(eligible, key=lambda row: row["issue"])


def plan_recovery(snapshot: dict[str, Any], *, prior_event_keys: set[str] | None = None) -> dict[str, Any]:
    if not isinstance(snapshot, dict):
        raise ValueError("L5_RECOVERY_SNAPSHOT_INVALID")
    event_key = _event_key(snapshot)
    if event_key in (prior_event_keys or set()):
        return {"status": "REPLAY_NOOP", "event_key": event_key, "mutation_allowed": False, "next_action": "NONE_ALREADY_RECORDED"}
    state = reduce_evidence(snapshot)
    action = state["next_action"]
    retry_count, persisted_scope = _retry_state(snapshot, action)
    scope = RECOVERY_ACTION_SCOPES.get(action)
    result = {"status": "PLANNED", "event_key": event_key, "repository": state["repository"], "issue": state["issue"], "canonical_pr": state["canonical_pr"], "state": state["state"], "next_action": action, "retry_count": retry_count, "retry_action": scope if scope is not None else persisted_scope, "mutation_allowed": False}
    if action in {"EMERGENCY_STOP_HOLD", "HUMAN_OR_POLICY_BLOCKED", "DUPLICATE_STREAM_RECONCILIATION_REQUIRED"}:
        result["status"] = "BLOCKED"; return result
    if action == "REPLENISH_NEXT_READY_WU":
        candidates = _eligible_ready_candidates(snapshot)
        if not candidates:
            result.update(status="IDLE", next_action="IDLE_NO_CONFLICT_SAFE_READY_WORK", retry_count=0, retry_action=None); return result
        result.update(next_action="PLAN_REPLENISH_READY_WU", selected_issue=candidates[0]["issue"], retry_count=0, retry_action=None); return result
    if scope is not None:
        if retry_count >= MAX_RETRIES:
            result.update(status="BLOCKED", next_action="RETRY_BUDGET_EXHAUSTED"); return result
        result["retry_count_after"] = retry_count + 1
        result["retry_action_after"] = scope
        return result
    if action == "AWAIT_AUTHORIZED_EXPECTED_HEAD_MERGE":
        result.update(status="READY", retry_count=0, retry_action=None); return result
    raise ValueError(f"L5_RECOVERY_UNHANDLED_ACTION:{action}")


def selftest() -> None:
    head, base = "a" * 40, "b" * 40
    evidence = {"repository": "NTinkicht/Tabibi", "issue": 559, "canonical_pr": 562, "active_prs": [562], "head_sha": head, "base_sha": base, "head_current": True, "base_current": True, "implementation_complete": True, "emergency_stop": False, "human_only": False, "blocked": False, "merged": False, "verified": False, "verified_head_sha": None, "verified_base_sha": None, "ci": "SUCCESS", "ci_head_sha": head, "ci_base_sha": base, "review": "PASS", "review_head_sha": head, "review_base_sha": base, "reviewer_actor": "mistral-vibe", "material_authors": ["chatgpt"], "material_authors_head_sha": head, "review_eligible": True, "unresolved_threads": False, "mergeable": True, "retry_count": 0, "retry_action": None, "event_id": "evt-1", "ready_candidates": []}
    assert reduce_evidence(evidence)["state"] == "MERGE_READY"
    assert plan_recovery(evidence)["status"] == "READY"
    red = {**evidence, "ci": "FAILURE"}
    first = plan_recovery(red)
    assert first["retry_action_after"] == "CI"
    assert plan_recovery(red, prior_event_keys={first["event_key"]})["status"] == "REPLAY_NOOP"
    hold = {**red, "emergency_stop": True, "retry_count": 2, "retry_action": "CI"}
    hold_plan = plan_recovery(hold)
    assert hold_plan["status"] == "BLOCKED"
    assert hold_plan["retry_count"] == 2
    assert hold_plan["retry_action"] == "CI"
    try:
        plan_recovery({**red, "retry_count": 3, "retry_action": "garbage"})
        raise AssertionError("unknown retry scope accepted")
    except ValueError:
        pass
    print("l5_state_machine selftest PASS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--input", type=Path)
    args = parser.parse_args()
    if args.selftest:
        selftest(); return 0
    if args.input is None:
        raise SystemExit("--input is required unless --selftest is used")
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    raw_prior = payload.pop("prior_event_keys", [])
    if not isinstance(raw_prior, list) or not all(isinstance(key, str) and re.fullmatch(r"[0-9a-f]{64}", key) for key in raw_prior):
        raise SystemExit("prior_event_keys must be a list of sha256 hex event keys")
    print(json.dumps(plan_recovery(payload, prior_event_keys=set(raw_prior)), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())