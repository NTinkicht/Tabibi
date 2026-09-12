#!/usr/bin/env python3
"""Read-only Headroom shadow evaluator for Tabibi.

This helper never calls an LLM provider. It only invokes Headroom's local
compression API on an explicitly allowlisted repository file and prints metrics.
Use --emit-compressed only when manually comparing fidelity against the original.
"""

from __future__ import annotations

import argparse
from importlib import metadata
import json
from pathlib import Path
import sys
import time

REPO_ROOT = Path(__file__).resolve().parents[2]
HEADROOM_REPOSITORY = "https://github.com/NTinkicht/headroom"
HEADROOM_REVISION = "97aa9f6d0fc04619e4e821e7d54611eb9d6b9b81"
HEADROOM_INSTALL = (
    "headroom-ai[all] @ git+https://github.com/NTinkicht/headroom.git@"
    + HEADROOM_REVISION
)
ALLOWED_ROOTS = {
    "coordination",
    "tests",
    "src",
    ".github",
    "docs",
    "scripts",
}
BLOCKED_PARTS = {
    ".env",
    ".env.local",
    "secrets",
    "secret",
    "credentials",
    "credential",
    "production-data",
    "patient-data",
    "exports",
}


def resolve_input(raw: str) -> Path:
    """Resolve and validate one repository-local shadow-trial input file."""
    candidate = (REPO_ROOT / raw).resolve()
    try:
        relative = candidate.relative_to(REPO_ROOT)
    except ValueError as exc:
        raise ValueError("input must remain inside the Tabibi repository") from exc

    if not relative.parts or relative.parts[0] not in ALLOWED_ROOTS:
        raise ValueError(
            "input root is not allowlisted for the Headroom shadow trial: "
            f"{relative}"
        )

    lowered_parts = {part.lower() for part in relative.parts}
    if lowered_parts & BLOCKED_PARTS or any(
        part.lower().startswith(".env") for part in relative.parts
    ):
        raise ValueError(f"sensitive-looking path is blocked: {relative}")

    if not candidate.is_file():
        raise ValueError(f"input is not a regular file: {relative}")
    return candidate


def verify_headroom_revision() -> None:
    """Fail closed unless Headroom was installed from the approved fork commit."""
    try:
        distribution = metadata.distribution("headroom-ai")
    except metadata.PackageNotFoundError as exc:
        raise RuntimeError(
            f"Headroom is not installed; install the pinned artifact: {HEADROOM_INSTALL}"
        ) from exc

    provenance_text = distribution.read_text("direct_url.json")
    if not provenance_text:
        raise RuntimeError(
            "Headroom install has no PEP 610 VCS provenance; reinstall the pinned "
            f"artifact: {HEADROOM_INSTALL}"
        )

    try:
        provenance = json.loads(provenance_text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "Headroom install provenance is malformed; reinstall the pinned artifact"
        ) from exc

    vcs_info = provenance.get("vcs_info") or {}
    installed_revision = str(vcs_info.get("commit_id") or "").lower()
    installed_url = str(provenance.get("url") or "").rstrip("/")
    normalized_url = installed_url.removesuffix(".git").lower()

    if (
        str(vcs_info.get("vcs") or "").lower() != "git"
        or installed_revision != HEADROOM_REVISION
        or normalized_url != HEADROOM_REPOSITORY.lower()
    ):
        raise RuntimeError(
            "Headroom revision mismatch: expected "
            f"{HEADROOM_REPOSITORY}@{HEADROOM_REVISION}, found "
            f"{installed_url or 'unknown-source'}@{installed_revision or 'unknown-revision'}"
        )


def main() -> int:
    """Run one local, revision-attested Headroom shadow-compression sample."""
    parser = argparse.ArgumentParser(
        description="Run local Headroom compression in metrics-only shadow mode."
    )
    parser.add_argument("input", help="repository-relative allowlisted text file")
    parser.add_argument(
        "--model",
        default="gpt-4o",
        help="Headroom tokenizer/model profile only; this helper does not call that provider",
    )
    parser.add_argument(
        "--emit-compressed",
        action="store_true",
        help="also print the compressed messages for manual fidelity comparison",
    )
    args = parser.parse_args()

    try:
        source = resolve_input(args.input)
        text = source.read_text(encoding="utf-8")
    except (ValueError, OSError, UnicodeError) as exc:
        print(f"headroom-shadow: {exc}", file=sys.stderr)
        return 2

    try:
        verify_headroom_revision()
        from headroom import compress
    except (ImportError, RuntimeError) as exc:
        print(f"headroom-shadow: {exc}", file=sys.stderr)
        return 3

    started_at = time.perf_counter()
    try:
        result = compress(
            [{"role": "user", "content": text}],
            model=args.model,
            compress_user_messages=True,
            protect_recent=0,
        )
    except Exception as exc:
        print(f"headroom-shadow: compression failed: {exc}", file=sys.stderr)
        return 4
    compression_latency_seconds = time.perf_counter() - started_at

    compressed_messages = getattr(result, "messages", None)
    encoded = (
        json.dumps(compressed_messages, ensure_ascii=False)
        if compressed_messages is not None
        else ""
    )
    metrics = {
        "mode": "shadow_read_only",
        "source": str(source.relative_to(REPO_ROOT)),
        "headroom_repository": HEADROOM_REPOSITORY,
        "headroom_revision": HEADROOM_REVISION,
        "model_profile": args.model,
        "input_chars": len(text),
        "compressed_serialized_chars": len(encoded),
        "tokens_before": getattr(result, "tokens_before", None),
        "tokens_after": getattr(result, "tokens_after", None),
        "tokens_saved": getattr(result, "tokens_saved", None),
        "compression_ratio": getattr(result, "compression_ratio", None),
        "compression_latency_seconds": compression_latency_seconds,
        "authoritative_source_retained": True,
        "provider_call_performed_by_helper": False,
    }
    print(json.dumps(metrics, ensure_ascii=False, indent=2))

    if args.emit_compressed:
        print("\n--- COMPRESSED SHADOW OUTPUT ---")
        print(json.dumps(compressed_messages, ensure_ascii=False, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
