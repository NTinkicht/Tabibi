export const notificationTemplateIds = [
  'appointment_confirmed.v1',
  'queue_entry_created.v1',
  'estimate_changed_materially.v1',
  'turn_approaching.v1',
  'patient_called.v1',
  'session_delayed.v1',
  'session_cancelled.v1',
  'queue_entry_cancelled.v1',
  'queue_entry_transferred.v1',
] as const;

export type NotificationTemplateId = (typeof notificationTemplateIds)[number];
export type NotificationTemplateLocale = 'ar' | 'fr';
export type NotificationTemplateDirection = 'rtl' | 'ltr';

const MAX_OPERATIONAL_TEMPLATE_NUMBER = 1440;

type TemplateVariables = {
  'appointment_confirmed.v1': Record<string, never>;
  'queue_entry_created.v1': Record<string, never>;
  'estimate_changed_materially.v1': {
    windowStartMinutes: number;
    windowEndMinutes: number;
  };
  'turn_approaching.v1': { position: number };
  'patient_called.v1': Record<string, never>;
  'session_delayed.v1': { delayMinutes: number };
  'session_cancelled.v1': Record<string, never>;
  'queue_entry_cancelled.v1': Record<string, never>;
  'queue_entry_transferred.v1': Record<string, never>;
};

export type RenderNotificationTemplateInput = {
  [Id in NotificationTemplateId]: {
    templateId: Id;
    /** The outbox intent version is provenance, not the copy/template version. */
    sourceIntentVersion: number;
    locale?: string | null;
    variables: TemplateVariables[Id];
  };
}[NotificationTemplateId];

export interface RenderedNotificationTemplate {
  templateId: NotificationTemplateId;
  templateVersion: 1;
  sourceIntentVersion: number;
  locale: NotificationTemplateLocale;
  direction: NotificationTemplateDirection;
  title: string;
  body: string;
}

export class NotificationTemplateValidationError extends Error {}

type Copy = {
  title: string;
  body: (variables: Record<string, number>) => string;
};

const copies: Record<
  NotificationTemplateId,
  Record<NotificationTemplateLocale, Copy>
> = {
  'appointment_confirmed.v1': {
    fr: {
      title: 'Rendez-vous confirmé',
      body: () => 'Votre rendez-vous est confirmé.',
    },
    ar: { title: 'تم تأكيد الموعد', body: () => 'تم تأكيد موعدك.' },
  },
  'queue_entry_created.v1': {
    fr: {
      title: 'Ajout à la file d’attente',
      body: () =>
        'Votre inscription est enregistrée. Le moment de votre passage reste provisoire et peut évoluer.',
    },
    ar: {
      title: 'تمت إضافتك إلى قائمة الانتظار',
      body: () =>
        'تم تسجيلك في قائمة الانتظار. موعد دورك تقريبي وقد يتغير.',
    },
  },
  'estimate_changed_materially.v1': {
    fr: {
      title: 'Mise à jour de l’attente',
      body: ({ windowStartMinutes, windowEndMinutes }) =>
        `Votre attente provisoire est estimée entre ${windowStartMinutes} et ${windowEndMinutes} minutes. Cette estimation peut évoluer.`,
    },
    ar: {
      title: 'تحديث وقت الانتظار',
      body: ({ windowStartMinutes, windowEndMinutes }) =>
        `الانتظار التقديري حاليًا بين ${windowStartMinutes} و${windowEndMinutes} دقيقة، وقد يتغير هذا التقدير.`,
    },
  },
  'turn_approaching.v1': {
    fr: {
      title: 'Votre tour approche',
      body: ({ position }) =>
        `Il reste ${position} passage(s) avant votre tour.`,
    },
    ar: {
      title: 'اقترب دورك',
      body: ({ position }) => `تبقى ${position} قبلك.`,
    },
  },
  'patient_called.v1': {
    fr: {
      title: 'Votre tour est arrivé',
      body: () => 'Veuillez vous présenter au personnel de la clinique.',
    },
    ar: { title: 'حان دورك', body: () => 'يرجى التوجه إلى طاقم العيادة.' },
  },
  'session_delayed.v1': {
    fr: {
      title: 'Retard de la séance',
      body: ({ delayMinutes }) =>
        `La séance a environ ${delayMinutes} minutes de retard.`,
    },
    ar: {
      title: 'تأخر الجلسة',
      body: ({ delayMinutes }) => `تأخرت الجلسة بحوالي ${delayMinutes} دقيقة.`,
    },
  },
  'session_cancelled.v1': {
    fr: {
      title: 'Séance annulée',
      body: () =>
        'La séance a été annulée. Contactez la clinique pour la suite.',
    },
    ar: {
      title: 'تم إلغاء الجلسة',
      body: () => 'تم إلغاء الجلسة. يرجى التواصل مع العيادة.',
    },
  },
  'queue_entry_cancelled.v1': {
    fr: {
      title: 'Passage annulé',
      body: () => 'Votre passage dans la file d’attente a été annulé.',
    },
    ar: {
      title: 'تم إلغاء الدور',
      body: () => 'تم إلغاء دورك في قائمة الانتظار.',
    },
  },
  'queue_entry_transferred.v1': {
    fr: {
      title: 'File d’attente mise à jour',
      body: () => 'Votre passage a été transféré vers une autre séance.',
    },
    ar: {
      title: 'تم تحديث قائمة الانتظار',
      body: () => 'تم نقل دورك إلى جلسة أخرى.',
    },
  },
};

const variableNames: Record<NotificationTemplateId, readonly string[]> = {
  'appointment_confirmed.v1': [],
  'queue_entry_created.v1': [],
  'estimate_changed_materially.v1': ['windowStartMinutes', 'windowEndMinutes'],
  'turn_approaching.v1': ['position'],
  'patient_called.v1': [],
  'session_delayed.v1': ['delayMinutes'],
  'session_cancelled.v1': [],
  'queue_entry_cancelled.v1': [],
  'queue_entry_transferred.v1': [],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function resolveNotificationTemplateLocale(
  requested?: string | null,
): NotificationTemplateLocale {
  const normalized = requested?.trim().toLowerCase().replace('_', '-');
  if (normalized === 'ar' || normalized?.startsWith('ar-')) return 'ar';
  return 'fr';
}

/**
 * Renders privacy-minimal operational copy. The strict root and variable
 * allowlists intentionally reject contact, credential, provider and clinical data.
 */
export function renderNotificationTemplate(
  raw: RenderNotificationTemplateInput,
): RenderedNotificationTemplate {
  if (!isPlainObject(raw))
    throw new NotificationTemplateValidationError(
      'Invalid notification template input',
    );
  const rootKeys = Object.keys(raw);
  if (
    rootKeys.some(
      (key) =>
        !['templateId', 'sourceIntentVersion', 'locale', 'variables'].includes(
          key,
        ),
    )
  )
    throw new NotificationTemplateValidationError(
      'Invalid notification template input',
    );
  if (
    typeof raw.templateId !== 'string' ||
    !notificationTemplateIds.includes(raw.templateId as NotificationTemplateId)
  )
    throw new NotificationTemplateValidationError(
      'Unsupported notification template',
    );
  const templateId = raw.templateId as NotificationTemplateId;
  if (
    !Number.isSafeInteger(raw.sourceIntentVersion) ||
    raw.sourceIntentVersion <= 0
  )
    throw new NotificationTemplateValidationError(
      'Invalid notification template input',
    );
  if (
    raw.locale !== undefined &&
    raw.locale !== null &&
    typeof raw.locale !== 'string'
  )
    throw new NotificationTemplateValidationError(
      'Invalid notification template input',
    );
  if (
    !isPlainObject(raw.variables) ||
    Object.getOwnPropertySymbols(raw.variables).length > 0
  )
    throw new NotificationTemplateValidationError(
      'Invalid notification template variables',
    );

  const expected = variableNames[templateId];
  const actual = Object.keys(raw.variables);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  )
    throw new NotificationTemplateValidationError(
      'Invalid notification template variables',
    );
  const variables: Record<string, number> = {};
  const rawVariables = raw.variables as Record<string, unknown>;
  for (const name of expected) {
    const value = rawVariables[name];
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 0 ||
      (value as number) > MAX_OPERATIONAL_TEMPLATE_NUMBER
    )
      throw new NotificationTemplateValidationError(
        'Invalid notification template variables',
      );
    variables[name] = value as number;
  }
  if (
    templateId === 'estimate_changed_materially.v1' &&
    variables.windowEndMinutes < variables.windowStartMinutes
  )
    throw new NotificationTemplateValidationError(
      'Invalid notification template variables',
    );

  const locale = resolveNotificationTemplateLocale(raw.locale);
  const copy = copies[templateId][locale];
  return {
    templateId,
    templateVersion: 1,
    sourceIntentVersion: raw.sourceIntentVersion,
    locale,
    direction: locale === 'ar' ? 'rtl' : 'ltr',
    title: copy.title,
    body: copy.body(variables),
  };
}

/**
 * The guest transfer exchange URL is decrypted/resolved outside the general
 * renderer. This narrow composition path accepts only the expected HTTPS
 * exchange route, preventing arbitrary strings or credentials from crossing
 * the strict rendering boundary.
 */
export function composeGuestTransferExchangeLink(
  rendered: RenderedNotificationTemplate,
  exchangeUrl: string,
): RenderedNotificationTemplate {
  if (rendered.templateId !== 'queue_entry_transferred.v1')
    throw new NotificationTemplateValidationError(
      'Invalid guest transfer notification',
    );

  let parsed: URL;
  try {
    parsed = new URL(exchangeUrl);
  } catch {
    throw new NotificationTemplateValidationError(
      'Invalid guest transfer notification',
    );
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^\/g\/exchange\/[A-Za-z0-9_-]+$/.test(parsed.pathname)
  )
    throw new NotificationTemplateValidationError(
      'Invalid guest transfer notification',
    );

  return {
    ...rendered,
    body: `${rendered.body}\n${parsed.toString()}`,
  };
}
