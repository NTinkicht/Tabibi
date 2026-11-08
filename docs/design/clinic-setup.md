# Clinic setup — design specification

Status: approved by the owner on 2026-11-08. Builds on [`foundations.md`](foundations.md) and
uses the console header from [`reception-console.md`](reception-console.md).
Visual reference: https://claude.ai/artifact/RRe557S5McvDYnLFc7QLEm (row "Clinic setup", French
and Arabic). Gap register: G-09 (clinic setup), G-18, G-19, G-20, G-21.

Clinic setup is for the **clinic_admin** only. Every API below already enforces this on the
server. The UI hides the entry point from other roles and shows "Réservé aux administrateurs." /
"مخصّص لمسؤولي العيادة." if a non-admin opens the URL (any 403).

## Shell `/operations/[clinicId]/settings/{clinic|doctors|staff}`

- The console header shows a "Paramètres" / "الإعدادات" link for clinic admins only. The link
  is shown when the signed-in membership role is `clinic_admin` (from the sign-in response or
  the memberships list).
- Page title "Paramètres de la clinique". Three tabs as links (`aria-current="page"` on the
  active one): Clinique · Médecins et horaires · Personnel. Each tab has its own URL, so reload
  and back keep the tab.
- Every section follows the same pattern: section title, a one-line explanation, then the form
  or list.
  - Saving shows inline success text (`role="status"`).
  - Errors use the foundations error summary (`role="alert"`, focused).
  - 409 conflicts get the specific messages below.
- Times and dates are shown in the clinic time zone. `<bdi>` is used for names and identifiers
  inside Arabic text.

## Clinique tab

**Profil.** `GET /api/clinics/{clinicId}` and `PATCH` with the changed fields.

- Fields: name, time zone (select, default `Africa/Algiers`), wilaya (select `01`–`58`),
  commune, address, offered languages (checkboxes ar/fr, at least one), default language (one
  of the offered ones).
- Help line: "Les modifications apparaissent dans la recherche publique."

**Jours de fermeture.**

- `GET /api/clinics/{clinicId}/closures` lists the closure days. They are shown as full dates,
  each with a "Retirer" button that calls `DELETE …/closures/{date}`.
- A date input with "Ajouter" calls `POST …/closures` with `{ closureDate }`.
- A 409 on a day that already has sessions shows: "Des sessions existent déjà ce jour-là :
  annulez-les depuis l’accueil avant de fermer."

**Types de consultation.**

- `GET …/consultation-types?includeInactive=true` fills a table with three columns: label,
  nominal duration, state.
- "Désactiver" / "Réactiver" calls `PATCH …/{id}` with `{ active }`.
- "Ajouter un type" opens an inline row with label, code (generated from the label and
  editable, `^[a-z0-9][a-z0-9_-]{0,47}$`) and duration in minutes. It saves with `POST`.
- Help line: "Leur durée nominale sert de base aux estimations d’attente."

## Médecins et horaires tab

**List.** `GET /api/clinics/{clinicId}/doctors` shows each doctor's name and specialties.
Selecting a doctor opens the three panels below for that doctor.

**Ajouter un médecin.**

1. The admin picks an existing member who is not yet a doctor, from
   `GET …/memberships` (G-20: `displayName`, `identifier`).
2. The admin enters the **public display name** (as shown to patients). The form saves with
   `POST …/doctors` `{ userId, displayName }`.
3. Help line: "Le médecin doit d’abord être membre du personnel (voir Personnel)." A new doctor
   is normally added by a doctor invite from the Personnel tab, which creates the doctor at
   once.

**Spécialités (1 à 3).** Checkboxes from the controlled specialty list.
`PATCH …/doctors/{doctorId}` `{ specialtyCodes }` saves them, and a fourth checkbox is disabled
once three are chosen.

**Semaine type.**

- `GET …/schedule-templates` (active templates of this doctor) is shown as seven weekday rows
  in the clinic week order (Sunday first in both languages). Each row shows its time ranges,
  "Pas de consultation" when empty, and "Ajouter une plage".
- Adding a range takes start and end times (`HH:MM`, end after start) and calls `POST …/schedule-
  templates` with `{ doctorId, weekday, localStartTime, localEndTime, occurrenceIndex }`, where
  `occurrenceIndex` is the next free index for that weekday.
- "×" deactivates a range with `PATCH …/schedule-templates/{id}` `{ active: false }`. Existing
  sessions are not changed.
- A 409 for overlapping ranges shows: "Cette plage chevauche une plage existante."

**Générer les sessions.**

- Fields: start date (default today) and a period choice of 4 or 8 weeks. "Générer" calls
  `POST …/schedule-generations` with `{ doctorId, startDate, daysAhead: 28 | 56 }`.
- Explanation: "Crée les sessions à partir de la semaine type, en sautant les fermetures et
  les absences. Les sessions déjà créées ne sont pas dupliquées."
- After a run, the page shows the count the response returned (`{ generated }`) and the period
  the admin requested: "12 sessions créées du 8 novembre au 5 décembre 2026." It never claims a
  stored "generated until" date. The reference artboard's line "Sessions générées jusqu’au …"
  is replaced by this message, because the API has no such field.

**Absences du médecin.** `GET/POST/DELETE …/doctors/{doctorId}/absences` uses the same list and
date-input pattern as closures.

## Personnel tab

**Membres.**

- `GET …/memberships` fills a table, sorted by name in the UI. Columns: name, identifier
  (`dir="ltr"`), role, access.
- The role is a three-option segmented control: Administrateur · Accueil · Médecin.
- Changing the role:
  - To Administrateur or Accueil: `PATCH …/memberships/{userId}` `{ role }`.
  - To Médecin for someone who is not yet a doctor: opens the "Ajouter un médecin" flow
    (display name), because a doctor membership needs a doctor profile.
  - From Médecin to another role: first confirm "<nom> ne sera plus proposé aux patients et
    n’aura plus accès à ses sessions. Ses sessions à venir restent visibles à l’accueil pour
    être réattribuées ou annulées." (G-19: the doctor leaves discovery and booking).
- "Retirer l’accès" opens a confirmation dialog that names the person and calls
  `DELETE …/memberships/{userId}` (G-19).
  - The dialog explains: "L’accès s’arrête immédiatement. L’historique est conservé."
  - For a doctor, it also shows the departed-doctor sentence above.
  - Focus returns to the table after the dialog closes.
- 409 messages:
  - last admin: "Il doit rester au moins un administrateur."
  - doctor without a profile: "Ajoutez d’abord cette personne comme médecin."
- The signed-in admin's own row shows "(vous)". Removing yourself is allowed only while another
  admin remains; the server enforces this.

**Inviter une personne** (G-18). There is no e-mail sending (zero additional spend), so the
button label on the reference artboard, "Envoyer l’invitation", is replaced by **"Créer le lien
d’invitation"** / **"إنشاء رابط الدعوة"**.

- Fields: e-mail address and role (Accueil or Médecin; administrators are never invited).
  "Créer le lien d’invitation" calls `POST …/staff-invites` with `{ email, role }`.
- On 201, the page shows the one-time link `${origin}/staff/invite#${token}` in a read-only
  field (`dir="ltr"`) with a "Copier le lien" button.
  - Text: "Ce lien ne sera plus affiché. Transmettez-le à la personne (SMS, WhatsApp ou en main
    propre). Il est valable 7 jours et ne fonctionne qu’une fois."
  - The token stays in component state only. It is cleared when the panel closes or the page
    changes, and is never put in the page URL, storage or logs.
- 409: "Une invitation est déjà en attente pour cette adresse."
- 400: the field-level error for an invalid e-mail.

**Invitations en attente.**

- `GET …/staff-invites` lists e-mail, role and expiry. Expired invites carry the badge
  "Expirée — révoquez pour réinviter", because an expired invite still blocks a new one for the
  same address.
- "Révoquer" calls `DELETE …/staff-invites/{inviteId}`. A 404 on revoke means the invite was
  accepted or revoked meanwhile, so the list is refreshed.

## Invite acceptance `/staff/invite#<token>` (public)

Implemented with G-18 (#824). The page uses the sign-in card layout and reads the token from
the URL fragment, then removes it from the address bar.

- It shows "<Clinique> vous invite en tant que <rôle>.", the invited e-mail and the expiry.
- Form fields: name, password (`autocomplete="new-password"`, at least 12 characters) and
  confirmation.
- It shows one generic message for any unusable link, and a "Se connecter" link after
  success.
- Restyling it to the foundations card is part of the setup UI work.

## Acceptance

- Playwright fr/ar at 1440 px and 1024 px, for each tab:
  - clinic profile save;
  - closure add/remove;
  - consultation type add/deactivate;
  - doctor add, specialties limit, weekly range add/remove, generation result, absence;
  - member role change with the doctor confirmation, removal dialog with focus return, and the
    last-admin 409 message;
  - invite creation showing the link once, copy, duplicate 409, and revoke;
  - non-admin URL showing the admin-only message.
- Keyboard-only navigation through the tabs and dialogs; screenshot baselines.
- API coverage: `staff-membership-removal.test.ts`, `staff-invite-http-api.test.ts`,
  `staff-membership-http-api.test.ts` and the existing clinic and scheduling suites.
