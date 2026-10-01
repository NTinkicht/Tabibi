#!/usr/bin/env python3
import sys,unittest
from dataclasses import replace
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from l5_kernel import *

def snap():
 h="a"*40;b="b"*40;c={"head_sha":h,"tested_base_sha":b,"latest_attempt":True,"conclusion":"success","app_id":1,"workflow_path":"ci","assertion_failure_any_attempt":False};r={"state":"APPROVED","commit_id":h,"base_sha":b,"complete":True,"skipped":False,"covers_full_diff":True,"author":"coderabbitai","material_authors":["chatgpt"],"controller_identities":["controller"],"designated_independent":True};s={"head_sha":h,"base_sha":b,"expected_head_sha":h,"expected_base_sha":b,"repo_mode":"NORMAL","required_checks":[c],"security_checks":[c],"review":r}
 for k in TRUE_FIELDS:s[k]=True
 for k in FALSE_FIELDS:s[k]=False
 return s
class T(unittest.TestCase):
 def test_epoch_intent_recovery(self):
  st=MemoryCASStore();o=Observation("a"*40,"b"*40);l=acquire(st,"k","a",o,now_srv=0,ttl=5);li=attach_intent(st,l,"r","i","merge");self.assertIsNone(acquire(st,"k","b",o,now_srv=10));self.assertEqual(intent_recovery(li,"UNKNOWN"),"READBACK_REQUIRED")
 def test_fence(self):
  st=MemoryCASStore();o=Observation("a"*40,"b"*40);l=acquire(st,"k","a",o,now_srv=0);li=attach_intent(st,l,"r","i","merge");self.assertFalse(fence_ok(st,"r",li,replace(o,head="c"*40),now_srv=1)[0])
 def test_locks(self):
  for k in (repo_merge_lock_key("r"),capacity_slot_key("r",4)):
   st=MemoryCASStore();o=Observation("a"*40,"b"*40);self.assertEqual(sum(acquire(st,k,str(i),o,now_srv=0) is not None for i in range(4)),1)
 def test_governance(self):
  self.assertEqual(governance_mode({"platform_enforcement_ok":False,"live_rules_at_least_pinned":True,"rulesets_or_protection_active":False,"required_check_sources_pinned":True}),RepoMode.GOVERNANCE_DRIFT)
 def test_merge_ok_and_rerun_history(self):
  s=snap();self.assertTrue(merge_ok(s)[0]);s["required_checks"][0]["assertion_failure_any_attempt"]=True;self.assertFalse(merge_ok(s)[0])
 def test_external_review(self):
  s=snap();s["review"]["author"]="chatgpt";self.assertFalse(merge_ok(s)[0])
 def test_unknown_fails_closed(self):
  s=snap();del s["files_fully_enumerated"];self.assertFalse(merge_ok(s)[0])
 def test_budget_parks(self):self.assertEqual(classify_item({"ci":"GREEN"},Budget(fix_iterations=MAX_FIX_ITERATIONS)),ItemState.PARKED)
if __name__=="__main__":unittest.main()
