const VERSION = 'zvanets-sb-36';
const CORE = ['./', 'index.html', 'config.js', 'lib.js', 'manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const SCOPE = self.registration.scope;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
  });
}

async function networkFirst(req, key, ms) {
  const cache = await caches.open(VERSION);
  const net = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then((res) => {
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  });
  try {
    return await withTimeout(net, ms);
  } catch (err) {
    const hit = await cache.match(key);
    return hit || net;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || net;
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/config.js')) { e.respondWith(networkFirst(req, new URL('config.js', SCOPE).href, 3000)); return; }
    if (req.mode === 'navigate') { e.respondWith(networkFirst(req, SCOPE, 3000)); return; }
    e.respondWith(staleWhileRevalidate(req));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req));
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const show = self.registration.showNotification(d.title || 'Звънец', { body: d.body || '', tag: d.tag || undefined, icon: 'icon-192.png', lang: 'bg', data: { url: d.url || './' } });
  // Open copies of the app reload the timetable right away, so a change shows up without waiting for the next poll.
  const tell = self.clients.matchAll({ type: 'window' }).then((list) => list.forEach((c) => c.postMessage({ zv: 'refresh' })));
  e.waitUntil(Promise.all([show, tell.catch(() => {})]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', SCOPE).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(SCOPE) && 'focus' in c) { c.postMessage({ zv: 'open', url }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
