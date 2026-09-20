#!/usr/bin/env python3
"""Parent-owned validation for Mistral's owner-dispatched exact-head READ-ONLY lane.

Only the trusted workflow invokes this helper. Copy it to /tmp BEFORE checking
out the reviewed PR so PR-authored files cannot replace the verifier.
"""
import json
import os
from pathlib import Path
import re
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
    for run in runs:
        if (
            run.get("name") != "CI"
            or run.get("head_sha") != exact_sha
            or run.get("status") != "completed"
            or run.get("conclusion") != "success"
        ):
            continue
        jobs = github_json(
            f"repos/{repo}/actions/runs/{run['id']}/jobs?per_page=100"
        ).get("jobs", [])
        successful = {
            job.get("name") for job in jobs if job.get("conclusion") == "success"
        }
        if REQUIRED_JOBS.issubset(successful):
            return True
    return False


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
        print("Mistral review-target parser selftest passed")
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
            diff = subprocess.check_output(
                ["gh", "pr", "diff", number, "--repo", repo],
                stderr=subprocess.DEVNULL, timeout=35
            )
            if not diff.startswith(b"diff --git ") or len(diff) > DIFF_LIMIT_BYTES:
                blocked("REVIEW_DIFF_UNAVAILABLE_OR_TOO_LARGE")
                return
            Path(".tabibi_mistral_review.diff").write_bytes(diff)
        elif command != "recheck":
            blocked("REVIEW_TARGET_BLOCKED")
            return
        output(ready="true", status="OK", mode="review")
    except (ValueError, subprocess.SubprocessError, json.JSONDecodeError):
        blocked("STALE_SHA_OR_EVIDENCE_UNAVAILABLE")


if __name__ == "__main__":
    main()
