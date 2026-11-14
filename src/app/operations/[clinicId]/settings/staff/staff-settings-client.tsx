'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import { Button, SegmentedControl } from '@/app/ui';
import { clinicSetupCopy } from '@/modules/localization/clinic-setup';
import '../settings.css';
import { SettingsTabs } from '../settings-tabs';
import {
  STAFF_ROLES,
  parseStaff,
  patchBody,
  planRoleChange,
  removalConflict,
  sortStaff,
  type StaffMember,
  type StaffRole,
} from '../staff-model';

type Locale = 'ar' | 'fr';
type Load = 'loading' | 'forbidden' | 'error' | 'ready';
type Pending =
  | { kind: 'remove'; member: StaffMember }
  | { kind: 'leave_doctor'; member: StaffMember; role: StaffRole };
const JSON_HEADERS = { 'content-type': 'application/json' };

// Personnel tab, members part (docs/design/clinic-setup.md). Invitations and
// the invite page restyle are the next slice of #830.
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
