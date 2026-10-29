// Minimal service worker so the app can be installed to the home screen.
// It deliberately caches nothing: every request goes to the network, so new deploys show up immediately.
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(event){ event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function(){});
