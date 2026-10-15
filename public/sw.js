// Service worker: only shows panel notifications and focuses the panel when one is tapped. No caching.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',e=>{
 e.notification.close();
 e.waitUntil((async()=>{const all=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const c of all){c.postMessage({type:'open',data:e.notification.data});return c.focus();}
  return self.clients.openWindow('/');})());
});
