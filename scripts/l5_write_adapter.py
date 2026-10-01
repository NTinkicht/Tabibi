#!/usr/bin/env python3
"""Guarded L5 write adapter with atomic remote CAS and replay safety."""
from __future__ import annotations
import fcntl, json, os, sys
from pathlib import Path
from typing import Any
sys.path.insert(0, str(Path(__file__).resolve().parent))
from l5_control_plane import mutation_policy
from l5_recovery import HARD_BOUNDARY_FIELDS, KNOWN_RETRY_SCOPES, MAX_RETRIES, SAFE_MUTATIONS, SHA40, TOKEN64, _required_bool, authorize_mutation

RETRYABLE=frozenset({"retry_ci","dispatch_review","remediate_review"})
MUTATIONS=frozenset(SAFE_MUTATIONS.values())
REVIEW_SENSITIVE=frozenset({"dispatch_review","merge_expected_head"})
_UNSET=object()
class LostResponse(Exception): pass
class AlreadyExists(Exception): pass
class WriteRejected(Exception): pass

def stream_key(auth,snapshot): return json.dumps([snapshot.get("repository"),auth["issue"],auth["canonical_pr"]],separators=(",",":"))
def _result(status,reason,token=None): return {"status":status,"reason":reason,"mutation_token":token,"written":False}
def _validate_authorization(auth,snapshot):
    if not isinstance(auth,dict) or auth.get("authorized") is not True or auth.get("mutation_allowed") is not True:return "NOT_AUTHORIZED"
    if auth.get("mutation") not in MUTATIONS:return "MUTATION_NOT_WHITELISTED"
    token=auth.get("mutation_token")
    if not isinstance(token,str) or not TOKEN64.fullmatch(token):return "TOKEN_INVALID"
    for key in ("expected_head_sha","expected_base_sha"):
        if not isinstance(auth.get(key),str) or not SHA40.fullmatch(auth[key]):return "EXPECTED_REFS_INVALID"
    if type(auth.get("canonical_pr")) is not int or auth["canonical_pr"]<1 or type(auth.get("issue")) is not int:return "CANONICAL_PR_INVALID"
    try:fresh=authorize_mutation(snapshot)
    except ValueError:return "AUTHORIZATION_NOT_REPRODUCIBLE"
    if fresh.get("authorized") is not True or fresh!=auth:return "AUTHORIZATION_MISMATCH"
    if auth["mutation"] in RETRYABLE:
        count,scope=auth.get("retry_count_after"),auth.get("retry_action_after")
        if type(count) is not int or count<1 or scope not in KNOWN_RETRY_SCOPES:return "RETRY_STATE_INVALID"
        if count>MAX_RETRIES:return "RETRY_BUDGET_EXHAUSTED"
    elif auth["mutation"]=="reserve_next_wu" and (type(auth.get("selected_issue")) is not int or auth["selected_issue"]<1):return "SELECTED_ISSUE_INVALID"
    return None

def _live_gate(auth,client,*,retry=None):
    boundaries=client.fetch_boundaries()
    if not isinstance(boundaries,dict):return "BOUNDARY_STATE_UNKNOWN"
    try:
        if any(_required_bool(boundaries,k) for k in HARD_BOUNDARY_FIELDS):return "HARD_BOUNDARY"
    except ValueError:return "BOUNDARY_STATE_UNKNOWN"
    live=client.fetch_live(auth["canonical_pr"])
    if not isinstance(live,dict):return "LIVE_STATE_UNKNOWN"
    if live.get("head_sha")!=auth["expected_head_sha"] or live.get("base_sha")!=auth["expected_base_sha"]:return "STALE_HEAD_OR_BASE"
    mutation=auth["mutation"]; expected_state="merged" if mutation=="reserve_next_wu" else "open"
    if live.get("pr_state")!=expected_state:return "PR_STATE_MISMATCH"
    streams=live.get("open_streams")
    if not isinstance(streams,dict):return "LIVE_STATE_UNKNOWN"
    if mutation=="reserve_next_wu":
        if any(streams.values()) or streams.get(auth["selected_issue"]):return "DUPLICATE_STREAM"
    elif streams.get(auth["issue"])!=[auth["canonical_pr"]] or sum(len(v) for v in streams.values())!=1:return "DUPLICATE_STREAM"
    if mutation in REVIEW_SENSITIVE and live.get("review_eligible_nonauthor") is not True:return "REVIEWER_NOT_ELIGIBLE"
    if retry is not None and mutation in RETRYABLE:
        count,scope=retry; wanted=auth["retry_action_after"]
        if (count if scope==wanted else 0)+1!=auth["retry_count_after"]:return "RETRY_STATE_STALE"
    return None

def _params(auth):
    p={k:auth.get(k) for k in ("canonical_pr","issue","expected_head_sha","expected_base_sha","selected_issue")};p["idempotency_key"]=auth["mutation_token"];return p

def _reconcile(auth,client,store,written):
    token=auth["mutation_token"]
    if client.verify_effect(auth["mutation"],_params(auth)) is True:
        store.set_status(token,"COMPLETE");return {**_result("COMPLETE","EFFECT_VERIFIED",token),"written":written}
    return {**_result("IN_PROGRESS","EFFECT_NOT_YET_VERIFIED",token),"written":written}

def execute_mutation(auth,snapshot,client,store):
    control_allowed,control_reason=mutation_policy()
    if not control_allowed:return _result("BLOCKED",control_reason,auth.get("mutation_token") if isinstance(auth,dict) else None)
    reason=_validate_authorization(auth,snapshot)
    if reason:return _result("BLOCKED",reason,auth.get("mutation_token") if isinstance(auth,dict) else None)
    token=auth["mutation_token"];stream=stream_key(auth,snapshot);prior=store.get(token)
    if prior is not None:
        status=prior.get("status")
        if status=="COMPLETE":return _result("REPLAY_NOOP","ALREADY_COMPLETE",token)
        if status=="PENDING":return _reconcile(auth,client,store,False)
        if status!="RETRYABLE":return _result("BLOCKED",f"PRIOR_{status}",token)
    observed_retry=store.retry_state(stream) if auth["mutation"] in RETRYABLE else None
    observed_owner=store.retry_owner(stream) if auth["mutation"] in RETRYABLE else _UNSET
    block=_live_gate(auth,client,retry=observed_retry)
    if block:return _result("BLOCKED",block,token)
    perform_cas=getattr(client,"perform_cas",None)
    if not callable(perform_cas):return _result("BLOCKED","ATOMIC_CAS_UNAVAILABLE",token)
    record={"mutation":auth["mutation"],"canonical_pr":auth["canonical_pr"],"status":"PENDING","expected_head_sha":auth["expected_head_sha"],"expected_base_sha":auth["expected_base_sha"]}
    if not store.begin(token,record,stream,auth.get("retry_count_after"),auth.get("retry_action_after"),expected_retry=observed_retry,expected_owner=observed_owner):
        existing=store.get(token)
        if existing is not None and existing.get("status")=="PENDING":return _result("REPLAY_NOOP","TOKEN_ALREADY_PERSISTED",token)
        return _result("BLOCKED","RETRY_STATE_STALE",token)
    try:block=_live_gate(auth,client)
    except Exception as exc:
        store.fail_and_restore(token,f"{type(exc).__name__}: {exc}",stream,observed_retry);return _result("FAILED","UNEXPECTED_ERROR",token)
    if block:
        store.fail_and_restore(token,block,stream,observed_retry);return _result("BLOCKED",block,token)
    try:
        result=perform_cas(auth["mutation"],_params(auth))
        if result is False:raise WriteRejected("ATOMIC_CAS_REJECTED")
        if result is not True:return _reconcile(auth,client,store,False)
    except WriteRejected as exc:
        store.fail_and_restore(token,str(exc),stream,observed_retry);return _result("FAILED","WRITE_REJECTED",token)
    except Exception:return _reconcile(auth,client,store,False)
    return _reconcile(auth,client,store,True)

class MemoryStore:
    def __init__(self):self.records={};self.retry={};self.retry_owners={}
    def get(self,token):return dict(self.records[token]) if token in self.records else None
    def begin(self,token,record,stream,count,action,*,expected_retry=None,expected_owner=_UNSET):
        existing=self.records.get(token)
        if existing is not None and existing.get("status")!="RETRYABLE":return False
        if expected_retry is not None and self.retry.get(stream,(0,None))!=expected_retry:return False
        if expected_owner is not _UNSET and self.retry_owners.get(stream)!=expected_owner:return False
        row=dict(record)
        if expected_retry is not None:row["retry_before"]=list(expected_retry)
        if count is not None:row["retry_written"]=[count,action]
        self.records[token]=row
        if count is not None:self.retry[stream]=(count,action);self.retry_owners[stream]=token
        return True
    def fail_and_restore(self,token,detail,stream,prior_retry):
        row=self.records[token];row["detail"]=detail;row["status"]="RETRYABLE"
        if prior_retry is None:return
        written=row.get("retry_written")
        if not isinstance(written,list) or len(written)!=2:return
        if self.retry.get(stream,(0,None))!=(written[0],written[1]) or self.retry_owners.get(stream)!=token:return
        if prior_retry==(0,None):self.retry.pop(stream,None)
        else:self.retry[stream]=prior_retry
        # Keep retry_owners[stream]=token as a monotonic ownership/version tag.
    def set_status(self,token,status,detail=None):self.records[token]["status"]=status;self.records[token]["detail"]=detail
    def retry_state(self,stream):return self.retry.get(stream,(0,None))
    def retry_owner(self,stream):return self.retry_owners.get(stream)

class JsonFileStore(MemoryStore):
    def __init__(self,path):super().__init__();self.path=Path(path)
    def _locked(self,fn):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with open(str(self.path)+".lock","w",encoding="utf-8") as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            if self.path.exists():
                data=json.loads(self.path.read_text(encoding="utf-8"));self.records=data["records"];self.retry={k:(v[0],v[1]) for k,v in data["retry"].items()};self.retry_owners=dict(data.get("retry_owners",{}))
            else:self.records,self.retry,self.retry_owners={},{},{}
            out=fn();tmp=self.path.with_suffix(".tmp");payload=json.dumps({"records":self.records,"retry":{k:list(v) for k,v in self.retry.items()},"retry_owners":self.retry_owners},sort_keys=True)
            with open(tmp,"w",encoding="utf-8") as fh:fh.write(payload);fh.flush();os.fsync(fh.fileno())
            os.replace(tmp,self.path);fd=os.open(self.path.parent,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
            return out
    def get(self,token):return self._locked(lambda:MemoryStore.get(self,token))
    def begin(self,token,record,stream,count,action,*,expected_retry=None,expected_owner=_UNSET):return self._locked(lambda:MemoryStore.begin(self,token,record,stream,count,action,expected_retry=expected_retry,expected_owner=expected_owner))
    def fail_and_restore(self,token,detail,stream,prior_retry):self._locked(lambda:MemoryStore.fail_and_restore(self,token,detail,stream,prior_retry))
    def set_status(self,token,status,detail=None):self._locked(lambda:MemoryStore.set_status(self,token,status,detail))
    def retry_state(self,stream):return self._locked(lambda:MemoryStore.retry_state(self,stream))
    def retry_owner(self,stream):return self._locked(lambda:MemoryStore.retry_owner(self,stream))

def selftest():
    from l5_recovery import selftest as recovery_selftest
    recovery_selftest();assert MUTATIONS==frozenset(SAFE_MUTATIONS.values());print("l5_write_adapter selftest PASS")
if __name__=="__main__":
    if "--selftest" in sys.argv:selftest()
    else:raise SystemExit("l5_write_adapter is a library; it has no CLI write path (use --selftest)")
