'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import { Button, Chip, SegmentedControl } from '@/app/ui';
import { clinicSetupCopy } from '@/modules/localization/clinic-setup';
import '../settings.css';
import { SettingsTabs } from '../settings-tabs';
import {
  INVITE_ROLES,
  STAFF_ROLES,
  inviteLink,
  parseCreatedInvite,
  parseInvites,
  parseStaff,
  patchBody,
  planRoleChange,
  removalConflict,
  sortStaff,
  type InviteRole,
  type PendingInvite,
  type StaffMember,
  type StaffRole,
} from '../staff-model';

type Locale = 'ar' | 'fr';
type Load = 'loading' | 'forbidden' | 'error' | 'ready';
type Pending =
  | { kind: 'remove'; member: StaffMember }
  | { kind: 'leave_doctor'; member: StaffMember; role: StaffRole };
const JSON_HEADERS = { 'content-type': 'application/json' };

// Personnel tab (docs/design/clinic-setup.md): members, invite link, pending
// invites. The /staff/invite restyle is the last slice of #830.
export function StaffSettingsClient({
  clinicId,
  initialLocale,
}: {
  clinicId: string;
  initialLocale: Locale;
}) {
  const locale = initialLocale;
  const t = clinicSetupCopy[locale];
  const base = `/api/clinics/${encodeURIComponent(clinicId)}`;
  const [load, setLoad] = useState<Load>('loading');
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [needDoctor, setNeedDoctor] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<PendingInvite[] | null>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRole>('receptionist');
  const [inviteError, setInviteError] = useState<string | null>(null);
  // One-time token: component state only, never URL, storage or logs.
  const [link, setLink] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    if (!pending && dialog.open) {
      dialog.close();
      // Focus returns to the table, or to the error when the action failed.
      (errorRef.current ?? tableRef.current)?.focus();
    }
  }, [pending]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        // GET /memberships is clinic_admin-only: it doubles as the role check.
        const res = await fetch(`${base}/memberships`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (res.status === 403) return setLoad('forbidden');
        const rows = res.ok ? parseStaff(await res.json()) : null;
        if (!rows) return setLoad('error');
        setMembers(sortStaff(rows, locale));
        try {
          const inv = await fetch(`${base}/staff-invites`, {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          });
          setInvites(inv.ok ? parseInvites(await inv.json()) : null);
        } catch {
          if (!controller.signal.aborted) setInvites(null);
        }
        setLoad('ready');
      } catch {
        if (!controller.signal.aborted) setLoad('error');
      }
    })();
    return () => controller.abort();
  }, [base, tick, locale]);

  function closeDialog() {
    setPending(null);
  }

  async function send(
    url: string,
    method: 'PATCH' | 'DELETE',
    body: unknown,
    success: string,
    conflict?: string,
  ): Promise<void> {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : JSON_HEADERS,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 403) return setLoad('forbidden');
      if (res.status === 409 && conflict) setError(conflict);
      else if (res.status === 404) {
        // Already gone or changed elsewhere: show the committed list.
        reload();
        setError(t.actionFailed);
      } else if (!res.ok) setError(t.actionFailed);
      else {
        // Honest state: re-read the committed list instead of patching locally.
        reload();
        setOk(success);
      }
    } catch {
      setError(t.actionFailed);
    } finally {
      setBusy(false);
      closeDialog();
    }
  }

  async function onCreateInvite(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setInviteError(null);
    setOk(null);
    setLink(null);
    setCopyNote(null);
    setBusy(true);
    try {
      const res = await fetch(`${base}/staff-invites`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      if (res.status === 403) return setLoad('forbidden');
      if (res.status === 409) setInviteError(t.inviteDuplicate);
      else if (res.status === 400) setInviteError(t.inviteEmailInvalid);
      else {
        const created = res.ok ? parseCreatedInvite(await res.json()) : null;
        if (!created) setInviteError(t.actionFailed);
        else {
          setLink(inviteLink(window.location.origin, created.token));
          setInviteEmail('');
          reload();
        }
      }
    } catch {
      setInviteError(t.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopyNote(t.inviteCopied);
    } catch {
      setCopyNote(t.inviteCopyFailed);
      linkRef.current?.select();
    }
  }

  function closeLink() {
    setLink(null);
    setCopyNote(null);
  }

  async function onRevoke(invite: PendingInvite) {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const res = await fetch(
        `${base}/staff-invites/${encodeURIComponent(invite.inviteId)}`,
        { method: 'DELETE', credentials: 'same-origin' },
      );
      if (res.status === 403) return setLoad('forbidden');
      // 404: accepted or revoked meanwhile; the refreshed list is the truth.
      if (res.ok) setOk(t.inviteRevoked);
      else if (res.status !== 404) setError(t.actionFailed);
      reload();
    } catch {
      setError(t.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  function memberUrl(member: StaffMember) {
    return `${base}/memberships/${encodeURIComponent(member.userId)}`;
  }

  function onRole(member: StaffMember, to: StaffRole) {
    setError(null);
    setOk(null);
    setNeedDoctor(null);
    const plan = planRoleChange(member.role, to);
    if (plan.kind === 'add_doctor') return setNeedDoctor(member.userId);
    if (plan.kind === 'confirm_leave_doctor')
      return setPending({ kind: 'leave_doctor', member, role: plan.role });
    if (plan.kind === 'patch')
      void send(
        memberUrl(member),
        'PATCH',
        patchBody(plan.role),
        t.roleChanged,
      );
  }

  function onConfirm() {
    if (!pending) return;
    if (pending.kind === 'remove')
      void send(
        memberUrl(pending.member),
        'DELETE',
        undefined,
        t.removed,
        t.staffConflicts[removalConflict(pending.member.role)],
      );
    else
      void send(
        memberUrl(pending.member),
        'PATCH',
        patchBody(pending.role as 'clinic_admin' | 'receptionist'),
        t.roleChanged,
      );
  }

  return (
    <main className="cs">
      <DocumentLocaleSync locale={locale} />
      <h1>{t.pageTitle}</h1>
      <SettingsTabs clinicId={clinicId} locale={locale} active="staff" />
      {load === 'loading' && <p role="status">{t.loading}</p>}
      {load === 'forbidden' && <p role="alert">{t.adminOnly}</p>}
      {load === 'error' && <p role="alert">{t.loadError}</p>}
      {load === 'ready' && (
        <>
          {error && (
            <div className="cs-error" role="alert" tabIndex={-1} ref={errorRef}>
              {error}
            </div>
          )}
          {ok && (
            <p className="cs-ok" role="status">
              {ok}
            </p>
          )}
          <section className="cs-card" aria-labelledby="cs-staff-title">
            <h2 id="cs-staff-title">{t.staffTitle}</h2>
            <p className="cs-help">{t.staffHelp}</p>
            {members.length === 0 && <p>{t.staffEmpty}</p>}
            <div className="cs-table-wrap" tabIndex={-1} ref={tableRef}>
              <table className="cs-table">
                <thead>
                  <tr>
                    <th scope="col">{t.staffColName}</th>
                    <th scope="col">{t.staffColIdentifier}</th>
                    <th scope="col">{t.staffColRole}</th>
                    <th scope="col">{t.staffColAccess}</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.userId} data-testid={`member-${m.userId}`}>
                      <th scope="row">
                        <bdi>{m.displayName}</bdi>
                      </th>
                      <td dir="ltr">{m.identifier}</td>
                      <td>
                        <SegmentedControl
                          label={`${t.roleLabel} ${m.displayName}`}
                          options={STAFF_ROLES.map((r) => ({
                            value: r,
                            label: t.roles[r],
                          }))}
                          value={m.role}
                          onChange={(r) => !busy && onRole(m, r as StaffRole)}
                        />
                        {needDoctor === m.userId && (
                          <p className="cs-help" role="status">
                            {t.needDoctorProfile}{' '}
                            <Link
                              href={`/operations/${encodeURIComponent(clinicId)}/settings/doctors?locale=${locale}`}
                            >
                              {t.goDoctors}
                            </Link>
                          </p>
                        )}
                      </td>
                      <td>
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => {
                            setError(null);
                            setOk(null);
                            setPending({ kind: 'remove', member: m });
                          }}
                        >
                          {t.removeAccess}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="cs-card" aria-labelledby="cs-invite-title">
            <h2 id="cs-invite-title">{t.inviteTitle}</h2>
            <p className="cs-help">{t.inviteHelp}</p>
            <form className="cs-inline" onSubmit={onCreateInvite} noValidate>
              <div className="cs-field">
                <label htmlFor="cs-invite-email">{t.inviteEmail}</label>
                <input
                  id="cs-invite-email"
                  type="email"
                  dir="ltr"
                  autoComplete="off"
                  value={inviteEmail}
                  aria-invalid={inviteError ? true : undefined}
                  aria-describedby={inviteError ? 'cs-invite-error' : undefined}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <div className="cs-field">
                <label htmlFor="cs-invite-role">{t.inviteRole}</label>
                <select
                  id="cs-invite-role"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as InviteRole)}
                >
                  {INVITE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t.roles[r]}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" disabled={busy || !inviteEmail.trim()}>
                {t.inviteCreate}
              </Button>
            </form>
            {inviteError && (
              <p id="cs-invite-error" className="cs-error" role="alert">
                {inviteError}
              </p>
            )}
            {link && (
              <div data-testid="invite-link-panel">
                <div className="cs-field">
                  <label htmlFor="cs-invite-link">{t.inviteLinkLabel}</label>
                  <input
                    id="cs-invite-link"
                    ref={linkRef}
                    type="text"
                    dir="ltr"
                    readOnly
                    value={link}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
                <p className="cs-help">{t.inviteLinkNote}</p>
                <div className="cs-inline">
                  <Button variant="secondary" onClick={() => void onCopy()}>
                    {t.inviteCopy}
                  </Button>
                  <Button variant="secondary" onClick={closeLink}>
                    {t.inviteClose}
                  </Button>
                </div>
                {copyNote && (
                  <p className="cs-ok" role="status">
                    {copyNote}
                  </p>
                )}
              </div>
            )}
          </section>
          <section className="cs-card" aria-labelledby="cs-pending-title">
            <h2 id="cs-pending-title">{t.pendingTitle}</h2>
            {invites === null && <p role="alert">{t.loadError}</p>}
            {invites?.length === 0 && <p>{t.pendingEmpty}</p>}
            {invites && invites.length > 0 && (
              <div className="cs-table-wrap">
                <table className="cs-table">
                  <thead>
                    <tr>
                      <th scope="col">{t.pendingColEmail}</th>
                      <th scope="col">{t.pendingColRole}</th>
                      <th scope="col">{t.pendingColExpires}</th>
                      <th scope="col">{t.staffColAccess}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((i) => (
                      <tr key={i.inviteId} data-testid={`invite-${i.inviteId}`}>
                        <th scope="row" dir="ltr">
                          {i.email}
                        </th>
                        <td>{t.roles[i.role]}</td>
                        <td>
                          <time dateTime={i.expiresAt}>
                            {new Intl.DateTimeFormat(locale, {
                              dateStyle: 'medium',
                              timeZone: 'Africa/Algiers',
                            }).format(new Date(i.expiresAt))}
                          </time>{' '}
                          {i.status === 'expired' && (
                            <Chip tone="warning">{t.pendingExpired}</Chip>
                          )}
                        </td>
                        <td>
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void onRevoke(i)}
                          >
                            {t.inviteRevoke}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      <dialog
        ref={dialogRef}
        className="cs-dialog"
        aria-labelledby="cs-dialog-title"
        onClose={() => setPending(null)}
      >
        {pending && (
          <>
            <h2 id="cs-dialog-title">
              {pending.kind === 'remove' ? t.removeTitle : t.leaveDoctorTitle}{' '}
              <bdi>{pending.member.displayName}</bdi>
            </h2>
            {pending.kind === 'remove' ? (
              <>
                <p>{t.removeBody}</p>
                {pending.member.role === 'doctor' && <p>{t.leaveDoctorBody}</p>}
              </>
            ) : (
              <p>{t.leaveDoctorBody}</p>
            )}
            <div className="cs-dialog-actions">
              <Button variant="secondary" onClick={closeDialog}>
                {t.cancel}
              </Button>
              <Button variant="danger" disabled={busy} onClick={onConfirm}>
                {pending.kind === 'remove' ? t.removeConfirm : t.confirmChange}
              </Button>
            </div>
          </>
        )}
      </dialog>
    </main>
  );
}
