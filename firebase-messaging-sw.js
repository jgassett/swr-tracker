/* Firebase Cloud Messaging — background push handler for SWR Tracker.
 * Registered separately from sw.js (the PWA cache worker) at its own scope.
 * Shows a notification for data-only messages sent by the backend. */
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDTfeTRBYN4WT-I7NtAyx8vfO7Tq0N-Tz0',
  authDomain: 'swr-tracker-54dfd.firebaseapp.com',
  projectId: 'swr-tracker-54dfd',
  storageBucket: 'swr-tracker-54dfd.firebasestorage.app',
  messagingSenderId: '333363468822',
  appId: '1:333363468822:web:a715bb7255d88f6a1cb337'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  self.registration.showNotification(d.title || 'SWR Tracker', {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || './' }
  });
});

/* Focus an open tab (or open one) when a notification is tapped. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if ('focus' in w) return w.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
