import { expect, test, type Page } from '@playwright/test';

// TAB-PWA-5a (#905): Notifications card states on /guest/status, fr and ar at
// 320 px, with Notification, PushManager and the service worker mocked.
test.use({ viewport: { width: 320, height: 640 } });

const KEY = 'B'.repeat(87);

type Mock = {
  permission: 'default' | 'granted' | 'denied';
  subscribed?: boolean;
  requestResult?: 'granted' | 'denied';
  pushManager?: boolean;
  userAgent?: string;
};

async function mockPush(page: Page, mock: Mock) {
  await page.addInitScript((m) => {
    const w = window as unknown as Record<string, unknown>;
    w.__calls = { requestPermission: 0, subscribe: 0, unsubscribe: 0 };
    const calls = w.__calls as Record<string, number>;
    let permission = m.permission;
    class FakeNotification {
      static get permission() {
        return permission;
      }
      static async requestPermission() {
        calls.requestPermission += 1;
        permission = m.requestResult ?? 'granted';
        return permission;
      }
    }
    w.Notification = FakeNotification;
    if (m.pushManager === false) delete w.PushManager;
    else w.PushManager = function PushManager() {};
    let sub: unknown = m.subscribed
      ? {
          endpoint: 'https://fcm.googleapis.com/fcm/send/mock',
          toJSON: () => ({
            endpoint: 'https://fcm.googleapis.com/fcm/send/mock',
            keys: { p256dh: 'p', auth: 'a' },
          }),
          unsubscribe: async () => {
            calls.unsubscribe += 1;
            sub = null;
            return true;
          },
        }
      : null;
    const registration = {
      pushManager: {
        getSubscription: async () => sub,
        subscribe: async () => {
          calls.subscribe += 1;
          sub = {
            endpoint: 'https://fcm.googleapis.com/fcm/send/mock',
            toJSON: () => ({
              endpoint: 'https://fcm.googleapis.com/fcm/send/mock',
              keys: { p256dh: 'p', auth: 'a' },
            }),
            unsubscribe: async () => {
              calls.unsubscribe += 1;
              sub = null;
              return true;
            },
          };
          return sub;
        },
      },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        register: async () => ({}),
      },
    });
    if (m.userAgent)
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: m.userAgent,
      });
  }, mock);
  await page.route('**/api/guest/status', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/guest/inbox*', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
}

async function mockKey(page: Page, status = 200) {
  await page.route('**/api/guest/push-subscription/key', (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(
        status === 200 ? { publicKey: KEY } : { error: 'push_unavailable' },
      ),
    }),
  );
}

const copies = {
  fr: {
    locale: 'fr-FR',
    available: 'Recevez une alerte quand votre tour approche.',
    enable: 'Activer les notifications',
    denied: 'Notifications bloquées dans le navigateur.',
    active: 'Notifications activées sur cet appareil.',
    disable: 'Désactiver',
    unsupported: 'Votre navigateur ne permet pas les notifications.',
    ios: 'Sur iPhone : touchez Partager',
    dir: 'ltr',
  },
  ar: {
    locale: 'ar',
    available: 'احصل على تنبيه عندما يقترب دورك.',
    enable: 'تفعيل الإشعارات',
    denied: 'الإشعارات محظورة في المتصفح.',
    active: 'الإشعارات مفعّلة على هذا الجهاز.',
    disable: 'إيقاف',
    unsupported: 'متصفحك لا يدعم الإشعارات.',
    ios: 'على iPhone: اضغط على مشاركة',
    dir: 'rtl',
  },
} as const;

for (const [name, c] of Object.entries(copies)) {
  test.describe(`${name} notifications card`, () => {
    test.use({ locale: c.locale });

    test('available: no prompt until the tap, then subscribes with the cookie only', async ({
      page,
    }) => {
      await mockPush(page, { permission: 'default' });
      await mockKey(page);
      let request: { headers: Record<string, string>; body: string } | null =
        null;
      await page.route('**/api/guest/push-subscription', async (route) => {
        request = {
          headers: route.request().headers(),
          body: route.request().postData() ?? '',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"subscribed":true}',
        });
      });
      await page.goto('/guest/status');
      const card = page.getByTestId('guest-push-card');
      await expect(card).toHaveAttribute('dir', c.dir);
      await expect(card.getByRole('status')).toHaveText(c.available);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __calls: Record<string, number> }).__calls
              .requestPermission,
        ),
      ).toBe(0);
      await card.getByRole('button', { name: c.enable }).click();
      await expect(card.getByRole('status')).toHaveText(c.active);
      await expect(card.getByRole('button', { name: c.disable })).toBeVisible();
      expect(request).not.toBeNull();
      const sent = request as unknown as {
        headers: Record<string, string>;
        body: string;
      };
      expect(sent.headers['authorization']).toBeUndefined();
      expect(JSON.parse(sent.body)).toMatchObject({
        endpoint: 'https://fcm.googleapis.com/fcm/send/mock',
        locale: name,
      });
      expect(page.url()).not.toContain('token');
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
    });

    test('active: turning off unbinds the server then the browser', async ({
      page,
    }) => {
      await mockPush(page, { permission: 'granted', subscribed: true });
      await mockKey(page);
      const methods: string[] = [];
      let body = '';
      await page.route('**/api/guest/push-subscription', async (route) => {
        methods.push(route.request().method());
        body = route.request().postData() ?? '';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"subscribed":false}',
        });
      });
      await page.goto('/guest/status');
      const card = page.getByTestId('guest-push-card');
      await expect(card.getByRole('status')).toHaveText(c.active);
      await card.getByRole('button', { name: c.disable }).click();
      await expect(card.getByRole('status')).toHaveText(c.available);
      // Page load re-binds the existing subscription before claiming active.
      expect(methods).toEqual(['POST', 'DELETE']);
      expect(JSON.parse(body)).toEqual({
        endpoint: 'https://fcm.googleapis.com/fcm/send/mock',
      });
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __calls: Record<string, number> }).__calls
              .unsubscribe,
        ),
      ).toBe(1);
    });

    test('an existing subscription whose binding was refused is not shown as active', async ({
      page,
    }) => {
      await mockPush(page, { permission: 'granted', subscribed: true });
      await mockKey(page);
      await page.route('**/api/guest/push-subscription', (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: '{"error":"Guest access rejected"}',
        }),
      );
      await page.goto('/guest/status');
      const card = page.getByTestId('guest-push-card');
      await expect(card.getByRole('status')).toHaveText(c.available);
      await expect(card.getByRole('button', { name: c.enable })).toBeVisible();
    });

    test('a refused binding shows an alert and leaves no browser subscription', async ({
      page,
    }) => {
      await mockPush(page, { permission: 'default' });
      await mockKey(page);
      await page.route('**/api/guest/push-subscription', (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: '{"error":"Guest access rejected"}',
        }),
      );
      await page.goto('/guest/status');
      const card = page.getByTestId('guest-push-card');
      await card.getByRole('button', { name: c.enable }).click();
      await expect(card.getByRole('alert')).toBeVisible();
      await expect(card.getByRole('status')).toHaveText(c.available);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __calls: Record<string, number> }).__calls
              .unsubscribe,
        ),
      ).toBe(1);
    });

    test('denied permission is explained without an action', async ({
      page,
    }) => {
      await mockPush(page, { permission: 'denied' });
      await mockKey(page);
      await page.goto('/guest/status');
      const card = page.getByTestId('guest-push-card');
      await expect(card.getByRole('status')).toContainText(c.denied);
      await expect(card.getByRole('button')).toHaveCount(0);
    });

    test('unsupported browser is explained without an action', async ({
      page,
    }) => {
      await mockPush(page, { permission: 'default', pushManager: false });
      await mockKey(page);
      await page.goto('/guest/status');
      const card = page.getByTestId('guest-push-card');
      await expect(card.getByRole('status')).toContainText(c.unsupported);
      await expect(card.getByRole('button')).toHaveCount(0);
    });

    test('iPhone outside the installed app gets the home-screen instruction', async ({
      page,
    }) => {
      await mockPush(page, {
        permission: 'default',
        pushManager: false,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)',
      });
      await mockKey(page);
      await page.goto('/guest/status');
      const card = page.getByTestId('guest-push-card');
      await expect(card.getByRole('status')).toContainText(c.ios);
      await expect(card.getByRole('button')).toHaveCount(0);
    });
  });
}

test('an unsupported iPhone gets no card when the server has no VAPID key', async ({
  page,
}) => {
  await mockPush(page, {
    permission: 'default',
    pushManager: false,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)',
  });
  await mockKey(page, 503);
  const keyResponse = page.waitForResponse(
    '**/api/guest/push-subscription/key',
  );
  await page.goto('/guest/status');
  expect((await keyResponse).status()).toBe(503);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await expect(page.getByTestId('guest-push-card')).toHaveCount(0);
});

test('the card is hidden when the server has no VAPID key', async ({
  page,
}) => {
  await mockPush(page, { permission: 'default' });
  await mockKey(page, 503);
  const keyResponse = page.waitForResponse(
    '**/api/guest/push-subscription/key',
  );
  await page.goto('/guest/status');
  expect((await keyResponse).status()).toBe(503);
  // Let the card's detection settle; the positive controls above prove the
  // same mocks do render the card when the key route answers 200.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await expect(page.getByTestId('guest-push-card')).toHaveCount(0);
});
