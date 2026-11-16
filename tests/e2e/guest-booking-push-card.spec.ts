import { expect, test, type Page } from '@playwright/test';

// TAB-PWA-5c (#887): the Notifications card on the booking confirmation sends
// the memory-only booking bearer in Authorization, fr and ar at 320 px, with
// Notification, PushManager and the service worker mocked.
test.use({ viewport: { width: 320, height: 640 } });

const BEARER = 'booking-push-private-bearer.signature';
const KEY = 'B'.repeat(87);
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/mock';

async function mockPush(page: Page) {
  await page.addInitScript((endpoint) => {
    const w = window as unknown as Record<string, unknown>;
    let permission = 'default';
    class FakeNotification {
      static get permission() {
        return permission;
      }
      static async requestPermission() {
        permission = 'granted';
        return permission;
      }
    }
    w.Notification = FakeNotification;
    w.PushManager = function PushManager() {};
    let sub: unknown = null;
    const make = () => ({
      endpoint,
      toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: async () => {
        sub = null;
        return true;
      },
    });
    const registration = {
      pushManager: {
        getSubscription: async () => sub,
        subscribe: async () => (sub = make()),
      },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        register: async () => ({}),
      },
    });
  }, ENDPOINT);
  await page.route('**/api/guest/push-subscription/key', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ publicKey: KEY }),
    }),
  );
  await page.route('**/api/public/bookings', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ queueLabel: 'G-905', guestBearer: BEARER }),
    }),
  );
  await page.route('**/api/public/bookings/live-queue-status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    }),
  );
}

const cases = {
  fr: {
    locale: 'fr-FR',
    nameLabel: 'Votre nom',
    submit: 'Confirmer la réservation',
    available: 'Recevez une alerte quand votre tour approche.',
    enable: 'Activer les notifications',
    active: 'Notifications activées sur cet appareil.',
    disable: 'Désactiver',
    dir: 'ltr',
  },
  ar: {
    locale: 'ar-DZ',
    nameLabel: 'اسمك',
    submit: 'تأكيد الحجز',
    available: 'احصل على تنبيه عندما يقترب دورك.',
    enable: 'تفعيل الإشعارات',
    active: 'الإشعارات مفعّلة على هذا الجهاز.',
    disable: 'إيقاف',
    dir: 'rtl',
  },
} as const;

for (const [name, c] of Object.entries(cases)) {
  test.describe(`${name} booking confirmation notifications card`, () => {
    test.use({ locale: c.locale });

    test('subscribes and unsubscribes with the booking bearer only', async ({
      page,
    }) => {
      await mockPush(page);
      const calls: { method: string; headers: Record<string, string> }[] = [];
      await page.route('**/api/guest/push-subscription', (route) => {
        calls.push({
          method: route.request().method(),
          headers: route.request().headers(),
        });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"subscribed":true}',
        });
      });
      // A leftover status cookie must not travel with the bearer.
      await page.context().addCookies([
        {
          name: 'stale_status_cookie',
          value: 'x',
          url: 'http://127.0.0.1:3000',
        },
      ]);
      await page.goto('/guest/live-queue/test-selection-ref');
      await expect(page.getByTestId('guest-push-card')).toHaveCount(0);
      await page.getByLabel(c.nameLabel).fill('Guest');
      await page.locator('input[type="tel"]').fill('0555555555');
      await page.getByRole('button', { name: c.submit }).click();
      const card = page.getByTestId('guest-push-card');
      await expect(card).toHaveAttribute('dir', c.dir);
      await expect(card.getByRole('status')).toHaveText(c.available);
      expect(calls).toHaveLength(0);
      await card.getByRole('button', { name: c.enable }).click();
      await expect(card.getByRole('status')).toHaveText(c.active);
      await card.getByRole('button', { name: c.disable }).click();
      await expect(card.getByRole('button', { name: c.enable })).toBeVisible();
      expect(calls.map((x) => x.method)).toEqual(['POST', 'DELETE']);
      for (const call of calls) {
        expect(call.headers['authorization']).toBe(`Bearer ${BEARER}`);
        expect(call.headers['cookie']).toBeUndefined();
      }
      expect(page.url()).not.toContain(BEARER);
      expect(await page.locator('body').innerText()).not.toContain(BEARER);
      const stored = await page.evaluate(
        () =>
          JSON.stringify(Object.entries(localStorage)) +
          JSON.stringify(Object.entries(sessionStorage)),
      );
      expect(stored).not.toContain(BEARER);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
    });
  });
}
