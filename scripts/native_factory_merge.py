#!/usr/bin/env python3
import importlib.util
import json
import os
import re
import subprocess
from pathlib import Path

from native_factory_ruleset_policy import strict_ruleset_enforces

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
MATERIAL_AUTHOR_TRAILER = re.compile(r"(?im)^Material-Author:\s*([a-z0-9_-]+)\s*$")
REVIEWER_ACTORS = {
    "github-actions[bot]": "mistral-vibe",
    "coderabbitai[bot]": "coderabbit",
    "copilot-pull-request-reviewer[bot]": "copilot",
}
L4_AUTH_CHECK = "L4 review authorization"
PLATFORM_CHECKS = CI_JOBS | frozenset({L4_AUTH_CHECK})
RULESET_RESTRICTED_PATHS = frozenset()

# Authority-defining control-plane files cannot be auto-merged by the machinery
# they define. They require the external/manual trusted-gate merge path.
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
    ".github/workflows/l5-continuity-ci.yml",
    ".github/workflows/l5-continuity-supervision.yml",
    ".github/workflows/l5-durable-state-ci.yml",
    ".github/workflows/l5-self-healing-ci.yml",
    ".github/workflows/l5-certification-ci.yml",
    ".github/workflows/mistral-vibe-wake.yml",
    ".github/workflows/native-factory-merge-controller.yml",
    ".github/workflows/l5-write-adapter-ci.yml",
    ".github/workflows/l5-hostile-controller-ci.yml",
    ".l5/control-plane.json",
    "docs/L5-POST-CLAUDE-CUTOVER.md",
    "scripts/l5_control_plane.py",
    "scripts/l5_continuity.py",
    "scripts/l5_continuity_policy.json",
    "scripts/l5_state_machine.py",
    "tests/l5_state_machine.test.py",
    "scripts/l5_recovery.py",
    "tests/l5_recovery.test.py",
    "scripts/l5_certification.py",
    "tests/l5_certification.test.py",
    "scripts/l5_write_adapter.py",
    "tests/l5_write_adapter.test.py",
    "tests/test_l5_control_plane.py",
    "tests/fixtures/l5-control-plane-active.json",
    "scripts/l5_kernel.py",
    "scripts/l5_ledger.py",
    "scripts/l5_ledger_store.py",
    "scripts/l5_controller.py",
    "scripts/l5_hostile_sim.py",
    "scripts/l5_intent_hostile_sim.py",
    "tests/test_l5_kernel.py",
    "tests/test_l5_ledger.py",
    "tests/test_l5_ledger_store.py",
    "tests/test_l5_controller.py",
    "tests/test_l5_intent_restraint.py",
    "tests/test_l5_ledger_takeover.py",
    "docs/L5-STATE-MACHINE-V1.md",
    "docs/L5-INTENT-RESTRAINT-V1.1.md",
    "scripts/mistral-review-target.py",
    "scripts/coordination/mistral-review-proof.py",
    "scripts/coordination/publish-mistral-review.py",
    "scripts/coordination/grok-review-proof.py",
    "scripts/coordination/grok-review-attestation.mjs",
    "scripts/native_factory_merge.py",
    "scripts/native_factory_ruleset_policy.py",
    "tests/test_native_factory_ruleset_policy.py",
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
    payload = gh(f"repos/{REPO}/actions/runs?head_sha={sha}&event=pull_request&per_page=100")
    runs = [
        run for run in payload.get("workflow_runs", [])
        if run.get("head_sha") == sha
        and run.get("event") == "pull_request"
        and run.get("name") == CI_WORKFLOW_NAME
        and run.get("path") == ".github/workflows/ci.yml"
    ]
    if not runs:
        return None
    return max(runs, key=lambda run: run.get("run_number", 0))


def ci_is_green(sha):
    run = latest_ci_run(sha)
    if not run or run.get("status") != "completed" or run.get("conclusion") != "success":
        return False
    jobs = gh(f"repos/{REPO}/actions/runs/{run['id']}/jobs?per_page=100").get("jobs", [])
    conclusions = {job.get("name"): job.get("conclusion") for job in jobs}
    return all(conclusions.get(name) == "success" for name in CI_JOBS)


def main():
    pr = EVENT.get("pull_request") or {}
    number = pr.get("number") or EVENT.get("number")
    if not number:
        raise RuntimeError("PR_NUMBER_MISSING")
    pr = gh(f"repos/{REPO}/pulls/{number}")
    sha = pr["head"]["sha"]
    if changed_paths(number) & TRUSTED_GATE_PATHS:
        print(f"PR #{number}: TRUSTED_GATE_CHANGE_REQUIRES_EXTERNAL_MERGE")
        return
    if pr.get("draft"):
        print(f"PR #{number}: DRAFT")
        return
    if pr.get("mergeable") is not True:
        print(f"PR #{number}: NOT_CURRENTLY_MERGEABLE")
        return
    if unresolved_threads(number):
        print(f"PR #{number}: UNRESOLVED_REVIEW_THREADS")
        return
    if not ci_is_green(sha):
        print(f"PR #{number}: CI_NOT_GREEN")
        return
    print(f"PR #{number}: READY_FOR_EXTERNAL_MERGE head={sha}")


if __name__ == "__main__":
    main()
