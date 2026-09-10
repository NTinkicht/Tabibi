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

test('guest SSE change to terminal closes the stream and does not schedule fallback work', async ({
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

    const state = { created: 0, closed: 0, urls: [] as string[] };
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
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: TestEventSource,
    });
    Object.defineProperty(window, '__guestSseTerminalHarnessForTest', {
      configurable: true,
      value: {
        state,
        emitChange: () => instances.at(-1)?.emitChange(),
      },
    });
  });

  let polls = 0;
  await page.route('**/api/guest/status', async (route) => {
    polls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        polls === 1
          ? activeEligible
          : {
              generatedAt: '2026-09-10T09:00:15Z',
              terminal: true,
              finalStatus: 'completed',
            },
      ),
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
              __guestSseTerminalHarnessForTest: {
                state: { created: number; urls: string[] };
              };
            }
          ).__guestSseTerminalHarnessForTest.state,
      ),
    )
    .toMatchObject({
      created: 1,
      urls: ['/api/guest/status/stream'],
    });

  await page.evaluate(() => {
    (
      window as typeof window & {
        __guestSseTerminalHarnessForTest: { emitChange: () => void };
      }
    ).__guestSseTerminalHarnessForTest.emitChange();
  });

  await expect.poll(() => polls).toBe(2);
  await expect(page.getByText('Completed')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __guestSseTerminalHarnessForTest: {
                state: { created: number; closed: number };
              };
            }
          ).__guestSseTerminalHarnessForTest.state,
      ),
    )
    .toMatchObject({ created: 1, closed: 1 });

  await page.waitForTimeout(100);
  expect(polls).toBe(2);
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __guestSseTerminalHarnessForTest: {
              state: { created: number; closed: number };
            };
          }
        ).__guestSseTerminalHarnessForTest.state,
    ),
  ).toEqual({ created: 1, closed: 1, urls: ['/api/guest/status/stream'] });
});
