#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

POLICY_PATH = Path("scripts/l5_continuity_policy.json")
MAX_PAGES = 10
WORK_REF = re.compile(
    r"(?i)\b(?:implements?|closes?|fixes?|resolves?|tracks?)\s+#([1-9][0-9]{0,5})(?![0-9])"
)
MANDATORY_BLOCKING_LABELS = {"l4-blocked", "human-only", "release-go-no-go"}


def gh(path: str):
    result = subprocess.run(["gh", "api", path], text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"GitHub API failed: {path}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def paged(repo: str, path: str):
    items = []
    for page in range(1, MAX_PAGES + 1):
        sep = "&" if "?" in path else "?"
        batch = gh(f"repos/{repo}/{path}{sep}per_page=100&page={page}")
        if not isinstance(batch, list):
            raise RuntimeError("PAGINATED_RESPONSE_INVALID")
        items.extend(batch)
        if len(batch) < 100:
            return items
    raise RuntimeError("PAGINATION_BOUND_EXCEEDED")


def validate_policy(policy: dict, repo: str) -> None:
    if not isinstance(policy, dict):
        raise RuntimeError("L5_POLICY_INVALID")
    if policy.get("schema_version") != "1.0":
        raise RuntimeError("L5_POLICY_SCHEMA_INVALID")
    if policy.get("level") != "L5_CANDIDATE" or policy.get("phase") != "L4.1_CONTINUITY":
        raise RuntimeError("L5_POLICY_PHASE_INVALID")
    if policy.get("repository") != repo:
        raise RuntimeError("POLICY_REPOSITORY_MISMATCH")
    if policy.get("mutation_mode") != "PLAN_ONLY":
        raise RuntimeError("UNREVIEWED_MUTATION_MODE")
    if policy.get("base_branch") != "main" or type(policy.get("count_drafts")) is not bool:
        raise RuntimeError("L5_POLICY_QUOTA_INVALID")
    target = policy.get("target_open_prs")
    if type(target) is not int or not 1 <= target <= 8:
        raise RuntimeError("L5_POLICY_QUOTA_INVALID")
    if policy.get("ready_labels") != ["l4-ready"]:
        raise RuntimeError("L5_POLICY_READY_LABEL_INVALID")
    blocking = policy.get("blocking_labels")
    if not isinstance(blocking, list) or not all(
        isinstance(value, str) and value for value in blocking
    ):
        raise RuntimeError("L5_POLICY_BLOCKING_LABELS_INVALID")
    if not MANDATORY_BLOCKING_LABELS.issubset({value.lower() for value in blocking}):
        raise RuntimeError("L5_POLICY_MANDATORY_BLOCKING_LABELS_MISSING")


def label_names(item: dict) -> set[str]:
    names = set()
    for label in item.get("labels") or []:
        name = label.get("name") if isinstance(label, dict) else label
        if isinstance(name, str):
            names.add(name.lower())
    return names


def internal_pr_rows(pulls: list[dict], repo: str, base: str) -> list[dict]:
    result = []
    for pr in pulls:
        head_repo = ((pr.get("head") or {}).get("repo") or {}).get("full_name")
        if (
            (pr.get("base") or {}).get("ref") == base
            and head_repo == repo
            and isinstance(pr.get("number"), int)
        ):
            result.append(pr)
    return sorted(result, key=lambda row: row["number"])


def quota_pr_rows(pulls: list[dict], *, count_drafts: bool) -> list[dict]:
    return [row for row in pulls if count_drafts or row.get("draft") is not True]


def represented_issue_numbers(pulls: list[dict], repo: str) -> set[int]:
    represented: set[int] = set()
    url_ref = re.compile(
        rf"(?i)\b(?:implements?|closes?|fixes?|resolves?|tracks?)\s+"
        rf"https://github\.com/{re.escape(repo)}/issues/([1-9][0-9]{{0,5}})(?![0-9])"
    )
    for pr in pulls:
        text = f"{pr.get('title') or ''}\n{pr.get('body') or ''}"
        represented.update(int(value) for value in WORK_REF.findall(text))
        represented.update(int(value) for value in url_ref.findall(text))
    return represented


def ready_issues(
    issues: list[dict], ready: set[str], blocked: set[str], represented: set[int]
) -> list[dict]:
    result = []
    for issue in issues:
        number = issue.get("number")
        if (
            issue.get("pull_request") is not None
            or issue.get("state") != "open"
            or not isinstance(number, int)
            or number in represented
        ):
            continue
        labels = label_names(issue)
        if not labels.intersection(ready) or labels.intersection(blocked):
            continue
        result.append(issue)
    return sorted(result, key=lambda row: row["number"])


def reconcile(policy: dict, repo: str) -> dict:
    validate_policy(policy, repo)
    target = int(policy["target_open_prs"])
    base = str(policy["base_branch"])
    all_rows = internal_pr_rows(paged(repo, "pulls?state=open"), repo, base)
    quota_rows = quota_pr_rows(all_rows, count_drafts=policy["count_drafts"])
    pulls = [row["number"] for row in quota_rows]
    deficit = max(0, target - len(pulls))
    candidates = ready_issues(
        paged(repo, "issues?state=open"),
        {x.lower() for x in policy["ready_labels"]},
        {x.lower() for x in policy["blocking_labels"]},
        represented_issue_numbers(all_rows, repo),
    )
    selected = candidates[:1] if deficit else []
    unfilled = max(0, deficit - len(selected))
    if deficit == 0:
        status = "QUOTA_SATISFIED"
    elif selected:
        status = "REPLENISHMENT_PLANNED_CONFLICT_CHECK_REQUIRED_FOR_MORE"
    else:
        status = "IDLE_CAPACITY_NO_READY_WORK"
    return {
        "repository": repo,
        "phase": policy["phase"],
        "mutation_mode": policy["mutation_mode"],
        "target_open_prs": target,
        "active_prs": pulls,
        "deficit": deficit,
        "selected_ready_issues": [
            {"number": row["number"], "title": row.get("title")} for row in selected
        ],
        "unfilled_slots": unfilled,
        "status": status,
    }


def selftest() -> None:
    repo = "NTinkicht/Tabibi"
    pulls = [
        {
            "number": 7,
            "draft": False,
            "base": {"ref": "main"},
            "head": {"repo": {"full_name": repo}},
            "body": "Implements #3. Follow-up work remains in #9.",
        },
        {
            "number": 8,
            "draft": True,
            "base": {"ref": "main"},
            "head": {"repo": {"full_name": repo}},
            "body": "Closes https://github.com/NTinkicht/Tabibi/issues/5",
        },
    ]
    all_rows = internal_pr_rows(pulls, repo, "main")
    assert [row["number"] for row in quota_pr_rows(all_rows, count_drafts=True)] == [7, 8]
    assert [row["number"] for row in quota_pr_rows(all_rows, count_drafts=False)] == [7]
    assert represented_issue_numbers(all_rows, repo) == {3, 5}
    issues = [
        {"number": 3, "state": "open", "labels": [{"name": "l4-ready"}]},
        {"number": 4, "state": "open", "labels": [{"name": "l4-ready"}]},
        {"number": 5, "state": "open", "labels": [{"name": "l4-ready"}]},
        {
            "number": 2,
            "state": "open",
            "labels": [{"name": "l4-ready"}, {"name": "human-only"}],
        },
    ]
    assert [
        row["number"]
        for row in ready_issues(issues, {"l4-ready"}, {"human-only"}, {3, 5})
    ] == [4]
    print("l5_continuity selftest PASS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--validate-policy", action="store_true")
    args = parser.parse_args()
    repo = os.environ.get("GITHUB_REPOSITORY", "NTinkicht/Tabibi")
    if args.selftest:
        selftest()
        return 0
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    if args.validate_policy:
        validate_policy(policy, repo)
        print("l5_continuity policy PASS")
        return 0
    if not os.environ.get("GITHUB_REPOSITORY"):
        raise SystemExit("L5_BLOCKED: GITHUB_REPOSITORY missing")
    print(json.dumps(reconcile(policy, repo), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
