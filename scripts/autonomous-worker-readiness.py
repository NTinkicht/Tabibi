#!/usr/bin/env python3
"""Offline structural + negative-path selftest for Tabibi's cloud code adapters.

No provider login, model inference, network calls, GitHub write or credentials.
A PASS is NOT proof of cloud entitlement, autonomous triggering, or merge safety.
"""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ADAPTERS = (
    {
        "name": "mistral",
        "workflow": ".github/workflows/mistral-scoped-code-adapter.yml",
        "script": "scripts/mistral-code-adapter.py",
        "markers": (
            "MISTRAL_LEASED_CODE_V1",
            "TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED",
            "mistral-vibe==",
            "timeout --signal=TERM",
            "permissions:",
            "contents: read",
            "contents: write",
            "persist-credentials: false",
            "mistral-validated-patch",
        ),
    },
    {
        "name": "grok",
        "workflow": ".github/workflows/grok-cloud-code-proposal.yml",
        "script": "scripts/grok-cloud-code-adapter.py",
        "markers": (
            "GROK_CLOUD_CODE_PROPOSAL_V1",
            "source_lease_id",
            "github.actor == 'NTinkicht'",
            "permissions:",
            "contents: read",
            "contents: write",
            "persist-credentials: false",
            "grok-validated-patch",
        ),
    },
)


def structural_errors(name, text, markers):
    errors = [f"{name}: missing {marker}" for marker in markers if marker not in text]
    if name == "grok" and ("secrets.XAI_API_KEY" in text or "secrets.GROK_API_KEY" in text):
        errors.append("grok: paid-provider key unexpectedly bound in workflow")
    if "pull_request_target:" in text:
        errors.append(f"{name}: untrusted pull_request_target trigger")
    return errors


def main():
    errors = []
    for entry in ADAPTERS:
        workflow = ROOT / entry["workflow"]
        adapter = ROOT / entry["script"]
        if not workflow.is_file() or not adapter.is_file():
            errors.append(f'{entry["name"]}: required workflow or adapter absent')
            continue
        text = workflow.read_text(encoding="utf-8")
        errors.extend(structural_errors(entry["name"], text, entry["markers"]))
        try:
            result = subprocess.run(
                [sys.executable, str(adapter), "selftest"],
                cwd=ROOT,
                timeout=20,
                capture_output=True,
                text=True,
                check=False,
                env={"PATH": __import__("os").environ.get("PATH", "")},
            )
        except (OSError, subprocess.TimeoutExpired):
            errors.append(f'{entry["name"]}: offline adapter selftest did not complete')
            continue
        if result.returncode:
            errors.append(f'{entry["name"]}: offline adapter selftest failed')
        else:
            print(f'{entry["name"]}: structural markers and parser/patch selftest passed')
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print("STATIC READINESS ONLY: subscription entitlement and Codespace-off model execution NOT verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
