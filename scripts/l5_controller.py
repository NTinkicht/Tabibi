#!/usr/bin/env python3
"""Executable Claude-exact L5 BOOT-to-ACTION controller."""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Any,Mapping,Protocol,Sequence
from l5_kernel import Budget,HUMAN_CLEAR_ONLY,ItemState,Lease,MemoryCASStore,Observation,RepoMode,acquire,attach_intent,capacity_slot_key,classify_item,fence_ok,governance_mode,intent_recovery,lease_key,merge_ok,new_run_id,repo_merge_lock_key,resolve_intent
class RunPhase(str,Enum):BOOT="BOOT";HALT_CHECK="HALT_CHECK";GOVERNANCE_AUDIT="GOVERNANCE_AUDIT";REPOSITORY_MODE="REPOSITORY_MODE";INTENT_RECOVERY="INTENT_RECOVERY";INVENTORY="INVENTORY";CLASSIFY="CLASSIFY";SELECT="SELECT";ACQUIRE_CAS_LEASE="ACQUIRE_CAS_LEASE";RECONCILE_ITEM="RECONCILE_ITEM";WRITE_INTENT="WRITE_INTENT";FENCE_CHECK="FENCE_CHECK";ACTION="ACTION";EXIT="EXIT"
@dataclass(frozen=True)
class RunResult:run_id:str;phase:RunPhase;status:str;action:str|None=None;item_id:str|None=None;reason:str|None=None;mutation_result:Mapping[str,Any]|None=None
class ControllerIO(Protocol):
 def repo_snapshot(self)->Mapping[str,Any]:...
 def pending_intent_leases(self)->Sequence[Lease]:...
 def detect_intent_effect(self,lease:Lease)->str:...
 def inventory(self)->Sequence[Mapping[str,Any]]:...
 def budget_for(self,item:Mapping[str,Any])->Budget:...
 def observe_item(self,item:Mapping[str,Any])->Observation:...
 def execute_guarded(self,operation:str,item:Mapping[str,Any],lease:Lease)->Mapping[str,Any]:...
def _item_id(i):
 v=i.get("item_id")
 if not isinstance(v,(str,int)) or str(v)=="":raise ValueError("L5_ITEM_ID_INVALID")
 return str(v)
def _priority(s):return {ItemState.MERGED_UNVERIFIED:0,ItemState.MAIN_BROKEN:1,ItemState.CI_RED_DETERMINISTIC:2,ItemState.FINDINGS_OPEN:3,ItemState.CI_RED_INFRA:4,ItemState.BEHIND_BASE:5,ItemState.CI_GREEN_UNREVIEWED:6,ItemState.MERGE_ELIGIBLE:7,ItemState.IMPLEMENT:8,ItemState.IDLE:9}.get(s,100)
def _op(s,i):
 return {ItemState.CI_RED_INFRA:"retry_ci",ItemState.CI_RED_DETERMINISTIC:"remediate_review",ItemState.CI_GREEN_UNREVIEWED:"dispatch_review",ItemState.FINDINGS_OPEN:"remediate_review",ItemState.BEHIND_BASE:"update_branch",ItemState.MERGE_ELIGIBLE:"merge_expected_head",ItemState.MAIN_BROKEN:"revert"}.get(s) or ("reserve_next_wu" if s==ItemState.IDLE and i.get("replenish_candidate") is True else None)
def _lkey(repo,item_id,op,item):
 if op in {"merge_expected_head","revert"}:return repo_merge_lock_key(repo)
 if op=="reserve_next_wu":
  slot=item.get("capacity_slot")
  if type(slot) is not int:raise ValueError("L5_CAPACITY_SLOT_UNKNOWN")
  return capacity_slot_key(repo,slot)
 return lease_key(repo,"item",item_id,op.upper())
def _intent_op(op):
 m={"retry_ci":"ci_rerun","dispatch_review":"review_request","remediate_review":"push","update_branch":"update_branch","merge_expected_head":"merge","reserve_next_wu":"reserve_next_wu","revert":"revert"}
 if op not in m:raise ValueError("L5_OPERATION_NOT_ALLOWLISTED")
 return m[op]
def _sync(store,repo,derived):
 cur,ver=store.read_repo_mode(repo)
 if cur==derived:return True,"UNCHANGED"
 if cur in HUMAN_CLEAR_ONLY:return False,"HUMAN_CLEAR_REQUIRED"
 return (True,"UPDATED") if store.cas_repo_mode(repo,ver,derived) else (False,"MODE_CAS_CONFLICT")
def _recover(io,store):
 for l in io.pending_intent_leases():
  if store.read(l.key)!=l:return False,"RECOVERY_LEASE_STALE"
  d=intent_recovery(l,io.detect_intent_effect(l))
  if d=="READBACK_REQUIRED":return False,"RECOVERY_READBACK_REQUIRED"
  if d=="RESOLVE_DONE" and resolve_intent(store,l,"DONE") is None:return False,"RECOVERY_CAS_CONFLICT"
  if d=="RESOLVE_ABORTED" and resolve_intent(store,l,"ABORTED") is None:return False,"RECOVERY_CAS_CONFLICT"
 return True,"RECOVERED"
def _select(io,items):
 rows=[]
 for i in items:
  s=classify_item(i,io.budget_for(i));op=_op(s,i)
  if op is not None:rows.append((_priority(s),_item_id(i),i,s))
 if not rows:return None
 rows.sort(key=lambda x:(x[0],x[1]));return rows[0][2],rows[0][3]
def run_once(repo_id,io,store,*,now_srv,run_id=None):
 rid=run_id or new_run_id();repo=io.repo_snapshot()
 if repo.get("halted") is True:return RunResult(rid,RunPhase.HALT_CHECK,"BLOCKED",reason="HALTED")
 mode=governance_mode(repo);ok,reason=_sync(store,repo_id,mode)
 if not ok:return RunResult(rid,RunPhase.REPOSITORY_MODE,"BLOCKED",reason=reason)
 if mode in HUMAN_CLEAR_ONLY:return RunResult(rid,RunPhase.REPOSITORY_MODE,"BLOCKED",reason=mode.value)
 if mode not in {RepoMode.NORMAL,RepoMode.MAIN_BROKEN}:return RunResult(rid,RunPhase.REPOSITORY_MODE,"WAIT",reason=mode.value)
 ok,reason=_recover(io,store)
 if not ok:return RunResult(rid,RunPhase.INTENT_RECOVERY,"WAIT",reason=reason)
 sel=_select(io,io.inventory())
 if sel is None:return RunResult(rid,RunPhase.SELECT,"IDLE",reason="NO_ACTIONABLE_ITEM")
 item,state=sel;iid=_item_id(item);op=_op(state,item)
 if op=="merge_expected_head" and not merge_ok(item)[0]:return RunResult(rid,RunPhase.RECONCILE_ITEM,"BLOCKED",action=op,item_id=iid,reason="MERGE_OK_FALSE")
 observed=io.observe_item(item);lease=acquire(store,_lkey(repo_id,iid,op,item),rid,observed,now_srv=now_srv)
 if lease is None:return RunResult(rid,RunPhase.ACQUIRE_CAS_LEASE,"WAIT",action=op,item_id=iid,reason="LEASE_BUSY")
 if io.observe_item(item)!=observed:return RunResult(rid,RunPhase.RECONCILE_ITEM,"WAIT",action=op,item_id=iid,reason="OBSERVATION_CHANGED")
 li=attach_intent(store,lease,repo_id,iid,_intent_op(op),now_srv=now_srv)
 if li is None:return RunResult(rid,RunPhase.WRITE_INTENT,"WAIT",action=op,item_id=iid,reason="INTENT_CAS_FAILED")
 f,why=fence_ok(store,repo_id,li,io.observe_item(item),now_srv=now_srv)
 if not f:return RunResult(rid,RunPhase.FENCE_CHECK,"BLOCKED",action=op,item_id=iid,reason=why)
 result=io.execute_guarded(op,item,li);status=result.get("status") if isinstance(result,Mapping) else None
 if status in {"COMPLETE","REPLAY_NOOP"}:
  if resolve_intent(store,li,"DONE") is None:return RunResult(rid,RunPhase.ACTION,"WAIT",action=op,item_id=iid,reason="RESULT_COMMIT_CAS_FAILED",mutation_result=result)
  return RunResult(rid,RunPhase.EXIT,"COMPLETE",action=op,item_id=iid,mutation_result=result)
 if status in {"FAILED","BLOCKED"}:
  if resolve_intent(store,li,"ABORTED") is None:return RunResult(rid,RunPhase.ACTION,"WAIT",action=op,item_id=iid,reason="ABORT_COMMIT_CAS_FAILED",mutation_result=result)
  return RunResult(rid,RunPhase.EXIT,status,action=op,item_id=iid,mutation_result=result)
 return RunResult(rid,RunPhase.ACTION,"WAIT",action=op,item_id=iid,reason="OUTCOME_UNKNOWN",mutation_result=result)
class GuardedWriteBridge:
 """Bridge to the existing certified write adapter."""
 def __init__(self,client,token_store):self.client=client;self.token_store=token_store
 def execute(self,operation,item,lease):
  from l5_activation import authorize_mutation
  from l5_write_adapter import execute_mutation
  snap=item.get("activation_snapshot")
  if not isinstance(snap,dict):return {"status":"BLOCKED","reason":"ACTIVATION_SNAPSHOT_MISSING"}
  auth=authorize_mutation(snap);expected={"retry_ci":"retry_ci","dispatch_review":"dispatch_review","remediate_review":"remediate_review","merge_expected_head":"merge_expected_head","reserve_next_wu":"reserve_next_wu"}.get(operation)
  if expected is None or auth.get("mutation")!=expected:return {"status":"BLOCKED","reason":"ACTION_AUTHORIZATION_MISMATCH"}
  if lease.intent is None or auth.get("expected_head_sha")!=lease.intent.expected_head or auth.get("expected_base_sha")!=lease.intent.expected_base:return {"status":"BLOCKED","reason":"LEASE_REF_MISMATCH"}
  return execute_mutation(auth,snap,self.client,self.token_store)
