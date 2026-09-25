# WU175 — Post-WU174 combined clinic-day acceptance

Parent: Epic #5 and issue #505. Baseline: main at `f368808726ec2bac36f7095f853e86450cc51b41`, after merged WU171–WU174. WU170's audit predates these changes and must not be represented as current verification.

## Regression sequence

`tests/integration/appointment-bulk-no-show.test.ts` adds a real PostgreSQL, synthetic-data scenario that:
1. Creates expired and not-yet-expired appointment-backed waiting entries alongside an arrived walk-in.
2. Proves normal close fails while serviceable entries remain.
3. Executes the receptionist's explicit grace-qualified bulk resolution; only the expired appointment/entry becomes no-show. The future appointment remains waiting and the walk-in remains checked-in.
4. Confirms queue-order version and the checked-in entry's opaque ETA revision change on committed bulk mutation, even while numeric ETA is unchanged.
5. Verifies an exact bulk retry produces an identical aggregate receipt, with no additional queue-order version or new ETA revision.
6. Verifies normal close still fails while future appointment and walk-in remain, then succeeds after **separate explicit** appointment and walk-in cancellation. The recorded no-show audit is not duplicated.

## Evidence limits

The source/test exists on the WU175 branch. **Do not classify as PASS until the exact-final-head three CI jobs finish, an independently executed non-material-author reviewer checks that exact head and any Medium+ findings are resolved.** Passing a synthetic clinic-day test never proves deployment suitability, production concurrency capacity, real provider dispatch, or care outcomes. WU176 keyboard UI accessibility and WU177 direct SQL session INSERT guard are separate nonoverlapping streams. Issue #485's GitHub required-check/ruleset enforcement remains separately outstanding. No real patient data, model PAYG, overage or extra infrastructure cost.
