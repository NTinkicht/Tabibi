#!/usr/bin/env python3
import importlib.util
import json
import os
import re
import subprocess
import zipfile
from pathlib import Path

REPO = os.environ["GITHUB_REPOSITORY"]
OWNER, NAME = REPO.split("/", 1)
EVENT = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
CI_WORKFLOW_NAME = "CI"
CI_JOBS = frozenset({"Quality and build", "PostgreSQL integration", "Browser smoke"})
MAX_PAGES = 10
MISTRAL_NATIVE_REVIEW = re.compile(
    r"<!-- tabibi-mistral-native-v1 run=([0-9]{1,15}) "
    r"report=([0-9]{1,15}) sha=([a-f0-9]{40}) -->"
)
TRUSTED_EXTERNAL_REVIEWERS = frozenset({
    "coderabbitai[bot]",
    "copilot-pull-request-reviewer[bot]",
})

# Changes to the machinery that proves CI/review provenance are never auto-merged
# by that same machinery. They require the normal external/manual merge path.
TRUSTED_GATE_PATHS = frozenset({
    "AGENTS.md",
    "coordination/AUTONOMY_PROTOCOL.md",
    "coordination/ROLE_FAILOVER_PROTOCOL.md",
    "coordination/COLLABORATION_PROTOCOL.md",
    "coordination/COMPANY_OPERATING_SYSTEM.md",
    "coordination/WORK_UNIT_TEMPLATE.md",
    "coordination/AI_CAPACITY_POLICY.md",
    "coordination/ACTOR_REGISTRY.json",
    ".github/workflows/ci.yml",
    ".github/workflows/mistral-vibe-wake.yml",
    ".github/workflows/native-factory-merge-controller.yml",
    "scripts/mistral-review-target.py",
    "scripts/coordination/mistral-review-proof.py",
    "scripts/coordination/publish-mistral-review.py",
    "scripts/coordination/grok-review-proof.py",
    "scripts/coordination/grok-review-attestation.mjs",
    "scripts/native_factory_merge.py",
})


def gh(path, method=None, fields=None):
    command = ["gh", "api"]
    if method:
        command += ["-X", method]
    if fields:
        for key, value in fields.items():
            command += ["-f", f"{key}={value}"]
    command.append(path)
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"GitHub API failed: {path}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def paged_rest(path):
    items = []
    for page in range(1, MAX_PAGES + 1):
        separator = "&" if "?" in path else "?"
        batch = gh(f"{path}{separator}per_page=100&page={page}")
        if not isinstance(batch, list):
            raise RuntimeError("PAGINATED_RESPONSE_INVALID")
        items.extend(batch)
        if len(batch) < 100:
            return items
    raise RuntimeError("PAGINATION_BOUND_EXCEEDED")


def changed_paths(number):
    paths = set()
    for item in paged_rest(f"repos/{REPO}/pulls/{number}/files"):
        if not isinstance(item, dict):
            continue
        filename = item.get("filename")
        previous = item.get("previous_filename")
        if isinstance(filename, str):
            paths.add(filename)
        if isinstance(previous, str):
            paths.add(previous)
    return paths


def all_reviews(number):
    return paged_rest(f"repos/{REPO}/pulls/{number}/reviews")


def unresolved_threads(number):
    cursor = None
    for _ in range(MAX_PAGES):
        query = """query($owner:String!,$name:String!,$number:Int!,$after:String){
          repository(owner:$owner,name:$name){
            pullRequest(number:$number){
              reviewThreads(first:100,after:$after){
                nodes{isResolved}
                pageInfo{hasNextPage endCursor}
              }
            }
          }
        }"""
        command = [
            "gh", "api", "graphql",
            "-F", f"owner={OWNER}", "-F", f"name={NAME}",
            "-F", f"number={number}", "-f", f"query={query}",
        ]
        if cursor:
            command += ["-F", f"after={cursor}"]
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        if result.returncode:
            raise RuntimeError("REVIEW_THREAD_RECONCILIATION_UNAVAILABLE")
        connection = json.loads(result.stdout)["data"]["repository"]["pullRequest"]["reviewThreads"]
        if any(not node.get("isResolved") for node in connection["nodes"]):
            return True
        page = connection["pageInfo"]
        if not page.get("hasNextPage"):
            return False
        cursor = page.get("endCursor")
        if not cursor:
            raise RuntimeError("REVIEW_THREAD_CURSOR_MISSING")
    raise RuntimeError("REVIEW_THREAD_PAGE_BOUND_EXCEEDED")


def latest_ci_run(sha):
    payload = gh(
        f"repos/{REPO}/actions/runs?head_sha={sha}&event=pull_request&per_page=100"
    )
    runs = [
        run for run in payload.get("workflow_runs", [])
        if run.get("head_sha") == sha
        and run.get("event") == "pull_request"
        and run.get("name") == CI_WORKFLOW_NAME
        and run.get("path") == ".github/workflows/ci.yml"
    ]
    if not runs:
        return None
    return max(
        runs,
        key=lambda run: (
            run.get("run_number") or 0,
            run.get("run_attempt") or 0,
            run.get("id") or 0,
        ),
    )


def latest_ci_green(sha):
    run = latest_ci_run(sha)
    if (
        not run
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
    ):
        return False
    jobs = gh(
        f"repos/{REPO}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100"
    ).get("jobs", [])
    latest_by_name = {}
    for job in jobs:
        name = job.get("name")
        if name in CI_JOBS:
            previous = latest_by_name.get(name)
            if previous is None or (job.get("id") or 0) > (previous.get("id") or 0):
                latest_by_name[name] = job
    return all(
        latest_by_name.get(name, {}).get("status") == "completed"
        and latest_by_name.get(name, {}).get("conclusion") == "success"
        for name in CI_JOBS
    )


def mistral_proof_reader():
    path = Path("scripts/coordination/mistral-review-proof.py")
    spec = importlib.util.spec_from_file_location("trusted_mistral_proof", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("MISTRAL_REVIEW_PROOF_HELPER_UNAVAILABLE")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def authenticated_mistral_approval(review, number, sha):
    """Verify the native approval against the trusted run-sealed Mistral proof.

    This replaces the removed verifier check-run without trusting a generic
    github-actions[bot] approval. The proof artifact, immutable Issue #11
    report, workflow identity, PR number and exact head must all agree.
    """
    body = review.get("body") or ""
    markers = MISTRAL_NATIVE_REVIEW.findall(body)
    if len(markers) != 1:
        return False
    run_id, report_id, marker_sha = markers[0]
    if marker_sha != sha:
        return False
    try:
        run = gh(f"repos/{REPO}/actions/runs/{run_id}")
        if (
            run.get("name") != "Mistral Vibe Wake"
            or run.get("path") != ".github/workflows/mistral-vibe-wake.yml"
            or run.get("head_branch") != "main"
            or run.get("event") not in {"issue_comment", "workflow_run"}
            or run.get("status") != "completed"
            or run.get("conclusion") != "success"
            or run.get("head_repository", {}).get("full_name") != REPO
        ):
            return False
        proof_reader = mistral_proof_reader()
        proof = proof_reader.read_run_proof(run_id)
        if (
            str(proof.get("run_id")) != run_id
            or str(proof.get("report_id")) != report_id
            or str(proof.get("pr")) != str(number)
            or proof.get("sha") != sha
            or proof.get("verdict") != "PASS"
        ):
            return False
        # Re-authenticate the immutable Issue #11 report and its digest.
        proof_reader.sealed_report(proof)
        return True
    except (
        RuntimeError, ValueError, TypeError, KeyError, OSError, ImportError,
        AttributeError, subprocess.SubprocessError, json.JSONDecodeError,
        zipfile.BadZipFile,
    ):
        return False


def eligible_approval(review, number, sha, author):
    if review.get("state") != "APPROVED" or review.get("commit_id") != sha:
        return False
    user = review.get("user") or {}
    login = user.get("login", "").lower()
    if not login or login == author:
        return False
    if login == "github-actions[bot]":
        return authenticated_mistral_approval(review, number, sha)
    if user.get("type") != "Bot":
        return True
    return login in TRUSTED_EXTERNAL_REVIEWERS


def review_gate_clean(number, sha, author):
    reviews = all_reviews(number)
    approvals = [
        review for review in reviews
        if eligible_approval(review, number, sha, author)
    ]
    adverse = [
        review for review in reviews
        if review.get("state") == "CHANGES_REQUESTED"
        and review.get("commit_id") == sha
    ]
    return bool(approvals) and not adverse and not unresolved_threads(number)


def candidate_numbers():
    # Direct review events preserve their PR. Chained workflow_run events from
    # trusted-main workflows frequently do not, so reconcile all open same-repo
    # PRs rather than losing the reviewed PR after CI -> reviewer -> verifier.
    if os.environ["GITHUB_EVENT_NAME"] == "pull_request_review":
        number = EVENT.get("pull_request", {}).get("number")
        return [int(number)] if number else []
    pulls = paged_rest(f"repos/{REPO}/pulls?state=open")
    return [
        int(pr["number"])
        for pr in pulls
        if not pr.get("draft")
        and pr.get("base", {}).get("ref") == "main"
        and pr.get("head", {}).get("repo", {}).get("full_name") == REPO
    ]


def gates(number):
    pr = gh(f"repos/{REPO}/pulls/{number}")
    if pr.get("state") != "open" or pr.get("draft"):
        return None
    if pr.get("base", {}).get("ref") != "main":
        return None
    if pr.get("head", {}).get("repo", {}).get("full_name") != REPO:
        return None

    sha = pr["head"]["sha"]
    if changed_paths(number) & TRUSTED_GATE_PATHS:
        print(f"PR #{number}: TRUSTED_GATE_CHANGE_REQUIRES_EXTERNAL_MERGE")
        return None
    if not latest_ci_green(sha):
        print(f"PR #{number}: LATEST_EXACT_HEAD_CI_NOT_GREEN")
        return None
    author = pr.get("user", {}).get("login", "").lower()
    if not review_gate_clean(number, sha, author):
        print(f"PR #{number}: INDEPENDENT_REVIEW_OR_THREADS_NOT_CLEAN")
        return None
    return pr, sha, author


for number in candidate_numbers():
    first = gates(number)
    if not first:
        continue
    _, sha, author = first

    # Close the review/thread race as tightly as the REST merge API permits:
    # re-fetch the unchanged PR and repeat every custom review gate immediately
    # before the expected-head merge request.
    pr = gh(f"repos/{REPO}/pulls/{number}")
    if (
        pr.get("state") != "open"
        or pr.get("head", {}).get("sha") != sha
        or pr.get("mergeable") is not True
    ):
        print(f"PR #{number}: HEAD_MOVED_OR_NOT_MERGEABLE")
        continue
    if not latest_ci_green(sha):
        print(f"PR #{number}: FINAL_CI_CHANGED")
        continue
    if not review_gate_clean(number, sha, author):
        print(f"PR #{number}: FINAL_REVIEW_RECHECK_BLOCKED")
        continue

    merged = gh(
        f"repos/{REPO}/pulls/{number}/merge",
        method="PUT",
        fields={"sha": sha, "merge_method": "squash"},
    )
    if not merged.get("merged"):
        raise RuntimeError(f"MERGE_REJECTED PR #{number}")
    print(f"NATIVE_FACTORY_MERGED PR #{number} exact head {sha}")
