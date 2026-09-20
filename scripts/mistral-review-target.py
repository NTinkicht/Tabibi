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
    return int(number), exact_sha


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
        ) == (345, "a" * 40)
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
        finally:
            globals()["github_json"] = original_api
        print("Mistral review-target parser and security selftests passed")
        return

    repo = os.environ["GITHUB_REPOSITORY"]
    if command == "prepare":
        try:
            target = parse(os.environ["DISPATCH_BODY"])
            if target is None:
                output(ready="true", status="OK", mode="main")
                return
            number, exact_sha = target
            read_current_pr(repo, number, exact_sha)
            if not ci_green(repo, exact_sha):
                blocked("CI_NOT_GREEN")
                return
            output(
                ready="true", status="OK", mode="review",
                pr=number, sha=exact_sha
            )
        except (ValueError, subprocess.SubprocessError, json.JSONDecodeError):
            blocked("REVIEW_TARGET_BLOCKED")
        return

    number = os.environ.get("REVIEW_PR", "")
    exact_sha = os.environ.get("REVIEW_SHA", "")
    try:
        if not number.isascii() or not number.isdigit() or not SHA.fullmatch(exact_sha):
            blocked("REVIEW_TARGET_BLOCKED")
            return
        read_current_pr(repo, int(number), exact_sha)
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
                ["git", "fetch", "--no-tags", "--depth=1", "origin", base_sha],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=40,
            )
            diff = subprocess.check_output(
                ["git", "diff", "--no-ext-diff", "--binary",
                 base_sha, exact_sha, "--"],
                stderr=subprocess.DEVNULL, timeout=35,
            )
            if not diff.startswith(b"diff --git ") or len(diff) > DIFF_LIMIT_BYTES:
                blocked("REVIEW_DIFF_UNAVAILABLE_OR_TOO_LARGE")
                return
            write_evidence(diff)
        elif command != "recheck":
            blocked("REVIEW_TARGET_BLOCKED")
            return
        output(ready="true", status="OK", mode="review")
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError):
        blocked("STALE_SHA_OR_EVIDENCE_UNAVAILABLE")


if __name__ == "__main__":
    main()
