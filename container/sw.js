// AgentHost service worker: renders web-push notifications and focuses (or opens)
// the app when one is tapped. Registered at the root scope by the client
// (Service-Worker-Allowed: / on the /sw.js response) so it can receive pushes
// for the whole app. Zero dependencies; runs in the ServiceWorker global.
self.addEventListener("push", function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (err) { data = { body: e.data ? e.data.text() : "" }; }
  var title = data.title || "AgentHost";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    data: data,
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ("focus" in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
