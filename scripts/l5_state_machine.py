#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

SHA40 = re.compile(r"^[0-9a-f]{40}$")
PASSING_REVIEWS = {"PASS", "PASS_WITH_MINOR_FINDINGS"}


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

    result = {
        "repository": repository,
        "issue": issue,
        "canonical_pr": canonical_pr,
        "state": "SELECTED",
        "next_action": "START_CANONICAL_STREAM",
        "mutation_allowed": False,
    }
    if emergency_stop:
        result.update(next_action="EMERGENCY_STOP_HOLD")
        return result
    if human_only or blocked:
        result.update(next_action="HUMAN_OR_POLICY_BLOCKED")
        return result
    if len(active_prs) > 1:
        result.update(next_action="DUPLICATE_STREAM_RECONCILIATION_REQUIRED")
        return result
    if canonical_pr is None:
        if merged:
            result.update(state="VERIFYING", next_action="RECONCILE_CANONICAL_PR")
        elif active_prs:
            result.update(next_action="RECONCILE_CANONICAL_PR")
        return result
    if type(canonical_pr) is not int or canonical_pr < 1:
        raise ValueError("L5_STATE_CANONICAL_PR_INVALID")
    if not merged and active_prs != [canonical_pr]:
        result.update(state="IMPLEMENTING", next_action="RECONCILE_CANONICAL_PR")
        return result
    if merged and active_prs:
        result.update(state="VERIFYING", next_action="RECONCILE_POST_MERGE_STREAM_STATE")
        return result

    head, base = evidence.get("head_sha"), evidence.get("base_sha")
    if not _valid_sha(head) or not _valid_sha(base):
        result.update(state="IMPLEMENTING", next_action="RECONCILE_EXACT_REFS")
        return result
    if _required_bool(evidence, "head_current") is not True or _required_bool(evidence, "base_current") is not True:
        result.update(state="IMPLEMENTING", next_action="RECONCILE_HEAD_BASE")
        return result

    if merged:
        if not verified:
            result.update(state="VERIFYING", next_action="VERIFY_MERGED_RESULT")
            return result
        if not _bound_exact_refs(evidence, "verified", head, base):
            result.update(state="VERIFYING", next_action="RECONCILE_VERIFIED_MERGE_EVIDENCE")
            return result
        result.update(state="COMPLETE", next_action="REPLENISH_NEXT_READY_WU")
        return result

    if _required_bool(evidence, "implementation_complete") is not True:
        result.update(state="IMPLEMENTING", next_action="CONTINUE_IMPLEMENTATION")
        return result

    ci = evidence.get("ci", "UNKNOWN")
    if ci in {"FAILURE", "CANCELLED", "TIMED_OUT"}:
        result.update(state="REMEDIATING", next_action="REMEDIATE_SAME_PR_CI")
        return result
    if ci != "SUCCESS":
        result.update(state="TESTING", next_action="RUN_OR_RECONCILE_EXACT_HEAD_CI")
        return result
    if not _bound_exact_refs(evidence, "ci", head, base):
        result.update(state="TESTING", next_action="RECONCILE_EXACT_HEAD_CI_EVIDENCE")
        return result

    review = evidence.get("review", "UNKNOWN")
    unresolved_threads = _required_bool(evidence, "unresolved_threads")
    if review in {"CHANGES_REQUESTED", "FINDINGS"} or unresolved_threads:
        result.update(state="REMEDIATING", next_action="REMEDIATE_SAME_PR_REVIEW")
        return result
    if review == "OUTAGE":
        result.update(state="REVIEWING", next_action="FAILOVER_TO_ELIGIBLE_NONAUTHOR_REVIEWER")
        return result
    if review not in PASSING_REVIEWS:
        result.update(state="REVIEWING", next_action="DISPATCH_ELIGIBLE_NONAUTHOR_REVIEW")
        return result
    if not _bound_exact_refs(evidence, "review", head, base):
        result.update(state="REVIEWING", next_action="RECONCILE_EXACT_HEAD_REVIEW_EVIDENCE")
        return result

    reviewer = evidence.get("reviewer_actor")
    authors = evidence.get("material_authors")
    if not isinstance(reviewer, str) or not reviewer.strip():
        result.update(state="REVIEWING", next_action="RECONCILE_REVIEWER_IDENTITY")
        return result
    if not isinstance(authors, list) or not authors or not all(isinstance(a, str) and a.strip() for a in authors):
        result.update(state="REVIEWING", next_action="RECONCILE_MATERIAL_AUTHORSHIP")
        return result
    if evidence.get("material_authors_head_sha") != head:
        result.update(state="REVIEWING", next_action="RECONCILE_MATERIAL_AUTHORSHIP")
        return result
    if _required_bool(evidence, "review_eligible") is not True or reviewer.strip().lower() in {a.strip().lower() for a in authors}:
        result.update(state="REVIEWING", next_action="DISPATCH_ELIGIBLE_NONAUTHOR_REVIEW")
        return result
    if evidence.get("mergeable") is not True:
        result.update(state="REMEDIATING", next_action="RECONCILE_MERGEABILITY")
        return result
    result.update(state="MERGE_READY", next_action="AWAIT_AUTHORIZED_EXPECTED_HEAD_MERGE")
    return result


def selftest() -> None:
    head, base = "a" * 40, "b" * 40
    evidence = {
        "repository": "NTinkicht/Tabibi", "issue": 559, "canonical_pr": 562,
        "active_prs": [562], "head_sha": head, "base_sha": base,
        "head_current": True, "base_current": True, "implementation_complete": True,
        "emergency_stop": False, "human_only": False, "blocked": False,
        "merged": False, "verified": False, "verified_head_sha": None, "verified_base_sha": None,
        "ci": "SUCCESS", "ci_head_sha": head, "ci_base_sha": base,
        "review": "PASS", "review_head_sha": head, "review_base_sha": base,
        "reviewer_actor": "mistral-vibe", "material_authors": ["chatgpt"],
        "material_authors_head_sha": head, "review_eligible": True,
        "unresolved_threads": False, "mergeable": True,
    }
    assert reduce_evidence(evidence)["state"] == "MERGE_READY"
    assert reduce_evidence({**evidence, "review": "PASS_WITH_MINOR_FINDINGS"})["state"] == "MERGE_READY"
    assert reduce_evidence({**evidence, "material_authors_head_sha": "c" * 40})["next_action"] == "RECONCILE_MATERIAL_AUTHORSHIP"
    assert reduce_evidence({**evidence, "canonical_pr": None, "active_prs": [], "merged": True})["next_action"] == "RECONCILE_CANONICAL_PR"
    print("l5_state_machine selftest PASS")


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
    print(json.dumps(reduce_evidence(json.loads(args.input.read_text(encoding="utf-8"))), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
