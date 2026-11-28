// TAB-P1-06 slice 4: allow-list view of the read-only template catalogue API.
// Only these fields ever reach the DOM; anything else in a response is dropped.
export type TemplatePreview = {
  direction: 'rtl' | 'ltr';
  title: string;
  body: string;
};
export type TemplateView = {
  templateId: string;
  variables: string[];
  previews: { fr: TemplatePreview; ar: TemplatePreview };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPreview(value: unknown): TemplatePreview | null {
  if (!isRecord(value)) return null;
  const { direction, title, body } = value;
  if (direction !== 'rtl' && direction !== 'ltr') return null;
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  return { direction, title, body };
}

export function toTemplateViews(payload: unknown): TemplateView[] {
  if (!isRecord(payload) || !Array.isArray(payload.templates)) return [];
  const views: TemplateView[] = [];
  for (const entry of payload.templates) {
    if (!isRecord(entry) || typeof entry.templateId !== 'string') continue;
    if (!isRecord(entry.previews)) continue;
    const fr = toPreview(entry.previews.fr);
    const ar = toPreview(entry.previews.ar);
    if (!fr || !ar) continue;
    const variables = Array.isArray(entry.variables)
      ? entry.variables.filter(
          (name): name is string => typeof name === 'string',
        )
      : [];
    views.push({
      templateId: entry.templateId,
      variables,
      previews: { fr, ar },
    });
  }
  return views;
}
