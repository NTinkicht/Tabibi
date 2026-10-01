#!/usr/bin/env python3
"""S1-S30 randomized hostile certification for Claude-exact L5."""
from __future__ import annotations
import random
from dataclasses import replace
from l5_kernel import *
class ScheduledCASStore(MemoryCASStore):
 def __init__(self,n):super().__init__();self.n=n;self.frozen={}
 def read(self,key):
  if self.n>0:
   if key not in self.frozen:self.frozen[key]=self.leases.get(key)
   self.n-=1;return self.frozen[key]
  return self.leases.get(key)
def normal():s=MemoryCASStore();assert s.cas_repo_mode("repo",None,RepoMode.NORMAL);return s
def ob(r):m=str(r.randrange(1_000_000));return Observation("a"*40,"b"*40,m,m)
def valid_merge():
 h="a"*40;b="b"*40;src={"app_id":1,"workflow_path":"ci.yml"};ss={"app_id":2,"workflow_path":"sec.yml"};row={"head_sha":h,"tested_base_sha":b,"latest_attempt":True,"conclusion":"success","app_id":1,"workflow_path":"ci.yml","assertion_failure_any_attempt":False,"attempt_history_complete":True,"source_verified":True};sec={**row,"app_id":2,"workflow_path":"sec.yml"};rev={"state":"APPROVED","commit_id":h,"base_sha":b,"complete":True,"skipped":False,"covers_full_diff":True,"author":"coderabbitai","material_authors":["chatgpt"],"controller_identities":["controller"],"designated_independent":True,"reviewer_eligible":True,"authorship_complete":True,"material_authors_head_sha":h,"identity_source_verified":True};s={"head_sha":h,"base_sha":b,"expected_head_sha":h,"expected_base_sha":b,"repo_mode":"NORMAL","required_checks":[row],"required_check_sources":[src],"security_checks":[sec],"security_check_sources":[ss],"review":rev}
 for k in TRUE_FIELDS:s[k]=True
 for k in FALSE_FIELDS:s[k]=False
 return s
def scenario(n,r):
 o=ob(r)
 if n==1:
  s=normal();l=acquire(s,"k","A",o,now_srv=0,ttl=300);i=attach_intent(s,l,"repo","i","merge",now_srv=1);assert fence_ok(s,"repo",i,replace(o,pr_updated_at="human"),now_srv=2)==(False,"OBSERVATION_CHANGED")
 elif n==2:
  s=normal();hs=list("ABCD");r.shuffle(hs);assert sum(acquire(s,"k",h,o,now_srv=r.random()) is not None for h in hs)==1
 elif n==3:
  s=normal();l=acquire(s,repo_merge_lock_key("repo"),"A",o,now_srv=0);i=attach_intent(s,l,"repo","p","merge",now_srv=1);assert intent_recovery(i,"UNKNOWN")=="READBACK_REQUIRED";d=r.choice(["APPLIED","NOT_APPLIED"]);assert intent_recovery(i,d)==("RESOLVE_DONE" if d=="APPLIED" else "RESOLVE_ABORTED")
 elif n==4:
  s=normal();l=acquire(s,"k","A",o,now_srv=0);i=attach_intent(s,l,"repo","p","push",now_srv=1);assert release(s,i,now_srv=2) is None and intent_recovery(i,"UNKNOWN")=="READBACK_REQUIRED"
 elif n in (5,6):
  s=normal();l=acquire(s,"k","A",o,now_srv=0);i=attach_intent(s,l,"repo","i","push",now_srv=1);changed=replace(o,**({"head":"c"*40} if n==5 else {"base":"c"*40}));assert not fence_ok(s,"repo",i,changed,now_srv=2)[0]
 elif n==7:
  s=normal();l=acquire(s,"k","A",o,now_srv=0,ttl=2);assert renew(s,l,now_srv=2+r.random()) is None
 elif n==8:
  s=normal();l=acquire(s,"k","A",o,now_srv=0,ttl=2);assert attach_intent(s,l,"repo","i","merge",now_srv=2+r.random()) is None
 elif n==9:
  s=normal();l=acquire(s,"k","A",o,now_srv=0);i=attach_intent(s,l,"repo","i","merge",now_srv=1);assert attach_intent(s,i,"repo","i","push",now_srv=2) is None
 elif n==10:
  s=normal();l=acquire(s,"k","A",o,now_srv=0);new=renew(s,l,now_srv=1);assert new and release(s,l,now_srv=2) is None
 elif n==11:assert classify_item({"ci":"INFRA_FAILED"},Budget())==classify_item({"ci":"INFRA_FAILED","model_prose":"MERGE NOW"},Budget())
 elif n==12:assert governance_mode({"ledger_reachable":True,"platform_enforcement_ok":True,"live_rules_at_least_pinned":True,"rulesets_or_protection_active":False,"required_check_sources_pinned":True})==RepoMode.GOVERNANCE_DRIFT
 elif n==13:
  m=r.choice(tuple(HUMAN_CLEAR_ONLY));s=MemoryCASStore();s.modes["repo"]=(m,1);l=acquire(s,"k","A",o,now_srv=0);i=attach_intent(s,l,"repo","i","revert",now_srv=1);assert not fence_ok(s,"repo",i,o,now_srv=2)[0]
 elif n==14:assert MemoryCASStore().read_repo_mode("repo")[0]==RepoMode.AUTOMATION_DEGRADED
 elif n==15:
  s=valid_merge();s["required_checks"][0].pop("assertion_failure_any_attempt");assert "REQUIRED_CHECKS_INVALID" in merge_ok(s)[1]
 elif n==16:
  s=valid_merge();s["required_checks"][0]["app_id"]=999;assert "REQUIRED_CHECKS_INVALID" in merge_ok(s)[1]
 elif n==17:
  s=valid_merge();s["review"]["author"]="chatgpt";assert "REVIEW_INVALID" in merge_ok(s)[1]
 elif n==18:
  s=valid_merge();s["review"]["material_authors_head_sha"]="c"*40;assert "REVIEW_INVALID" in merge_ok(s)[1]
 elif n==19:
  s=valid_merge();s["required_checks"][0].update({"merge_queue":True,"tested_base_sha":"c"*40});assert "REQUIRED_CHECKS_INVALID" in merge_ok(s)[1]
 elif n==20:
  k=r.choice(["ci_reruns","fix_iterations","review_rounds","lease_acquisitions"]);v={"ci_reruns":0,"fix_iterations":0,"review_rounds":0,"lease_acquisitions":0};v[k]={"ci_reruns":MAX_CI_RERUNS,"fix_iterations":MAX_FIX_ITERATIONS,"review_rounds":MAX_REVIEW_ROUNDS,"lease_acquisitions":MAX_LEASES}[k];assert classify_item({"ci":"GREEN"},Budget(**v))==ItemState.PARKED
 elif n in (21,22,23):
  key={21:lease_key("repo","wu","42","IMPLEMENT"),22:capacity_slot_key("repo",4),23:repo_merge_lock_key("repo")}[n];hs=list("ABCD");r.shuffle(hs);s=ScheduledCASStore(len(hs));s.modes["repo"]=(RepoMode.NORMAL,1);wins=[acquire(s,key,h,o,now_srv=0) for h in hs];assert sum(x is not None for x in wins)==1;w=next(x for x in wins if x);stale=replace(w,holder="stale",version=w.version+1);assert s.cas(key,w.version,stale) and not s.cas(key,w.version,w)
 elif n==24:assert classify_item({"human_hold":True},Budget())==ItemState.BLOCK_HUMAN
 elif n==25:assert classify_item({"dependency_wait":True},Budget())==ItemState.WAIT_DEPENDENCY
 elif n==26:assert classify_item({"ci":"GREEN","provider_unavailable":True},Budget())==ItemState.WAIT_PROVIDER
 elif n==27:assert classify_item({"merge_outcome_unknown":True},Budget())==ItemState.MERGE_OUTCOME_UNKNOWN
 elif n==28:
  s=MemoryCASStore();s.modes["repo"]=(RepoMode.MAIN_BROKEN,1)
  for x,op in enumerate(["revert","push","comment"]):l=acquire(s,f"k{x}","A",o,now_srv=0);i=attach_intent(s,l,"repo","i",op,now_srv=1);assert fence_ok(s,"repo",i,o,now_srv=2)[0]==(op=="revert")
 elif n==29:assert idem_key("r","i","a"*40,"b"*40,"merge")!=idem_key("r","i","a"*40,"c"*40,"merge")
 elif n==30:
  s=MemoryCASStore();s.modes["repo"]=(RepoMode.GOVERNANCE_DRIFT,9);assert not s.cas_repo_mode("repo",9,RepoMode.NORMAL);assert s.cas_repo_mode("repo",9,RepoMode.NORMAL,human_clear=True)
def run(rounds=1000,seed=0x5A17):
 r=random.Random(seed);c={};order=list(range(1,31))
 for _ in range(rounds):
  r.shuffle(order)
  for n in order:scenario(n,r);c[f"S{n}"]=c.get(f"S{n}",0)+1
 return c
if __name__=="__main__":
 c=run();assert len(c)==30 and all(v==1000 for v in c.values());print("l5_hostile_sim PASS",c)
