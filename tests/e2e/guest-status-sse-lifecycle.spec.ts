import { expect, test } from '@playwright/test';

const activeEligible = {
  generatedAt: '2026-09-10T09:00:00Z',
  terminal: false,
  publicDisplayLabel: 'G-018',
  queueState: 'checked_in',
  clinicTimezone: 'Africa/Algiers',
  patientsAhead: 2,
  positionKind: 'live' as const,
  arrivalWindow: null,
  session: { status: 'open', declaredDelayMinutes: null },
};

test('guest SSE change and error paths canonical-refetch without credential-bearing URLs', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) =>
      nativeSetTimeout(
        handler,
        timeout === 30_000 ? 10 : timeout,
        ...args,
      )) as typeof window.setTimeout;

    const state = {
      created: 0,
      closed: 0,
      urls: [] as string[],
    };
    const instances: TestEventSource[] = [];

    class TestEventSource {
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
      private readonly listeners = new Map<string, EventListener[]>();

      constructor(url: string | URL) {
        state.created += 1;
        state.urls.push(String(url));
        instances.push(this);
      }

      addEventListener(type: string, listener: EventListener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      close() {
        state.closed += 1;
      }

      emitChange() {
        for (const listener of this.listeners.get('change') ?? []) {
          listener(new MessageEvent('change', { data: '{}' }));
        }
      }

      fail() {
        this.onerror?.call(this as unknown as EventSource, new Event('error'));
      }
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: TestEventSource,
    });
    Object.defineProperty(window, '__guestSseHarnessForTest', {
      configurable: true,
      value: {
        state,
        emitChange: () => instances.at(-1)?.emitChange(),
        fail: () => instances.at(-1)?.fail(),
      },
    });
  });

  let polls = 0;
  await page.route('**/api/guest/status', async (route) => {
    polls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...activeEligible,
        generatedAt: `2026-09-10T09:00:0${Math.min(polls, 9)}Z`,
        patientsAhead: polls === 1 ? 2 : 1,
      }),
    });
  });

  await page.goto('/guest/status');
  await expect(page.getByText('Patients ahead: 2')).toBeVisible();
  await expect.poll(() => polls).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __guestSseHarnessForTest: {
                state: { created: number; urls: string[] };
              };
            }
          ).__guestSseHarnessForTest.state.created,
      ),
    )
    .toBe(1);

  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __guestSseHarnessForTest: { state: { urls: string[] } };
          }
        ).__guestSseHarnessForTest.state.urls[0],
    ),
  ).toBe('/api/guest/status/stream');

  await page.evaluate(() => {
    (
      window as typeof window & {
        __guestSseHarnessForTest: { emitChange: () => void };
      }
    ).__guestSseHarnessForTest.emitChange();
  });

  await expect.poll(() => polls).toBe(2);
  await expect(page.getByText('Patients ahead: 1')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __guestSseHarnessForTest: { state: { created: number } };
            }
          ).__guestSseHarnessForTest.state.created,
      ),
    )
    .toBe(2);

  await page.evaluate(() => {
    (
      window as typeof window & {
        __guestSseHarnessForTest: { fail: () => void };
      }
    ).__guestSseHarnessForTest.fail();
  });

  await expect.poll(() => polls).toBe(3);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __guestSseHarnessForTest: {
                state: { created: number; closed: number; urls: string[] };
              };
            }
          ).__guestSseHarnessForTest.state,
      ),
    )
    .toMatchObject({ created: 3, closed: 2 });

  expect(
    await page.evaluate(() =>
      (
        window as typeof window & {
          __guestSseHarnessForTest: { state: { urls: string[] } };
        }
      ).__guestSseHarnessForTest.state.urls.every(
        (url) => url === '/api/guest/status/stream',
      ),
    ),
  ).toBe(true);
});
