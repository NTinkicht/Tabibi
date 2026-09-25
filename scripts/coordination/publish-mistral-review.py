#!/usr/bin/env python3
"""Trusted, credential-isolated PR publisher for a completed Mistral review job.

The preceding inference job has issues:write and pull-requests:read; this fresh
job has pull-requests:write but no Mistral credential, PR checkout or model.
Only repost a provider-run-bound review already published by the trusted parent
to Issue #11. An authenticated clean PASS also publishes a commit-pinned native
GitHub APPROVE review (like OneCompany), never an automatic merge or self-gate.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

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


def proof_reader():
    location = Path("scripts/coordination/mistral-review-proof.py")
    spec = importlib.util.spec_from_file_location("trusted_mistral_proof", location)
    if spec is None or spec.loader is None:
        raise ValueError("Run-scoped proof helper unavailable")
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


def native_approval(number, sha, *, run_id, report_id):
    """Publish a commit-bound APPROVE only after the caller checked sealed proof.

    This privileged publisher runs separately from model inference. Mistral has
    no pull-request-write token; a raw model statement can never call this path.
    """
    if not (str(run_id).isdigit() and str(report_id).isdigit()):
        raise ValueError("Untrusted review identity")
    marker = f"tabibi-mistral-native-v1 run={run_id} report={report_id} sha={sha}"
    for page in range(1, 11):
        batch = api(f"repos/{REPO}/pulls/{number}/reviews?per_page=100&page={page}")
        if not isinstance(batch, list):
            raise ValueError("Native review history unavailable")
        for review in batch:
            if marker in (review.get("body") or ""):
                if (
                    review.get("user", {}).get("login") == "github-actions[bot]"
                    and review.get("state") == "APPROVED"
                    and review.get("commit_id") == sha
                ):
                    print("CURRENT_RUN_NATIVE_MISTRAL_APPROVAL_ALREADY_PUBLISHED")
                    return
                raise ValueError("Conflicting native review marker")
        if len(batch) < 100:
            break
    else:
        raise ValueError("Native review history exceeds bound")
    approval = api(
        f"repos/{REPO}/pulls/{number}/reviews",
        body={
            "commit_id": sha,
            "event": "APPROVE",
            "body": (
                "Authenticated independent Mistral Vibe exact-head technical PASS.\n\n"
                f"PR #{number}; exact head {sha}.\n"
                f"Run: https://github.com/{REPO}/actions/runs/{run_id}\n"
                f"Immutable evidence: https://github.com/{REPO}/issues/11#issuecomment-{report_id}\n\n"
                "A run-sealed, independently executed, non-material-author PASS was verified "
                "against the unchanged current PR and green 3/3 CI by the trusted parent. "
                "This native review does not authorize merge without all other Tabibi gates.\n\n"
                f"<!-- {marker} -->"
            ),
        },
    )
    if approval.get("state") != "APPROVED" or approval.get("commit_id") != sha:
        raise ValueError("Native current-head approval not confirmed")
    print(f"CURRENT_RUN_NATIVE_MISTRAL_APPROVED PR #{number} SHA {sha}")


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
    sealed = proof_reader()
    proof = sealed.read_run_proof(run_id)
    if not sealed.matches(
        proof, source, run_id=run_id, dispatch_id=dispatch_id,
        pr=number, sha=sha,
    ):
        raise ValueError("Run-scoped artifact does not authenticate review report")
    body = source["body"]
    copied = any(
        c.get("user", {}).get("login") == "github-actions[bot]"
        and MARKER.search(c.get("body") or "")
        and c.get("body") == body
        for c in comments(number)
    )

    # Race fence immediately before ANY write; an old sealed result is not
    # approval of a new SHA, even when GitHub still displays its old PASS.
    trusted.read_current_pr(REPO, number, sha)
    trusted.verify_provenance(REPO, number, sha, actors)
    if not trusted.ci_green(REPO, sha):
        raise ValueError("Current head/CI changed before publication")
    if not copied:
        api(f"repos/{REPO}/issues/{number}/comments", body={"body": body})
        print(f"CURRENT_RUN_REVIEW_PUBLISHED PR #{number} SHA {sha}")
    else:
        print("CURRENT_RUN_REVIEW_ALREADY_PUBLISHED")

    # The new GitHub Actions create/approve repository setting allows a real
    # bot APPROVE, but only after the artifact-sealed non-author PASS above.
    # A CHANGES_REQUIRED / minor-only / failed / stale review never approves.
    if VERDICT.findall(body) == ["PASS"]:
        trusted.read_current_pr(REPO, number, sha)
        trusted.verify_provenance(REPO, number, sha, actors)
        if not trusted.ci_green(REPO, sha):
            raise ValueError("Current head/CI changed before native approval")
        native_approval(number, sha, run_id=run_id, report_id=source_report_id)


def publish_copy_path_selftest():
    """publish() must copy the sealed Issue #11 report byte-identically.

    The sealed document is the Issue #11 comment the run artifact points at
    (id 777). The PR-side copy gets a NEW comment id (888); publication stays
    valid only while the posted body is identical to the sealed document.
    """
    sha = "a" * 40
    dispatch_body = (
        "@mistral-vibe\nBINDING_EXACT_HEAD_REVIEW\n"
        f"review_pr: 487\nreview_sha: {sha}\nmaterial_authors: chatgpt"
    )
    review_body = (
        "**mistral-vibe unattended wake**\n\n"
        f"Target PR #487 exact_sha={sha}; parent verified 3/3 CI green.\n"
        f"sha {sha}\nVERDICT: PASS\n"
        "<!-- tabibi-mistral-review-run:123 dispatch-comment:456 -->"
    )
    sealed_source = {
        "id": 777,
        "user": {"login": "github-actions[bot]"},
        "issue_url": f"https://api.github.com/repos/{REPO}/issues/11",
        "created_at": "2026-09-24T10:02:00Z",
        "updated_at": "2026-09-24T10:02:00Z",
        "body": review_body,
    }
    pr_comments = []
    native_reviews = []
    real_target = parent()
    proof_mod = proof_reader()
    proof = proof_mod.proof_for(
        review_body, run_id=123, dispatch_id=456, pr=487, sha=sha,
        report_id=777,
    )

    class FakeTarget:
        @staticmethod
        def parse(body):
            return real_target.parse(body)

        @staticmethod
        def read_current_pr(repo, number, exact_sha):
            return {
                "state": "open",
                "head": {"sha": exact_sha, "repo": {"full_name": repo}},
                "base": {"ref": "main", "repo": {"full_name": repo}},
            }

        @staticmethod
        def verify_provenance(repo, number, exact_sha, actors):
            return True

        @staticmethod
        def ci_green(repo, exact_sha):
            return True

    class FakeProof:
        @staticmethod
        def read_run_proof(run_id):
            return proof

        @staticmethod
        def matches(p, c, *, run_id, dispatch_id, pr, sha):
            return proof_mod.matches(p, c, run_id=run_id,
                                     dispatch_id=dispatch_id, pr=pr, sha=sha)

    def fake_api(route, *, body=None):
        if route == f"repos/{REPO}/issues/comments/777":
            return sealed_source
        if route == f"repos/{REPO}/issues/487/comments?per_page=100&page=1":
            return pr_comments
        if route == f"repos/{REPO}/issues/487/comments":
            assert body is not None and body.get("body") == review_body
            copy = {"id": 888, "user": {"login": "github-actions[bot]"},
                    "body": body["body"]}
            pr_comments.append(copy)
            return copy
        if route == f"repos/{REPO}/pulls/487/reviews?per_page=100&page=1":
            return native_reviews
        if route == f"repos/{REPO}/pulls/487/reviews":
            assert body is not None
            assert body.get("event") == "APPROVE"
            assert body.get("commit_id") == sha
            assert "run=123 report=777" in body.get("body", "")
            approved = {
                "id": 999, "user": {"login": "github-actions[bot]"},
                "state": "APPROVED", "commit_id": sha, "body": body["body"],
            }
            native_reviews.append(approved)
            return approved
        raise ValueError("Unexpected publisher API route")

    event = {
        "action": "created",
        "issue": {"number": 11},
        "comment": {
            "id": 456, "user": {"login": "NTinkicht"},
            "created_at": "2026-09-24T10:00:00Z",
            "updated_at": "2026-09-24T10:00:00Z",
            "body": dispatch_body,
        },
    }
    saved_globals = {name: globals()[name] for name in ("api", "parent", "proof_reader")}
    saved_api_raw = proof_mod.api_raw
    saved_env = {key: os.environ.get(key) for key in (
        "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "SOURCE_REPORT_ID", "GITHUB_EVENT_PATH",
    )}
    event_path = None
    try:
        def proof_api_raw(route):
            if route == f"repos/{REPO}/issues/comments/777":
                return json.dumps(sealed_source).encode()
            raise ValueError("Sealed report unavailable")

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as stream:
            json.dump(event, stream)
            event_path = stream.name
        proof_mod.api_raw = proof_api_raw
        os.environ.update({
            "GITHUB_REPOSITORY": REPO,
            "GITHUB_RUN_ID": "123",
            "SOURCE_REPORT_ID": "777",
            "GITHUB_EVENT_PATH": event_path,
        })
        globals()["api"] = fake_api
        globals()["parent"] = lambda: FakeTarget
        globals()["proof_reader"] = lambda: FakeProof

        publish()
        assert pr_comments == [{
            "id": 888, "user": {"login": "github-actions[bot]"}, "body": review_body,
        }], pr_comments
        assert len(native_reviews) == 1
        assert native_reviews[0]["state"] == "APPROVED"
        assert native_reviews[0]["commit_id"] == sha
        # Idempotent on retry: neither the sealed copy nor bot approval doubles.
        publish()
        assert pr_comments == [{
            "id": 888, "user": {"login": "github-actions[bot]"}, "body": review_body,
        }], pr_comments
        assert len(native_reviews) == 1
        # An edited sealed report must fail closed before any copy or approval.
        sealed_source["updated_at"] = "2026-09-24T10:30:00Z"
        try:
            publish()
        except ValueError:
            pass
        else:
            raise AssertionError("Edited sealed report was published")
        sealed_source["updated_at"] = "2026-09-24T10:02:00Z"
        # Native approval is reserved for exact clean PASS only, even though
        # an adverse run may publish its sealed PR COMMENT for triage.
        assert VERDICT.findall(review_body) == ["PASS"]
        assert VERDICT.findall(review_body.replace("VERDICT: PASS", "VERDICT: CHANGES_REQUIRED")) != ["PASS"]
        assert VERDICT.findall(review_body.replace("VERDICT: PASS", "VERDICT: PASS_WITH_MINOR_FINDINGS")) != ["PASS"]
        # Collision/misbound review marker cannot be silently overwritten.
        bad = [dict(native_reviews[0], user={"login": "NTinkicht"})]
        native_reviews[:] = bad
        try:
            native_approval(487, sha, run_id="123", report_id="777")
        except ValueError:
            pass
        else:
            raise AssertionError("A spoofed native review marker was accepted")
        native_reviews[:] = []
        # Explicit stale-head rejection is performed again before native approval.
        class StaleTarget(FakeTarget):
            @staticmethod
            def read_current_pr(repo, number, exact_sha):
                raise ValueError("PR head moved")
        globals()["parent"] = lambda: StaleTarget
        try:
            publish()
        except ValueError:
            pass
        else:
            raise AssertionError("A stale head was approved")
        assert not native_reviews
    finally:
        globals().update(saved_globals)
        proof_mod.api_raw = saved_api_raw
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        if event_path is not None:
            os.unlink(event_path)


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
    publish_copy_path_selftest()
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
