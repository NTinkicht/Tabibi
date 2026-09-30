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
MATERIAL_AUTHOR_TRAILER = re.compile(
    r"(?im)^Material-Author:\s*([a-z0-9_-]+)\s*$"
)
REVIEWER_ACTORS = {
    "github-actions[bot]": "mistral-vibe",
    "coderabbitai[bot]": "coderabbit",
    "copilot-pull-request-reviewer[bot]": "copilot",
}
L4_AUTH_CHECK = "L4 review authorization"
PLATFORM_CHECKS = CI_JOBS | frozenset({L4_AUTH_CHECK})
RULESET_RESTRICTED_PATHS = frozenset()

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
    ".github/workflows/l5-continuity-ci.yml",
    ".github/workflows/l5-continuity-supervision.yml",
    ".github/workflows/mistral-vibe-wake.yml",
    ".github/workflows/native-factory-merge-controller.yml",
    "scripts/l5_continuity.py",
    "scripts/l5_continuity_policy.json",
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
    """Load the trusted run-sealed Mistral proof verifier from the repository."""
    path = Path("scripts/coordination/mistral-review-proof.py")
    spec = importlib.util.spec_from_file_location("trusted_mistral_proof", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("MISTRAL_REVIEW_PROOF_HELPER_UNAVAILABLE")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expected_mistral_native_body(number, sha, run_id, report_id):
    """Return the exact body emitted by the trusted Mistral review publisher."""
    marker = f"tabibi-mistral-native-v1 run={run_id} report={report_id} sha={sha}"
    return (
        "Authenticated independent Mistral Vibe exact-head technical PASS.\n\n"
        f"PR #{number}; exact head {sha}.\n"
        f"Run: https://github.com/{REPO}/actions/runs/{run_id}\n"
        f"Immutable evidence: https://github.com/{REPO}/issues/11#issuecomment-{report_id}\n\n"
        "A run-sealed, independently executed, non-material-author PASS was verified "
        "against the unchanged current PR and green 3/3 CI by the trusted parent. "
        "This native review does not authorize merge without all other Tabibi gates.\n\n"
        f"<!-- {marker} -->"
    )


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
    if (
        marker_sha != sha
        or body != expected_mistral_native_body(number, sha, run_id, report_id)
    ):
        return False
    try:
        run = gh(f"repos/{REPO}/actions/runs/{run_id}")
        workflow_path = run.get("path") or ""
        workflow_file, separator, workflow_ref = workflow_path.partition("@")
        if (
            run.get("name") != "Mistral Vibe Wake"
            or workflow_file != ".github/workflows/mistral-vibe-wake.yml"
            or (separator and workflow_ref != "main")
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
    except Exception:
        # A malformed trusted helper or unexpected proof-verification failure
        # makes this approval ineligible; it must not abort reconciliation of
        # unrelated candidate PRs.
        return False


def cumulative_material_authors(number, sha):
    pr = gh(f"repos/{REPO}/pulls/{number}")
    expected = pr.get("commits")
    commits = paged_rest(f"repos/{REPO}/pulls/{number}/commits")
    if (
        type(expected) is not int
        or expected < 1
        or expected > 250
        or len(commits) != expected
        or commits[-1].get("sha") != sha
    ):
        return set()
    actors = set()
    for commit in commits:
        tags = MATERIAL_AUTHOR_TRAILER.findall(
            (commit.get("commit") or {}).get("message", "")
        )
        if len(tags) > 1:
            return set()
        if tags:
            actors.add(tags[0].lower())
            continue
        login = ((commit.get("author") or {}).get("login") or "").lower()
        if not login:
            return set()
        actors.add(f"github:{login}")
    return actors


def reviewer_actor(review):
    login = ((review.get("user") or {}).get("login") or "").lower()
    return REVIEWER_ACTORS.get(login, f"github:{login}" if login else "")


def l4_authorization_green(sha):
    payload = gh(f"repos/{REPO}/commits/{sha}/check-runs?per_page=100")
    candidates = [
        item for item in payload.get("check_runs", [])
        if item.get("name") == L4_AUTH_CHECK
        and (item.get("app") or {}).get("id") == 15368
    ]
    if not candidates:
        return False
    latest = max(candidates, key=lambda item: item.get("id") or 0)
    return (
        latest.get("status") == "completed"
        and latest.get("conclusion") == "success"
        and latest.get("head_sha") == sha
    )


def eligible_approval(review, number, sha, material_authors):
    """Accept only exact-head approvals independent of every material author."""
    if review.get("state") != "APPROVED" or review.get("commit_id") != sha:
        return False
    user = review.get("user") or {}
    login = user.get("login", "").lower()
    actor = reviewer_actor(review)
    if not login or not actor or actor in material_authors:
        return False
    if login == "github-actions[bot]":
        return authenticated_mistral_approval(review, number, sha)
    if user.get("type") != "Bot":
        return True
    return login in TRUSTED_EXTERNAL_REVIEWERS


def review_gate_clean(number, sha):
    """Require one exact-head approval independent of cumulative material authors."""
    material_authors = cumulative_material_authors(number, sha)
    if not material_authors:
        return False
    reviews = all_reviews(number)
    approvals = [
        review for review in reviews
        if eligible_approval(review, number, sha, material_authors)
    ]
    adverse = [
        review for review in reviews
        if review.get("state") == "CHANGES_REQUESTED"
        and review.get("commit_id") == sha
    ]
    return bool(approvals) and not adverse and not unresolved_threads(number)


def _classic_protection_enforces(protection):
    checks = protection.get("required_status_checks")
    reviews = protection.get("required_pull_request_reviews")
    enforce_admins = protection.get("enforce_admins")
    force_pushes = protection.get("allow_force_pushes")
    deletions = protection.get("allow_deletions")
    if (
        not isinstance(checks, dict)
        or checks.get("strict") is not True
        or not isinstance(reviews, dict)
        or int(reviews.get("required_approving_review_count") or 0) < 1
        or reviews.get("dismiss_stale_reviews") is not True
        or reviews.get("require_last_push_approval") is not True
        or not isinstance(enforce_admins, dict)
        or enforce_admins.get("enabled") is not True
        or not isinstance(force_pushes, dict)
        or force_pushes.get("enabled") is not False
        or not isinstance(deletions, dict)
        or deletions.get("enabled") is not False
    ):
        return False
    configured = checks.get("checks")
    if not isinstance(configured, list):
        return False
    if not all(
        any(
            isinstance(item, dict)
            and item.get("context") == context
            and item.get("app_id") == 15368
            for item in configured
        )
        for context in CI_JOBS
    ):
        return False
    allowances = reviews.get("bypass_pull_request_allowances")
    if not isinstance(allowances, dict):
        return False
    return not any(allowances.get(key) for key in ("users", "teams", "apps"))


def strict_base_enforcement():
    """Require the active non-bypassable L4 branch ruleset; classic protection is insufficient."""
    try:
        repository = gh(f"repos/{REPO}")
        default_branch = repository.get("default_branch")
        if default_branch != "main":
            return False
        summaries = paged_rest(f"repos/{REPO}/rulesets")
    except RuntimeError:
        return False
    for summary in summaries:
        if (
            not isinstance(summary, dict)
            or summary.get("enforcement") != "active"
            or not summary.get("id")
        ):
            continue
        try:
            detail = gh(f"repos/{REPO}/rulesets/{summary['id']}")
        except RuntimeError:
            continue
        if strict_ruleset_enforces(
            detail,
            branch="main",
            required_checks=PLATFORM_CHECKS,
            default_branch=default_branch,
            required_restricted_paths=RULESET_RESTRICTED_PATHS,
        ):
            return True
    return False


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


def gates(number, *, require_authorization=True):
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
    if not strict_base_enforcement():
        print(f"PR #{number}: PLATFORM_ENFORCEMENT_BLOCKED")
        return None
    if not latest_ci_green(sha):
        print(f"PR #{number}: LATEST_EXACT_HEAD_CI_NOT_GREEN")
        return None
    if not review_gate_clean(number, sha):
        print(f"PR #{number}: INDEPENDENT_REVIEW_OR_THREADS_NOT_CLEAN")
        return None
    if require_authorization and not l4_authorization_green(sha):
        print(f"PR #{number}: L4_REVIEW_AUTHORIZATION_NOT_GREEN")
        return None
    return pr, sha


def selftest_authenticated_review_gate():
    """Exercise exact-body, workflow-ref and fail-closed proof authentication."""
    required_l5_paths = {
        ".github/workflows/l5-continuity-ci.yml",
        ".github/workflows/l5-continuity-supervision.yml",
        "scripts/l5_continuity.py",
        "scripts/l5_continuity_policy.json",
    }
    assert required_l5_paths.issubset(TRUSTED_GATE_PATHS)

    sha = "a" * 40
    number = 7
    run_id = "123"
    report_id = "456"
    body = expected_mistral_native_body(number, sha, run_id, report_id)
    review = {
        "state": "APPROVED",
        "commit_id": sha,
        "user": {"login": "github-actions[bot]", "type": "Bot"},
        "body": body,
    }
    proof = {
        "run_id": run_id,
        "report_id": report_id,
        "pr": str(number),
        "sha": sha,
        "verdict": "PASS",
    }

    class FakeProof:
        @staticmethod
        def read_run_proof(_run_id):
            assert str(_run_id) == run_id
            return dict(proof)

        @staticmethod
        def sealed_report(candidate):
            assert candidate == proof
            return {"id": int(report_id)}

    original_gh = globals()["gh"]
    original_reader = globals()["mistral_proof_reader"]
    try:
        def fake_gh(route, method=None, fields=None):
            assert route == f"repos/{REPO}/actions/runs/{run_id}"
            return {
                "name": "Mistral Vibe Wake",
                "path": ".github/workflows/mistral-vibe-wake.yml@main",
                "head_branch": "main",
                "event": "issue_comment",
                "status": "completed",
                "conclusion": "success",
                "head_repository": {"full_name": REPO},
            }

        globals()["gh"] = fake_gh
        globals()["mistral_proof_reader"] = lambda: FakeProof
        assert authenticated_mistral_approval(review, number, sha)
        assert eligible_approval(review, number, sha, {"chatgpt"})

        forged = dict(review, body=body.replace("Immutable evidence:", "Evidence:"))
        assert not authenticated_mistral_approval(forged, number, sha)

        stale = dict(review, commit_id="b" * 40)
        assert not eligible_approval(stale, number, sha, {"chatgpt"})

        def wrong_ref_gh(route, method=None, fields=None):
            value = fake_gh(route, method, fields)
            value["path"] = ".github/workflows/mistral-vibe-wake.yml@feature"
            return value
        globals()["gh"] = wrong_ref_gh
        assert not authenticated_mistral_approval(review, number, sha)

        globals()["gh"] = fake_gh
        globals()["mistral_proof_reader"] = lambda: (_ for _ in ()).throw(
            Exception("malformed helper")
        )
        assert not authenticated_mistral_approval(review, number, sha)

        untrusted_bot = dict(
            review,
            user={"login": "unknown-review-bot[bot]", "type": "Bot"},
        )
        assert not eligible_approval(untrusted_bot, number, sha, {"chatgpt"})
    finally:
        globals()["gh"] = original_gh
        globals()["mistral_proof_reader"] = original_reader
    print("Authenticated native review gate selftest passed")


def main():
    """Authorize exact-head review events or reconcile merge-ready PRs."""
    authorize_only = os.environ.get("L4_AUTHORIZE_ONLY") == "1"
    if authorize_only:
        if os.environ.get("GITHUB_EVENT_NAME") != "pull_request_review":
            print("L4_AUTHORIZATION_BLOCKED: review event required")
            return 2
        numbers = candidate_numbers()
        if len(numbers) != 1:
            print("L4_AUTHORIZATION_BLOCKED: exact PR unavailable")
            return 2
        first = gates(numbers[0], require_authorization=False)
        if not first:
            print("L4_AUTHORIZATION_BLOCKED")
            return 2
        _, sha = first
        print(f"L4_REVIEW_AUTHORIZED PR #{numbers[0]} exact head {sha}")
        return 0

    for number in candidate_numbers():
        first = gates(number)
        if not first:
            continue
        _, sha = first

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
        if not review_gate_clean(number, sha):
            print(f"PR #{number}: FINAL_REVIEW_RECHECK_BLOCKED")
            continue
        if not l4_authorization_green(sha):
            print(f"PR #{number}: FINAL_L4_AUTHORIZATION_NOT_GREEN")
            continue
        if not strict_base_enforcement():
            print(f"PR #{number}: FINAL_PLATFORM_ENFORCEMENT_BLOCKED")
            continue

        merged = gh(
            f"repos/{REPO}/pulls/{number}/merge",
            method="PUT",
            fields={"sha": sha, "merge_method": "squash"},
        )
        if not merged.get("merged"):
            raise RuntimeError(f"MERGE_REJECTED PR #{number}")
        print(f"NATIVE_FACTORY_MERGED PR #{number} exact head {sha}")
    return 0


if __name__ == "__main__":
    if len(__import__("sys").argv) == 2 and __import__("sys").argv[1] == "selftest":
        selftest_authenticated_review_gate()
    elif len(__import__("sys").argv) == 1:
        raise SystemExit(main())
    else:
        raise SystemExit("usage: native_factory_merge.py [selftest]")