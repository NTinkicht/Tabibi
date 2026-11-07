import { describe, expect, it } from 'vitest';
import { applyDocumentLocale } from '../../src/app/DocumentLocaleSync';

describe('TAB-UI-01b applyDocumentLocale', () => {
  it('mirrors ar/fr onto lang and dir', () => {
    const root = { lang: 'ar', dir: 'rtl' };
    applyDocumentLocale(root, 'fr');
    expect(root).toEqual({ lang: 'fr', dir: 'ltr' });
    applyDocumentLocale(root, 'ar');
    expect(root).toEqual({ lang: 'ar', dir: 'rtl' });
  });
});
