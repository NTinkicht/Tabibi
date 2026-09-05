# Tabibi — Product Vision

Tabibi will be an Algeria-first healthcare access platform that combines doctor discovery, appointment booking, virtual queueing, live waiting-time estimates, reception workflows, patient notifications, multilingual UX, and operational analytics.

The product must work for real clinic behavior rather than assuming rigid pre-booked schedules. It must support online appointments, walk-ins, receptionist-entered patients, delayed doctors, no-shows, pauses, emergencies, reordering policies, and patients who may not have smartphones.

## Product principles

1. **Algeria-first, not copy-paste Doctolib.** Local workflow reality is the design input.
2. **Hybrid access.** Digital and non-digital patients enter one coherent queue system.
3. **Explainable queue intelligence.** Start deterministic, measurable, auditable; add ML only when data justifies it.
4. **Patient time is valuable.** The product should minimize useless physical waiting.
5. **Reception-first usability.** A clinic should be able to operate the system under pressure with minimal training.
6. **Privacy by design.** Minimize medical data; never expose identities casually in queue views.
7. **Resilient operations.** Temporary connectivity loss or staff mistakes must not destroy queue integrity.
8. **Multilingual by default.** Arabic RTL and French are first-class. Tamazight-ready architecture.
9. **Incremental trust.** Launch with reliable operational value before advanced automation.
10. **Evidence over hype.** Every estimate, recommendation, and future AI feature should be measurable and explainable.

## Ultimate product surface

### Patient experience
- Doctor and clinic discovery by specialty, location, language, gender preference, availability and service type.
- Clinic/doctor profile with verified operational information.
- Appointment booking and cancellation.
- Virtual queue joining where enabled.
- Current queue position and live ETA.
- Delay and acceleration notifications.
- Arrival/check-in confirmation.
- Guest flow for patients without full accounts.
- Family/dependent management.
- Saved doctors and visit history limited to operational metadata unless explicitly expanded.
- Arabic/French localized UI, accessible design, low-bandwidth considerations.

### Clinic/reception experience
- Daily operations dashboard.
- Appointment calendar plus walk-in queue in one view.
- Fast patient entry by phone/name or anonymous temporary ticket.
- Check-in, mark absent, defer, restore, cancel, transfer and priority handling according to policy.
- Session open/pause/resume/close.
- Doctor delay declaration and automatic ETA propagation.
- Controlled emergency insertion with audit trail.
- Bulk messaging for exceptional disruptions.
- Role-based access for doctor, receptionist, clinic manager and platform administrator.

### Doctor experience
- Personal schedule and queue view.
- One-click call-next/start/complete consultation flow.
- Configurable consultation types and nominal durations.
- Temporary pause and emergency handling.
- Historical operational analytics without requiring clinical notes.

### Platform capabilities
- Multi-clinic, multi-doctor tenancy.
- Search and discovery.
- Notification orchestration across push/SMS/email/approved messaging integrations.
- Queue ETA service.
- Audit/event history.
- Operational analytics.
- Abuse/fraud controls.
- Observability and incident diagnostics.
- Future payment/insurance integrations only when product/legal requirements justify them.

## Explicit non-goals for initial releases

- Electronic medical records.
- Diagnosis or medical advice.
- Prescription management.
- Clinical decision support.
- AI diagnosis.
- Storing detailed clinical notes without a separate compliance/product decision.

These non-goals keep Tabibi focused on access, scheduling and operations while reducing unnecessary healthcare-data exposure.
