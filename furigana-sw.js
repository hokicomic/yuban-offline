// Cache only bundled dictionary assets; do not intercept user media or pages.
const cacheName='yuban-kuromoji-0.1.2-v1';
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url),root=new URL('./assets/kuromoji/',self.registration.scope);
 if(url.origin!==root.origin || (!url.pathname.startsWith(root.pathname) && url.pathname!==new URL('./furigana-worker.js',self.registration.scope).pathname) || event.request.method!=='GET')return;
 event.respondWith(caches.open(cacheName).then(async cache=>{
  const saved=await cache.match(event.request);if(saved)return saved;
  const response=await fetch(event.request);if(response.ok)await cache.put(event.request,response.clone());return response;
 }));
});
