#!/usr/bin/env python3
"""Parent-owned validation for Mistral's owner-dispatched exact-head READ-ONLY lane.

Only the trusted workflow invokes this helper. Copy it to /tmp BEFORE checking
out the reviewed PR so PR-authored files cannot replace the verifier.
"""
import json
import os
from pathlib import Path
import re
import tempfile
import subprocess
import sys

SHA = re.compile(r"[0-9a-f]{40}\Z")
REVIEW_MARKER = re.compile(r"(?m)^BINDING_EXACT_HEAD_REVIEW\s*$")
REQUIRED_JOBS = {"Quality and build", "PostgreSQL integration", "Browser smoke"}
DIFF_LIMIT_BYTES = 120_000


def output(**items):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
        for key, value in items.items():
            stream.write(f"{key}={value}\n")


def blocked(status):
    output(ready="false", status=status, mode="blocked")


def github_json(route):
    data = subprocess.check_output(
        ["gh", "api", route], stderr=subprocess.DEVNULL, timeout=25
    )
    return json.loads(data)


def get_field(body, name):
    values = re.findall(rf"(?m)^{re.escape(name)}:\s*(.*?)\s*$", body)
    if len(values) != 1 or not values[0]:
        raise ValueError("Missing or duplicate trusted review field")
    return values[0].strip()


def parse(body):
    review_intent = any(
        term in body for term in ("BINDING_EXACT_HEAD_REVIEW", "review_pr:", "review_sha:")
    )
    if not review_intent:
        return None
    if len(REVIEW_MARKER.findall(body)) != 1:
        raise ValueError("Untrusted or malformed review marker")
    number = get_field(body, "review_pr")
    exact_sha = get_field(body, "review_sha")
    material_authors = get_field(body, "material_authors").lower().split(",")
    material_authors = [author.strip() for author in material_authors]
    if (
        not number.isascii()
        or not number.isdigit()
        or int(number) < 1
        or not SHA.fullmatch(exact_sha)
        or not material_authors
        or any(not re.fullmatch(r"[a-z0-9_-]+", a) for a in material_authors)
        or "mistral-vibe" in material_authors
        or "mistral" in material_authors
    ):
        raise ValueError("Invalid or self-authored exact-head review target")
    return int(number), exact_sha, ",".join(material_authors)


def read_current_pr(repo, number, exact_sha):
    data = github_json(f"repos/{repo}/pulls/{number}")
    if (
        data.get("state") != "open"
        or data.get("head", {}).get("sha") != exact_sha
        or data.get("head", {}).get("repo", {}).get("full_name") != repo
        or data.get("base", {}).get("repo", {}).get("full_name") != repo
        or data.get("base", {}).get("ref") != "main"
    ):
        raise ValueError("PR no longer matches a trusted canonical exact head")
    return data


def material_authors(repo, number, exact_sha):
    """Get all per-commit material actors through bounded, paginated provenance.

    Shared by the inference parent's review eligibility check and the pilot
    gate, so a legitimate PR with 100+ commits cannot be rejected by a
    smaller gate-only first-page limit. Missing/contradictory trailers or a
    truncated/head-mismatched history still fail closed.
    """
    observed = set()
    found = 0
    last_sha = None
    for page in range(1, 21):
        commits = github_json(
            f"repos/{repo}/pulls/{number}/commits?per_page=100&page={page}"
        )
        if not isinstance(commits, list):
            raise ValueError("Commit provenance unavailable")
        for commit in commits:
            found += 1
            last_sha = commit.get("sha")
            if not SHA.fullmatch(last_sha or ""):
                raise ValueError("Commit provenance SHA is invalid")
            message = commit.get("commit", {}).get("message", "")
            trailers = re.findall(
                r"(?mi)^Material-Author:[ \t]*([a-z0-9_-]+)[ \t]*$", message
            )
            if len(trailers) != 1:
                raise ValueError("Missing or conflicting per-commit actor provenance")
            actor = trailers[0].lower()
            if actor in ("mistral-vibe", "mistral"):
                raise ValueError("Self-authored commit actor")
            login = (commit.get("author") or {}).get("login", "").lower()
            if login in ("mistral-vibe", "mistral"):
                raise ValueError("GitHub commit has Mistral authorship")
            observed.add(actor)
        if len(commits) < 100:
            break
    else:
        raise ValueError("Commit provenance exceeds the safety bound")
    if not found or last_sha != exact_sha:
        raise ValueError("Commit provenance does not match exact head")
    return observed


def verify_provenance(repo, number, exact_sha, declared):
    """Require the owner dispatch to name exactly the observed material actors."""
    if material_authors(repo, number, exact_sha) != set(declared.split(",")):
        raise ValueError("Commit provenance does not match owner dispatch")
    return True


def ci_green(repo, exact_sha):
    runs = github_json(
        f"repos/{repo}/actions/runs?head_sha={exact_sha}&event=pull_request&per_page=30"
    ).get("workflow_runs", [])
    # A newer attempt/failure must never be masked by an older successful
    # run for the very same head (including explicit Actions reruns).
    relevant = [
        run for run in runs
        if run.get("name") == "CI" and run.get("head_sha") == exact_sha
        and run.get("event") == "pull_request"
    ]
    if not relevant:
        return False
    latest = max(
        relevant,
        key=lambda run: (
            run.get("run_number") or 0,
            run.get("run_attempt") or 0,
            run.get("id") or 0,
        ),
    )
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        return False
    jobs = github_json(
        f"repos/{repo}/actions/runs/{latest['id']}/jobs?filter=latest&per_page=100"
    ).get("jobs", [])
    successful = {
        job.get("name") for job in jobs if job.get("conclusion") == "success"
    }
    return REQUIRED_JOBS.issubset(successful)


def write_evidence(diff, filename=".tabibi_mistral_review.diff"):
    # The checked-out PR controls all paths inside its worktree. Never follow
    # an attacker-created symlink, or overwrite an already-existing file.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(filename, flags, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(diff)


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "selftest":
        assert parse("A bounded MAIN analysis") is None
        assert parse(
            "BINDING_EXACT_HEAD_REVIEW\nreview_pr: 345\n"
            + "review_sha: " + "a" * 40 + "\nmaterial_authors: chatgpt"
        ) == (345, "a" * 40, "chatgpt")
        for bad in (
            "BINDING_EXACT_HEAD_REVIEW\nreview_pr: 1\nreview_sha: bad\n"
            "material_authors: codex",
            "BINDING_EXACT_HEAD_REVIEW\nreview_pr: 1\nreview_sha: "
            + "a" * 40 + "\nmaterial_authors: mistral-vibe",
        ):
            try:
                parse(bad)
            except ValueError:
                pass
            else:
                raise AssertionError("Untrusted review target accepted")
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "victim"
            target.write_bytes(b"original")
            link = Path(directory) / "evidence"
            link.symlink_to(target)
            try:
                write_evidence(b"tamper", str(link))
            except OSError:
                pass
            else:
                raise AssertionError("Symlink evidence was overwritten")
            assert target.read_bytes() == b"original"
            link.unlink()
            write_evidence(b"verified", str(link))
            assert link.read_bytes() == b"verified"
            try:
                write_evidence(b"overwritten", str(link))
            except FileExistsError:
                pass
            else:
                raise AssertionError("Existing evidence was overwritten")
        original_api = github_json
        try:
            def mock_api(route):
                if "/actions/runs?" in route:
                    return {"workflow_runs": [
                        {"name": "CI", "head_sha": "a" * 40,
                         "event": "pull_request", "run_number": 1,
                         "run_attempt": 1, "id": 10, "status": "completed",
                         "conclusion": "success"},
                        {"name": "CI", "head_sha": "a" * 40,
                         "event": "pull_request", "run_number": 2,
                         "run_attempt": 1, "id": 11, "status": "completed",
                         "conclusion": "failure"},
                    ]}
                return {"jobs": [{"name": name, "conclusion": "success"}
                                 for name in REQUIRED_JOBS]}
            globals()["github_json"] = mock_api
            assert not ci_green("owner/repo", "a" * 40), (
                "Older green CI masked latest failure"
            )
            def provenance_api(route):
                if "/pulls/" in route and "/commits?" in route:
                    return [{"sha": "a" * 40,
                             "commit": {"message": "feat: demo\n\nMaterial-Author: chatgpt"},
                             "author": {"login": "NTinkicht"}}]
                raise ValueError("Unexpected mock API call")
            globals()["github_json"] = provenance_api
            assert verify_provenance("owner/repo", 1, "a" * 40, "chatgpt")
            for mismatched in ("mistral-vibe", "codex"):
                try:
                    verify_provenance("owner/repo", 1, "a" * 40, mismatched)
                except ValueError:
                    pass
                else:
                    raise AssertionError("Self/undeclared material author accepted")
            # 101 commits: one full page plus the actual final head on page 2.
            # The gate must reuse this exact paginated proof rather than the
            # former first-page-only commit_authors() limit.
            def paginated_api(route):
                if route.endswith("/commits?per_page=100&page=1"):
                    return [{
                        "sha": f"{index + 1:040x}",
                        "commit": {"message": "feat: demo\n\nMaterial-Author: chatgpt"},
                        "author": {"login": "NTinkicht"},
                    } for index in range(100)]
                if route.endswith("/commits?per_page=100&page=2"):
                    return [{
                        "sha": "a" * 40,
                        "commit": {"message": "feat: final\n\nMaterial-Author: chatgpt"},
                        "author": {"login": "NTinkicht"},
                    }]
                raise ValueError("Unexpected page")
            globals()["github_json"] = paginated_api
            assert material_authors("owner/repo", 1, "a" * 40) == {"chatgpt"}
            assert verify_provenance("owner/repo", 1, "a" * 40, "chatgpt")
            try:
                material_authors("owner/repo", 1, "b" * 40)
            except ValueError:
                pass
            else:
                raise AssertionError("Incorrect final head accepted")
        finally:
            globals()["github_json"] = original_api
        print("Mistral review-target parser and security selftests passed")
        return

    repo = os.environ["GITHUB_REPOSITORY"]
    if command == "auto-prepare":
        try:
            exact_sha = os.environ.get("AUTO_REVIEW_SHA", "")
            run_id = os.environ.get("AUTO_REVIEW_RUN_ID", "")
            if not SHA.fullmatch(exact_sha) or not run_id.isascii() or not run_id.isdigit():
                blocked("REVIEW_TARGET_BLOCKED")
                return
            candidates = github_json(
                f"repos/{repo}/commits/{exact_sha}/pulls?per_page=20"
            )
            matches = [
                item for item in candidates
                if item.get("state") == "open"
                and item.get("head", {}).get("sha") == exact_sha
                and item.get("head", {}).get("repo", {}).get("full_name") == repo
                and item.get("base", {}).get("repo", {}).get("full_name") == repo
                and item.get("base", {}).get("ref") == "main"
            ]
            if len(matches) != 1:
                blocked("REVIEW_TARGET_BLOCKED")
                return
            number = int(matches[0]["number"])
            authors = ",".join(sorted(material_authors(repo, number, exact_sha)))
            if not authors or not ci_green(repo, exact_sha):
                blocked("CI_NOT_GREEN")
                return
            output(
                ready="true", status="OK", mode="review",
                pr=number, sha=exact_sha, authors=authors
            )
        except (ValueError, subprocess.SubprocessError, json.JSONDecodeError):
            blocked("REVIEW_TARGET_BLOCKED")
        return

    if command == "prepare":
        try:
            target = parse(os.environ["DISPATCH_BODY"])
            if target is None:
                output(ready="true", status="OK", mode="main")
                return
            number, exact_sha, authors = target
            read_current_pr(repo, number, exact_sha)
            verify_provenance(repo, number, exact_sha, authors)
            if not ci_green(repo, exact_sha):
                blocked("CI_NOT_GREEN")
                return
            output(
                ready="true", status="OK", mode="review",
                pr=number, sha=exact_sha, authors=authors
            )
        except (ValueError, subprocess.SubprocessError, json.JSONDecodeError):
            blocked("REVIEW_TARGET_BLOCKED")
        return

    number = os.environ.get("REVIEW_PR", "")
    exact_sha = os.environ.get("REVIEW_SHA", "")
    authors = os.environ.get("REVIEW_AUTHORS", "")
    try:
        if not number.isascii() or not number.isdigit() or not SHA.fullmatch(exact_sha):
            blocked("REVIEW_TARGET_BLOCKED")
            return
        read_current_pr(repo, int(number), exact_sha)
        if not re.fullmatch(r"[a-z0-9_-]+(?:,[a-z0-9_-]+)*", authors):
            blocked("REVIEW_PROVENANCE_BLOCKED")
            return
        verify_provenance(repo, int(number), exact_sha, authors)
        if subprocess.check_output(
            ["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL
        ).decode().strip() != exact_sha:
            blocked("STALE_SHA")
            return
        if command == "evidence":
            if not ci_green(repo, exact_sha):
                blocked("CI_NOT_GREEN")
                return
            # The reviewed diff must come from the already-pinned local
            # exact head, not a second live gh pr diff request (TOCTOU).
            base_sha = read_current_pr(repo, int(number), exact_sha)[
                "base"
            ]["sha"]
            if not SHA.fullmatch(base_sha):
                blocked("REVIEW_TARGET_BLOCKED")
                return
            subprocess.check_call(
                ["git", "fetch", "--no-tags", "origin", base_sha],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=40,
            )
            # The checkout uses full history; calculate the PR fork point
            # instead of comparing against main's moving tip, which would
            # otherwise include unrelated base-branch changes as reversions.
            merge_base = subprocess.check_output(
                ["git", "merge-base", base_sha, exact_sha],
                stderr=subprocess.DEVNULL, timeout=20,
            ).decode("ascii").strip()
            if not SHA.fullmatch(merge_base):
                blocked("REVIEW_TARGET_BLOCKED")
                return
            diff = subprocess.check_output(
                ["git", "diff", "--no-ext-diff", "--binary",
                 merge_base, exact_sha, "--"],
                stderr=subprocess.DEVNULL, timeout=35,
            )
            if not diff.startswith(b"diff --git ") or len(diff) > DIFF_LIMIT_BYTES:
                blocked("REVIEW_DIFF_UNAVAILABLE_OR_TOO_LARGE")
                return
            write_evidence(diff)
        elif command == "recheck":
            # Required CI may be rerun (and fail) while the model is reading.
            # Rechecking only HEAD is not a valid publication gate.
            if not ci_green(repo, exact_sha):
                blocked("CI_NOT_GREEN")
                return
        else:
            blocked("REVIEW_TARGET_BLOCKED")
            return
        output(ready="true", status="OK", mode="review")
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError):
        blocked("STALE_SHA_OR_EVIDENCE_UNAVAILABLE")


if __name__ == "__main__":
    main()
