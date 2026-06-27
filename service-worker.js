var CACHE = 'mezza-scorecard-v1';
var SHELL = ['/', '/index.html', '/icons/icon-192.png', '/icons/icon-512.png'];

// Cache app shell on install
self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

// Remove old caches on activate
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

// Network-first for Google Sheets data; cache-first for everything else
self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  var isData = url.includes('docs.google.com') || url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com') || url.includes('cdn.jsdelivr.net') || url.includes('squarespace-cdn.com');
  if (isData) {
    e.respondWith(fetch(e.request).catch(function() { return caches.match(e.request); }));
  } else {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        return cached || fetch(e.request).then(function(res) {
          return caches.open(CACHE).then(function(c) { c.put(e.request, res.clone()); return res; });
        });
      })
    );
  }
});
