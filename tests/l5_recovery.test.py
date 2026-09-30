import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("l5_recovery", ROOT / "scripts" / "l5_recovery.py")
l5 = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(l5)


class L5RecoveryTest(unittest.TestCase):
    def base(self):
        h, b = "a" * 40, "b" * 40
        return {
            "repository":"NTinkicht/Tabibi","issue":559,"canonical_pr":562,"active_prs":[562],
            "head_sha":h,"base_sha":b,"head_current":True,"base_current":True,
            "implementation_complete":True,"emergency_stop":False,"human_only":False,"blocked":False,
            "merged":False,"verified":False,"verified_head_sha":None,"verified_base_sha":None,
            "ci":"SUCCESS","ci_head_sha":h,"ci_base_sha":b,"review":"PASS","review_head_sha":h,
            "review_base_sha":b,"reviewer_actor":"mistral-vibe","material_authors":["chatgpt"],
            "material_authors_head_sha":h,"review_eligible":True,"unresolved_threads":False,"mergeable":True,
            "retry_count":0,"retry_action":None,"event_id":"evt-1","ready_candidates":[],
        }

    def test_merge_ready_is_read_only(self):
        plan = l5.plan_recovery(self.base())
        self.assertEqual(plan["status"], "READY")
        self.assertFalse(plan["mutation_allowed"])

    def test_ci_retry_budget_survives_transient_state(self):
        pending = {**self.base(), "ci":"PENDING", "retry_count":2, "retry_action":"CI"}
        plan = l5.plan_recovery(pending)
        self.assertEqual(plan["retry_count_after"], 3)
        failed = {**self.base(), "ci":"FAILURE", "retry_count":3, "retry_action":"CI"}
        self.assertEqual(l5.plan_recovery(failed)["next_action"], "RETRY_BUDGET_EXHAUSTED")

    def test_review_failover_stays_same_stream(self):
        plan = l5.plan_recovery({**self.base(), "review":"OUTAGE"})
        self.assertEqual(plan["next_action"], "FAILOVER_TO_ELIGIBLE_NONAUTHOR_REVIEWER")
        self.assertEqual(plan["retry_action_after"], "REVIEW")

    def test_replay_noop(self):
        snap = {**self.base(), "ci":"FAILURE"}
        first = l5.plan_recovery(snap)
        self.assertEqual(l5.plan_recovery(snap, prior_event_keys={first["event_key"]})["status"], "REPLAY_NOOP")

    def test_verification_scope_resets_ci_budget(self):
        snap = {**self.base(), "active_prs":[], "merged":True, "verified":False, "retry_count":3, "retry_action":"CI"}
        plan = l5.plan_recovery(snap)
        self.assertEqual(plan["next_action"], "VERIFY_MERGED_RESULT")
        self.assertEqual(plan["retry_count"], 0)
        self.assertEqual(plan["retry_action_after"], "VERIFY")

    def test_verified_merge_requires_exact_verification(self):
        snap = {**self.base(), "active_prs":[], "merged":True, "verified":True}
        plan = l5.plan_recovery(snap)
        self.assertEqual(plan["next_action"], "RECONCILE_VERIFIED_MERGE_EVIDENCE")

    def test_replenishment_selects_only_conflict_safe_ready(self):
        snap = {**self.base(), "active_prs":[], "merged":True, "verified":True,
                "verified_head_sha":"a"*40,"verified_base_sha":"b"*40,
                "ready_candidates":[
                    {"issue":560,"ready":True,"blocked":False,"human_only":False,"conflict_safe":True},
                    {"issue":600,"ready":True,"blocked":True,"human_only":False,"conflict_safe":True},
                ]}
        plan = l5.plan_recovery(snap)
        self.assertEqual(plan["selected_issue"], 560)

    def test_empty_ready_queue_does_not_invent_work(self):
        snap = {**self.base(), "active_prs":[], "merged":True,"verified":True,
                "verified_head_sha":"a"*40,"verified_base_sha":"b"*40}
        plan = l5.plan_recovery(snap)
        self.assertEqual(plan["status"], "IDLE")

    def test_journal_normalizes_invalid_refs_and_pr(self):
        snap = {**self.base(), "canonical_pr":"bad", "emergency_stop":True, "head_sha":"bad", "base_sha":"bad"}
        plan = l5.plan_recovery(snap)
        record = l5.journal_record(snap, plan)
        self.assertIsNone(record["canonical_pr"])
        self.assertIsNone(record["head_sha"])
        self.assertIsNone(record["base_sha"])


if __name__ == "__main__":
    unittest.main()
