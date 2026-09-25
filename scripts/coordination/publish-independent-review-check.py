#!/usr/bin/env python3
"""Publish a fail-closed exact-PR-head check from trusted main, never PR code.

The existing provider-run proof supports only non-material-author Mistral Vibe.
Other providers need separately verified adapters; requests, leases, owner
comments and generic bot acknowledgements are NOT interchangeable with proof.
A GitHub ruleset must REQUIRE this check before it enforces merging.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REPO = "NTinkicht/Tabibi"
CHECK_NAME = "Independent AI review / Verified final head"
SHA = re.compile(r"[a-f0-9]{40}\Z")
PROOF_LINE = re.compile(r"^REVIEW_PROOF_ONLY: PR #([0-9]+) exact_sha=([a-f0-9]{40})$", re.M)
THREADS_QUERY = """query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$after){
        nodes{isResolved}
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}"""


def gh_api(route):
    raw = subprocess.check_output(["gh", "api", route], timeout=30)
    return json.loads(raw)


def pr_numbers(event_name, event):
    if event_name == "workflow_dispatch":
        value = (event.get("inputs") or {}).get("pr_number") or ""
        return [int(value)] if str(value).isascii() and str(value).isdigit() and int(value) > 0 else []
    if event_name == "issue_comment":
        issue = event.get("issue") or {}
        return [issue["number"]] if issue.get("pull_request") and isinstance(issue.get("number"), int) else []
    if event_name == "pull_request":
        pr = event.get("pull_request") or {}
        return [pr["number"]] if isinstance(pr.get("number"), int) else []
    if event_name == "pull_request_review":
        pr = event.get("pull_request") or {}
        return [pr["number"]] if isinstance(pr.get("number"), int) else []
    if event_name == "workflow_run":
        run = event.get("workflow_run") or {}
        if run.get("name") == "CI":
            return sorted({p["number"] for p in run.get("pull_requests", []) if isinstance(p.get("number"), int)})
        # A Mistral Issue #11 wake is not a PR run; bounded discovery is
        # necessary because its run has no pull_requests field.
        if run.get("name") == "Mistral Vibe Wake":
            prs = gh_api(f"repos/{REPO}/pulls?state=open&per_page=100")
            if len(prs) >= 100:
                raise ValueError("Too many open PRs for bounded review scan")
            return [p["number"] for p in prs]
    return []


def native_review_holds(number):
    """Reject unresolved GitHub review requests without accepting them as PASS."""
    for page in range(1, 21):
        batch = gh_api(f"repos/{REPO}/pulls/{number}/reviews?per_page=100&page={page}")
        if not isinstance(batch, list):
            raise ValueError("Review evidence unavailable")
        if any(r.get("state") == "CHANGES_REQUESTED" for r in batch):
            raise ValueError("Unreconciled CHANGES_REQUESTED review")
        if len(batch) < 100:
            return
    raise ValueError("Review history exceeds bound")


def no_open_threads(number):
    after = None
    for _ in range(20):
        args = ["gh", "api", "graphql", "-f", "query=" + THREADS_QUERY,
                "-f", "owner=NTinkicht", "-f", "name=Tabibi",
                "-F", f"number={number}"]
        if after:
            args += ["-f", "after=" + after]
        payload = json.loads(subprocess.check_output(args, timeout=30))
        threads = (((payload.get("data") or {}).get("repository") or {})
                   .get("pullRequest") or {}).get("reviewThreads")
        if not isinstance(threads, dict):
            raise ValueError("Review thread evidence unavailable")
        if any(not node.get("isResolved") for node in threads.get("nodes", [])):
            raise ValueError("Unresolved inline review thread")
        info = threads.get("pageInfo") or {}
        if not info.get("hasNextPage"):
            return
        after = info.get("endCursor")
        if not after:
            raise ValueError("Missing review thread cursor")
    raise ValueError("Review thread history exceeds bound")


def gate(number, sha):
    """Check the real provider proof AND reject outstanding native review holds."""
    spec = importlib.util.spec_from_file_location(
        "trusted_review_pilot", Path("scripts/coordination/independent-review-gate.py")
    )
    if spec is None or spec.loader is None:
        raise ValueError("Trusted verifier unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.evaluate(number) != sha:
        raise ValueError("Stale or absent final-head model proof")
    native_review_holds(number)
    no_open_threads(number)


def check_body(number, sha, passed):
    return {
        "name": CHECK_NAME,
        "head_sha": sha,
        "status": "completed",
        "conclusion": "success" if passed else "failure",
        "output": {
            "title": "Verified independent final-head review" if passed else "Independent review not verified",
            "summary": (
                f"PR #{number} exact head {sha}: "
                + ("provider-run-backed non-author clean PASS, exact-head CI and no native review holds."
                   if passed else
                   "fail closed: missing/stale/adverse proof, CI, provenance, review holds or unavailable evidence. "
                   "A request, lease, comment or CI-only green is not a PASS.")
            ),
        },
    }


def publish(body):
    result = subprocess.run(
        ["gh", "api", "--method", "POST", f"repos/{REPO}/check-runs", "--input", "-"],
        input=json.dumps(body), text=True, capture_output=True, timeout=30,
    )
    if result.returncode:
        raise ValueError("GitHub check-run write failed")


def run():
    if os.environ.get("GITHUB_REPOSITORY") != REPO:
        raise ValueError("Repository mismatch")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    numbers = pr_numbers(os.environ.get("GITHUB_EVENT_NAME", ""), event)
    for number in numbers:
        if not isinstance(number, int) or number <= 0:
            raise ValueError("Invalid PR")
        pr = gh_api(f"repos/{REPO}/pulls/{number}")
        sha = (pr.get("head") or {}).get("sha", "")
        if pr.get("state") != "open":
            continue
        if not SHA.fullmatch(sha) or (pr.get("head", {}).get("repo") or {}).get("full_name") != REPO:
            raise ValueError("Noncanonical PR or SHA")
        passed = False
        try:
            if not pr.get("draft") and (pr.get("base") or {}).get("ref") == "main":
                gate(number, sha)
                passed = True
        except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, json.JSONDecodeError):
            pass  # Lack of provable evidence is a FAILURE check, never success.
        publish(check_body(number, sha, passed))
        print(f"PR #{number} {sha[:12]}: {'VERIFIED' if passed else 'BLOCKED'}")
        # A workflow invocation must itself fail on blocked evidence; the
        # correctly SHA-attached check-run has already been written.
        if not passed:
            raise ValueError("Independent review gate blocked")
    return 0


def selftest():
    sha = "a" * 40
    assert pr_numbers("pull_request", {"pull_request": {"number": 7}}) == [7]
    assert pr_numbers("issue_comment", {"issue": {"number": 7, "pull_request": {}}}) == []
    assert pr_numbers("issue_comment", {"issue": {"number": 7, "pull_request": {"url": "x"}}}) == [7]
    assert pr_numbers("workflow_run", {"workflow_run": {
        "name": "CI", "pull_requests": [{"number": 7}, {"number": 7}]}}) == [7]
    assert not pr_numbers("workflow_run", {"workflow_run": {"name": "CI", "pull_requests": []}})
    assert pr_numbers("workflow_dispatch", {"inputs": {"pr_number": "7"}}) == [7]
    assert not pr_numbers("workflow_dispatch", {"inputs": {"pr_number": "-7"}})
    assert check_body(7, sha, False)["conclusion"] == "failure"
    assert check_body(7, sha, True)["conclusion"] == "success"
    assert check_body(7, sha, False)["head_sha"] == sha
    assert "not a PASS" in check_body(7, sha, False)["output"]["summary"]
    print("Trusted SHA-attached independent-review check selftest passed")


if __name__ == "__main__":
    try:
        raise SystemExit(selftest() or 0 if len(sys.argv) == 2 and sys.argv[1] == "selftest" else run())
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, json.JSONDecodeError):
        print("BLOCKED: independent-review check could not establish its evidence", file=sys.stderr)
        raise SystemExit(1)
