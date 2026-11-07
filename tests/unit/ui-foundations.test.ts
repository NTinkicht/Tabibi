import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, Chip, SegmentedControl, StatusBar } from '../../src/app/ui';
import {
  documentDirection,
  documentLocaleFromHeader,
  documentLocaleFromQuery,
} from '../../src/app/document-locale';

const css = readFileSync('src/app/tokens.css', 'utf8');
const tokens = new Map(
  [...css.matchAll(/--tb-([a-z-]+):\s*(#[0-9A-Fa-f]{6});/g)].map((m) => [
    m[1],
    m[2],
  ]),
);

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('design tokens', () => {
  it.each([
    ['text', 'ground'],
    ['text', 'surface'],
    ['text-secondary', 'surface'],
    ['text-muted', 'surface'],
    ['text-muted', 'ground'],
    ['surface', 'primary'],
    ['primary-strong', 'primary-tint'],
    ['info', 'info-tint'],
    ['warning-text', 'warning-tint'],
    ['priority-text', 'priority-tint'],
    ['danger', 'surface'],
    ['disabled-text', 'disabled-bg'],
    ['text-secondary', 'disabled-bg'],
    ['text', 'segmented-selected-bg'],
    ['surface', 'inverse'],
  ])('%s on %s has contrast of at least 4.5:1', (fg, bg) => {
    expect(tokens.has(fg) && tokens.has(bg)).toBe(true);
    expect(contrast(tokens.get(fg)!, tokens.get(bg)!)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('defines every colour token of the foundations spec', () => {
    const spec = readFileSync('docs/design/foundations.md', 'utf8');
    const documented = [
      ...spec.matchAll(/^\| `--tb-([a-z-]+)` \| `(#[0-9A-F]{6})`/gm),
    ];
    expect(documented.length).toBeGreaterThanOrEqual(25);
    for (const [, name, value] of documented) {
      expect(tokens.get(name)?.toUpperCase()).toBe(value);
    }
  });
});

describe('shared components', () => {
  it('Button renders a real button and a real disabled attribute', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { variant: 'danger', disabled: true }, 'x'),
    );
    expect(html).toContain('<button type="button"');
    expect(html).toContain('tb-button--danger');
    expect(html).toContain('disabled=""');
    expect(
      renderToStaticMarkup(createElement(Button, null, 'x')),
    ).not.toContain('disabled');
  });

  it('Chip is non-interactive', () => {
    const html = renderToStaticMarkup(
      createElement(Chip, { tone: 'called', children: 'c' }),
    );
    expect(html.startsWith('<span')).toBe(true);
    expect(html).not.toContain('button');
  });

  it('SegmentedControl marks only the selected option aria-pressed', () => {
    const html = renderToStaticMarkup(
      createElement(SegmentedControl, {
        value: 'b',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      }),
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>B</);
  });

  it('StatusBar exposes role=status', () => {
    expect(
      renderToStaticMarkup(createElement(StatusBar, { children: 'done' })),
    ).toContain('role="status"');
  });
});

describe('document locale', () => {
  it('maps fr to ltr and everything else to ar rtl', () => {
    expect(documentLocaleFromQuery(new URLSearchParams('lang=fr'))).toBe('fr');
    expect(documentLocaleFromQuery(new URLSearchParams('locale=fr'))).toBe(
      'fr',
    );
    expect(documentLocaleFromQuery(new URLSearchParams('lang=en'))).toBe('ar');
    expect(documentLocaleFromQuery(new URLSearchParams(''))).toBe('ar');
    expect(documentLocaleFromHeader('fr')).toBe('fr');
    expect(documentLocaleFromHeader('<x>')).toBe('ar');
    expect(documentDirection('ar')).toBe('rtl');
    expect(documentDirection('fr')).toBe('ltr');
  });
});
