import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "scripts" / "l5_state_machine.py"
SPEC = importlib.util.spec_from_file_location("l5_state_machine", MODULE)
l5 = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(l5)


class L5StateMachineTest(unittest.TestCase):
    def base(self):
        head, base = "a" * 40, "b" * 40
        return {
            "repository": "NTinkicht/Tabibi",
            "issue": 558,
            "canonical_pr": 561,
            "active_prs": [561],
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
            "ci": "SUCCESS",
            "ci_head_sha": head,
            "ci_base_sha": base,
            "review": "PASS",
            "review_head_sha": head,
            "review_base_sha": base,
            "reviewer_actor": "mistral-vibe",
            "material_authors": ["chatgpt"],
            "review_eligible": True,
            "unresolved_threads": False,
            "mergeable": True,
        }

    def test_ready(self):
        result = l5.reduce_evidence(self.base())
        self.assertEqual(result["state"], "MERGE_READY")
        self.assertFalse(result["mutation_allowed"])

    def test_unknown_safety_fails_closed(self):
        for field in ("emergency_stop", "human_only", "blocked"):
            sample = self.base(); sample.pop(field)
            with self.assertRaises(ValueError):
                l5.reduce_evidence(sample)

    def test_duplicate_stream_blocks(self):
        sample = self.base(); sample["active_prs"] = [561, 562]
        self.assertEqual(l5.reduce_evidence(sample)["next_action"], "DUPLICATE_STREAM_RECONCILIATION_REQUIRED")

    def test_exact_bound_evidence_required(self):
        sample = self.base(); sample["ci_head_sha"] = "c" * 40
        self.assertEqual(l5.reduce_evidence(sample)["next_action"], "RECONCILE_EXACT_HEAD_CI_EVIDENCE")
        sample = self.base(); sample["review_base_sha"] = "c" * 40
        self.assertEqual(l5.reduce_evidence(sample)["next_action"], "RECONCILE_EXACT_HEAD_REVIEW_EVIDENCE")

    def test_self_review_rejected(self):
        sample = self.base(); sample["reviewer_actor"] = "chatgpt"
        self.assertEqual(l5.reduce_evidence(sample)["next_action"], "DISPATCH_ELIGIBLE_NONAUTHOR_REVIEW")

    def test_post_merge_verification_before_replenishment(self):
        sample = self.base(); sample.update(active_prs=[], merged=True, verified=False)
        self.assertEqual(l5.reduce_evidence(sample)["next_action"], "VERIFY_MERGED_RESULT")
        sample["verified"] = True
        self.assertEqual(l5.reduce_evidence(sample)["next_action"], "REPLENISH_NEXT_READY_WU")


if __name__ == "__main__":
    unittest.main()
