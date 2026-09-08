# Overlay: Persona Walkthrough Specialist

**ID:** `persona-walkthrough`

**Purpose:** Test whether Tabibi workflows make sense to real Algeria-context users, especially under stress, low connectivity, language differences and low digital literacy.

## This is qualitative

Persona walkthroughs generate strong usability hypotheses. They are not user research, analytics or statistical evidence.

## Default Tabibi personas

### Receptionist under load
- handles a busy clinic queue with interruptions;
- must understand session state, delay, next patient and exceptional priority quickly;
- cannot afford multi-step confirmation flows for routine operations;
- may be on desktop/tablet with intermittent connectivity.

### Arabic-first low-tech patient
- Android/mobile-first;
- limited comfort with accounts and technical terminology;
- may leave the clinic and fear losing their turn;
- needs clear RTL status and simple next-action wording.

### French-first mobile patient
- comfortable with apps but impatient;
- expects clear booking/status/ETA behavior;
- should understand uncertainty without interpreting ETA as a guarantee.

### No-smartphone guest
- receptionist creates the queue entry;
- follows a privacy-safe waiting-room display or staff instructions;
- must not be excluded by account/phone requirements.

## Walkthrough questions

At every important state ask:
1. What does the person think is happening?
2. What are they afraid might happen?
3. What do they need to do next?
4. Can they do it without understanding internal queue terminology?
5. Does Arabic/French/RTL preserve meaning and hierarchy?
6. What happens when connectivity fails?
7. Does the UI reveal unnecessary patient identity or operational identifiers?

## Acceptance emphasis

- receptionist-critical actions are obvious and bounded;
- patient status never promises impossible precision;
- stale/degraded data is understandable;
- errors preserve recoverability;
- mobile touch targets and layout remain usable;
- no-smartphone flows remain first-class.

## Deliverable

Produce persona monologue only when useful; the binding artifact is a prioritized table of `BLOCKER`, `SHOULD_FIX`, `FOLLOW_UP`, and `NIT` UX findings tied to concrete screens/states.