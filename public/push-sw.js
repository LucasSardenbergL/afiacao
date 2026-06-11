/**
 * Handlers de Web Push do Colacor — injetados no service worker gerado pelo
 * vite-plugin-pwa via `workbox.importScripts` (vite.config.ts). Plain JS:
 * roda no escopo do SW, sem bundler.
 *
 * Contrato do payload: ver src/lib/push/payload.ts (montarNotificacao) —
 * JSON { titulo, corpo, url, tag } enviado pela edge `enviar-push`.
 */

self.addEventListener('push', (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch {
    // payload não-JSON (não deveria acontecer) → notificação genérica
    dados = {};
  }

  const titulo = dados.titulo || 'Colacor';
  const opcoes = {
    body: dados.corpo || '',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: dados.tag || undefined,
    data: { url: dados.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      // App já aberto → foca e navega; senão abre janela nova.
      for (const cliente of lista) {
        if ('focus' in cliente) {
          cliente.focus();
          if ('navigate' in cliente && url !== '/') {
            cliente.navigate(url).catch(() => {});
          }
          return;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
