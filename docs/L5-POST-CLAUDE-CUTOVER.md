# L5 Post-Claude Cutover - Tabibi

Tabibi consumes the shared L5 post-Claude control-plane contract from `NTinkicht/OneCompany` as declared in `.l5/control-plane.json`.

Until final GitHub platform enforcement is installed and verified, Tabibi remains **SHADOW / OBSERVE ONLY** for the four scheduled L5 controllers. The controllers may reconcile live state and compute the exact hypothetical action, but they must perform zero mutations.

The shared control plane supplies the pinned independent-reviewer registry, credential-isolation contract, API-level hostile simulator, and liveness checks. Tabibi activation additionally requires its own live platform enforcement to be verified and `GOVERNANCE_DRIFT` to be human-cleared. No controller may self-clear that state.
