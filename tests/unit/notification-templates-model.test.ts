import { describe, expect, it } from 'vitest';
import { toTemplateViews } from '@/app/operations/[clinicId]/notifications/templates/templates-model';
import { notificationTemplateCatalogue } from '@/modules/notification-templates/catalogue';

const preview = { direction: 'ltr', title: 'T', body: 'B' };

describe('toTemplateViews', () => {
  it('keeps every entry of the real catalogue (positive control)', () => {
    const catalogue = notificationTemplateCatalogue();
    const views = toTemplateViews({ templates: catalogue });
    expect(views).toHaveLength(catalogue.length);
    expect(views[0]).toEqual({
      templateId: catalogue[0].templateId,
      variables: catalogue[0].variables,
      previews: catalogue[0].previews,
    });
  });

  it('drops unknown fields so nothing else can reach the page', () => {
    const [view] = toTemplateViews({
      templates: [
        {
          templateId: 'x.v1',
          variables: ['position'],
          previews: { fr: preview, ar: { ...preview, direction: 'rtl' } },
          patientPhone: '+213000',
        },
      ],
    });
    expect(Object.keys(view).sort()).toEqual([
      'previews',
      'templateId',
      'variables',
    ]);
    expect(JSON.stringify(view)).not.toContain('+213000');
  });

  it('drops malformed entries and non-string variables', () => {
    const views = toTemplateViews({
      templates: [
        null,
        { templateId: 7, previews: {} },
        { templateId: 'a', previews: { fr: preview } },
        {
          templateId: 'b',
          previews: { fr: preview, ar: { ...preview, direction: 'up' } },
        },
        {
          templateId: 'ok',
          variables: ['n', 3],
          previews: { fr: preview, ar: preview },
        },
      ],
    });
    expect(views.map((v) => v.templateId)).toEqual(['ok']);
    expect(views[0].variables).toEqual(['n']);
  });

  it('returns an empty list for non-catalogue payloads', () => {
    expect(toTemplateViews(null)).toEqual([]);
    expect(toTemplateViews({})).toEqual([]);
    expect(toTemplateViews({ templates: 'x' })).toEqual([]);
  });
});
