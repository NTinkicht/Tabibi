# ETA audit contract-version binding

WU #587 defines the bounded audit/evidence binding for the merged `eta-uncertainty/v1` contract.

## Canonical identifier

ETA-producing and ETA-recomputation audit evidence MUST record the exact contract identifier `eta-uncertainty/v1` as `etaContractVersion` **only after the executing estimator has actually adopted and satisfied the `eta-uncertainty/v1` calculation contract**.

Legacy ETA paths MUST NOT emit `etaContractVersion: eta-uncertainty/v1`. The existence of this binding document or a shared audit pipeline is not evidence that the v1 estimator contract executed. Until estimator adoption is separately implemented and verified, the field MUST remain absent from legacy ETA audit evidence.

The value identifies the deterministic calculation contract that actually executed, not an individual estimate, queue revision, retry, or patient. An idempotent retry over unchanged committed inputs MUST reuse the same contract identifier only when the original computation was itself produced under that contract.

## Scope

The binding applies only when an ETA is computed or recomputed by an implementation that has adopted the ETA uncertainty contract. Unrelated queue lifecycle actions and legacy ETA calculations MUST NOT acquire `etaContractVersion` merely because they share the queue audit pipeline.

This binding does not change queue ordering, authorization, patient-facing ETA semantics, estimator inputs, or the existing `queue-ordering/v1` audit metadata.

## Implementation acceptance

Actual v1 estimator adoption is an explicit prerequisite for emitting this field. A follow-up for this WU must therefore fail closed: it may define the canonical source constant and audit plumbing before adoption, but it MUST NOT label legacy calculations as v1.

Once a separately authorized implementation proves the executing estimator satisfies `eta-uncertainty/v1`, the audit implementation must:

1. expose one canonical source constant for `eta-uncertainty/v1`;
2. attach `etaContractVersion` only to privacy-minimal ETA compute/recompute audit evidence produced by the adopted v1 estimator;
3. prove the exact value on v1 ETA-producing/recomputation paths;
4. prove the field is absent from legacy ETA paths and unrelated lifecycle audit events;
5. preserve deterministic retry behavior and existing queue-ordering metadata.

No new estimator, deployment behavior, credential, spending, or product-direction change is authorized by this document.
