#!/usr/bin/env python3
"""Verify Grok Build reviews signed by the pinned, private owner Codespace worker.

A PR comment or GitHub login is NOT proof. The trusted worker signs the exact
published comment body after a real completed Grok CLI JSON result. The private
Ed25519 key remains in the owner Codespace; only its public key is reviewed on
main. This proves trusted-worker provenance, not an xAI-issued signature.
"""
import base64
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

REGISTRY = Path("coordination/trust/grok-review-public-keys.json")
SHA = re.compile(r"[a-f0-9]{40}\Z")
REQUEST = re.compile(r"[A-Za-z0-9-]{8,128}\Z")
MARKER = re.compile(
    r"(?s)(?P<visible>.+)\n\n<!-- tabibi-grok-attestation-v1:"
    r"(?P<payload>[A-Za-z0-9_-]{100,4096}):(?P<signature>[A-Za-z0-9_-]{80,100}) -->\Z"
)
VERDICT = re.compile(
    r"(?m)^VERDICT:[ \t]*(PASS|PASS_WITH_MINOR_FINDINGS|CHANGES_REQUIRED)[ \t]*$"
)
FIELDS = {
    "version", "actor", "runtime", "key_id", "pr", "exact_sha",
    "lease_comment_id", "material_authors", "verdict",
    "provider_request_id", "provider_session_id", "stop_reason",
    "review_body_sha256", "issued_at",
}


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate proof or registry key")
        result[key] = value
    return result


def strict_json(raw):
    return json.loads(raw, object_pairs_hook=unique_pairs)


def b64url(text):
    if not text.isascii():
        raise ValueError("Non-ASCII receipt")
    data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if base64.urlsafe_b64encode(data).decode().rstrip("=") != text:
        raise ValueError("Noncanonical base64url receipt")
    return data


def timestamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("Invalid signing time")
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Naive signing time")
    return result


def valid_lease(dispatch, number, sha, authors):
    body = dispatch.get("body") or ""
    fields = {}
    lines = body.strip().splitlines()
    if not lines or lines.pop(0) != "ROLE_LEASE_ASSIGNED":
        return False
    for line in lines:
        match = re.fullmatch(r"([a-z_]+):[ \t]*(\S(?:.*\S)?)", line)
        if not match or match[1] in fields:
            return False
        fields[match[1]] = match[2]
    material = fields.get("material_authors", "")
    declared = [a.strip().lower() for a in material.split(",")]
    return (
        dispatch.get("user", {}).get("login") == "NTinkicht"
        and dispatch.get("updated_at", dispatch.get("created_at"))
        == dispatch.get("created_at")
        and set(fields) == {"actor", "capability", "pr", "exact_sha", "material_authors"}
        and fields["actor"] == "grok"
        and fields["capability"] == "review"
        and fields["pr"] == f"#{number}"
        and fields["exact_sha"] == sha
        and bool(declared)
        and len(declared) == len(set(declared))
        and set(declared) == authors
        and "grok" not in authors
    )


def verify_signature(payload_bytes, signature, key_pem):
    with tempfile.TemporaryDirectory(prefix="tabibi-grok-proof-") as work:
        root = Path(work)
        (root / "key.pem").write_text(key_pem)
        (root / "payload").write_bytes(payload_bytes)
        (root / "signature").write_bytes(signature)
        run = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-rawin", "-pubin",
             "-inkey", str(root / "key.pem"),
             "-in", str(root / "payload"),
             "-sigfile", str(root / "signature")],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
        return run.returncode == 0


def verified_review(comment, number, sha, authors, dispatches, registry=None):
    """Return clean/adverse verdict, or None for ANY unverifiable receipt."""
    try:
        body = comment.get("body") or ""
        match = MARKER.fullmatch(body)
        if (
            comment.get("user", {}).get("login") != "NTinkicht"
            or comment.get("updated_at", comment.get("created_at"))
            != comment.get("created_at")
            or not match or not SHA.fullmatch(sha) or "grok" in authors
        ):
            return None
        visible = match["visible"]
        payload_bytes = b64url(match["payload"])
        signature = b64url(match["signature"])
        proof = strict_json(payload_bytes)
        if (
            not isinstance(proof, dict) or set(proof) != FIELDS
            or proof["version"] != 1
            or proof["actor"] != "grok"
            or proof["runtime"] != "owner-codespace-grok-build"
            or proof["stop_reason"] != "end_turn"
            or type(proof["pr"]) is not int or proof["pr"] != number
            or proof["exact_sha"] != sha
            or type(proof["lease_comment_id"]) is not int
            or proof["lease_comment_id"] < 1
            or not isinstance(proof["material_authors"], list)
            or proof["material_authors"] != sorted(authors)
            or proof["verdict"] not in {"PASS", "PASS_WITH_MINOR_FINDINGS", "CHANGES_REQUIRED"}
            or not isinstance(proof["key_id"], str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,63}", proof["key_id"])
            or not isinstance(proof["provider_request_id"], str)
            or not REQUEST.fullmatch(proof["provider_request_id"])
            or not isinstance(proof["provider_session_id"], str)
            or not REQUEST.fullmatch(proof["provider_session_id"])
            or not isinstance(proof["review_body_sha256"], str)
            or proof["review_body_sha256"] != hashlib.sha256(
                visible.encode("utf-8")
            ).hexdigest()
            or f"exact_sha: {sha}" not in visible
            or f"source_lease_comment: {proof['lease_comment_id']}" not in visible
            or "**Automatic Grok Build review**" not in visible
            or not re.search(r"(?m)^actor: grok$", visible)
            or not re.search(r"(?m)^capability: review$", visible)
            or len(VERDICT.findall(visible)) != 1
            or VERDICT.findall(visible)[0] != proof["verdict"]
        ):
            return None
        dispatch = dispatches.get(proof["lease_comment_id"])
        if not dispatch or not valid_lease(dispatch, number, sha, authors):
            return None
        issued = timestamp(proof["issued_at"])
        posted = timestamp(comment["created_at"])
        assigned = timestamp(dispatch["created_at"])
        if not (
            assigned - dt.timedelta(minutes=5) <= issued
            <= posted + dt.timedelta(minutes=5)
            and posted >= assigned
            and issued <= dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)
        ):
            return None
        trusted = registry if registry is not None else strict_json(REGISTRY.read_text())
        if (
            not isinstance(trusted, dict)
            or trusted.get("version") != 1
            or not isinstance(trusted.get("keys"), list)
            or len(trusted["keys"]) > 8
        ):
            return None
        matches = [
            row for row in trusted["keys"]
            if isinstance(row, dict) and row.get("id") == proof["key_id"]
        ]
        if (
            len(matches) != 1
            or not isinstance(matches[0].get("public_key_pem"), str)
            or len(matches[0]["public_key_pem"]) > 2048
            or len(signature) != 64
            or not verify_signature(payload_bytes, signature, matches[0]["public_key_pem"])
        ):
            return None
        return proof["verdict"]
    except (
        ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError,
        UnicodeError, OverflowError,
    ):
        return None


def selftest():
    sha = "a" * 40
    with tempfile.TemporaryDirectory(prefix="tabibi-grok-test-") as work:
        private = Path(work) / "private.pem"
        public = Path(work) / "public.pem"
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(private)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            ["openssl", "pkey", "-in", str(private), "-pubout", "-out", str(public)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        registry = {"version": 1, "keys": [{
            "id": "owner-codespace-v1", "public_key_pem": public.read_text(),
        }]}
        assigned = {
            "id": 41, "user": {"login": "NTinkicht"},
            "created_at": "2026-09-25T12:00:00Z",
            "updated_at": "2026-09-25T12:00:00Z",
            "body": (
                "ROLE_LEASE_ASSIGNED\nactor: grok\ncapability: review\npr: #496\n"
                f"exact_sha: {sha}\nmaterial_authors: chatgpt"
            ),
        }
        visible = (
            f"<!-- tabibi-grok-dispatch:dummy -->\n**Automatic Grok Build review**\n\n"
            f"actor: grok\ncapability: review\nexact_sha: {sha}\n"
            "source_lease_comment: 41\n\n"
            f"SHA {sha}\nVERDICT: PASS"
        )
        proof = {
            "version": 1, "actor": "grok",
            "runtime": "owner-codespace-grok-build",
            "key_id": "owner-codespace-v1", "pr": 496,
            "exact_sha": sha, "lease_comment_id": 41,
            "material_authors": ["chatgpt"], "verdict": "PASS",
            "provider_request_id": "provider-request-123",
            "provider_session_id": "provider-session-456",
            "stop_reason": "end_turn",
            "review_body_sha256": hashlib.sha256(visible.encode()).hexdigest(),
            "issued_at": "2026-09-25T12:02:00.000Z",
        }
        payload = json.dumps(proof, separators=(",", ":"), ensure_ascii=False).encode()
        payload_path = Path(work) / "payload"
        signature_path = Path(work) / "sig"
        payload_path.write_bytes(payload)
        subprocess.run(
            ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private),
             "-in", str(payload_path), "-out", str(signature_path)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        encoded = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip("=")
        body = (
            visible + "\n\n<!-- tabibi-grok-attestation-v1:" +
            encoded(payload) + ":" + encoded(signature_path.read_bytes()) + " -->"
        )
        comment = {
            "id": 99, "user": {"login": "NTinkicht"},
            "created_at": "2026-09-25T12:03:00Z",
            "updated_at": "2026-09-25T12:03:00Z", "body": body,
        }
        check = lambda c, a={"chatgpt"}, d={41: assigned}, r=registry: (
            verified_review(c, 496, sha, a, d, r)
        )
        assert check(comment) == "PASS"
        assert check({**comment, "body": body.replace("VERDICT: PASS", "VERDICT: CHANGES_REQUIRED")}) is None
        assert check({**comment, "user": {"login": "stranger"}}) is None
        assert check({**comment, "updated_at": "2026-09-25T12:05:00Z"}) is None
        assert check(comment, {"grok"}) is None
        assert check(comment, {"chatgpt"}, {}) is None
        assert check(comment, {"chatgpt"}, {41: {**assigned, "body": assigned["body"].replace(sha, "b" * 40)}}) is None
        assert check(comment, {"chatgpt"}, {41: {**assigned, "updated_at": "2026-09-25T12:09:00Z"}}) is None
        assert check(comment, {"chatgpt"}, {41: assigned}, {"version": 1, "keys": []}) is None
        assert verified_review(comment, 496, "b" * 40, {"chatgpt"}, {41: assigned}, registry) is None
        assert check({**comment, "created_at": "2026-09-25T11:00:00Z"}) is None
        bad = body[:-4] + "A -->"
        assert check({**comment, "body": bad}) is None
        print("Grok signed-review verifier selftest passed")


if __name__ == "__main__":
    selftest()
