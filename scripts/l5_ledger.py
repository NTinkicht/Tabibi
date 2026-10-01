#!/usr/bin/env python3
"""Durable GitHub-backed ledger contract for Claude-exact L5 controllers."""
from __future__ import annotations
import copy,json
from typing import Any,Mapping
from l5_kernel import HUMAN_CLEAR_ONLY,RepoMode,SHA40
SCHEMA_VERSION=2;LEDGER_PATH=".l5/controller-ledger.json";LEDGER_BRANCH="l5/controller-ledger"
class LedgerConflict(RuntimeError):pass
class LedgerInvalid(ValueError):pass
def _sha(v):return isinstance(v,str) and bool(SHA40.fullmatch(v))
def _obs(r):
 if not isinstance(r,Mapping) or not _sha(r.get("head")) or not _sha(r.get("base")):raise LedgerInvalid("LEASE_OBSERVATION")
def _intent(r,epoch):
 if r is None:return
 if not isinstance(r,Mapping) or r.get("state") not in {"PENDING","DONE","ABORTED"} or r.get("epoch")!=epoch or not _sha(r.get("expected_head")) or not _sha(r.get("expected_base")):raise LedgerInvalid("LEASE_INTENT")
 for k in ("op_id","idem_key","operation"):
  if not isinstance(r.get(k),str) or not r[k]:raise LedgerInvalid("LEASE_INTENT_"+k.upper())
def validate_lease_record(r):
 if not isinstance(r,Mapping):raise LedgerInvalid("LEASE_RECORD")
 if type(r.get("version")) is not int or r["version"]<1:raise LedgerInvalid("LEASE_RECORD_VERSION")
 if type(r.get("epoch")) is not int or r["epoch"]<1:raise LedgerInvalid("LEASE_RECORD_EPOCH")
 if not isinstance(r.get("holder"),str) or not r["holder"]:raise LedgerInvalid("LEASE_RECORD_HOLDER")
 if r.get("state") not in {"ACTIVE","RELEASED"}:raise LedgerInvalid("LEASE_RECORD_STATE")
 if not isinstance(r.get("acquired_at"),(int,float)) or not isinstance(r.get("expires_at"),(int,float)):raise LedgerInvalid("LEASE_RECORD_TIME")
 _obs(r.get("observed"));_intent(r.get("intent"),r["epoch"])
 if r["state"]=="RELEASED" and isinstance(r.get("intent"),Mapping) and r["intent"].get("state")=="PENDING":raise LedgerInvalid("LEASE_RELEASED_WITH_PENDING_INTENT")
def validate_budget_record(r):
 if not isinstance(r,Mapping) or type(r.get("version")) is not int or r["version"]<1:raise LedgerInvalid("BUDGET_RECORD")
 for k in ("ci_reruns","fix_iterations","review_rounds","lease_acquisitions"):
  if type(r.get(k)) is not int or r[k]<0:raise LedgerInvalid("BUDGET_"+k.upper())
def validate_ledger(d:Mapping[str,Any],*,expected_repo=None):
 if not isinstance(d,Mapping) or d.get("schema_version")!=SCHEMA_VERSION:raise LedgerInvalid("LEDGER_SCHEMA")
 if not isinstance(d.get("repository"),str) or not d["repository"]:raise LedgerInvalid("LEDGER_REPOSITORY")
 if expected_repo is not None and d["repository"]!=expected_repo:raise LedgerInvalid("LEDGER_REPOSITORY_MISMATCH")
 if type(d.get("revision")) is not int or d["revision"]<0:raise LedgerInvalid("LEDGER_REVISION")
 try:m=RepoMode(d.get("mode"))
 except Exception as e:raise LedgerInvalid("LEDGER_MODE") from e
 if type(d.get("mode_version")) is not int or d["mode_version"]<1:raise LedgerInvalid("LEDGER_MODE_VERSION")
 if type(d.get("human_clear_required")) is not bool:raise LedgerInvalid("LEDGER_HUMAN_CLEAR")
 if m in HUMAN_CLEAR_ONLY and d["human_clear_required"] is not True:raise LedgerInvalid("LEDGER_HUMAN_CLEAR_REQUIRED")
 for k in ("leases","budgets","observations"):
  if not isinstance(d.get(k),Mapping):raise LedgerInvalid("LEDGER_"+k.upper())
 for r in d["leases"].values():validate_lease_record(r)
 for r in d["budgets"].values():validate_budget_record(r)
 pe=d.get("platform_enforcement")
 if not isinstance(pe,Mapping) or type(pe.get("branch_protected")) is not bool or type(pe.get("active_rulesets")) is not int or pe["active_rulesets"]<0:raise LedgerInvalid("LEDGER_PLATFORM_ENFORCEMENT")
def canonical_json(d):validate_ledger(d);return json.dumps(d,sort_keys=True,indent=2,separators=(",",": "))+"\n"
def blob_cas_ok(observed,expected):return isinstance(observed,str) and bool(observed) and observed==expected
def _begin(d,rev):
 validate_ledger(d)
 if d["revision"]!=rev:raise LedgerConflict("LEDGER_REVISION_STALE")
 o=copy.deepcopy(dict(d));o["revision"]+=1;return o
def cas_mode(d,*,expected_revision,expected_mode_version,new_mode,human_clear=False):
 o=_begin(d,expected_revision)
 if o["mode_version"]!=expected_mode_version:raise LedgerConflict("MODE_VERSION_STALE")
 old=RepoMode(o["mode"])
 if old in HUMAN_CLEAR_ONLY and old!=new_mode and not human_clear:raise LedgerConflict("HUMAN_CLEAR_REQUIRED")
 o["mode"]=new_mode.value;o["mode_version"]+=1;o["human_clear_required"]=new_mode in HUMAN_CLEAR_ONLY;validate_ledger(o);return o
def _lease_transition(cur,row):
 validate_lease_record(row)
 if cur is None:
  if row["version"]!=1:raise LedgerInvalid("LEASE_INITIAL_VERSION")
  return
 validate_lease_record(cur)
 if row["version"]<=cur["version"]:raise LedgerInvalid("LEASE_VERSION_NOT_MONOTONIC")
 same=row["holder"]==cur["holder"] and row["epoch"]==cur["epoch"];advance=row["epoch"]>cur["epoch"]
 if not (same or advance):raise LedgerInvalid("LEASE_EPOCH_NOT_MONOTONIC")
 ci=cur.get("intent");ni=row.get("intent")
 if isinstance(ci,Mapping) and ci.get("state")=="PENDING":
  if not isinstance(ni,Mapping):raise LedgerConflict("PENDING_INTENT_LOST")
  if ni.get("op_id")!=ci.get("op_id"):raise LedgerConflict("PENDING_INTENT_REPLACED")
  if row["epoch"]!=cur["epoch"] or row["holder"]!=cur["holder"]:raise LedgerConflict("PENDING_INTENT_REASSIGNED")
  if ni.get("state") not in {"PENDING","DONE","ABORTED"}:raise LedgerInvalid("PENDING_INTENT_TRANSITION")
def cas_lease(d,key,*,expected_revision,expected_lease_version,new_record):
 if not isinstance(key,str) or not key:raise LedgerInvalid("LEASE_KEY")
 if new_record is None:raise LedgerInvalid("LEASE_DELETE_FORBIDDEN")
 o=_begin(d,expected_revision);cur=o["leases"].get(key);actual=None if cur is None else cur.get("version")
 if actual!=expected_lease_version:raise LedgerConflict("LEASE_VERSION_STALE")
 row=copy.deepcopy(dict(new_record));_lease_transition(cur,row);o["leases"][key]=row;validate_ledger(o);return o
def cas_budget(d,key,*,expected_revision,expected_budget_version,new_record):
 o=_begin(d,expected_revision);cur=o["budgets"].get(key);actual=None if cur is None else cur.get("version")
 if actual!=expected_budget_version:raise LedgerConflict("BUDGET_VERSION_STALE")
 row=copy.deepcopy(dict(new_record));validate_budget_record(row)
 if expected_budget_version is None and row["version"]!=1:raise LedgerInvalid("BUDGET_INITIAL_VERSION")
 if expected_budget_version is not None and row["version"]<=expected_budget_version:raise LedgerInvalid("BUDGET_VERSION_NOT_MONOTONIC")
 o["budgets"][key]=row;validate_ledger(o);return o
