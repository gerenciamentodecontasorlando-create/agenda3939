// sw.js - Agenda AH
const CACHE = 'agenda-ah-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async ()=>{
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k!==CACHE) ? caches.delete(k) : null));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== location.origin) return;

  event.respondWith((async ()=>{
    const cached = await caches.match(req);
    if (cached) return cached;

    try{
      const fresh = await fetch(req);
      if (req.method === 'GET' && fresh && fresh.status === 200){
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone());
      }
      return fresh;
    }catch(_e){
      return caches.match('./index.html');
    }
  })());
});
