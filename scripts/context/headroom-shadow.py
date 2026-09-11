#!/usr/bin/env python3
"""Read-only Headroom shadow evaluator for Tabibi.

This helper never calls an LLM provider. It only invokes Headroom's local
compression API on an explicitly allowlisted repository file and prints metrics.
Use --emit-compressed only when manually comparing fidelity against the original.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

REPO_ROOT = Path(__file__).resolve().parents[2]
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


def main() -> int:
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
        from headroom import compress
    except ImportError:
        print(
            'headroom-shadow: Headroom is not installed. Install an isolated local copy of '
            '"headroom-ai[all]" and run `headroom doctor` first.',
            file=sys.stderr,
        )
        return 3

    result = compress([{"role": "user", "content": text}], model=args.model)

    compressed_messages = getattr(result, "messages", None)
    encoded = json.dumps(compressed_messages, ensure_ascii=False) if compressed_messages is not None else ""
    metrics = {
        "mode": "shadow_read_only",
        "source": str(source.relative_to(REPO_ROOT)),
        "model_profile": args.model,
        "input_chars": len(text),
        "compressed_serialized_chars": len(encoded),
        "tokens_saved": getattr(result, "tokens_saved", None),
        "compression_ratio": getattr(result, "compression_ratio", None),
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
