# L5 Post-Claude Cutover - Tabibi

Tabibi consumes the shared L5 post-Claude control-plane contract from `NTinkicht/OneCompany` as declared in `.l5/control-plane.json`.

Tabibi is now in **LIVE_SAFE validation mode**. The scheduled L5 controllers may perform reversible engineering mutations on canonical feature branches and PRs, including implementation commits, PR creation/updates, CI reruns, independent review requests, comments/labels, verified thread resolution, and work-unit replenishment.

GitHub platform enforcement is intentionally deferred during this validation phase. Its absence remains visible as `PLATFORM_ENFORCEMENT_DEFERRED`, but it does not block reversible non-main engineering work. Main-changing actions such as PR merge/enqueue, direct pushes to `main`, or default-branch history changes remain blocked by the controller contract until final activation.

The shared control plane still requires exact head/base evidence, source-pinned CI, independent non-author review, L5.1 intent/restraint evidence, durable lease/intent semantics, credential isolation, secret hygiene, and all human-only safety boundaries. Final `ACTIVE` mode continues to require the complete activation evidence set.
