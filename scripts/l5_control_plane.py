#!/usr/bin/env python3
"""Fail-closed local control-plane switch for every L5 mutation."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / ".l5" / "control-plane.json"
SHA40 = re.compile(r"^[0-9a-f]{40}$")
REQUIRED_ACTIVATION = frozenset({
    "control_plane_reviewed_and_green",
    "api_hostile_simulation_green",
    "shadow_liveness_validated",
    "platform_enforcement_verified",
    "governance_drift_human_cleared",
})


def load_manifest(path: Path = MANIFEST) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("CONTROL_PLANE_UNAVAILABLE") from exc
    if not isinstance(value, Mapping) or value.get("schema_version") != "1.0":
        raise ValueError("CONTROL_PLANE_INVALID")
    if value.get("control_repository") != "NTinkicht/OneCompany":
        raise ValueError("CONTROL_PLANE_REPOSITORY_INVALID")
    requirements = value.get("activation_requirements")
    if not isinstance(requirements, list) or set(requirements) != REQUIRED_ACTIVATION:
        raise ValueError("CONTROL_PLANE_REQUIREMENTS_INVALID")
    return value


def mutation_policy(path: Path = MANIFEST) -> tuple[bool, str]:
    """Return permission only after an immutable reviewed control plane is ACTIVE."""
    try:
        value = load_manifest(path)
    except ValueError as exc:
        return False, str(exc)
    if value.get("execution_mode") != "ACTIVE":
        return False, "CONTROL_PLANE_SHADOW"
    if value.get("mutation_allowed") is not True:
        return False, "CONTROL_PLANE_MUTATIONS_DISABLED"
    if value.get("platform_enforcement") != "VERIFIED":
        return False, "PLATFORM_ENFORCEMENT_NOT_VERIFIED"
    control_ref = value.get("control_ref")
    if not isinstance(control_ref, str) or not SHA40.fullmatch(control_ref):
        return False, "CONTROL_PLANE_REF_NOT_PINNED"
    evidence = value.get("activation_evidence")
    if not isinstance(evidence, Mapping):
        return False, "ACTIVATION_EVIDENCE_MISSING"
    if any(evidence.get(name) is not True for name in REQUIRED_ACTIVATION):
        return False, "ACTIVATION_EVIDENCE_INCOMPLETE"
    return True, "CONTROL_PLANE_ACTIVE"


if __name__ == "__main__":
    allowed, reason = mutation_policy()
    print(json.dumps({"mutation_allowed": allowed, "reason": reason}, sort_keys=True))
