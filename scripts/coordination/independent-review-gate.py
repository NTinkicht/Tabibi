#!/usr/bin/env python3
"""Fail-closed independent AI review gate for Tabibi PR heads (pilot).

Only a provider-run-backed, owner-dispatched Mistral review is eligible here.
No user-authored "Claude reviewed" assertion, bot capacity reply, old SHA,
CI_GREEN_HANDOFF, missing trailer, or unverified model comment is a gate.
This script is intentionally read-only; branch rulesets must separately REQUIRE
its workflow check before GitHub itself blocks merges.
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys

REPO = "NTinkicht/Tabibi"
HEX = re.compile(r"[0-9a-f]{40}\Z")
TRAILER = re.compile(r"(?mi)^Material-Author:[ \t]*([a-z0-9_-]+)[ \t]*$")
MARKER = re.compile(
    r"<!-- tabibi-mistral-review-run:([0-9]{1,15}) dispatch-comment:([0-9]{1,15}) -->"
)
VERDICT = re.compile(r"(?m)^VERDICT:[ \t]*(PASS|PASS_WITH_MINOR_FINDINGS|CHANGES_REQUIRED)[ \t]*$")
JOBS = {"Quality and build", "PostgreSQL integration", "Browser smoke"}
ACTOR = "mistral-vibe"


def api(route):
    return json.loads(
        subprocess.check_output(
            ["gh", "api", route], stderr=subprocess.DEVNULL, timeout=25
        )
    )


def after(text):
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


def single_owner_dispatch(body, number, sha, actors):
    if body.count("BINDING_EXACT_HEAD_REVIEW") != 1:
        return False
    fields = {}
    for name in ("review_pr", "review_sha", "material_authors"):
        hits = re.findall(r"(?m)^" + name + r":[ \t]*(.*?)[ \t]*$", body)
        if len(hits) != 1:
            return False
        fields[name] = hits[0].strip()
    authors = {x.strip().lower() for x in fields["material_authors"].split(",")}
    return (
        fields["review_pr"] == str(number)
        and fields["review_sha"] == sha
        and authors == actors
        and ACTOR not in authors
        and "mistral" not in authors
    )


def verified_bot_review(comment, number, sha, actors, dispatch, run):
    """No implicit trust in the GitHub login or the model text alone."""
    body = comment.get("body") or ""
    marker = MARKER.findall(body)
    verdict = VERDICT.findall(body)
    if (
        comment.get("user", {}).get("login") != "github-actions[bot]"
        or len(marker) != 1
        or len(verdict) != 1
        or comment.get("updated_at", comment.get("created_at")) != comment.get("created_at")
        or dispatch.get("updated_at", dispatch.get("created_at")) != dispatch.get("created_at")
        or not (dispatch.get("issue_url") or "").endswith("/issues/11")
        or body.count("**mistral-vibe unattended wake**") != 1
        or f"Target PR #{number} exact_sha={sha};" not in body
        or body.count(sha) < 2
        or str(run.get("id")) != marker[0][0]
        or str(dispatch.get("id")) != marker[0][1]
        or dispatch.get("user", {}).get("login") != "NTinkicht"
        or not single_owner_dispatch(dispatch.get("body") or "", number, sha, actors)
        or run.get("name") != "Mistral Vibe Wake"
        or run.get("event") != "issue_comment"
        or run.get("actor", {}).get("login") != "NTinkicht"
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
        or run.get("path") != ".github/workflows/mistral-vibe-wake.yml"
    ):
        return None
    try:
        created = after(comment["created_at"])
        opened = after(run["created_at"])
        completed = after(run["updated_at"])
        dispatched = after(dispatch["created_at"])
        valid_time = (dispatched <= opened <= dispatched + dt.timedelta(minutes=2)
                      and opened <= created <= completed + dt.timedelta(minutes=3))
        return verdict[0] if valid_time else None
    except (KeyError, ValueError, TypeError):
        return None


def commit_authors(commits, sha):
    if not commits or len(commits) >= 100 or commits[-1].get("sha") != sha:
        raise ValueError("PR commits incomplete or head changed")
    actors = set()
    for commit in commits:
        match = TRAILER.findall(commit.get("commit", {}).get("message") or "")
        if len(match) != 1:
            raise ValueError("Missing or ambiguous material author")
        actors.add(match[0].lower())
    if ACTOR in actors or "mistral" in actors:
        raise ValueError("Mistral cannot gate its own change")
    return actors


def exact_head_ci(runs, fetch_jobs, sha):
    runs = [
        r for r in runs
        if r.get("head_sha") == sha and r.get("name") == "CI"
        and r.get("event") == "pull_request"
    ]
    if not runs:
        return False
    latest = max(
        runs, key=lambda r: (
            r.get("run_number") or 0,
            r.get("run_attempt") or 0,
            r.get("id") or 0,
        )
    )
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        return False
    jobs = fetch_jobs(latest["id"])
    return JOBS.issubset({
        job.get("name") for job in jobs if job.get("conclusion") == "success"
    })


def evaluate(number):
    pr = api(f"repos/{REPO}/pulls/{number}")
    sha = pr.get("head", {}).get("sha") or ""
    if (
        pr.get("state") != "open" or pr.get("draft")
        or not HEX.fullmatch(sha)
        or pr.get("head", {}).get("repo", {}).get("full_name") != REPO
        or pr.get("base", {}).get("ref") != "main"
        or pr.get("base", {}).get("repo", {}).get("full_name") != REPO
    ):
        raise ValueError("Not a canonical current Tabibi PR")
    commits = api(f"repos/{REPO}/pulls/{number}/commits?per_page=100")
    actors = commit_authors(commits, sha)
    runs = api(
        f"repos/{REPO}/actions/runs?head_sha={sha}&event=pull_request&per_page=30"
    ).get("workflow_runs", [])
    if not exact_head_ci(
        runs,
        lambda run_id: api(
            f"repos/{REPO}/actions/runs/{run_id}/jobs?filter=latest&per_page=100"
        ).get("jobs", []),
        sha,
    ):
        raise ValueError("Current exact-head 3/3 CI not green")
    comments = []
    for page in range(1, 101):
        batch = api(f"repos/{REPO}/issues/{number}/comments?per_page=100&page={page}")
        if not isinstance(batch, list):
            raise ValueError("PR comment history unavailable")
        comments.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise ValueError("PR comment history exceeds checked bound")
    eligible = []
    for comment in comments:
        # Public-PR adversaries can write arbitrary markers. Only an actual
        # github-actions bot comment may trigger a dispatch/run lookup.
        if comment.get("user", {}).get("login") != "github-actions[bot]":
            continue
        match = MARKER.findall(comment.get("body") or "")
        if len(match) != 1:
            continue
        run_id, dispatch_id = match[0]
        dispatch = api(f"repos/{REPO}/issues/comments/{dispatch_id}")
        if dispatch.get("user", {}).get("login") != "NTinkicht":
            continue
        if not single_owner_dispatch(dispatch.get("body") or "", number, sha, actors):
            continue
        run = api(f"repos/{REPO}/actions/runs/{run_id}")
        verdict = verified_bot_review(comment, number, sha, actors, dispatch, run)
        if verdict is not None:
            eligible.append(verdict)
    if "PASS" not in eligible or any(v != "PASS" for v in eligible):
        raise ValueError("No clean current-head independent PASS or adverse verdict")
    # Inline reviewer findings require separate reconciliation; even this
    # verified proof is advisory until the complete merge gate is implemented.
    return sha


def selftest():
    sha = "a" * 40
    dispatch = {
        "id": 44, "user": {"login": "NTinkicht"},
        "issue_url": "https://api.github.com/repos/NTinkicht/Tabibi/issues/11",
        "created_at": "2026-09-24T10:00:00Z",
        "body": ("@mistral-vibe\nBINDING_EXACT_HEAD_REVIEW\n"
                 "review_pr: 7\nreview_sha: " + sha +
                 "\nmaterial_authors: chatgpt"),
    }
    run = {
        "id": 18, "name": "Mistral Vibe Wake", "event": "issue_comment",
        "actor": {"login": "NTinkicht"}, "status": "completed",
        "conclusion": "success",
        "path": ".github/workflows/mistral-vibe-wake.yml",
        "created_at": "2026-09-24T10:01:00Z",
        "updated_at": "2026-09-24T10:03:00Z",
    }
    comment = {
        "user": {"login": "github-actions[bot]"},
        "created_at": "2026-09-24T10:02:00Z",
        "body": (
            "**mistral-vibe unattended wake**\n"
            f"Target PR #7 exact_sha={sha}; parent verified 3/3 CI green.\n"
            f"SHA {sha}\nVERDICT: PASS\n"
            "<!-- tabibi-mistral-review-run:18 dispatch-comment:44 -->"
        ),
    }
    assert verified_bot_review(comment, 7, sha, {"chatgpt"}, dispatch, run) == "PASS"
    assert not verified_bot_review(comment, 8, sha, {"chatgpt"}, dispatch, run)
    assert not verified_bot_review(comment, 7, "b" * 40, {"chatgpt"}, dispatch, run)
    assert not verified_bot_review(
        dict(comment, user={"login": "NTinkicht"}), 7, sha,
        {"chatgpt"}, dispatch, run
    )
    assert verified_bot_review(
        dict(comment, body=comment["body"].replace("VERDICT: PASS", "VERDICT: CHANGES_REQUIRED")),
        7, sha, {"chatgpt"}, dispatch, run
    ) == "CHANGES_REQUIRED"
    assert not verified_bot_review(comment, 7, sha, {"chatgpt"},
                                   dispatch, dict(run, conclusion="failure"))
    assert not verified_bot_review(comment, 7, sha, {"mistral-vibe"},
                                   dispatch, run)
    assert not verified_bot_review(
        dict(comment, updated_at="2026-09-24T10:06:00Z"),
        7, sha, {"chatgpt"}, dispatch, run
    )
    assert not verified_bot_review(
        comment, 7, sha, {"chatgpt"},
        dict(dispatch, issue_url="https://api.github.com/repos/NTinkicht/Tabibi/issues/99"),
        run,
    )
    assert not verified_bot_review(
        comment, 7, sha, {"chatgpt"}, dispatch,
        dict(run, created_at="2026-09-24T10:07:00Z"),
    )
    assert commit_authors([{
        "sha": sha, "commit": {"message": "fix\n\nMaterial-Author: chatgpt"}
    }], sha) == {"chatgpt"}
    for messages in (["no actor"], ["Material-Author: mistral-vibe"],
                     ["Material-Author: grok\nMaterial-Author: chatgpt"]):
        try:
            commit_authors([{"sha": sha, "commit": {"message": messages[0]}}], sha)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid author accepted")
    green = {
        "id": 2, "name": "CI", "head_sha": sha, "event": "pull_request",
        "run_number": 1, "run_attempt": 1, "status": "completed",
        "conclusion": "success",
    }
    jobs = [{"name": n, "conclusion": "success"} for n in JOBS]
    assert exact_head_ci([green], lambda _: jobs, sha)
    assert not exact_head_ci([green], lambda _: jobs[:-1], sha)
    assert not exact_head_ci([green, dict(green, id=3, run_attempt=2,
                                         conclusion="failure")],
                             lambda _: jobs, sha)
    # Whole-gate regression: a red review must block even after a PASS;
    # repeated PASS reviews must not accidentally block clean current head.
    saved_api = globals()["api"]
    try:
        def exercise(verdicts):
            dispatches = {}
            runs = {}
            comments = []
            for index, verdict in enumerate(verdicts):
                identifier = 44 + index
                run_id = 18 + index
                hour = 10 + index
                dispatches[str(identifier)] = dict(
                    dispatch, id=identifier,
                    created_at=f"2026-09-24T{hour:02d}:00:00Z",
                )
                runs[str(run_id)] = dict(
                    run, id=run_id,
                    created_at=f"2026-09-24T{hour:02d}:01:00Z",
                    updated_at=f"2026-09-24T{hour:02d}:03:00Z",
                )
                comments.append(dict(
                    comment,
                    created_at=f"2026-09-24T{hour:02d}:02:00Z",
                    body=comment["body"]
                    .replace("VERDICT: PASS", f"VERDICT: {verdict}")
                    .replace("review-run:18", f"review-run:{run_id}")
                    .replace("dispatch-comment:44", f"dispatch-comment:{identifier}"),
                ))

            def mocked_api(route):
                if route.endswith("/pulls/7"):
                    return {
                        "state": "open", "draft": False,
                        "head": {"sha": sha, "repo": {"full_name": REPO}},
                        "base": {"ref": "main", "repo": {"full_name": REPO}},
                    }
                if route.endswith("/pulls/7/commits?per_page=100"):
                    return [{
                        "sha": sha,
                        "commit": {"message": "fix\n\nMaterial-Author: chatgpt"},
                    }]
                if "/actions/runs?head_sha=" in route:
                    return {"workflow_runs": [green]}
                if route.endswith("/actions/runs/2/jobs?filter=latest&per_page=100"):
                    return {"jobs": jobs}
                if "/issues/7/comments?per_page=100&page=" in route:
                    return comments if route.endswith("page=1") else []
                for name, prefix, values in (
                    ("dispatch", "/issues/comments/", dispatches),
                    ("run", "/actions/runs/", runs),
                ):
                    if prefix in route:
                        key = route.rsplit("/", 1)[-1]
                        if key in values:
                            return values[key]
                raise ValueError("Unexpected mock route")

            globals()["api"] = mocked_api
            try:
                return evaluate(7)
            except ValueError:
                return None

        assert exercise(["PASS"]) == sha
        assert exercise(["PASS", "PASS"]) == sha
        assert exercise(["PASS", "CHANGES_REQUIRED"]) is None
        assert exercise(["PASS", "PASS_WITH_MINOR_FINDINGS"]) is None
        assert exercise(["CHANGES_REQUIRED"]) is None
    finally:
        globals()["api"] = saved_api
    print("Independent review gate pilot selftest passed")


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "selftest":
        selftest()
        return 0
    if len(sys.argv) != 2 or not sys.argv[1].isascii() or not sys.argv[1].isdigit():
        print("Usage: independent-review-gate.py selftest|PR_NUMBER", file=sys.stderr)
        return 2
    if os.environ.get("GITHUB_REPOSITORY") != REPO:
        print("BLOCKED: repository mismatch")
        return 1
    try:
        sha = evaluate(int(sys.argv[1]))
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError,
            json.JSONDecodeError):
        print("BLOCKED: independent final-head provider-run-backed review not verified")
        return 1
    print(f"REVIEW_PROOF_ONLY: PR #{sys.argv[1]} exact_sha={sha}")
    print("Check remaining threads/material findings and owner branch protection before merge.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
