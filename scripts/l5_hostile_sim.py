#!/usr/bin/env python3
import random,sys
from dataclasses import replace
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from l5_kernel import *

def run(rounds=1000,seed=0x5A17):
 r=random.Random(seed);counts={k:0 for k in ("S1","S2","S3","S4","S21","S22")}
 for _ in range(rounds):
  st=MemoryCASStore();o=Observation("a"*40,"b"*40,"wu","t");l=acquire(st,repo_merge_lock_key("r"),"A",o,now_srv=0,ttl=5);li=attach_intent(st,l,"r","p","merge");assert not fence_ok(st,"r",li,replace(o,pr_updated_at="x"),now_srv=10)[0];counts["S1"]+=1
  st=MemoryCASStore();k=lease_key("r","pr","1","REPAIR");assert acquire(st,k,"A",o,now_srv=0);assert acquire(st,k,"B",o,now_srv=r.uniform(1,299)) is None;counts["S2"]+=1
  st=MemoryCASStore();l=acquire(st,repo_merge_lock_key("r"),"A",o,now_srv=0);li=attach_intent(st,l,"r","p","merge");assert intent_recovery(li,"UNKNOWN")=="READBACK_REQUIRED";counts["S3"]+=1
  st=MemoryCASStore();l=acquire(st,lease_key("r","pr","1","REPAIR"),"A",o,now_srv=0);li=attach_intent(st,l,"r","p","push");assert intent_recovery(li,"UNKNOWN")=="READBACK_REQUIRED";counts["S4"]+=1
  for sid,k in (("S21",lease_key("r","wu","42","IMPLEMENT")),("S22",capacity_slot_key("r",4))):
   st=MemoryCASStore();hs=list("ABCD");r.shuffle(hs);assert sum(acquire(st,k,h,o,now_srv=0) is not None for h in hs)==1;counts[sid]+=1
 return counts
if __name__=="__main__":
 c=run();assert all(v==1000 for v in c.values());print("l5_hostile_sim PASS",c)
