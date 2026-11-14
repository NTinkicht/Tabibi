import { describe, expect, it, vi } from 'vitest';

const permanentRedirect = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
);
vi.mock('next/navigation', () => ({ permanentRedirect }));

import FindDoctorRedirect from '@/app/find/page';

describe('/find legacy path', () => {
  it('permanently redirects to the home page', () => {
    expect(() => FindDoctorRedirect()).toThrow('NEXT_REDIRECT');
    expect(permanentRedirect).toHaveBeenCalledWith('/');
  });
});
