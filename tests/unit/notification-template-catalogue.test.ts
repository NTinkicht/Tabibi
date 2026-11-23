import { describe, expect, it } from 'vitest';
import { notificationTemplateIds } from '@/modules/notification-templates';
import { notificationTemplateCatalogue } from '@/modules/notification-templates/catalogue';

describe('notification template catalogue (TAB-P1-06 slice 1)', () => {
  const catalogue = notificationTemplateCatalogue();

  it('lists every template id exactly once with FR and AR previews', () => {
    expect(catalogue.map((entry) => entry.templateId)).toEqual([
      ...notificationTemplateIds,
    ]);
    for (const entry of catalogue) {
      expect(entry.previews.fr.direction).toBe('ltr');
      expect(entry.previews.ar.direction).toBe('rtl');
      expect(entry.previews.fr.title.length).toBeGreaterThan(0);
      expect(entry.previews.ar.body.length).toBeGreaterThan(0);
    }
  });

  it('shows the sample delay in both languages (positive control)', () => {
    const delayed = catalogue.find(
      (entry) => entry.templateId === 'session_delayed.v1',
    );
    expect(delayed?.variables).toEqual(['delayMinutes']);
    expect(delayed?.previews.fr.body).toContain('15');
    expect(delayed?.previews.ar.body).toContain('15');
  });

  it('is deterministic and carries only operational copy', () => {
    expect(notificationTemplateCatalogue()).toEqual(catalogue);
    expect(JSON.stringify(catalogue)).not.toMatch(/https?:|@|bearer/i);
  });
});
