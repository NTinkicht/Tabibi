#!/usr/bin/env python3
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from l5_kernel import RepoMode
from l5_ledger import *
def doc():return {"schema_version":SCHEMA_VERSION,"repository":"NTinkicht/Tabibi","revision":0,"mode":"GOVERNANCE_DRIFT","mode_version":1,"human_clear_required":True,"leases":{},"budgets":{},"observations":{},"platform_enforcement":{"branch_protected":False,"active_rulesets":0}}
def intent(epoch=1,op="x"):return {"op_id":op,"idem_key":"f"*64,"operation":"merge","expected_head":"a"*40,"expected_base":"b"*40,"epoch":epoch,"state":"PENDING"}
def lease(version=1,epoch=1,holder="r1",state="ACTIVE",it=None):return {"version":version,"epoch":epoch,"holder":holder,"state":state,"acquired_at":1.0,"expires_at":300.0 if state=="ACTIVE" else 2.0,"observed":{"head":"a"*40,"base":"b"*40,"wu_body_hash":"wu","pr_updated_at":"t"},"intent":it}
class T(unittest.TestCase):
 def test_valid_and_human_clear(self):
  validate_ledger(doc());self.assertRaises(LedgerConflict,lambda:cas_mode(doc(),expected_revision=0,expected_mode_version=1,new_mode=RepoMode.NORMAL));self.assertEqual(cas_mode(doc(),expected_revision=0,expected_mode_version=1,new_mode=RepoMode.NORMAL,human_clear=True)["mode"],"NORMAL")
 def test_delete_forbidden_and_tombstone(self):
  d=doc();d["leases"]["k"]=lease(version=3,epoch=7);self.assertRaises(LedgerInvalid,lambda:cas_lease(d,"k",expected_revision=0,expected_lease_version=3,new_record=None));r=lease(version=4,epoch=7,state="RELEASED");o=cas_lease(d,"k",expected_revision=0,expected_lease_version=3,new_record=r);self.assertEqual((o["leases"]["k"]["epoch"],o["leases"]["k"]["version"]),(7,4))
 def test_new_owner_higher_epoch(self):
  d=doc();d["leases"]["k"]=lease(version=3,epoch=7,state="RELEASED");self.assertRaises(LedgerInvalid,lambda:cas_lease(d,"k",expected_revision=0,expected_lease_version=3,new_record=lease(version=4,epoch=7,holder="r2")));self.assertEqual(cas_lease(d,"k",expected_revision=0,expected_lease_version=3,new_record=lease(version=4,epoch=8,holder="r2"))["leases"]["k"]["epoch"],8)
 def test_pending_intent_preserved(self):
  d=doc();d["leases"]["k"]=lease(it=intent());self.assertRaises(LedgerConflict,lambda:cas_lease(d,"k",expected_revision=0,expected_lease_version=1,new_record=lease(version=2)));self.assertRaises(LedgerConflict,lambda:cas_lease(d,"k",expected_revision=0,expected_lease_version=1,new_record=lease(version=2,it=intent(op="different"))))
 def test_pending_resolve_then_release(self):
  d=doc();d["leases"]["k"]=lease(it=intent());done=intent();done["state"]="DONE";r=lease(version=2,it=done);o=cas_lease(d,"k",expected_revision=0,expected_lease_version=1,new_record=r);t={**r,"version":3,"state":"RELEASED","expires_at":2.0};self.assertEqual(cas_lease(o,"k",expected_revision=1,expected_lease_version=2,new_record=t)["leases"]["k"]["state"],"RELEASED")
 def test_blob_and_revision_cas(self):self.assertTrue(blob_cas_ok("a","a"));self.assertFalse(blob_cas_ok("a","b"))
if __name__=="__main__":unittest.main()
