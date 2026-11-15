// Tabibi guest service worker (TAB-PWA-1, docs/design/pwa-push.md section 1).
// Handles ONLY push, notificationclick and pushsubscriptionchange. It has no
// fetch handler and never touches Cache Storage, so no status, queue or
// patient data is stored on the device by this worker.
'use strict';

var TITLE_MAX = 80;
var BODY_MAX = 240;

// Same-origin allow-list for notification targets. Returns a normalised
// path+query, or the status page for anything else.
function safeTarget(raw) {
  var fallback = '/guest/status';
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return fallback;
  }
  var u;
  try {
    u = new URL(raw, self.location.origin);
  } catch (e) {
    return fallback;
  }
  if (u.origin !== self.location.origin) return fallback;
  if (u.username || u.password) return fallback;
  if (
    u.pathname === '/guest/status' ||
    u.pathname.indexOf('/api/guest/exchange/') === 0
  ) {
    return u.pathname + u.search;
  }
  return fallback;
}

function parsePush(event) {
  var data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (e) {
    data = null;
  }
  if (!data || typeof data !== 'object' || data.v !== 1) return null;
  if (data.kind !== 'status' && data.kind !== 'link') return null;
  if (typeof data.body !== 'string' || data.body.length === 0) return null;
  var title =
    typeof data.title === 'string' && data.title.length > 0
      ? data.title.slice(0, TITLE_MAX)
      : 'Tabibi';
  var body = data.body.slice(0, BODY_MAX);
  var lang =
    data.lang === 'ar' || data.lang === 'fr'
      ? data.lang
      : /[؀-ۿ]/.test(body)
        ? 'ar'
        : 'fr';
  return {
    title: title,
    options: {
      body: body,
      tag: typeof data.tag === 'string' ? data.tag.slice(0, 64) : data.kind,
      lang: lang,
      dir: lang === 'ar' ? 'rtl' : 'ltr',
      icon: '/icons/icon-192.png',
      data: { url: safeTarget(data.url) },
    },
  };
}

self.addEventListener('push', function (event) {
  var parsed = parsePush(event);
  if (!parsed) return;
  event.waitUntil(
    self.registration.showNotification(parsed.title, parsed.options),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = safeTarget(
    event.notification.data && event.notification.data.url,
  );
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (windows) {
        for (var i = 0; i < windows.length; i += 1) {
          var w = windows[i];
          var path = '';
          try {
            path = new URL(w.url).pathname;
          } catch (e) {
            path = '';
          }
          if (target === '/guest/status' && path === '/guest/status') {
            return w.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});

self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    (function () {
      var oldSub = event.oldSubscription || null;
      var newSubPromise = event.newSubscription
        ? Promise.resolve(event.newSubscription)
        : oldSub && oldSub.options
          ? self.registration.pushManager.subscribe(oldSub.options)
          : Promise.resolve(null);
      return newSubPromise
        .then(function (newSub) {
          if (!newSub) return undefined;
          return fetch('/api/guest/push-subscription/renew', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              oldSubscription: oldSub ? oldSub.toJSON() : null,
              newSubscription: newSub.toJSON(),
            }),
          });
        })
        .catch(function () {
          // No credential or no route yet: the page re-subscribes when next opened.
        });
    })(),
  );
});
