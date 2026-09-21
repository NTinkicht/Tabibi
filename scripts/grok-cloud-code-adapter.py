#!/usr/bin/env python3
"""Trusted parent for DEFAULT-OFF Grok proposal-to-code GitHub adapter.

The Vibe child has ONLY read tools and prints bounded JSON edits. It never
receives GitHub write credentials. This file validates a cloud Bot PR-comment proposal and is copied outside the reviewed
worktree before exact-SHA checkout; only the trusted parent applies edits,
runs deterministic tests, and can commit/push onto the SAME canonical PR.
"""
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

SHA = re.compile(r"[a-f0-9]{40}\Z")
SAFE_PATH = re.compile(r"(?:src|tests)/[A-Za-z0-9_./\[\]-]+\Z")
FIELD_PATH = re.compile(r"(?m)^([a-z_]+):[ \t]*(.*?)[ \t]*$")
BEGIN = "BEGIN_TABIBI_PATCH_JSON"
END = "END_TABIBI_PATCH_JSON"
MAX_PATCH_BYTES = 28_000
MAX_FILE_BYTES = 200_000
REDACT = re.compile(
    r"(?im)-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    r"(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}|"
    r"(?<![A-Za-z0-9])(?:sk|xai|grok)-[A-Za-z0-9_\-]{20,}|"
    r"(?:GITHUB_TOKEN|GROK_API_KEY|XAI_API_KEY)[ \t]*[:=][ \t]*[^\s]+"
)


def github(route):
    data = subprocess.check_output(
        ["gh", "api", route], stderr=subprocess.DEVNULL, timeout=25
    )
    return json.loads(data)


def emit(**values):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
        for key, value in values.items():
            out.write(f"{key}={value}\n")


def fail(code):
    emit(ready="false", status=code)


def fields(body):
    values = {}
    for key, value in FIELD_PATH.findall(body):
        if key in values:
            raise ValueError("Duplicate lease field")
        values[key] = value.strip()
    return values


def parse_owner_dispatch(body):
    if body.count("GROK_CLOUD_CODE_PROPOSAL_V1") != 1:
        raise ValueError("Missing or duplicate implementation marker")
    f = fields(body)
    number = f.get("pr", "")
    sha = f.get("exact_sha", "")
    stream = f.get("stream", "")
    paths = f.get("allowed_paths", "").split(",")
    objective = f.get("objective", "")
    if (
        not number.isascii() or not number.isdigit() or int(number) < 1
        or not SHA.fullmatch(sha)
        or not re.fullmatch(r"WU[0-9]{1,5}", stream)
        or not 2 <= len(paths) <= 4
        or not 10 <= len(objective) <= 240
        or not objective.isprintable() or REDACT.search(objective)
    ):
        raise ValueError("Invalid implementation lease")
    paths = [v.strip() for v in paths]
    if len(paths) != len(set(paths)) or any(not SAFE_PATH.fullmatch(v) for v in paths):
        raise ValueError("Unsafe or repeated path")
    if not any(v.startswith("src/") for v in paths):
        raise ValueError("Only test changes cannot claim production implementation")
    if not any(v.startswith("tests/") for v in paths):
        raise ValueError("A coding lease requires test changes")
    if any(".." in Path(v).parts for v in paths):
        raise ValueError("Path traversal")
    return int(number), sha, stream, paths, objective


def pr_current(repo, number, sha):
    pr = github(f"repos/{repo}/pulls/{number}")
    branch = pr.get("head", {}).get("ref", "")
    if (
        pr.get("state") != "open" or pr.get("head", {}).get("sha") != sha
        or pr.get("head", {}).get("repo", {}).get("full_name") != repo
        or pr.get("base", {}).get("repo", {}).get("full_name") != repo
        or pr.get("base", {}).get("ref") != "main"
        or not re.fullmatch(r"[A-Za-z0-9_./-]{1,160}", branch)
        or ".." in branch or branch.startswith(("/", "-"))
    ):
        raise ValueError("Canonical same-repo PR head changed or is unsafe")
    return branch


LEASE_EVENTS = frozenset({
    "ROLE_LEASE_ASSIGNED", "ROLE_LEASE_RELEASED", "ROLE_LEASE_REPLACED",
    "ROLE_FAILOVER", "ROLE_LEASE_CANCELLED",
})
LEASE_EVENT_LINE = re.compile(r"(?m)^(ROLE_LEASE_[A-Z_]+|ROLE_FAILOVER)[ ]*$")


def replay_owner_lease(comments, number, sha, stream):
    """Replay only exact owner event lines; mentions in prose cannot grant a lease."""
    active = None
    for comment in sorted(comments, key=lambda c: c.get("id") or 0):
        if comment.get("user", {}).get("login") != "NTinkicht":
            continue
        body = comment.get("body") or ""
        markers = LEASE_EVENT_LINE.findall(body)
        if not markers:
            continue
        if len(markers) != 1 or markers[0] not in LEASE_EVENTS:
            raise ValueError("Mixed or unsupported owner lease event")
        event = markers[0]
        if event == "ROLE_LEASE_ASSIGNED":
            if active is not None:
                raise ValueError("Overlapping active implementation leases")
            f = fields(body)
            if (
                f.get("actor") is None or f.get("capability") != "implementation"
                or f.get("pr", "").removeprefix("#") != str(number)
                or not SHA.fullmatch(f.get("exact_sha", ""))
                or not re.fullmatch(r"WU[0-9]{1,5}", f.get("stream", ""))
            ):
                raise ValueError("Invalid sole-implementer assignment")
            active = (comment.get("id"), f)
        else:
            if active is None:
                raise ValueError("Lease released or replaced without active lease")
            # A release is terminal for the current actor; replacement/failover
            # also requires a later explicit new ROLE_LEASE_ASSIGNED event.
            active = None
    if active is None:
        raise ValueError("No active owner implementation assignment")
    lease_id, f = active
    if (
        f.get("actor") != "grok"
        or f.get("pr", "").removeprefix("#") != str(number)
        or f.get("exact_sha") != sha
        or f.get("stream") != stream
    ):
        raise ValueError("Active implementation lease is not for Grok/current SHA")
    return lease_id


def active_owner_lease(repo, number, sha, stream):
    comments = []
    for page in range(1, 11):
        batch = github(f"repos/{repo}/issues/{number}/comments?per_page=100&page={page}")
        if not isinstance(batch, list):
            raise ValueError("Lease comment history unavailable")
        comments.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise ValueError("Lease comment history exceeds safety bound")
    return replay_owner_lease(comments, number, sha, stream)


def parse_patch(text, allowed):
    if len(text.encode("utf-8")) > MAX_PATCH_BYTES * 2:
        raise ValueError("Model output too large")
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        raise ValueError("Missing or duplicate patch delimiters")
    body = text.split(BEGIN, 1)[1].split(END, 1)[0].strip()
    if not body or len(body.encode("utf-8")) > MAX_PATCH_BYTES:
        raise ValueError("Empty or oversized patch")
    obj = json.loads(body)
    if not isinstance(obj, dict) or set(obj) != {"edits"}:
        raise ValueError("Unexpected patch object shape")
    edits = obj["edits"]
    if not isinstance(edits, list) or not 2 <= len(edits) <= len(allowed):
        raise ValueError("Patch must modify only leased production and test files")
    found = set()
    for edit in edits:
        if not isinstance(edit, dict) or set(edit) != {"path", "old", "new"}:
            raise ValueError("Unexpected edit shape")
        path, old, new = edit["path"], edit["old"], edit["new"]
        if (
            not isinstance(path, str) or path not in allowed or path in found
            or not isinstance(old, str) or not isinstance(new, str)
            or not old or old == new or len(old) > 12_000 or len(new) > 12_000
            or REDACT.search(new)
        ):
            raise ValueError("Disallowed edit, repeated path or secret material")
        found.add(path)
    if not any(p.startswith("src/") for p in found):
        raise ValueError("Missing production edit")
    if not any(p.startswith("tests/") for p in found):
        raise ValueError("Missing test edit")
    return edits


def apply_patch(text, allowed, root):
    edits = parse_patch(text, allowed)
    modified = []
    for edit in edits:
        raw = edit["path"]
        path = root / raw
        # Reject linked worktree files and all indirect path traversals.
        current = root
        for part in Path(raw).parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("Symlinked edit path")
        if path.resolve().is_relative_to(root.resolve()) is False:
            raise ValueError("Edit escapes repository")
        metadata = path.lstat()
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_size > MAX_FILE_BYTES
        ):
            raise ValueError("Edit target not a bounded single-link regular file")
        source = path.read_text(encoding="utf-8")
        if source.count(edit["old"]) != 1:
            raise ValueError("Old text must match exactly once")
        result = source.replace(edit["old"], edit["new"], 1)
        if len(result.encode("utf-8")) > MAX_FILE_BYTES or REDACT.search(result):
            raise ValueError("Result unsafe or oversized")
        modified.append((path, result))
    # Validate ALL edits before writing any of them.
    for path, result in modified:
        path.write_text(result, encoding="utf-8")
    return [str(path.relative_to(root)) for path, _ in modified]


def run(command, *, capture=False):
    return subprocess.run(command, check=True, text=True, capture_output=capture)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "selftest":
        sha = "a" * 40
        body = (f"GROK_CLOUD_CODE_PROPOSAL_V1\npr: 2\nexact_sha: {sha}\n"
                "stream: WU101\nallowed_paths: src/a.ts,tests/a.test.ts\n"
                "objective: Change foo and test assertion from 1 to 2")
        assert parse_owner_dispatch(body) == (
            2, sha, "WU101", ["src/a.ts", "tests/a.test.ts"],
            "Change foo and test assertion from 1 to 2"
        )
        for bad in (
            body.replace("src/a.ts", "../.github/workflows/a.yml"),
            body.replace(sha, "wrong"),
            body.replace("tests/a.test.ts", "src/b.ts"),
        ):
            try:
                parse_owner_dispatch(bad)
            except ValueError:
                pass
            else:
                raise AssertionError("Unsafe implementation lease accepted")
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as d:
            root = Path(d)
            (root / "src").mkdir()
            (root / "tests").mkdir()
            (root / "src/a.ts").write_text("const foo = 1;\n")
            (root / "tests/a.test.ts").write_text("expect(1).toBe(1);\n")
            body = json.dumps({"edits": [
                {"path": "src/a.ts", "old": "foo = 1", "new": "foo = 2"},
                {"path": "tests/a.test.ts",
                 "old": "expect(1)", "new": "expect(2)"},
            ]})
            payload = f"{BEGIN}\n{body}\n{END}"
            changed = apply_patch(
                payload, ["src/a.ts", "tests/a.test.ts"], root
            )
            assert len(changed) == 2
            assert "foo = 2" in (root / "src/a.ts").read_text()
            symlink = root / "src/link.ts"
            symlink.symlink_to(root / "src/a.ts")
            attack = json.dumps({"edits": [
                {"path": "src/link.ts", "old": "foo = 2", "new": "foo = 3"},
                {"path": "tests/a.test.ts",
                 "old": "expect(2)", "new": "expect(3)"},
            ]})
            try:
                apply_patch(f"{BEGIN}\n{attack}\n{END}",
                            ["src/link.ts", "tests/a.test.ts"], root)
            except ValueError:
                pass
            else:
                raise AssertionError("Symlink attack accepted")
        assigned = {
            "id": 10, "user": {"login": "NTinkicht"},
            "body": (f"ROLE_LEASE_ASSIGNED\nactor: grok\n"
                     f"capability: implementation\npr: #2\nexact_sha: {sha}\n"
                     "stream: WU101"),
        }
        assert replay_owner_lease([assigned], 2, sha, "WU101") == 10
        release = {
            "id": 11, "user": {"login": "NTinkicht"},
            "body": ("ROLE_LEASE_RELEASED\n"
                     "reason: releasing prior ROLE_LEASE_ASSIGNED actor"),
        }
        for history in ([assigned, release], [assigned, dict(assigned, id=11)],
                        [assigned, {"id": 11, "user": {"login": "NTinkicht"},
                                    "body": "ROLE_LEASE_CANCELLED\nROLE_LEASE_ASSIGNED"}]):
            try:
                replay_owner_lease(history, 2, sha, "WU101")
            except ValueError:
                pass
            else:
                raise AssertionError("Inactive, duplicate or mixed lease accepted")
        new_assignment = dict(assigned, id=12)
        assert replay_owner_lease(
            [assigned, release, new_assignment], 2, sha, "WU101"
        ) == 12
        print("Grok trusted implementation-adapter selftest passed")
        return

    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if repo != "NTinkicht/Tabibi":
        fail("REPOSITORY_BLOCKED")
        return
    if mode == "prepare":
        # A fresh owner lease activates this one proposal. Grok inference
        # happens only in the provider's existing included Bot routine;
        # this trusted parent has no xAI credentials or billable API route.
        try:
            number, sha, stream, paths, objective = parse_owner_dispatch(
                os.environ.get("DISPATCH_BODY", "")
            )
            if int(os.environ.get("EVENT_PR", "0")) != number:
                raise ValueError("Grok proposal posted on wrong PR")
            branch = pr_current(repo, number, sha)
            lease = active_owner_lease(repo, number, sha, stream)
            if fields(os.environ.get("DISPATCH_BODY", "")).get("source_lease_id") != str(lease):
                raise ValueError("Proposal has wrong source lease")
            emit(ready="true", status="OK", pr=number, sha=sha,
                 stream=stream, branch=branch, lease=lease,
                 paths=",".join(paths), objective=objective)
        except (ValueError, KeyError, subprocess.SubprocessError, json.JSONDecodeError):
            fail("LEASE_OR_TARGET_BLOCKED")
        return
    if mode == "apply":
        try:
            number = int(os.environ["REVIEW_PR"])
            sha = os.environ["REVIEW_SHA"]
            stream = os.environ["REVIEW_STREAM"]
            paths = os.environ["ALLOWED_PATHS"].split(",")
            branch = pr_current(repo, number, sha)
            if branch != os.environ["REVIEW_BRANCH"]:
                raise ValueError("Canonical branch changed")
            if str(active_owner_lease(repo, number, sha, stream)) != os.environ["LEASE_ID"]:
                raise ValueError("Original lease superseded")
            head = run(["git", "rev-parse", "HEAD"], capture=True).stdout.strip()
            if head != sha or run(["git", "status", "--porcelain"], capture=True).stdout:
                raise ValueError("Unclean or stale checkout")
            content = Path("/tmp/tabibi-grok-code.txt").read_text(encoding="utf-8")
            changed = apply_patch(content, paths, Path.cwd())
            run(["git", "diff", "--check"])
            actual = run(["git", "diff", "--name-only"], capture=True).stdout.splitlines()
            if set(actual) != set(changed):
                raise ValueError("Unexpected changed files")
            # Seal only the schema-checked patch before any untrusted tests run.
            # No raw model transcript, environment or other runner files travel
            # from the proposal job into the fresh publish job.
            parsed = parse_patch(content, paths)
            Path("/tmp/tabibi-grok-validated.json").write_text(
                json.dumps({"edits": parsed}, ensure_ascii=False),
                encoding="utf-8",
            )
            emit(ready="true", status="PATCH_READY", changed=",".join(changed))
        except (ValueError, KeyError, OSError, subprocess.SubprocessError, json.JSONDecodeError):
            fail("PATCH_BLOCKED")
        return
    if mode == "applyartifact":
        try:
            number = int(os.environ["REVIEW_PR"])
            sha = os.environ["REVIEW_SHA"]
            stream = os.environ["REVIEW_STREAM"]
            paths = os.environ["ALLOWED_PATHS"].split(",")
            branch = pr_current(repo, number, sha)
            if branch != os.environ["REVIEW_BRANCH"]:
                raise ValueError("Canonical branch changed")
            if str(active_owner_lease(repo, number, sha, stream)) != os.environ["LEASE_ID"]:
                raise ValueError("Lease superseded")
            if run(["git", "rev-parse", "HEAD"], capture=True).stdout.strip() != sha:
                raise ValueError("Stale artifact checkout")
            if run(["git", "status", "--porcelain"], capture=True).stdout:
                raise ValueError("Artifact checkout not clean")
            blob = Path("/tmp/tabibi-grok-validated.json").read_text(encoding="utf-8")
            if len(blob.encode("utf-8")) > MAX_PATCH_BYTES:
                raise ValueError("Artifact too large")
            changed = apply_patch(f"{BEGIN}\n{blob}\n{END}", paths, Path.cwd())
            run(["git", "diff", "--check"])
            actual = run(["git", "diff", "--name-only"], capture=True).stdout.splitlines()
            if set(changed) != set(actual):
                raise ValueError("Unexpected artifact changes")
            emit(ready="true", status="ARTIFACT_VERIFIED")
        except (ValueError, KeyError, OSError, subprocess.SubprocessError, json.JSONDecodeError):
            fail("ARTIFACT_BLOCKED")
        return
    if mode == "publish":
        try:
            number = int(os.environ["REVIEW_PR"])
            sha = os.environ["REVIEW_SHA"]
            stream = os.environ["REVIEW_STREAM"]
            branch = pr_current(repo, number, sha)
            if branch != os.environ["REVIEW_BRANCH"]:
                raise ValueError("Canonical branch changed")
            if str(active_owner_lease(repo, number, sha, stream)) != os.environ["LEASE_ID"]:
                raise ValueError("Implementation lease released")
            current = run(["git", "rev-parse", "HEAD"], capture=True).stdout.strip()
            if current != sha:
                raise ValueError("Wrong parent")
            changed = run(["git", "diff", "--name-only"], capture=True).stdout.splitlines()
            permitted = os.environ["ALLOWED_PATHS"].split(",")
            if not changed or any(path not in permitted for path in changed):
                raise ValueError("Unleased changes")
            if not any(path.startswith("tests/") for path in changed):
                raise ValueError("Missing tests")
            run(["git", "add", "--", *changed])
            run(["git", "-c", "user.name=Tabibi Trusted Parent",
                 "-c", "user.email=tabibi-trusted-parent@users.noreply.github.com",
                 "commit", "-m", f"feat({stream.lower()}): Grok leased bounded edit",
                 "-m", "Material-Author: grok"])
            result = run(["git", "rev-parse", "HEAD"], capture=True).stdout.strip()
            # Auth is initialized only after Vibe exits, in this parent-only step.
            run(["gh", "auth", "setup-git"])
            run(["git", "push", "origin", f"HEAD:refs/heads/{branch}"])
            emit(ready="true", status="PUSHED", result_sha=result)
        except (ValueError, KeyError, OSError, subprocess.SubprocessError):
            fail("PUBLISH_BLOCKED")
        return
    fail("INVALID_MODE")


if __name__ == "__main__":
    main()
