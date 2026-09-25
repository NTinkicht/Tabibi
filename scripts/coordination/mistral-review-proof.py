#!/usr/bin/env python3
"""Immutable, run-scoped evidence for unattended Mistral review (not a merge gate).

The safe trusted parent seals the EXACT comment it just sent to Issue #11.
GitHub Actions attaches the digest to that SAME workflow run; arbitrary
github-actions[bot] comments, edited text and run/dispatch splices cannot
create a proof artifact in an unrelated run. No credentials or raw model text
are ever stored in the artifact.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

REPO = "NTinkicht/Tabibi"
SHA = re.compile(r"[a-f0-9]{40}\Z")
MARKER = re.compile(
    r"<!-- tabibi-mistral-review-run:([0-9]{1,15}) dispatch-comment:([0-9]{1,15}) -->"
)
VERDICT = re.compile(
    r"(?m)^VERDICT:[ \t]*(PASS|PASS_WITH_MINOR_FINDINGS|CHANGES_REQUIRED)[ \t]*$"
)


# The trusted parent and its diagnostic lane use the SAME conservative redactor
# before untrusted model text can reach Actions logs or public Issue #11.
# The model may read /proc/self/environ despite a read-only tool allowlist;
# never rely on the prompt to keep environment credentials out of its output.
SENSITIVE = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    r"(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}|"
    r"(?<![A-Za-z0-9])(?:sk|xai|mistral)-[A-Za-z0-9_-]{20,}",
    re.I,
)


def redact_public_text(text, *, provider_key=""):
    if provider_key:
        text = text.replace(provider_key, "[REDACTED]")
    # A PEM body must never survive after only its header was replaced.
    if re.search(r"-----BEGIN [A-Z ]*PRIVATE KEY-----", text, re.I):
        return "[REDACTED SECURITY-SENSITIVE OUTPUT]"
    text = re.sub(
        r"(?i)(authorization\s*:\s*bearer\s+)\S+",
        r"\1[REDACTED]", text,
    )
    text = re.sub(
        r"(?i)(\b(?:MISTRAL_API_KEY|GITHUB_TOKEN|GH_TOKEN)\s*[=:]\s*)\S+",
        r"\1[REDACTED]", text,
    )
    return SENSITIVE.sub("[REDACTED]", text)


def digest(body):
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def artifact_name(run_id):
    if not str(run_id).isascii() or not str(run_id).isdigit():
        raise ValueError("Bad run id")
    return f"tabibi-mistral-review-proof-{run_id}"


def proof_for(body, *, run_id, dispatch_id, pr, sha, report_id):
    markers = MARKER.findall(body)
    verdicts = VERDICT.findall(body)
    for field in (run_id, dispatch_id, pr, report_id):
        if not str(field).isascii() or not str(field).isdigit():
            raise ValueError("Bad review evidence identity")
    if (
        len(body) >= 55_000
        or not SHA.fullmatch(sha)
        or len(markers) != 1
        or markers[0] != (str(run_id), str(dispatch_id))
        or len(verdicts) != 1
        or body.count("**mistral-vibe unattended wake**") != 1
        or f"Target PR #{pr} exact_sha={sha};" not in body
        or body.count(sha) < 2
    ):
        raise ValueError("Missing authentic final-head review result")
    return {
        "schema": 1,
        "run_id": str(run_id),
        "dispatch_id": str(dispatch_id),
        "pr": str(pr),
        "sha": sha,
        "report_id": str(report_id),
        "verdict": verdicts[0],
        "body_sha256": digest(body),
    }


def seal():
    if os.environ.get("GITHUB_REPOSITORY") != REPO:
        raise ValueError("Wrong repository")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    trigger = event.get("comment") or {}
    if (
        (event.get("issue") or {}).get("number") != 11
        or trigger.get("user", {}).get("login") != "NTinkicht"
        or event.get("action") != "created"
    ):
        raise ValueError("Untrusted review dispatch")
    proof = proof_for(
        Path("/tmp/tabibi-mistral-comment.md").read_text(),
        run_id=os.environ["GITHUB_RUN_ID"],
        dispatch_id=str(trigger.get("id", "")),
        pr=os.environ["REVIEW_PR"],
        sha=os.environ["REVIEW_SHA"],
        report_id=os.environ["SOURCE_REPORT_ID"],
    )
    folder = Path("/tmp/tabibi-mistral-sealed-review")
    folder.mkdir(mode=0o700, exist_ok=False)
    (folder / "proof.json").write_text(json.dumps(proof, sort_keys=True))
    os.chmod(folder / "proof.json", 0o600)


def api_raw(route):
    response = subprocess.run(
        ["gh", "api", route], capture_output=True, timeout=25, check=False
    )
    if response.returncode:
        raise ValueError("Provider-run artifact not available")
    if len(response.stdout) > 100_000:
        raise ValueError("Oversized review proof artifact")
    return response.stdout


def read_run_proof(run_id):
    run_id = str(run_id)
    name = artifact_name(run_id)
    metadata = json.loads(api_raw(
        f"repos/{REPO}/actions/runs/{run_id}/artifacts?name={name}&per_page=100"
    ))
    matches = [
        item for item in metadata.get("artifacts", [])
        if item.get("name") == name
        and not item.get("expired")
        and item.get("workflow_run", {}).get("id") == int(run_id)
    ]
    if len(matches) != 1:
        raise ValueError("Missing unique immutable run-scoped proof")
    payload = api_raw(f"repos/{REPO}/actions/artifacts/{matches[0]['id']}/zip")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        if archive.namelist() != ["proof.json"]:
            raise ValueError("Malformed proof archive")
        if archive.getinfo("proof.json").file_size > 4_096:
            raise ValueError("Oversized proof JSON")
        proof = json.loads(archive.read("proof.json"))
    if not isinstance(proof, dict) or proof.get("schema") != 1:
        raise ValueError("Unknown review proof schema")
    if proof.get("run_id") != run_id:
        raise ValueError("Artifact cannot be paired with another run")
    return proof


def sealed_report(proof):
    """Authenticate the sealed Issue #11 report this run's artifact points at.

    The artifact's report_id is the only pointer to the sealed document. The
    PR-side copy published later is a DIFFERENT comment whose id can never
    equal the sealed Issue #11 report id, so the copy itself is never the
    sealed document.
    """
    report_id = str((proof or {}).get("report_id") or "")
    if not report_id.isascii() or not report_id.isdigit():
        raise ValueError("Sealed report identity missing")
    source = json.loads(api_raw(f"repos/{REPO}/issues/comments/{report_id}"))
    if (
        not isinstance(source, dict)
        or str(source.get("id") or "") != report_id
        or not (source.get("issue_url") or "").endswith("/issues/11")
        or source.get("updated_at", source.get("created_at")) != source.get("created_at")
        or source.get("user", {}).get("login") != "github-actions[bot]"
        or digest(source.get("body") or "") != str((proof or {}).get("body_sha256") or "")
    ):
        raise ValueError("Sealed report does not authenticate against run proof")
    return source


def matches(proof, comment, *, run_id, dispatch_id, pr, sha):
    """Accept a PR comment only as an identical-body copy of the sealed report.

    The sealed document is always the Issue #11 comment authenticated via the
    run-scoped artifact. A PR copy with a different comment id stays eligible
    only while its body is byte-identical to that sealed document.
    """
    if not isinstance(proof, dict):
        return False
    try:
        source = sealed_report(proof)
        expected = proof_for(
            source.get("body") or "",
            run_id=run_id,
            dispatch_id=dispatch_id,
            pr=pr,
            sha=sha,
            report_id=source.get("id"),
        )
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        return False
    return expected == proof and (comment.get("body") or "") == source.get("body")


def selftest():
    secret = "provider-test-secret-never-log"
    github = "ghs_" + "Z" * 32
    for sample in (
        secret, github, "ghp_" + "Y" * 32,
        "Authorization: Bearer " + github,
        "GH_TOKEN=" + github, "GITHUB_TOKEN: " + github,
        "MISTRAL_API_KEY=" + secret,
        "mistral-" + "Q" * 24,
    ):
        public = redact_public_text("before " + sample + " after", provider_key=secret)
        assert secret not in public and github not in public
        assert sample not in public
        assert "[REDACTED]" in public
    assert redact_public_text("safe SHA " + "a" * 40) == "safe SHA " + "a" * 40
    assert redact_public_text("-----BEGIN RSA PRIVATE KEY-----\\nFAKE_PRIVATE_MATERIAL").startswith(
        "[REDACTED SECURITY-SENSITIVE OUTPUT]"
    )
    sha = "a" * 40
    body = (
        "**mistral-vibe unattended wake**\n"
        f"Target PR #7 exact_sha={sha}; parent verified 3/3 CI green.\n"
        f"sha {sha}\nVERDICT: PASS\n"
        "<!-- tabibi-mistral-review-run:18 dispatch-comment:44 -->"
    )
    # The sealed document is the Issue #11 report; the PR-side copy is a
    # different comment whose id can never equal the sealed report id.
    sealed_source = {
        "id": 900,
        "user": {"login": "github-actions[bot]"},
        "issue_url": f"https://api.github.com/repos/{REPO}/issues/11",
        "created_at": "2026-09-24T10:02:00Z",
        "updated_at": "2026-09-24T10:02:00Z",
        "body": body,
    }
    pr_copy = {"id": 123, "body": body}
    proof = proof_for(body, run_id=18, dispatch_id=44, pr=7,
                      sha=sha, report_id=900)
    # API and ZIP boundary: a user-authored bot comment must not stand in
    # for a GitHub artifact uploaded by this exact reviewer run.
    archive_stream = io.BytesIO()
    with zipfile.ZipFile(archive_stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("proof.json", json.dumps(proof))
    archive_bytes = archive_stream.getvalue()
    original_api = globals()["api_raw"]
    try:
        def synthetic_api(route):
            if route == f"repos/{REPO}/issues/comments/900":
                return json.dumps(sealed_source).encode()
            if "/artifacts?name=" in route:
                return json.dumps({
                    "artifacts": [{
                        "id": 991, "name": artifact_name(18),
                        "expired": False, "workflow_run": {"id": 18},
                    }],
                }).encode()
            if route.endswith("/artifacts/991/zip"):
                return archive_bytes
            raise ValueError("Unknown synthetic API path")
        globals()["api_raw"] = synthetic_api
        assert matches(proof, pr_copy, run_id=18, dispatch_id=44, pr=7, sha=sha)
        # Any other PR copy id is still eligible: only the body must be an
        # identical copy of the sealed Issue #11 document.
        assert matches(proof, dict(pr_copy, id=124), run_id=18,
                       dispatch_id=44, pr=7, sha=sha)
        assert not matches(proof, dict(pr_copy, body=body + "edited"),
                           run_id=18, dispatch_id=44, pr=7, sha=sha)
        assert not matches(proof, dict(pr_copy, body=body.replace(
            "VERDICT: PASS", "VERDICT: CHANGES_REQUIRED"
        )), run_id=18, dispatch_id=44, pr=7, sha=sha)
        assert not matches(proof, pr_copy, run_id=19, dispatch_id=44, pr=7, sha=sha)
        assert not matches(proof, pr_copy, run_id=18, dispatch_id=45, pr=7, sha=sha)
        assert not matches(proof, pr_copy, run_id=18, dispatch_id=44, pr=8, sha=sha)
        assert not matches(proof, pr_copy, run_id=18, dispatch_id=44, pr=7,
                           sha="b" * 40)
        assert not matches(dict(proof, body_sha256="0" * 64), pr_copy,
                           run_id=18, dispatch_id=44, pr=7, sha=sha)
        # The sealed Issue #11 document itself must stay authentic.
        for forged in (
            dict(sealed_source, updated_at="2026-09-24T10:30:00Z"),
            dict(sealed_source, issue_url=f"https://api.github.com/repos/{REPO}/issues/99"),
            dict(sealed_source, id=901),
            dict(sealed_source, user={"login": "NTinkicht"}),
            dict(sealed_source, body=body + "edited"),
        ):
            def forged_api(route, forged=forged):
                if route == f"repos/{REPO}/issues/comments/900":
                    return json.dumps(forged).encode()
                raise ValueError("Unknown synthetic API path")
            globals()["api_raw"] = forged_api
            assert not matches(proof, pr_copy, run_id=18, dispatch_id=44,
                               pr=7, sha=sha), forged
        def absent_api(route):
            raise ValueError("Sealed report unavailable")
        globals()["api_raw"] = absent_api
        assert not matches(proof, pr_copy, run_id=18, dispatch_id=44, pr=7, sha=sha)
        globals()["api_raw"] = synthetic_api
        assert read_run_proof(18) == proof
        assert matches(read_run_proof(18), pr_copy,
                       run_id=18, dispatch_id=44, pr=7, sha=sha)
        try:
            read_run_proof(19)
        except ValueError:
            pass
        else:
            raise AssertionError("Wrong run accepted an unrelated artifact")
        def missing_artifact_api(route):
            if route == f"repos/{REPO}/issues/comments/900":
                return json.dumps(sealed_source).encode()
            if "/artifacts?name=" in route:
                return b'{"artifacts":[]}'
            raise ValueError("Artifact unavailable")
        globals()["api_raw"] = missing_artifact_api
        try:
            read_run_proof(18)
        except ValueError:
            pass
        else:
            raise AssertionError("Missing provider artifact accepted")
    finally:
        globals()["api_raw"] = original_api
    print("Run-scoped Mistral review proof selftest passed")


if __name__ == "__main__":
    try:
        if len(sys.argv) == 2 and sys.argv[1] == "selftest":
            selftest()
        elif len(sys.argv) == 2 and sys.argv[1] == "seal":
            seal()
        else:
            raise ValueError("Usage: proof.py selftest|seal")
    except (OSError, ValueError, TypeError, KeyError,
            subprocess.SubprocessError, json.JSONDecodeError, zipfile.BadZipFile):
        print("BLOCKED: review proof cannot be established", file=sys.stderr)
        sys.exit(1)
