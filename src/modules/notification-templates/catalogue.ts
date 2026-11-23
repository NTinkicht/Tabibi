import {
  type NotificationTemplateId,
  type NotificationTemplateLocale,
  type RenderNotificationTemplateInput,
  notificationTemplateIds,
  renderNotificationTemplate,
} from './index';

// TAB-P1-06 slice 1: read-only catalogue of the exact patient-visible wording,
// so staff can tell what a delay or cancellation message says. Previews use
// fixed sample numbers only; no patient, queue or clinic data enters rendering.
const SAMPLE_VARIABLES: {
  [Id in NotificationTemplateId]: Extract<
    RenderNotificationTemplateInput,
    { templateId: Id }
  >['variables'];
} = {
  'appointment_confirmed.v1': {},
  'queue_entry_created.v1': {},
  'estimate_changed_materially.v1': {
    windowStartMinutes: 20,
    windowEndMinutes: 40,
  },
  'turn_approaching.v1': { position: 3 },
  'patient_called.v1': {},
  'session_delayed.v1': { delayMinutes: 15 },
  'session_cancelled.v1': {},
  'queue_entry_cancelled.v1': {},
  'queue_entry_transferred.v1': {},
};

export interface NotificationTemplateCataloguePreview {
  direction: 'rtl' | 'ltr';
  title: string;
  body: string;
}

export interface NotificationTemplateCatalogueEntry {
  templateId: NotificationTemplateId;
  variables: string[];
  previews: Record<
    NotificationTemplateLocale,
    NotificationTemplateCataloguePreview
  >;
}

export function notificationTemplateCatalogue(): NotificationTemplateCatalogueEntry[] {
  return notificationTemplateIds.map((templateId) => {
    const variables = SAMPLE_VARIABLES[templateId];
    const preview = (locale: NotificationTemplateLocale) => {
      const rendered = renderNotificationTemplate({
        templateId,
        sourceIntentVersion: 1,
        locale,
        variables,
      } as RenderNotificationTemplateInput);
      return {
        direction: rendered.direction,
        title: rendered.title,
        body: rendered.body,
      };
    };
    return {
      templateId,
      variables: Object.keys(variables),
      previews: { fr: preview('fr'), ar: preview('ar') },
    };
  });
}
