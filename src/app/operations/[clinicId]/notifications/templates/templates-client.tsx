'use client';

import Link from 'next/link';
import '../notifications.css';
import './templates.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toTemplateViews, type TemplateView } from './templates-model';

type Locale = 'ar' | 'fr';
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; offline: boolean }
  | { kind: 'ready'; templates: TemplateView[] };

const copy = {
  fr: {
    title: 'Modèles de notification',
    back: 'Retour aux notifications non remises',
    language: 'Langue',
    intro:
      'Voici le texte exact envoyé aux patients. Les exemples utilisent des valeurs fictives : aucune donnée de patient n’est affichée.',
    loading: 'Chargement des modèles…',
    error: 'Impossible de charger les modèles. Veuillez réessayer.',
    offline:
      'Vous êtes hors ligne : le catalogue est indisponible. Il se rechargera au retour de la connexion.',
    empty: 'Aucun modèle disponible.',
    retry: 'Réessayer',
    french: 'Français',
    arabic: 'Arabe',
    variables: 'Valeurs variables',
    none: 'aucune',
    readOnly: 'Lecture seule : les textes ne peuvent pas être modifiés ici.',
  },
  ar: {
    title: 'نماذج الإشعارات',
    back: 'العودة إلى الإشعارات التي تعذّر تسليمها',
    language: 'اللغة',
    intro:
      'هذا هو النص الدقيق المرسل إلى المرضى. الأمثلة تستخدم قيمًا وهمية ولا تعرض أي بيانات مريض.',
    loading: 'جارٍ تحميل النماذج…',
    error: 'تعذّر تحميل النماذج. حاول مرة أخرى.',
    offline:
      'أنت غير متصل بالإنترنت: الكتالوج غير متاح. سيُعاد تحميله عند عودة الاتصال.',
    empty: 'لا توجد نماذج متاحة.',
    retry: 'إعادة المحاولة',
    french: 'الفرنسية',
    arabic: 'العربية',
    variables: 'القيم المتغيرة',
    none: 'لا شيء',
    readOnly: 'للقراءة فقط: لا يمكن تعديل النصوص من هنا.',
  },
} as const;

export function TemplatesClient({
  clinicId,
  initialLocale,
}: {
  clinicId: string;
  initialLocale: Locale;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const requestId = useRef(0);
  const t = copy[locale];

  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++requestId.current;
    void (async () => {
      try {
        const response = await fetch(
          `/api/clinics/${encodeURIComponent(clinicId)}/notification-templates`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error('Rejected');
        const templates = toTemplateViews(await response.json());
        if (current === requestId.current && !controller.signal.aborted)
          setState({ kind: 'ready', templates });
      } catch {
        if (current === requestId.current && !controller.signal.aborted)
          setState({ kind: 'error', offline: !navigator.onLine });
      }
    })();
    return () => {
      controller.abort();
      requestId.current += 1;
    };
  }, [clinicId, attempt]);

  useEffect(() => {
    window.addEventListener('online', reload);
    return () => window.removeEventListener('online', reload);
  }, [reload]);

  return (
    <main className="nx nt" lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="nx-header">
        <Link
          href={`/operations/${encodeURIComponent(clinicId)}/notifications?locale=${locale}`}
        >
          {t.back}
        </Link>
        <div className="tb-segmented" role="group" aria-label={t.language}>
          <button
            type="button"
            lang="fr"
            onClick={() => setLocale('fr')}
            aria-pressed={locale === 'fr'}
          >
            Français
          </button>
          <button
            type="button"
            lang="ar"
            onClick={() => setLocale('ar')}
            aria-pressed={locale === 'ar'}
          >
            العربية
          </button>
        </div>
      </header>
      <h1>{t.title}</h1>
      <p>{t.intro}</p>
      <p>{t.readOnly}</p>
      {state.kind === 'loading' && <p aria-live="polite">{t.loading}</p>}
      {state.kind === 'error' && (
        <p role="alert">{state.offline ? t.offline : t.error}</p>
      )}
      {state.kind === 'error' && (
        <button type="button" onClick={reload}>
          {t.retry}
        </button>
      )}
      {state.kind === 'ready' && state.templates.length === 0 && (
        <p role="status">{t.empty}</p>
      )}
      {state.kind === 'ready' && state.templates.length > 0 && (
        <ul className="nt-list">
          {state.templates.map((template) => (
            <li key={template.templateId} className="nt-card">
              <h2>{template.templateId}</h2>
              {(['fr', 'ar'] as const).map((previewLocale) => {
                const preview = template.previews[previewLocale];
                return (
                  <div
                    key={previewLocale}
                    className="nt-preview"
                    lang={previewLocale}
                    dir={preview.direction}
                  >
                    <span>{previewLocale === 'fr' ? t.french : t.arabic}</span>
                    <strong>{preview.title}</strong>
                    <p>{preview.body}</p>
                  </div>
                );
              })}
              <p className="nt-vars">
                {t.variables} :{' '}
                {template.variables.length > 0
                  ? template.variables.join(', ')
                  : t.none}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
