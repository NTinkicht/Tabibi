#!/usr/bin/env python3
"""Trusted, credential-isolated PR publisher for a completed Mistral review job.

The preceding inference job has issues:write and pull-requests:read; this fresh
job has pull-requests:write but no Mistral credential, PR checkout or model.
Only repost a provider-run-bound review already published by the trusted parent
to Issue #11. This is delivery, NOT a merge approval or owner attestation.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REPO = "NTinkicht/Tabibi"
MARKER = re.compile(
    r"<!-- tabibi-mistral-review-run:([0-9]{1,15}) dispatch-comment:([0-9]{1,15}) -->"
)
VERDICT = re.compile(
    r"(?m)^VERDICT:[ \t]*(PASS|PASS_WITH_MINOR_FINDINGS|CHANGES_REQUIRED)[ \t]*$"
)
SENSITIVE = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    r"(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}|"
    r"(?<![A-Za-z0-9])(?:sk|xai|mistral)-[A-Za-z0-9_-]{20,}",
    re.I,
)


def api(route, *, body=None):
    command = ["gh", "api"]
    if body is not None:
        command += ["-X", "POST", "--input", "-"]
    command += [route]
    result = subprocess.run(
        command, input=json.dumps(body) if body is not None else None,
        text=True, capture_output=True, timeout=35, check=False,
    )
    if result.returncode:
        raise ValueError("GitHub review delivery failed")
    return json.loads(result.stdout)


def parent():
    path = Path("scripts/mistral-review-target.py")
    spec = importlib.util.spec_from_file_location("trusted_mistral_review", path)
    if spec is None or spec.loader is None:
        raise ValueError("Trusted review verifier unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def trusted_report(comment, *, run_id, dispatch_id, number, sha):
    body = comment.get("body") or ""
    markers = MARKER.findall(body)
    verdicts = VERDICT.findall(body)
    return (
        comment.get("user", {}).get("login") == "github-actions[bot]"
        and len(body) < 55_000
        and not SENSITIVE.search(body)
        and len(markers) == 1
        and markers[0] == (str(run_id), str(dispatch_id))
        and len(verdicts) == 1
        and body.count("**mistral-vibe unattended wake**") == 1
        and body.count(sha) >= 2
        and f"Target PR #{number} exact_sha={sha};" in body
        and "parent verified 3/3 CI green" in body
    )


def comments(number):
    result = []
    for page in range(1, 11):
        batch = api(
            f"repos/{REPO}/issues/{number}/comments?per_page=100&page={page}"
        )
        if not isinstance(batch, list):
            raise ValueError("Comment evidence not available")
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise ValueError("Comment pagination bound exceeded")


def publish():
    if os.environ.get("GITHUB_REPOSITORY") != REPO:
        raise ValueError("Wrong repository")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    issue = event.get("issue") or {}
    trigger = event.get("comment") or {}
    if (
        issue.get("number") != 11
        or trigger.get("user", {}).get("login") != "NTinkicht"
        or event.get("action") != "created"
    ):
        raise ValueError("Not owner-issued Issue #11 dispatch")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    dispatch_id = str(trigger.get("id", ""))
    if not (run_id.isdigit() and dispatch_id.isdigit()):
        raise ValueError("Invalid run/dispatch identity")

    trusted = parent()
    target = trusted.parse(trigger.get("body") or "")
    if target is None:
        raise ValueError("Not a binding exact-head review")
    number, sha, actors = target
    trusted.read_current_pr(REPO, number, sha)
    trusted.verify_provenance(REPO, number, sha, actors)
    if not trusted.ci_green(REPO, sha):
        raise ValueError("Latest exact-head CI is not green")

    # No finite scan of the permanent Issue #11 bus: its comment ID comes
    # directly from the preceding trusted job output, never model text.
    source_report_id = os.environ.get("SOURCE_REPORT_ID", "")
    if not source_report_id.isascii() or not source_report_id.isdigit():
        raise ValueError("Trusted predecessor report ID not supplied")
    source = api(f"repos/{REPO}/issues/comments/{source_report_id}")
    if not (source.get("issue_url") or "").endswith("/issues/11"):
        raise ValueError("Model report does not belong to permanent wake bus")
    if source.get("updated_at", source.get("created_at")) != source.get("created_at"):
        raise ValueError("Model result was edited after first publication")
    if not trusted_report(
        source, run_id=run_id, dispatch_id=dispatch_id,
        number=number, sha=sha,
    ):
        raise ValueError("Predecessor's provider-run report not verified")
    body = source["body"]
    if any(
        c.get("user", {}).get("login") == "github-actions[bot]"
        and MARKER.search(c.get("body") or "")
        and c.get("body") == body
        for c in comments(number)
    ):
        print("CURRENT_RUN_REVIEW_ALREADY_PUBLISHED")
        return

    # Race fence immediately before posting; no fork/untrusted checkout,
    # provider secret, execution of PR scripts or force merge.
    trusted.read_current_pr(REPO, number, sha)
    trusted.verify_provenance(REPO, number, sha, actors)
    if not trusted.ci_green(REPO, sha):
        raise ValueError("Current head/CI changed before publication")
    api(f"repos/{REPO}/issues/{number}/comments", body={"body": body})
    print(f"CURRENT_RUN_REVIEW_PUBLISHED PR #{number} SHA {sha}")


def selftest():
    sha = "a" * 40
    result = {
        "user": {"login": "github-actions[bot]"},
        "body": (
            "**mistral-vibe unattended wake**\n\n"
            f"Target PR #487 exact_sha={sha}; parent verified 3/3 CI green.\n"
            f"sha {sha}\nVERDICT: PASS\n"
            "<!-- tabibi-mistral-review-run:123 dispatch-comment:456 -->"
        ),
    }
    args = dict(run_id="123", dispatch_id="456", number=487, sha=sha)
    assert trusted_report(result, **args)
    for broken in (
        dict(result, user={"login": "NTinkicht"}),
        dict(result, body=result["body"].replace("VERDICT: PASS", "VERDICT: NO")),
        dict(result, body=result["body"].replace("123", "999")),
        dict(result, body=result["body"].replace(sha, "b" * 40)),
        dict(result, body=result["body"] + "\nVERDICT: PASS"),
        dict(result, body=result["body"] + "\nghp_" + "a" * 18),
    ):
        assert not trusted_report(broken, **args)
    print("Separated Mistral PR publisher negative-path selftest passed")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "selftest":
        selftest()
    elif len(sys.argv) == 1:
        try:
            publish()
        except (
            ValueError, KeyError, TypeError, OSError,
            subprocess.SubprocessError, json.JSONDecodeError,
        ):
            print("REVIEW_PUBLISH_BLOCKED: trusted provider/PR evidence incomplete")
            sys.exit(1)
    else:
        sys.exit(2)
