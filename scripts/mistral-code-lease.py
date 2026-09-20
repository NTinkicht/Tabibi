#!/usr/bin/env python3
"""Trusted parent controls for Mistral Vibe's default-off coding adapter."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SHA = re.compile(r"[0-9a-f]{40}\Z")
BRANCH = re.compile(r"[A-Za-z0-9._/-]{1,120}\Z")
PATH = re.compile(r"(?:src|tests)/[A-Za-z0-9._/@\[\]-]+(?:/[A-Za-z0-9._/@\[\]-]+)*\Z")
MARKER = re.compile(r"(?m)^MISTRAL_CODE_LEASE_V1\s*$")
MAX_PATHS = 6
MAX_PATCH_BYTES = 80_000
TEST_PROFILES = {
    "unit": ["npm", "run", "test:unit"],
    "api": ["npm", "run", "test:api"],
    "public-e2e": ["npx", "playwright", "test", "tests/e2e/public-discovery-landing.spec.ts"],
}

def output(**items):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
        for key, value in items.items():
            stream.write(f"{key}={value}\n")

def api(route):
    raw = subprocess.check_output(["gh", "api", route], stderr=subprocess.DEVNULL, timeout=25)
    return json.loads(raw)

def one(body, key):
    values = re.findall(rf"(?m)^{re.escape(key)}:\s*(.*?)\s*$", body)
    if len(values) != 1 or not values[0]:
        raise ValueError(f"missing/duplicate {key}")
    return values[0].strip()

def parse(body):
    if len(MARKER.findall(body)) != 1:
        raise ValueError("missing/duplicate coding marker")
    pr = one(body, "pr")
    issue = one(body, "issue")
    branch = one(body, "branch")
    base_sha = one(body, "base_sha")
    paths = [x.strip() for x in one(body, "allowed_paths").split(",") if x.strip()]
    profile = one(body, "test_profile")
    if not pr.isdigit() or int(pr) < 1 or not issue.isdigit() or int(issue) < 1:
        raise ValueError("invalid issue/pr")
    if not SHA.fullmatch(base_sha) or not BRANCH.fullmatch(branch) or ".." in branch:
        raise ValueError("invalid branch/base")
    if not (1 <= len(paths) <= MAX_PATHS) or len(set(paths)) != len(paths):
        raise ValueError("invalid path allowlist")
    if any(not PATH.fullmatch(p) or ".." in p for p in paths):
        raise ValueError("unsafe path")
    if profile not in TEST_PROFILES:
        raise ValueError("unsupported test profile")
    return int(pr), int(issue), branch, base_sha, paths, profile

def validate_target(repo, pr_number, branch, base_sha):
    pr = api(f"repos/{repo}/pulls/{pr_number}")
    if (
        pr.get("state") != "open"
        or pr.get("base", {}).get("ref") != "main"
        or pr.get("head", {}).get("repo", {}).get("full_name") != repo
        or pr.get("head", {}).get("ref") != branch
        or pr.get("head", {}).get("sha") != base_sha
    ):
        raise ValueError("stale/noncanonical PR target")
    return pr

def safe_path(path):
    candidate = Path(path)
    if candidate.is_symlink():
        raise ValueError(f"symlink path rejected: {path}")
    resolved = candidate.resolve(strict=False)
    root = Path.cwd().resolve()
    if root not in resolved.parents and resolved != root:
        raise ValueError(f"path escapes workspace: {path}")

def changed_paths():
    data = subprocess.check_output(["git", "diff", "--name-only", "HEAD"], text=True)
    return [line.strip() for line in data.splitlines() if line.strip()]

def validate_patch_file(patch_path, allowlist):
    patch = Path(patch_path)
    if patch.is_symlink() or not patch.is_file():
        raise ValueError("patch artifact missing/unsafe")
    payload = patch.read_bytes()
    if not payload or len(payload) > MAX_PATCH_BYTES:
        raise ValueError("patch size outside bounds")
    text = payload.decode("utf-8")
    forbidden = [
        "MISTRAL_API_KEY", "GITHUB_TOKEN", "BEGIN PRIVATE KEY",
        "authorization: bearer", "xai_api_key", "sk-",
    ]
    low = text.lower()
    for marker in forbidden:
        if marker.lower() in low:
            raise ValueError("secret-like material in proposed patch")
    for path in allowlist:
        safe_path(path)
    subprocess.check_call(["git", "apply", "--check", "--whitespace=error-all", patch_path])
    subprocess.check_call(["git", "apply", "--whitespace=error-all", patch_path])
    changed = changed_paths()
    if not changed or not set(changed).issubset(set(allowlist)):
        raise ValueError(f"changed paths outside allowlist: {changed}")
    if not any(path.startswith("src/") for path in changed):
        raise ValueError("coding proof must change production src/")
    if not any(path.startswith("tests/") for path in changed):
        raise ValueError("coding proof must add/change deterministic tests")
    for path in changed:
        safe_path(path)
    return changed

def extract_patch(output_path, patch_path):
    text = Path(output_path).read_text(encoding="utf-8", errors="replace")
    starts = [m.start() for m in re.finditer(r"(?m)^---BEGIN_TABIBI_PATCH---\s*$", text)]
    ends = [m.start() for m in re.finditer(r"(?m)^---END_TABIBI_PATCH---\s*$", text)]
    if len(starts) != 1 or len(ends) != 1 or ends[0] <= starts[0]:
        raise ValueError("exactly one patch envelope required")
    body = text[starts[0]:ends[0]].splitlines()[1:]
    patch_text = "\n".join(body).strip() + "\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(patch_path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(patch_text)

def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "selftest":
        body = (
            "MISTRAL_CODE_LEASE_V1\npr: 10\nissue: 20\nbranch: mistral/wu-x\n"
            + "base_sha: " + "a"*40 + "\nallowed_paths: src/a.ts,tests/a.test.ts\n"
            + "test_profile: unit\n"
        )
        assert parse(body) == (10, 20, "mistral/wu-x", "a"*40, ["src/a.ts","tests/a.test.ts"], "unit")
        for bad in (
            body.replace("src/a.ts", "../a.ts"),
            body.replace("test_profile: unit", "test_profile: shell"),
            body.replace("base_sha: " + "a"*40, "base_sha: bad"),
        ):
            try:
                parse(bad)
            except ValueError:
                pass
            else:
                raise AssertionError("unsafe coding lease accepted")
        print("mistral code lease selftest passed")
        return

    repo = os.environ["GITHUB_REPOSITORY"]
    if command == "prepare":
        if os.environ.get("MISTRAL_CODE_ADAPTER_ENABLED") != "true":
            output(ready="false", status="CONFIG_BLOCKED")
            return
        try:
            pr, issue, branch, base_sha, paths, profile = parse(os.environ.get("DISPATCH_BODY", ""))
            validate_target(repo, pr, branch, base_sha)
            issue_data = api(f"repos/{repo}/issues/{issue}")
            if issue_data.get("state") != "open":
                raise ValueError("work issue is not open")
            output(
                ready="true", status="OK", pr=pr, issue=issue, branch=branch,
                base_sha=base_sha, allowed_paths=",".join(paths), test_profile=profile
            )
        except (ValueError, subprocess.SubprocessError, json.JSONDecodeError):
            output(ready="false", status="LEASE_BLOCKED")
        return

    if command == "apply":
        allowlist = [p for p in os.environ["ALLOWED_PATHS"].split(",") if p]
        extract_patch("/tmp/tabibi-mistral-code-output.txt", "/tmp/tabibi-mistral.patch")
        changed = validate_patch_file("/tmp/tabibi-mistral.patch", allowlist)
        output(ready="true", changed_paths=" ".join(changed))
        return

    if command == "recheck":
        pr = int(os.environ["TARGET_PR"])
        branch = os.environ["TARGET_BRANCH"]
        base_sha = os.environ["BASE_SHA"]
        try:
            validate_target(repo, pr, branch, base_sha)
        except (ValueError, subprocess.SubprocessError, json.JSONDecodeError):
            output(ready="false", status="STALE_SHA")
            return
        output(ready="true", status="OK")
        return

    raise SystemExit("unknown command")

if __name__ == "__main__":
    main()
