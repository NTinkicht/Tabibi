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
            "release_go_no_go":False,"destructive_production":False,"spend_required":False,
            "secret_scope_change":False,"security_control_weakening":False,
            "merged":False,"verified":False,"verified_head_sha":None,"verified_base_sha":None,
            "ci":"SUCCESS","ci_head_sha":h,"ci_base_sha":b,"review":"PASS","review_head_sha":h,
            "review_base_sha":b,"reviewer_actor":"mistral-vibe","material_authors":["chatgpt"],
            "material_authors_head_sha":h,"review_eligible":True,"unresolved_threads":False,"mergeable":True,
            "retry_count":0,"retry_action":None,"event_id":"evt-1","ready_candidates":[],
            "prior_event_keys":[],"prior_mutation_tokens":[],
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

    def test_hold_preserves_retry_budget_and_scope(self):
        hold = {**self.base(), "ci":"FAILURE", "retry_count":2, "retry_action":"CI", "emergency_stop":True}
        plan = l5.plan_recovery(hold)
        self.assertEqual(plan["status"], "BLOCKED")
        self.assertEqual(plan["retry_count"], 2)
        self.assertEqual(plan["retry_action"], "CI")

    def test_unknown_retry_scope_fails_closed(self):
        with self.assertRaises(ValueError):
            l5.plan_recovery({**self.base(), "ci":"FAILURE", "retry_count":3, "retry_action":"garbage"})

    def test_review_failover_stays_same_stream(self):
        plan = l5.plan_recovery({**self.base(), "review":"OUTAGE"})
        self.assertEqual(plan["next_action"], "FAILOVER_TO_ELIGIBLE_NONAUTHOR_REVIEWER")
        self.assertEqual(plan["retry_action_after"], "REVIEW")

    def test_replay_noop(self):
        snap = {**self.base(), "ci":"FAILURE"}
        first = l5.plan_recovery(snap)
        self.assertEqual(l5.plan_recovery(snap, prior_event_keys={first["event_key"]})["status"], "REPLAY_NOOP")

    def test_cli_replay_history_is_validated_and_consumable(self):
        snap = {**self.base(), "ci":"FAILURE"}
        first = l5.plan_recovery(snap)
        self.assertEqual(l5._prior_event_keys({**snap, "prior_event_keys":[first["event_key"]]}), {first["event_key"]})
        with self.assertRaises(ValueError):
            l5._prior_event_keys({**snap, "prior_event_keys":["broken"]})

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

    def test_activation_authorizes_exact_head_merge_only(self):
        result = l5.authorize_mutation(self.base())
        self.assertTrue(result["mutation_allowed"])
        self.assertEqual(result["mutation"], "merge_expected_head")
        self.assertEqual(result["expected_head_sha"], "a" * 40)

    def test_activation_replay_is_noop(self):
        first = l5.authorize_mutation(self.base())
        replay = l5.authorize_mutation(self.base(), prior_mutation_tokens={first["mutation_token"]})
        self.assertFalse(replay["mutation_allowed"])
        self.assertEqual(replay["reason"], "REPLAY_NOOP")

    def test_activation_hard_boundaries_fail_closed(self):
        for field in l5.HARD_BOUNDARY_FIELDS:
            sample = self.base()
            sample[field] = True
            self.assertFalse(l5.authorize_mutation(sample)["mutation_allowed"], field)
        for field in l5.HARD_BOUNDARY_FIELDS:
            sample = self.base()
            sample.pop(field)
            with self.assertRaises(ValueError):
                l5.authorize_mutation(sample)

    def test_activation_unresolved_threads_only_allow_same_pr_remediation(self):
        sample = {**self.base(), "unresolved_threads":True}
        result = l5.authorize_mutation(sample)
        self.assertEqual(result["mutation"], "remediate_review")
        self.assertNotEqual(result["mutation"], "merge_expected_head")

    def test_activation_replenishment_reserves_verified_candidate(self):
        sample = {**self.base(), "active_prs":[], "merged":True,"verified":True,
                  "verified_head_sha":"a"*40,"verified_base_sha":"b"*40,
                  "ready_candidates":[
                      {"issue":701,"ready":True,"blocked":False,"human_only":False,"conflict_safe":True},
                      {"issue":700,"ready":True,"blocked":False,"human_only":False,"conflict_safe":False},
                  ]}
        result = l5.authorize_mutation(sample)
        self.assertEqual(result["mutation"], "reserve_next_wu")
        self.assertEqual(result["selected_issue"], 701)

    def test_activation_stale_refs_do_not_authorize(self):
        for field in ("head_current", "base_current"):
            sample = self.base(); sample[field] = False
            self.assertFalse(l5.authorize_mutation(sample)["mutation_allowed"])


if __name__ == "__main__":
    unittest.main()
