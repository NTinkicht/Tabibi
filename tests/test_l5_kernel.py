#!/usr/bin/env python3
import sys,unittest
from dataclasses import replace
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from l5_kernel import *
def snap():
 h="a"*40;b="b"*40;src={"app_id":1,"workflow_path":"ci.yml"};secsrc={"app_id":2,"workflow_path":"sec.yml"};row={"head_sha":h,"tested_base_sha":b,"latest_attempt":True,"conclusion":"success","app_id":1,"workflow_path":"ci.yml","assertion_failure_any_attempt":False,"attempt_history_complete":True,"source_verified":True};sec={**row,"app_id":2,"workflow_path":"sec.yml"};rev={"state":"APPROVED","commit_id":h,"base_sha":b,"complete":True,"skipped":False,"covers_full_diff":True,"author":"coderabbitai","material_authors":["chatgpt"],"controller_identities":["controller"],"designated_independent":True,"reviewer_eligible":True,"authorship_complete":True,"material_authors_head_sha":h,"identity_source_verified":True};s={"head_sha":h,"base_sha":b,"expected_head_sha":h,"expected_base_sha":b,"repo_mode":"NORMAL","required_checks":[row],"required_check_sources":[src],"security_checks":[sec],"security_check_sources":[secsrc],"review":rev,"ci":"GREEN","independent_review_pass":True}
 for k in TRUE_FIELDS:s[k]=True
 for k in FALSE_FIELDS:s[k]=False
 return s
class T(unittest.TestCase):
 def setUp(self):self.st=MemoryCASStore();self.st.cas_repo_mode("repo",None,RepoMode.NORMAL);self.o=Observation("a"*40,"b"*40,"wu","t")
 def test_pending_intent_recovery(self):
  l=acquire(self.st,"k","r1",self.o,now_srv=1,ttl=5);li=attach_intent(self.st,l,"repo","i","merge",now_srv=2);self.assertIsNone(release(self.st,li,now_srv=10));self.assertIsNone(acquire(self.st,"k","r2",self.o,now_srv=10));done=resolve_intent(self.st,li,"ABORTED");rel=release(self.st,done,now_srv=10);l2=acquire(self.st,"k","r2",self.o,now_srv=11,ttl=5);self.assertIsNotNone(rel);self.assertEqual(l2.epoch,l.epoch+1)
 def test_stale_and_expired_lease_ops_fail(self):
  l=acquire(self.st,"k","r",self.o,now_srv=1,ttl=2);self.assertIsNone(renew(self.st,l,now_srv=3));self.assertIsNone(attach_intent(self.st,l,"repo","i","merge",now_srv=3));st=MemoryCASStore();st.cas_repo_mode("repo",None,RepoMode.NORMAL);l=acquire(st,"k","r",self.o,now_srv=1);new=renew(st,l,now_srv=2);self.assertIsNotNone(new);self.assertIsNone(release(st,l,now_srv=3))
 def test_pending_intent_cannot_be_replaced(self):
  l=acquire(self.st,"k","r",self.o,now_srv=1);li=attach_intent(self.st,l,"repo","i","merge",now_srv=2);self.assertIsNone(attach_intent(self.st,li,"repo","i","push",now_srv=3))
 def test_observation_reason(self):
  l=acquire(self.st,"k","r",self.o,now_srv=1);li=attach_intent(self.st,l,"repo","i","merge",now_srv=2);self.assertEqual(fence_ok(self.st,"repo",li,self.o,now_srv=3),(True,"OK"));self.assertEqual(fence_ok(self.st,"repo",li,replace(self.o,pr_updated_at="x"),now_srv=3),(False,"OBSERVATION_CHANGED"))
 def test_human_modes_block_revert(self):
  for m in HUMAN_CLEAR_ONLY:
   st=MemoryCASStore();st.modes["repo"]=(m,1);l=acquire(st,"k","r",self.o,now_srv=1);li=attach_intent(st,l,"repo","i","revert",now_srv=2);self.assertFalse(fence_ok(st,"repo",li,self.o,now_srv=3)[0])
 def test_missing_mode_degraded_and_human_clear(self):
  st=MemoryCASStore();self.assertEqual(st.read_repo_mode("x")[0],RepoMode.AUTOMATION_DEGRADED);st.modes["repo"]=(RepoMode.GOVERNANCE_DRIFT,7);self.assertFalse(st.cas_repo_mode("repo",7,RepoMode.NORMAL));self.assertTrue(st.cas_repo_mode("repo",7,RepoMode.NORMAL,human_clear=True))
 def test_merge_ok_and_fail_closed_evidence(self):
  s=snap();self.assertTrue(merge_ok(s)[0]);s=snap();s["required_checks"][0].pop("assertion_failure_any_attempt");self.assertIn("REQUIRED_CHECKS_INVALID",merge_ok(s)[1]);s=snap();s["required_checks"][0]["tested_base_sha"]="c"*40;s["required_checks"][0]["merge_queue"]=True;self.assertIn("REQUIRED_CHECKS_INVALID",merge_ok(s)[1])
 def test_review_provenance(self):
  s=snap();s["review"]["author"]="chatgpt";self.assertIn("REVIEW_INVALID",merge_ok(s)[1]);s=snap();s["review"]["material_authors_head_sha"]="c"*40;self.assertIn("REVIEW_INVALID",merge_ok(s)[1])
 def test_specific_unknown_gate(self):
  s=snap();del s["files_fully_enumerated"];self.assertIn("FILES_FULLY_ENUMERATED_NOT_TRUE",merge_ok(s)[1])
 def test_holds_and_budget(self):
  self.assertEqual(classify_item({"human_hold":True},Budget()),ItemState.BLOCK_HUMAN);self.assertEqual(classify_item({"dependency_wait":True},Budget()),ItemState.WAIT_DEPENDENCY);self.assertEqual(classify_item({"ci":"GREEN"},Budget(fix_iterations=MAX_FIX_ITERATIONS)),ItemState.PARKED)
if __name__=="__main__":unittest.main()
