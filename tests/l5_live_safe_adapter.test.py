import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("l5_write_adapter_live_safe", ROOT / "scripts" / "l5_write_adapter.py")
wa = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(wa)
import l5_recovery as rec  # noqa: E402

H, B = "a" * 40, "b" * 40
LIVE_SAFE_CONTROL_PLANE = ROOT / ".l5" / "control-plane.json"


def merge_snapshot():
    return {
        "repository": "NTinkicht/Tabibi",
        "issue": 559,
        "canonical_pr": 562,
        "active_prs": [562],
        "head_sha": H,
        "base_sha": B,
        "head_current": True,
        "base_current": True,
        "implementation_complete": True,
        "emergency_stop": False,
        "human_only": False,
        "blocked": False,
        "release_go_no_go": False,
        "destructive_production": False,
        "spend_required": False,
        "secret_scope_change": False,
        "security_control_weakening": False,
        "merged": False,
        "verified": False,
        "verified_head_sha": None,
        "verified_base_sha": None,
        "ci": "SUCCESS",
        "ci_head_sha": H,
        "ci_base_sha": B,
        "review": "PASS",
        "review_head_sha": H,
        "review_base_sha": B,
        "reviewer_actor": "mistral-vibe",
        "material_authors": ["chatgpt"],
        "material_authors_head_sha": H,
        "review_eligible": True,
        "unresolved_threads": False,
        "mergeable": True,
        "retry_count": 0,
        "retry_action": None,
        "event_id": "live-safe-boundary",
        "ready_candidates": [],
        "prior_event_keys": [],
        "prior_mutation_tokens": [],
    }


class NoWriteClient:
    def __init__(self):
        self.calls = 0

    def perform_cas(self, _mutation, _params):
        self.calls += 1
        raise AssertionError("LIVE_SAFE main-changing mutation reached perform_cas")


class LiveSafeAdapterBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.previous = os.environ.get("L5_CONTROL_PLANE_MANIFEST")
        os.environ["L5_CONTROL_PLANE_MANIFEST"] = str(LIVE_SAFE_CONTROL_PLANE)

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("L5_CONTROL_PLANE_MANIFEST", None)
        else:
            os.environ["L5_CONTROL_PLANE_MANIFEST"] = self.previous

    def test_merge_expected_head_is_blocked_before_remote_cas(self):
        snap = merge_snapshot()
        auth = rec.authorize_mutation(snap)
        self.assertEqual(auth["mutation"], "merge_expected_head")
        client = NoWriteClient()
        out = wa.execute_mutation(auth, snap, client, wa.MemoryStore())
        self.assertEqual((out["status"], out["reason"]), ("BLOCKED", "CONTROL_PLANE_LIVE_SAFE_MAIN_CHANGE_BLOCKED"))
        self.assertEqual(client.calls, 0)

    def test_revert_is_blocked_at_adapter_boundary_without_remote_cas(self):
        snap = merge_snapshot()
        auth = rec.authorize_mutation(snap)
        auth = {**auth, "mutation": "revert"}
        client = NoWriteClient()
        out = wa.execute_mutation(auth, snap, client, wa.MemoryStore())
        self.assertEqual(out["status"], "BLOCKED")
        self.assertIn(out["reason"], {"MUTATION_NOT_WHITELISTED", "CONTROL_PLANE_LIVE_SAFE_MAIN_CHANGE_BLOCKED"})
        self.assertEqual(client.calls, 0)

    def test_live_safe_policy_blocks_revert_even_if_future_authorization_whitelists_it(self):
        snap = merge_snapshot()
        auth = {**rec.authorize_mutation(snap), "mutation": "revert"}
        client = NoWriteClient()
        with mock.patch.object(wa, "_validate_authorization", return_value=None):
            out = wa.execute_mutation(auth, snap, client, wa.MemoryStore())
        self.assertEqual((out["status"], out["reason"]), ("BLOCKED", "CONTROL_PLANE_LIVE_SAFE_MAIN_CHANGE_BLOCKED"))
        self.assertEqual(client.calls, 0)


if __name__ == "__main__":
    unittest.main()
