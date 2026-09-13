# WU38 in-app delivery runtime

WU38 closes the runtime-composition gap between durable queue notification intents and the durable in-app inbox without adding a scheduler, daemon, network provider, destination lookup, or paid dependency.

## Production boundary

`src/modules/notification-domain/in-app.ts` is the intentional public entry point for the WU38 composition.

`createQueueInAppNotificationDispatchService(pool)` wires only existing hardened components:

1. `NotificationOutboxRepository` for exact claim, retry, fencing, terminal and supersession semantics.
2. `QueueInAppNotificationTargetResolver` to derive the exact `visit_patient` subject from `intent.clinicId + intent.queueEntryId`.
3. `NotificationPreferenceRepository` plus `NotificationPreferenceDeliveryContextResolver` for the current in-app preference/consent gate.
4. The existing deterministic WU28/WU30 rendering boundary.
5. The security-fixed `InAppNotificationProviderAdapter`.
6. `InAppNotificationInboxRepository` for idempotent, clinic- and exact-subject-scoped persistence.

The caller of the composed service supplies only `clinicId` and `intentId`. Patient, account, subject-kind and contact identity are not caller-selectable. Unknown, missing, inconsistent, or cross-clinic queue targets fail closed before inbox persistence.

## Trigger boundary

This work unit deliberately does **not** add polling, cron, a daemon, an HTTP admin trigger, a queue consumer, or any automatic background execution. The composed service is suitable for a later bounded trigger while keeping the dispatch lifecycle independently testable.

## Provider and cost boundary

WU38 supports the existing zero-network `in_app` adapter only. It adds no SMS, push, email or WhatsApp provider, no provider credentials, no contact-value persistence, and no paid API or metered fallback.

## Verification

PostgreSQL integration coverage proves:

- an authorized queue-derived intent traverses outbox claim -> current preference -> rendering -> in-app adapter -> durable inbox;
- the item lands only in the exact patient inbox for the correct clinic;
- replaying the same delivered intent cannot create another inbox item;
- missing preference is suppressed before inbox persistence;
- a cross-clinic queue-entry target fails closed as missing delivery context and writes no inbox row.
