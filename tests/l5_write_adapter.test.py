import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("l5_write_adapter", ROOT / "scripts" / "l5_write_adapter.py")
wa = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(wa)
import l5_recovery as rec  # noqa: E402

H, B = "a" * 40, "b" * 40


def snapshot(**over):
    s = {
        "repository": "NTinkicht/Tabibi", "issue": 559, "canonical_pr": 562, "active_prs": [562],
        "head_sha": H, "base_sha": B, "head_current": True, "base_current": True,
        "implementation_complete": True, "emergency_stop": False, "human_only": False, "blocked": False,
        "release_go_no_go": False, "destructive_production": False, "spend_required": False,
        "secret_scope_change": False, "security_control_weakening": False,
        "merged": False, "verified": False, "verified_head_sha": None, "verified_base_sha": None,
        "ci": "FAILURE", "ci_head_sha": H, "ci_base_sha": B, "review": "UNKNOWN",
        "review_head_sha": None, "review_base_sha": None, "reviewer_actor": None,
        "material_authors": ["chatgpt"], "material_authors_head_sha": H, "review_eligible": False,
        "unresolved_threads": False, "mergeable": True, "retry_count": 0, "retry_action": None,
        "event_id": "evt-1", "ready_candidates": [], "prior_event_keys": [], "prior_mutation_tokens": [],
    }
    s.update(over)
    return s


def merge_snapshot(**over):
    return snapshot(ci="SUCCESS", review="PASS", review_head_sha=H, review_base_sha=B,
                    reviewer_actor="mistral-vibe", review_eligible=True, **over)


def reserve_snapshot():
    return snapshot(merged=True, verified=True, verified_head_sha=H, verified_base_sha=B,
                    active_prs=[], ci="SUCCESS", review="PASS", review_head_sha=H, review_base_sha=B,
                    reviewer_actor="mistral-vibe", review_eligible=True,
                    ready_candidates=[{"issue": 701, "ready": True, "blocked": False, "human_only": False, "conflict_safe": True}])


class FakeClient:
    def __init__(self, pr_state="open", streams=None, effect_on_write=True):
        self.boundaries = {k: False for k in rec.HARD_BOUNDARY_FIELDS}
        self.live = {"head_sha": H, "base_sha": B, "pr_state": pr_state,
                     "open_streams": {559: [562]} if streams is None else streams,
                     "review_eligible_nonauthor": True}
        self.effect = False
        self.effect_on_write = effect_on_write
        self.writes = []
        self.raise_on_write = None
        self.before_write = None  # hook to mutate remote state between final gate and write
        self.fetches = 0

    def fetch_boundaries(self):
        return dict(self.boundaries)

    def fetch_live(self, pr):
        self.fetches += 1
        return {k: (dict(v) if isinstance(v, dict) else v) for k, v in self.live.items()}

    def perform(self, mutation, params):
        if self.before_write:
            self.before_write(self)
        if self.raise_on_write is wa.WriteRejected:
            raise wa.WriteRejected("head moved")
        self.writes.append((mutation, params["idempotency_key"]))
        self.effect = self.effect_on_write
        if self.raise_on_write:
            raise self.raise_on_write("boom")

    def verify_effect(self, mutation, params):
        return self.effect


class WriteAdapterTest(unittest.TestCase):
    @staticmethod
    def stream(auth, snap=None):
        return wa.stream_key(auth, snap or snapshot())

    def run_it(self, snap, client, store=None):
        store = store or wa.MemoryStore()
        auth = rec.authorize_mutation(snap)
        self.assertTrue(auth["authorized"], auth)
        return auth, store, wa.execute_mutation(auth, snap, client, store)

    def test_happy_path_retry_ci_persists_token_and_retry_state(self):
        client = FakeClient()
        auth, store, out = self.run_it(snapshot(), client)
        self.assertEqual((out["status"], out["written"]), ("COMPLETE", True))
        self.assertEqual(store.records[auth["mutation_token"]]["status"], "COMPLETE")
        self.assertEqual(store.retry_state(self.stream(auth)), (1, "CI"))
        self.assertEqual(client.writes, [("retry_ci", auth["mutation_token"])])

    def test_each_safe_mutation_executes(self):
        cases = [(snapshot(), FakeClient()),
                 (merge_snapshot(), FakeClient()),
                 (reserve_snapshot(), FakeClient(pr_state="merged", streams={}))]
        for snap, client in cases:
            _, _, out = self.run_it(snap, client)
            self.assertEqual(out["status"], "COMPLETE", snap)

    def test_stale_head_and_base_block_without_write(self):
        for key in ("head_sha", "base_sha"):
            client = FakeClient(); client.live[key] = "c" * 40
            _, store, out = self.run_it(snapshot(), client)
            self.assertEqual(out["reason"], "STALE_HEAD_OR_BASE")
            self.assertEqual(client.writes, [])
            self.assertEqual(store.records, {})

    def test_duplicate_stream_blocks(self):
        for streams in ({559: [562, 570]}, {559: [562], 600: [601]}, {559: []}):
            client = FakeClient(streams=streams)
            _, _, out = self.run_it(snapshot(), client)
            self.assertEqual(out["reason"], "DUPLICATE_STREAM")
            self.assertEqual(client.writes, [])

    def test_lost_write_response_reconciles_without_second_write(self):
        client = FakeClient(); client.raise_on_write = wa.LostResponse
        auth, store, out = self.run_it(snapshot(), client)
        self.assertEqual(out["status"], "COMPLETE")
        self.assertFalse(out["written"])
        self.assertEqual(len(client.writes), 1)

    def test_crash_after_persist_replays_as_reconcile_not_rewrite(self):
        snap = snapshot(); auth = rec.authorize_mutation(snap)
        store = wa.MemoryStore()
        store.begin(auth["mutation_token"], {"status": "PENDING"}, self.stream(auth), 1, "CI")
        client = FakeClient(); client.effect = True  # write landed, process died before verify
        out = wa.execute_mutation(auth, snap, client, store)
        self.assertEqual(out["status"], "COMPLETE")
        self.assertEqual(client.writes, [])

    def test_replay_after_complete_is_noop(self):
        client = FakeClient()
        auth, store, _ = self.run_it(snapshot(), client)
        out = wa.execute_mutation(auth, snapshot(event_id="evt-9"), client, store)
        self.assertEqual(out["status"], "REPLAY_NOOP")
        self.assertEqual(len(client.writes), 1)

    def test_merge_race_head_moves_after_gate(self):
        client = FakeClient()
        def move(c): c.live["head_sha"] = "c" * 40
        client.before_write = move
        client.raise_on_write = wa.WriteRejected
        _, store, out = self.run_it(merge_snapshot(), client)
        self.assertEqual(out["status"], "FAILED")
        self.assertEqual(client.writes, [])
        self.assertFalse(client.effect)

    def test_branch_pr_creation_race_reserve(self):
        client = FakeClient(pr_state="merged", streams={})
        client.raise_on_write = wa.AlreadyExists; client.effect_on_write = False
        _, _, out = self.run_it(reserve_snapshot(), client)
        self.assertEqual(out["status"], "VERIFICATION_FAILED")
        live_dup = FakeClient(pr_state="merged", streams={701: [710]})
        _, _, out = self.run_it(reserve_snapshot(), live_dup)
        self.assertEqual(out["reason"], "DUPLICATE_STREAM")
        self.assertEqual(live_dup.writes, [])

    def test_exhausted_retries_never_write(self):
        snap = snapshot(retry_count=3, retry_action="CI")
        self.assertFalse(rec.authorize_mutation(snap)["mutation_allowed"])
        forged = {**rec.authorize_mutation(snapshot()), "retry_count_after": 4}
        client = FakeClient()
        out = wa.execute_mutation(forged, snapshot(), client, wa.MemoryStore())
        self.assertEqual(out["status"], "BLOCKED")
        self.assertEqual(client.writes, [])

    def test_stale_persisted_retry_state_blocks(self):
        snap = snapshot(); store = wa.MemoryStore(); store.retry[self.stream(rec.authorize_mutation(snap), snap)] = (2, "CI")
        client = FakeClient()
        _, _, out = self.run_it(snap, client, store)
        self.assertEqual(out["reason"], "RETRY_STATE_STALE")

    def test_emergency_stop_between_authorization_and_write(self):
        snap = snapshot(); auth = rec.authorize_mutation(snap)
        for field in rec.HARD_BOUNDARY_FIELDS:
            client = FakeClient(); client.boundaries[field] = True
            out = wa.execute_mutation(auth, snap, client, wa.MemoryStore())
            self.assertEqual(out["reason"], "HARD_BOUNDARY", field)
            self.assertEqual(client.writes, [])

    def test_emergency_stop_after_token_persist_blocks_write(self):
        client = FakeClient()
        calls = {"n": 0}
        orig = client.fetch_boundaries
        def flip():
            calls["n"] += 1
            b = orig()
            if calls["n"] >= 2: b["emergency_stop"] = True
            return b
        client.fetch_boundaries = flip
        auth, store, out = self.run_it(snapshot(), client)
        self.assertEqual(out["reason"], "HARD_BOUNDARY")
        self.assertEqual(client.writes, [])
        self.assertEqual(store.records[auth["mutation_token"]]["status"], "FAILED")

    def test_unknown_boundary_state_fails_closed(self):
        client = FakeClient(); del client.boundaries["human_only"]
        _, _, out = self.run_it(snapshot(), client)
        self.assertEqual(out["reason"], "BOUNDARY_STATE_UNKNOWN")

    def test_post_write_verification_failure_is_not_complete(self):
        client = FakeClient(effect_on_write=False)
        auth, store, out = self.run_it(snapshot(), client)
        self.assertEqual(out["status"], "VERIFICATION_FAILED")
        self.assertEqual(store.records[auth["mutation_token"]]["status"], "VERIFICATION_FAILED")
        again = wa.execute_mutation(auth, snapshot(), client, store)
        self.assertEqual(again["status"], "BLOCKED")
        self.assertEqual(len(client.writes), 1)

    def test_non_whitelisted_or_forged_authorization_fails_closed(self):
        snap = snapshot(); auth = rec.authorize_mutation(snap); client = FakeClient()
        for bad in ({**auth, "mutation": "delete_branch"}, {**auth, "authorized": False},
                    {**auth, "expected_head_sha": "c" * 40}, {**auth, "mutation_token": "x"}, None, {}):
            out = wa.execute_mutation(bad, snap, client, wa.MemoryStore())
            self.assertEqual(out["status"], "BLOCKED")
        self.assertEqual(client.writes, [])

    def test_provider_availability_does_not_grant_reviewer_dispatch(self):
        snap = snapshot(ci="SUCCESS", review="UNKNOWN")
        auth = rec.authorize_mutation(snap)
        self.assertEqual(auth["mutation"], "dispatch_review")
        # Provider is up, but no live eligible non-author reviewer: availability alone never grants eligibility.
        for eligible in (False, None, "yes", 1):
            client = FakeClient(); client.live["provider_available"] = True
            client.live["review_eligible_nonauthor"] = eligible
            store = wa.MemoryStore()
            out = wa.execute_mutation(auth, snap, client, store)
            self.assertEqual((out["status"], out["reason"]), ("BLOCKED", "REVIEWER_NOT_ELIGIBLE"))
            self.assertEqual(client.writes, [])
            self.assertEqual(store.records, {})
        client = FakeClient(); client.live["provider_available"] = False  # eligibility, not provider state, decides
        self.assertEqual(wa.execute_mutation(auth, snap, client, wa.MemoryStore())["status"], "COMPLETE")

    def _assert_retry_isolation(self, store):
        snap_a = snapshot()
        snap_b = snapshot(issue=600, canonical_pr=601, active_prs=[601], event_id="evt-b")
        ka = self.stream(rec.authorize_mutation(snap_a), snap_a)
        kb = self.stream(rec.authorize_mutation(snap_b), snap_b)
        self.assertNotEqual(ka, kb)
        streams_b = {600: [601]}

        def run(snap, streams=None):
            auth = rec.authorize_mutation(snap)
            return wa.execute_mutation(auth, snap, FakeClient(streams=streams), store)

        self.assertEqual(run(snap_a)["status"], "COMPLETE")
        self.assertEqual(run(snap_b, streams_b)["status"], "COMPLETE")
        self.assertEqual((store.retry_state(ka), store.retry_state(kb)), ((1, "CI"), (1, "CI")))
        # A takes a second CI retry; B's budget is untouched.
        self.assertEqual(run(snapshot(retry_count=1, retry_action="CI", event_id="evt-a2"))["status"], "COMPLETE")
        self.assertEqual((store.retry_state(ka), store.retry_state(kb)), ((2, "CI"), (1, "CI")))
        # A moves to REVIEW scope (resetting only A); B's CI count survives.
        snap_a3 = snapshot(ci="SUCCESS", retry_count=2, retry_action="CI", event_id="evt-a3")
        self.assertEqual(run(snap_a3)["status"], "COMPLETE")
        self.assertEqual((store.retry_state(ka), store.retry_state(kb)), ((1, "REVIEW"), (1, "CI")))
        # B's second CI retry is still valid against its own state despite A's changes.
        snap_b2 = snapshot(issue=600, canonical_pr=601, active_prs=[601], retry_count=1, retry_action="CI", event_id="evt-b2")
        self.assertEqual(run(snap_b2, streams_b)["status"], "COMPLETE")
        self.assertEqual((store.retry_state(ka), store.retry_state(kb)), ((1, "REVIEW"), (2, "CI")))
        # Exhausting B never blocks A.
        snap_b3 = snapshot(issue=600, canonical_pr=601, active_prs=[601], retry_count=2, retry_action="CI", event_id="evt-b3")
        self.assertEqual(run(snap_b3, streams_b)["status"], "COMPLETE")
        self.assertEqual(store.retry_state(kb), (3, "CI"))
        self.assertEqual(run(snapshot(ci="SUCCESS", retry_count=1, retry_action="REVIEW", event_id="evt-a4"))["status"], "COMPLETE")
        self.assertEqual(store.retry_state(ka), (2, "REVIEW"))

    def test_retry_state_isolated_per_stream_memory_store(self):
        self._assert_retry_isolation(wa.MemoryStore())

    def test_retry_state_isolated_per_stream_json_file_store(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "s.json"
            self._assert_retry_isolation(wa.JsonFileStore(path))
            fresh = wa.JsonFileStore(path)
            snap_b = snapshot(issue=600, canonical_pr=601, active_prs=[601])
            kb = self.stream(rec.authorize_mutation(snap_b), snap_b)
            self.assertEqual(fresh.retry_state(kb), (3, "CI"))

    def test_json_file_store_persists_across_instances(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "s.json"
            client = FakeClient()
            auth, _, out = self.run_it(snapshot(), client, wa.JsonFileStore(path))
            self.assertEqual(out["status"], "COMPLETE")
            fresh = wa.JsonFileStore(path)
            self.assertEqual(fresh.get(auth["mutation_token"])["status"], "COMPLETE")
            self.assertEqual(fresh.retry_state(self.stream(auth)), (1, "CI"))
            self.assertFalse(fresh.begin(auth["mutation_token"], {}, self.stream(auth), 1, "CI"))


if __name__ == "__main__":
    unittest.main()
