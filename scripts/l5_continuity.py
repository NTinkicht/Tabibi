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
ISSUE_REF = re.compile(r"(?<![A-Za-z0-9])#([1-9][0-9]{0,5})")


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


def label_names(item: dict) -> set[str]:
    names = set()
    for label in item.get("labels") or []:
        name = label.get("name") if isinstance(label, dict) else label
        if isinstance(name, str):
            names.add(name.lower())
    return names


def active_pr_rows(
    pulls: list[dict], repo: str, base: str, *, count_drafts: bool
) -> list[dict]:
    result = []
    for pr in pulls:
        head_repo = ((pr.get("head") or {}).get("repo") or {}).get("full_name")
        if (
            (pr.get("base") or {}).get("ref") == base
            and head_repo == repo
            and (count_drafts or pr.get("draft") is not True)
            and isinstance(pr.get("number"), int)
        ):
            result.append(pr)
    return sorted(result, key=lambda row: row["number"])


def active_prs(
    pulls: list[dict], repo: str, base: str, *, count_drafts: bool
) -> list[int]:
    return [
        row["number"]
        for row in active_pr_rows(pulls, repo, base, count_drafts=count_drafts)
    ]


def represented_issue_numbers(pulls: list[dict]) -> set[int]:
    represented: set[int] = set()
    for pr in pulls:
        text = f"{pr.get('title') or ''}\n{pr.get('body') or ''}"
        represented.update(int(value) for value in ISSUE_REF.findall(text))
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
    if policy.get("repository") != repo:
        raise RuntimeError("POLICY_REPOSITORY_MISMATCH")
    if policy.get("mutation_mode") != "PLAN_ONLY":
        raise RuntimeError("UNREVIEWED_MUTATION_MODE")
    target = int(policy["target_open_prs"])
    base = str(policy.get("base_branch") or "main")
    count_drafts = policy.get("count_drafts") is True
    pull_rows = active_pr_rows(
        paged(repo, "pulls?state=open"), repo, base, count_drafts=count_drafts
    )
    pulls = [row["number"] for row in pull_rows]
    deficit = max(0, target - len(pulls))
    issues = paged(repo, "issues?state=open")
    candidates = ready_issues(
        issues,
        {x.lower() for x in policy.get("ready_labels", [])},
        {x.lower() for x in policy.get("blocking_labels", [])},
        represented_issue_numbers(pull_rows),
    )
    # L4.1 plans at most one new WU at a time. Additional parallel work needs
    # explicit conflict proof in the next promotion stage.
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
    pulls = [
        {
            "number": 7,
            "draft": False,
            "base": {"ref": "main"},
            "head": {"repo": {"full_name": "NTinkicht/Tabibi"}},
            "body": "Implements #3",
        },
        {
            "number": 8,
            "draft": True,
            "base": {"ref": "main"},
            "head": {"repo": {"full_name": "NTinkicht/Tabibi"}},
        },
    ]
    assert active_prs(pulls, "NTinkicht/Tabibi", "main", count_drafts=True) == [7, 8]
    assert active_prs(pulls, "NTinkicht/Tabibi", "main", count_drafts=False) == [7]
    assert represented_issue_numbers(pulls) == {3}
    issues = [
        {"number": 3, "state": "open", "labels": [{"name": "l4-ready"}]},
        {"number": 4, "state": "open", "labels": [{"name": "l4-ready"}]},
        {
            "number": 2,
            "state": "open",
            "labels": [{"name": "l4-ready"}, {"name": "human-only"}],
        },
    ]
    assert [
        row["number"]
        for row in ready_issues(issues, {"l4-ready"}, {"human-only"}, {3})
    ] == [4]
    print("l5_continuity selftest PASS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return 0
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo:
        raise SystemExit("L5_BLOCKED: GITHUB_REPOSITORY missing")
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    print(json.dumps(reconcile(policy, repo), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
