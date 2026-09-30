import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "scripts" / "l5_activation.py"
SPEC = importlib.util.spec_from_file_location("l5_activation", MODULE)
l5 = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(l5)


class L5ActivationTest(unittest.TestCase):
    def base(self):
        head, base = "a" * 40, "b" * 40
        return {
            "repository": "NTinkicht/Tabibi",
            "issue": 565,
            "canonical_pr": 999,
            "active_prs": [999],
            "head_sha": head,
            "base_sha": base,
            "head_current": True,
            "base_current": True,
            "implementation_complete": True,
            "emergency_stop": False,
            "human_only": False,
            "blocked": False,
            "merged": False,
            "verified": False,
            "verified_head_sha": None,
            "verified_base_sha": None,
            "ci": "SUCCESS",
            "ci_head_sha": head,
            "ci_base_sha": base,
            "review": "PASS",
            "review_head_sha": head,
            "review_base_sha": base,
            "reviewer_actor": "claude",
            "material_authors": ["chatgpt"],
            "material_authors_head_sha": head,
            "review_eligible": True,
            "unresolved_threads": False,
            "mergeable": True,
            "retry_count": 0,
            "retry_action": None,
            "event_id": "activation-test",
            "ready_candidates": [],
            "prior_event_keys": [],
        }

    def test_exact_head_merge_is_authorized(self):
        result = l5.authorize_mutation(self.base())
        self.assertTrue(result["authorized"])
        self.assertEqual(result["mutation"], "merge_expected_head")
        self.assertEqual(result["expected_head_sha"], "a" * 40)

    def test_replay_is_noop(self):
        first = l5.authorize_mutation(self.base())
        replay = l5.authorize_mutation(self.base(), prior_mutation_tokens={first["mutation_token"]})
        self.assertFalse(replay["mutation_allowed"])
        self.assertEqual(replay["reason"], "REPLAY_NOOP")

    def test_hard_boundaries_never_authorize(self):
        for field in (
            "emergency_stop",
            "human_only",
            "blocked",
            "release_go_no_go",
            "destructive_production",
            "spend_required",
            "secret_scope_change",
            "security_control_weakening",
        ):
            sample = self.base()
            sample[field] = True
            result = l5.authorize_mutation(sample)
            self.assertFalse(result["mutation_allowed"], field)

    def test_stale_refs_never_authorize(self):
        for field in ("head_current", "base_current"):
            sample = self.base()
            sample[field] = False
            result = l5.authorize_mutation(sample)
            self.assertFalse(result["mutation_allowed"])

    def test_ci_remediation_is_same_stream_whitelisted(self):
        sample = self.base()
        sample.update(ci="FAILURE", review="UNKNOWN", event_id="activation-ci")
        result = l5.authorize_mutation(sample)
        self.assertTrue(result["authorized"])
        self.assertEqual(result["mutation"], "retry_ci")
        self.assertEqual(result["canonical_pr"], 999)

    def test_review_failover_is_whitelisted(self):
        sample = self.base()
        sample.update(review="OUTAGE", event_id="activation-review")
        result = l5.authorize_mutation(sample)
        self.assertTrue(result["authorized"])
        self.assertEqual(result["mutation"], "dispatch_review")

    def test_unresolved_threads_block_merge(self):
        sample = self.base()
        sample["unresolved_threads"] = True
        result = l5.authorize_mutation(sample)
        self.assertFalse(result["mutation_allowed"])

    def test_replenishment_selects_only_recovery_verified_candidate(self):
        sample = self.base()
        sample.update(
            active_prs=[],
            merged=True,
            verified=True,
            verified_head_sha="a" * 40,
            verified_base_sha="b" * 40,
            event_id="activation-replenish",
            ready_candidates=[
                {"issue": 700, "ready": True, "blocked": False, "human_only": False, "conflict_safe": False},
                {"issue": 701, "ready": True, "blocked": False, "human_only": False, "conflict_safe": True},
            ],
        )
        result = l5.authorize_mutation(sample)
        self.assertTrue(result["authorized"])
        self.assertEqual(result["mutation"], "reserve_next_wu")
        self.assertEqual(result["selected_issue"], 701)


if __name__ == "__main__":
    unittest.main()
