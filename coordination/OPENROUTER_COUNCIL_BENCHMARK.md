# OpenRouter Council Benchmark Plan

The council starts advisory-only. Before any OpenRouter model is considered for binding independent gate authority, benchmark it against a labeled set of historical Tabibi PRs/findings.

## Minimum benchmark

Use representative merged or reviewed PRs containing known:
- privacy/security defects;
- PostgreSQL migration/concurrency defects;
- tenant-isolation/API-negative defects;
- Arabic/French/RTL/browser defects;
- false-positive review claims.

Measure:
- recall of known MAJOR/BLOCKER findings;
- false-positive rate;
- exact-file/line or affected-area precision;
- ability to distinguish unverified suspicion from reproduced evidence;
- stability across repeated runs;
- cost and latency.

## Promotion rule

No OpenRouter council member gains `PASS/MERGE_READY` authority merely because it produces useful reviews. Promotion requires an explicit binding-protocol change after benchmark evidence shows acceptable reliability and non-self-gating semantics are defined.
