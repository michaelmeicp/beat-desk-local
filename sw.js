// Cache only the shipped app shell, never runtime audio or user content.
const CACHE='beatdesk-shell-v1-'+self.registration.scope;
const paths=['./','./index.html','./style.css','./app.mjs','./state.mjs','./engine.mjs'].map(p=>new URL(p,self.registration.scope).href);
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(paths)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||!paths.includes(e.request.url))return;e.respondWith(fetch(e.request).then(async r=>{if(r.ok){const c=await caches.open(CACHE);await c.put(e.request,r.clone())}return r}).catch(()=>caches.match(e.request)))});
