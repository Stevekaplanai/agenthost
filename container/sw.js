// AgentHost service worker: renders web-push notifications and focuses (or opens)
// the app when one is tapped. Registered at the root scope by the client
// (Service-Worker-Allowed: / on the /sw.js response) so it can receive pushes
// for the whole app. Zero dependencies; runs in the ServiceWorker global.
self.addEventListener("install", function (e) {
  // A waiting old worker can still open a retired route. Take over this
  // boot-fixed release as soon as its bytes are installed.
  e.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});

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
  // Deep link: a push may carry data.url (e.g. "/?task=t_abc123") so tapping
  // it opens the app right at the thing that needs Steve -- the board scrolled to
  // that card in the generated shell. Build the target from the push data;
  // default to the shell root. A review push adds ?task=<id>.
  var data = (e.notification && e.notification.data) || {};
  var target = "/";
  if (typeof data.url === "string" && data.url.indexOf("/") === 0) {
    try {
      var candidate = new URL(data.url, self.location.origin);
      if (candidate.origin === self.location.origin) {
        // Only the three live human entry paths survive the cutover. Old
        // workers/payloads may still name /chat, /kanban, /settings, etc.; keep
        // their query/hash context but land them at the canonical shell root.
        var livePath = candidate.pathname === "/audit" || candidate.pathname === "/2fa"
          ? candidate.pathname
          : "/";
        target = livePath + candidate.search + candidate.hash;
      }
    } catch (err) {}
  }
  if (data.taskId && target.indexOf("task=") === -1) {
    target += (target.indexOf("?") === -1 ? "?" : "&") + "task=" + encodeURIComponent(data.taskId);
  }
  var targetPath = target.split("?")[0];
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      // Prefer focusing an already-open app window and navigating it to target
      // (so we don't stack duplicate tabs); else open a fresh window at target.
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ("focus" in c) {
          if ("navigate" in c) { try { return c.navigate(target).then(function () { return c.focus(); }); } catch (err) {} }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
