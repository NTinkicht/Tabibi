from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
import l5_recovery as rec
import l5_write_adapter as wa
H,B="a"*40,"b"*40

def snapshot(**over):
    row={"repository":"NTinkicht/Tabibi","issue":559,"canonical_pr":562,"active_prs":[562],"head_sha":H,"base_sha":B,"head_current":True,"base_current":True,"implementation_complete":True,"emergency_stop":False,"human_only":False,"blocked":False,"release_go_no_go":False,"destructive_production":False,"spend_required":False,"secret_scope_change":False,"security_control_weakening":False,"merged":False,"verified":False,"verified_head_sha":None,"verified_base_sha":None,"ci":"FAILURE","ci_head_sha":H,"ci_base_sha":B,"review":"UNKNOWN","review_head_sha":None,"review_base_sha":None,"reviewer_actor":None,"material_authors":["chatgpt"],"material_authors_head_sha":H,"review_eligible":False,"unresolved_threads":False,"mergeable":True,"retry_count":0,"retry_action":None,"event_id":"evt-1","ready_candidates":[],"prior_event_keys":[],"prior_mutation_tokens":[]}
    row.update(over);return row

def merge_snapshot(**over):
    row=snapshot(ci="SUCCESS",review="PASS",review_head_sha=H,review_base_sha=B,reviewer_actor="mistral-vibe",review_eligible=True);row.update(over);return row

def reserve_snapshot(**over):
    row=snapshot(merged=True,verified=True,verified_head_sha=H,verified_base_sha=B,active_prs=[],ci="SUCCESS",review="PASS",review_head_sha=H,review_base_sha=B,reviewer_actor="mistral-vibe",review_eligible=True,ready_candidates=[{"issue":701,"ready":True,"blocked":False,"human_only":False,"conflict_safe":True}]);row.update(over);return row

class FakeClient:
    def __init__(self,pr_state="open",streams=None,effect_on_write=True):
        self.boundaries={k:False for k in rec.HARD_BOUNDARY_FIELDS};self.live={"head_sha":H,"base_sha":B,"pr_state":pr_state,"open_streams":{559:[562]} if streams is None else streams,"review_eligible_nonauthor":True};self.effect=False;self.effect_on_write=effect_on_write;self.writes=[];self.raise_on_write=None
    def fetch_boundaries(self):return dict(self.boundaries)
    def fetch_live(self,_pr):return {k:(dict(v) if isinstance(v,dict) else v) for k,v in self.live.items()}
    def perform_cas(self,mutation,params):
        if self.raise_on_write is wa.WriteRejected:raise wa.WriteRejected("definitive no-write rejection")
        self.writes.append((mutation,params["idempotency_key"],params["expected_head_sha"],params["expected_base_sha"]));self.effect=self.effect_on_write
        if self.raise_on_write:raise self.raise_on_write("unknown after send")
        return True
    def verify_effect(self,_mutation,_params):return self.effect

class WriteAdapterTest(unittest.TestCase):
    def run_it(self,snap,client,store=None):
        store=store or wa.MemoryStore();auth=rec.authorize_mutation(snap);self.assertTrue(auth["authorized"],auth);return auth,store,wa.execute_mutation(auth,snap,client,store)
    def test_atomic_refs_and_replay(self):
        c=FakeClient();a,s,o=self.run_it(snapshot(),c);self.assertEqual(o["status"],"COMPLETE");self.assertEqual(c.writes[0][2:],(H,B));self.assertEqual(wa.execute_mutation(a,snapshot(event_id="x"),c,s)["status"],"REPLAY_NOOP");self.assertEqual(len(c.writes),1)
    def test_all_safe_shapes(self):
        for s,c in ((snapshot(),FakeClient()),(merge_snapshot(),FakeClient()),(reserve_snapshot(),FakeClient(pr_state="merged",streams={}))):self.assertEqual(self.run_it(s,c)[2]["status"],"COMPLETE")
    def test_atomic_cas_required(self):
        c=FakeClient();c.perform_cas=None;self.assertEqual(self.run_it(snapshot(),c)[2]["reason"],"ATOMIC_CAS_UNAVAILABLE")
    def test_merge_rechecks_reviewer(self):
        c=FakeClient();c.live["review_eligible_nonauthor"]=False;self.assertEqual(self.run_it(merge_snapshot(),c)[2]["reason"],"REVIEWER_NOT_ELIGIBLE")
    def test_uncertain_write_remains_pending(self):
        c=FakeClient(effect_on_write=False);c.raise_on_write=wa.LostResponse;a,s,o=self.run_it(snapshot(),c);self.assertEqual(o["status"],"IN_PROGRESS");self.assertEqual(s.get(a["mutation_token"])["status"],"PENDING");c.effect=True;self.assertEqual(wa.execute_mutation(a,snapshot(event_id="replay"),c,s)["status"],"COMPLETE");self.assertEqual(len(c.writes),1)
    def test_retryable_definitive_rejection_budgeted(self):
        c=FakeClient();c.raise_on_write=wa.WriteRejected;a,s,o=self.run_it(snapshot(),c);self.assertEqual(o["reason"],"WRITE_REJECTED");self.assertEqual(s.get(a["mutation_token"])["status"],"RETRYABLE");c.raise_on_write=None;self.assertEqual(wa.execute_mutation(a,snapshot(event_id="retry"),c,s)["status"],"COMPLETE")
    def test_retryable_definitive_rejection_merge(self):
        c=FakeClient();c.raise_on_write=wa.WriteRejected;a,s,o=self.run_it(merge_snapshot(),c);self.assertEqual(o["reason"],"WRITE_REJECTED");self.assertEqual(s.get(a["mutation_token"])["status"],"RETRYABLE");c.raise_on_write=None;self.assertEqual(wa.execute_mutation(a,merge_snapshot(event_id="retry"),c,s)["status"],"COMPLETE")
    def test_token_owner_prevents_aba_restore(self):
        s=wa.MemoryStore();stream="s";t1="1"*64;t2="2"*64
        self.assertTrue(s.begin(t1,{"status":"PENDING"},stream,1,"CI",expected_retry=(0,None),expected_owner=None))
        self.assertTrue(s.begin(t2,{"status":"PENDING"},stream,1,"REVIEW",expected_retry=(1,"CI"),expected_owner=t1))
        s.fail_and_restore(t2,"newer failed",stream,(1,"CI"));self.assertEqual(s.retry_state(stream),(1,"CI"));self.assertEqual(s.retry_owner(stream),t2)
        s.fail_and_restore(t1,"old late failure",stream,(0,None));self.assertEqual(s.retry_state(stream),(1,"CI"));self.assertEqual(s.retry_owner(stream),t2)
    def test_stale_concurrent_owner_blocks(self):
        s=wa.MemoryStore();self.assertTrue(s.begin("3"*64,{"status":"PENDING"},"s",1,"CI",expected_retry=(0,None),expected_owner=None));self.assertFalse(s.begin("4"*64,{"status":"PENDING"},"s",1,"CI",expected_retry=(0,None),expected_owner=None))
    def test_stale_refs_and_duplicates_block(self):
        c=FakeClient();c.live["head_sha"]="c"*40;self.assertEqual(self.run_it(snapshot(),c)[2]["reason"],"STALE_HEAD_OR_BASE")
        for streams in ({559:[562,570]},{559:[562],600:[601]},{559:[]}):self.assertEqual(self.run_it(snapshot(),FakeClient(streams=streams))[2]["reason"],"DUPLICATE_STREAM")
    def test_hard_boundary_blocks(self):
        a=rec.authorize_mutation(snapshot())
        for field in rec.HARD_BOUNDARY_FIELDS:
            c=FakeClient();c.boundaries[field]=True;self.assertEqual(wa.execute_mutation(a,snapshot(),c,wa.MemoryStore())["reason"],"HARD_BOUNDARY")
    def test_json_store_persists_owner_and_retry(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"s.json";s=wa.JsonFileStore(p);token="5"*64;self.assertTrue(s.begin(token,{"status":"PENDING"},"stream",1,"CI",expected_retry=(0,None),expected_owner=None));fresh=wa.JsonFileStore(p);self.assertEqual(fresh.retry_state("stream"),(1,"CI"));self.assertEqual(fresh.retry_owner("stream"),token)

if __name__=="__main__":unittest.main()
