// Minimal service worker so the launcher is installable as a PWA. No caching:
// the launcher must always reflect the live project list, and every request is
// gated by the platform's admin session at the edge.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
