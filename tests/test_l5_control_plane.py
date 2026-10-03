#!/usr/bin/env python3
"""Hermetic tests for the L5 local control-plane execution-mode boundary."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import l5_control_plane as cp  # noqa: E402


class ControlPlaneTests(unittest.TestCase):
    """Prove SHADOW, LIVE_SAFE, and ACTIVE mutation boundaries."""

    def manifest(self, **overrides):
        value = {
            "schema_version": "1.0",
            "control_repository": "NTinkicht/OneCompany",
            "control_ref": "a" * 40,
            "execution_mode": "LIVE_SAFE",
            "platform_enforcement": "DEFERRED_FOR_VALIDATION",
            "mutation_allowed": True,
            "activation_requirements": sorted(cp.REQUIRED_ACTIVATION),
        }
        value.update(overrides)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "control-plane.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_live_safe_allows_reversible_operations(self):
        path = self.manifest()
        for operation in (
            "retry_ci",
            "dispatch_review",
            "remediate_review",
            "update_branch",
            "reserve_next_wu",
        ):
            self.assertEqual(cp.mutation_policy(operation, path), (True, "CONTROL_PLANE_LIVE_SAFE"))

    def test_live_safe_blocks_main_changing_operations(self):
        path = self.manifest()
        for operation in ("merge_expected_head", "revert"):
            self.assertEqual(
                cp.mutation_policy(operation, path),
                (False, "CONTROL_PLANE_LIVE_SAFE_MAIN_CHANGE_BLOCKED"),
            )

    def test_shadow_blocks_every_operation(self):
        path = self.manifest(execution_mode="SHADOW", mutation_allowed=False)
        self.assertEqual(cp.mutation_policy("retry_ci", path), (False, "CONTROL_PLANE_SHADOW"))
        self.assertEqual(cp.mutation_policy("merge_expected_head", path), (False, "CONTROL_PLANE_SHADOW"))

    def test_live_safe_manifest_must_be_explicit(self):
        disabled = self.manifest(mutation_allowed=False)
        self.assertEqual(cp.mutation_policy("retry_ci", disabled)[1], "CONTROL_PLANE_MUTATIONS_DISABLED")
        wrong_platform = self.manifest(platform_enforcement="VERIFIED")
        self.assertEqual(cp.mutation_policy("retry_ci", wrong_platform)[1], "CONTROL_PLANE_LIVE_SAFE_INVALID")

    def test_active_requires_pinned_ref_and_complete_evidence(self):
        base = {
            "execution_mode": "ACTIVE",
            "platform_enforcement": "VERIFIED",
            "mutation_allowed": True,
        }
        missing = self.manifest(**base)
        self.assertEqual(cp.mutation_policy("merge_expected_head", missing)[1], "ACTIVATION_EVIDENCE_MISSING")

        incomplete = self.manifest(
            **base,
            activation_evidence={name: name != "platform_enforcement_verified" for name in cp.REQUIRED_ACTIVATION},
        )
        self.assertEqual(cp.mutation_policy("merge_expected_head", incomplete)[1], "ACTIVATION_EVIDENCE_INCOMPLETE")

        unpinned = self.manifest(
            **base,
            control_ref="main",
            activation_evidence={name: True for name in cp.REQUIRED_ACTIVATION},
        )
        self.assertEqual(cp.mutation_policy("merge_expected_head", unpinned)[1], "CONTROL_PLANE_REF_NOT_PINNED")

        active = self.manifest(
            **base,
            activation_evidence={name: True for name in cp.REQUIRED_ACTIVATION},
        )
        self.assertEqual(cp.mutation_policy("merge_expected_head", active), (True, "CONTROL_PLANE_ACTIVE"))

    def test_missing_or_malformed_manifest_fails_closed(self):
        missing = Path(tempfile.gettempdir()) / "definitely-missing-l5-control-plane.json"
        missing.unlink(missing_ok=True)
        self.assertEqual(cp.mutation_policy("retry_ci", missing)[1], "CONTROL_PLANE_UNAVAILABLE")

        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        malformed = Path(directory.name) / "bad.json"
        malformed.write_text("{not-json", encoding="utf-8")
        self.assertEqual(cp.mutation_policy("retry_ci", malformed)[1], "CONTROL_PLANE_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
