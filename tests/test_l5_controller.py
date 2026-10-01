#!/usr/bin/env python3
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from l5_controller import *
from l5_kernel import *
def repo(**x):
 d={"halted":False,"controller_integrity_failure":False,"security_integrity_failure":False,"ledger_reachable":True,"platform_enforcement_ok":True,"live_rules_at_least_pinned":True,"rulesets_or_protection_active":True,"required_check_sources_pinned":True,"controller_admin":False,"controller_bypass":False};d.update(x);return d
class IO:
 def __init__(self,r=None,items=None):self.r=r or repo();self.items=list(items or []);self.pending=[];self.detect={};self.done=[];self.result={"status":"COMPLETE"}
 def repo_snapshot(self):return dict(self.r)
 def pending_intent_leases(self):return list(self.pending)
 def detect_intent_effect(self,l):return self.detect.get(l.key,"UNKNOWN")
 def inventory(self):return list(self.items)
 def budget_for(self,i):return Budget()
 def observe_item(self,i):return Observation(i.get("head_sha","a"*40),i.get("base_sha","b"*40))
 def execute_guarded(self,op,i,l):self.done.append((op,str(i["item_id"])));return dict(self.result)
class T(unittest.TestCase):
 def test_governance_drift_blocks(self):
  io=IO(repo(rulesets_or_protection_active=False));r=run_once("repo",io,MemoryCASStore(),now_srv=1);self.assertEqual((r.status,r.reason),("BLOCKED","GOVERNANCE_DRIFT"));self.assertEqual(io.done,[])
 def test_human_mode_not_auto_cleared(self):
  st=MemoryCASStore();st.modes["repo"]=(RepoMode.GOVERNANCE_DRIFT,4);r=run_once("repo",IO(),st,now_srv=1);self.assertEqual(r.reason,"HUMAN_CLEAR_REQUIRED")
 def test_ci_infra_one_action(self):
  io=IO(items=[{"item_id":"7","head_sha":"a"*40,"base_sha":"b"*40,"ci":"INFRA_FAILED"}]);r=run_once("repo",io,MemoryCASStore(),now_srv=1);self.assertEqual((r.status,r.action),("COMPLETE","retry_ci"));self.assertEqual(len(io.done),1)
 def test_unknown_write_stays_pending(self):
  io=IO(items=[{"item_id":"7","head_sha":"a"*40,"base_sha":"b"*40,"ci":"INFRA_FAILED"}]);io.result={"status":"IN_PROGRESS"};st=MemoryCASStore();r=run_once("repo",io,st,now_srv=1);self.assertEqual(r.reason,"OUTCOME_UNKNOWN");self.assertEqual(sum(1 for x in st.leases.values() if x.intent and x.intent.state=="PENDING"),1)
 def test_orphan_unknown_blocks_selection(self):
  st=MemoryCASStore();st.cas_repo_mode("repo",None,RepoMode.NORMAL);o=Observation("a"*40,"b"*40);l=acquire(st,"k","old",o,now_srv=0);li=attach_intent(st,l,"repo","1","push",now_srv=1);io=IO(items=[{"item_id":"9","ci":"INFRA_FAILED"}]);io.pending=[li];io.detect["k"]="UNKNOWN";r=run_once("repo",io,st,now_srv=2);self.assertEqual((r.phase,r.reason),(RunPhase.INTENT_RECOVERY,"RECOVERY_READBACK_REQUIRED"));self.assertEqual(io.done,[])
 def test_orphan_applied_resolves(self):
  st=MemoryCASStore();st.cas_repo_mode("repo",None,RepoMode.NORMAL);o=Observation("a"*40,"b"*40);l=acquire(st,"k","old",o,now_srv=0);li=attach_intent(st,l,"repo","1","push",now_srv=1);io=IO();io.pending=[li];io.detect["k"]="APPLIED";r=run_once("repo",io,st,now_srv=2);self.assertEqual(r.status,"IDLE");self.assertEqual(st.read("k").intent.state,"DONE")
 def test_deterministic_selection(self):
  repair={"item_id":"9","head_sha":"a"*40,"base_sha":"b"*40,"ci":"DETERMINISTIC_FAILED"};review={"item_id":"1","head_sha":"a"*40,"base_sha":"b"*40,"ci":"GREEN","independent_review_pass":False};r=run_once("repo",IO(items=[review,repair]),MemoryCASStore(),now_srv=1);self.assertEqual((r.item_id,r.action),("9","remediate_review"))
if __name__=="__main__":unittest.main()
