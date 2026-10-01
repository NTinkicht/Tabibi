#!/usr/bin/env python3
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from l5_controller import *
from l5_kernel import *
from test_l5_kernel import merge_snapshot

class Ports:
 def __init__(self,item=None):self.item=item or {"item_id":"1","ci":"PENDING","head_sha":"a"*40,"base_sha":"b"*40};self.detect="UNKNOWN";self.outcome="APPLIED";self.health="UNKNOWN"
 def governance_snapshot(self):return {"ledger_reachable":True,"platform_enforcement_ok":True,"live_rules_at_least_pinned":True,"rulesets_or_protection_active":True,"required_check_sources_pinned":True,"controller_admin":False,"controller_bypass":False}
 def inventory(self):return [self.item]
 def observe_item(self,item_id):return dict(self.item)
 def budget_for(self,item_id):return Budget()
 def detect_intent(self,intent):return self.detect
 def perform(self,operation,item,**kwargs):return self.outcome
 def post_merge_health(self,item_id):return self.health
class ControllerTests(unittest.TestCase):
 def test_governance_drift_blocks_before_inventory(self):
  class Drift(Ports):
   def governance_snapshot(self):s=super().governance_snapshot();s["platform_enforcement_ok"]=False;return s
  r=run_once("repo",MemoryCASStore(),Drift(),now_srv=1);self.assertEqual(r.stage,RunStage.REPOSITORY_MODE);self.assertEqual(r.status,"BLOCKED")
 def test_unknown_pending_intent_blocks_all_new_work(self):
  st=MemoryCASStore();o=Observation("a"*40,"b"*40);l=acquire(st,"k","old",o,now_srv=1);attach_intent(st,l,"repo","old","merge");r=run_once("repo",st,Ports(),now_srv=2);self.assertEqual(r.stage,RunStage.INTENT_RECOVERY);self.assertEqual(r.status,"BLOCKED")
 def test_applied_pending_intent_is_resolved_before_selection(self):
  st=MemoryCASStore();o=Observation("a"*40,"b"*40);l=acquire(st,"k","old",o,now_srv=1);attach_intent(st,l,"repo","old","merge");p=Ports();p.detect="APPLIED";r=run_once("repo",st,p,now_srv=2);self.assertEqual(st.read("k").intent.state,"DONE");self.assertNotEqual(r.stage,RunStage.INTENT_RECOVERY)
 def test_ci_rerun_is_fenced_and_intent_persisted(self):
  item={"item_id":"1","ci":"INFRA_FAILED","head_sha":"a"*40,"base_sha":"b"*40};st=MemoryCASStore();r=run_once("repo",st,Ports(item),now_srv=1);self.assertEqual(r.status,"APPLIED");self.assertEqual([x for x in st.list_leases() if x.intent][0].intent.state,"DONE")
 def test_merge_recomputes_full_merge_ok(self):
  item=merge_snapshot();item["item_id"]="1";r=run_once("repo",MemoryCASStore(),Ports(item),now_srv=1);self.assertEqual(r.action,"merge");self.assertEqual(r.status,"APPLIED")
 def test_merge_unknown_outcome_remains_pending(self):
  item=merge_snapshot();item["item_id"]="1";st=MemoryCASStore();p=Ports(item);p.outcome="UNKNOWN";r=run_once("repo",st,p,now_srv=1);self.assertEqual(r.status,"OUTCOME_UNKNOWN");self.assertEqual(len([x for x in st.list_leases() if x.intent and x.intent.state=="PENDING"]),1)
if __name__=="__main__":unittest.main()
