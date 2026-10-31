// Service Worker for LakshmiNaraya Expense Tracker
var CACHE_NAME = 'lakshminaraya-v1';
var STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install: cache local app shell
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Activate: clean up old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch: Network-first for Supabase / API requests, cache-fallback for local assets
self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);

  // Skip caching non-GET or chrome-extension or external analytics
  if (e.request.method !== 'GET') return;

  // Supabase requests: always go to network (IndexedDB handles offline data)
  if (url.origin.includes('supabase.co')) {
    return;
  }

  // Local assets: Stale-While-Revalidate
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      var fetchPromise = fetch(e.request).then(function(networkResponse) {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          var responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(function() {
        return cached;
      });

      return cached || fetchPromise;
    })
  );
});
