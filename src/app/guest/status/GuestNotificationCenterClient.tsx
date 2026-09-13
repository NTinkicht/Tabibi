'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

type SupportedLocale = 'en' | 'fr' | 'ar';

type NotificationItem = {
  id: string;
  locale: string;
  direction: 'ltr' | 'rtl';
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

type InboxSnapshot = {
  unreadCount: number;
  items: NotificationItem[];
};

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: InboxSnapshot; pendingItemId: string | null }
  | { kind: 'signed_out' }
  | { kind: 'throttled' }
  | { kind: 'error' };

type Copy = {
  heading: string;
  unread: string;
  loading: string;
  empty: string;
  markRead: string;
  markingRead: string;
  accessUnavailable: string;
  throttled: string;
  unavailable: string;
  retry: string;
};

const COPY: Record<SupportedLocale, Copy> = {
  en: {
    heading: 'Notifications',
    unread: 'Unread',
    loading: 'Loading notifications…',
    empty: 'No notifications yet.',
    markRead: 'Mark as read',
    markingRead: 'Marking as read…',
    accessUnavailable: 'Notifications are unavailable for this guest session.',
    throttled: 'Too many requests. Please try again shortly.',
    unavailable: 'Notifications are temporarily unavailable.',
    retry: 'Retry',
  },
  fr: {
    heading: 'Notifications',
    unread: 'Non lues',
    loading: 'Chargement des notifications…',
    empty: 'Aucune notification pour le moment.',
    markRead: 'Marquer comme lue',
    markingRead: 'Marquage en cours…',
    accessUnavailable:
      'Les notifications ne sont pas disponibles pour cette session invitée.',
    throttled: 'Trop de requêtes. Veuillez réessayer dans un instant.',
    unavailable: 'Les notifications sont temporairement indisponibles.',
    retry: 'Réessayer',
  },
  ar: {
    heading: 'الإشعارات',
    unread: 'غير مقروءة',
    loading: 'جارٍ تحميل الإشعارات…',
    empty: 'لا توجد إشعارات بعد.',
    markRead: 'تحديد كمقروء',
    markingRead: 'جارٍ التحديد كمقروء…',
    accessUnavailable: 'الإشعارات غير متاحة لجلسة الضيف هذه.',
    throttled: 'طلبات كثيرة جدًا. يرجى المحاولة بعد قليل.',
    unavailable: 'الإشعارات غير متاحة مؤقتًا.',
    retry: 'إعادة المحاولة',
  },
};

function detectGuestLocale(): SupportedLocale {
  if (typeof navigator === 'undefined') return 'en';
  const locale = navigator.language.toLowerCase();
  if (locale.startsWith('ar')) return 'ar';
  if (locale.startsWith('fr')) return 'fr';
  return 'en';
}

function subscribeToGuestLocale(): () => void {
  return () => undefined;
}

export function GuestNotificationCenterClient() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const locale = useSyncExternalStore<SupportedLocale>(
    subscribeToGuestLocale,
    detectGuestLocale,
    () => 'en',
  );
  const copy = COPY[locale];
  const direction = locale === 'ar' ? 'rtl' : 'ltr';

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    try {
      const response = await fetch('/api/guest/inbox?limit=20', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal,
      });
      if (signal?.aborted) return;
      if (response.status === 401) {
        setState({ kind: 'signed_out' });
        return;
      }
      if (response.status === 429) {
        setState({ kind: 'throttled' });
        return;
      }
      if (!response.ok) {
        setState({ kind: 'error' });
        return;
      }
      const snapshot = (await response.json()) as InboxSnapshot;
      if (signal?.aborted) return;
      setState({ kind: 'ready', snapshot, pendingItemId: null });
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        return;
      }
      setState({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const markRead = async (itemId: string) => {
    if (state.kind !== 'ready' || state.pendingItemId) return;
    setState({ ...state, pendingItemId: itemId });
    try {
      const response = await fetch(
        `/api/guest/inbox/${encodeURIComponent(itemId)}/read`,
        {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        },
      );
      if (response.status === 401) {
        setState({ kind: 'signed_out' });
        return;
      }
      if (response.status === 429) {
        setState({ kind: 'throttled' });
        return;
      }
      if (!response.ok) {
        setState({ ...state, pendingItemId: null });
        return;
      }
      const updated = (await response.json()) as NotificationItem;
      const wasUnread =
        state.snapshot.items.find((item) => item.id === itemId)?.readAt === null;
      setState({
        kind: 'ready',
        pendingItemId: null,
        snapshot: {
          unreadCount: Math.max(
            0,
            state.snapshot.unreadCount - (wasUnread ? 1 : 0),
          ),
          items: state.snapshot.items.map((item) =>
            item.id === itemId ? { ...item, readAt: updated.readAt } : item,
          ),
        },
      });
    } catch {
      setState({ ...state, pendingItemId: null });
    }
  };

  return (
    <aside
      lang={locale}
      dir={direction}
      aria-labelledby="guest-notification-heading"
    >
      <h2 id="guest-notification-heading">{copy.heading}</h2>
      {state.kind === 'loading' ? <p role="status">{copy.loading}</p> : null}
      {state.kind === 'signed_out' ? (
        <p role="status">{copy.accessUnavailable}</p>
      ) : null}
      {state.kind === 'throttled' ? (
        <div role="status">
          <p>{copy.throttled}</p>
          <button type="button" onClick={() => void load()}>
            {copy.retry}
          </button>
        </div>
      ) : null}
      {state.kind === 'error' ? (
        <div role="alert">
          <p>{copy.unavailable}</p>
          <button type="button" onClick={() => void load()}>
            {copy.retry}
          </button>
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          <p aria-live="polite">
            <strong>{copy.unread}:</strong> {state.snapshot.unreadCount}
          </p>
          {state.snapshot.items.length === 0 ? <p>{copy.empty}</p> : null}
          <ul>
            {state.snapshot.items.map((item) => {
              const isPending = state.pendingItemId === item.id;
              return (
                <li key={item.id} dir={item.direction} lang={item.locale}>
                  <article>
                    <h3>{item.title}</h3>
                    <p>{item.body}</p>
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString()}
                    </time>
                    {item.readAt === null ? (
                      <p>
                        <button
                          type="button"
                          disabled={state.pendingItemId !== null}
                          aria-busy={isPending}
                          onClick={() => void markRead(item.id)}
                        >
                          {isPending ? copy.markingRead : copy.markRead}
                        </button>
                      </p>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </aside>
  );
}
