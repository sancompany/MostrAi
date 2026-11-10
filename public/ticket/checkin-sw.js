// TICK — service worker do check-in (PWA). Guarda só a CASCA da página de
// check-in (HTML, scripts, estilo, leitor de QR e ícones) para ela abrir sem
// internet. Nenhuma resposta da API passa por aqui: os dados do check-in
// offline ficam no pacote que a própria página guarda (checkin-offline.js).
// Rede primeiro; sem rede, a cópia guardada.
const CACHE = 'tick-checkin-v1';
const CASCA = [
  '/ticket/checkin',
  '/ticket/comum.js',
  '/ticket/checkin-offline.js',
  '/ticket/checkin.page.js',
  '/ticket/ticket.css',
  '/ticket/jsqr.js',
  '/ticket/checkin.webmanifest',
  '/ticket/img/trimundi-logo.webp',
  '/ticket/img/trimundi-icone.png',
  '/ticket/img/tick-app-192.png',
  '/ticket/img/tick-app-512.png',
];

// Resposta que vale guardar: 200 de verdade, sem ter sido redirecionada
// (sem sessão, /ticket/checkin manda para /ticket/entrar — isso não fica).
const guardavel = (r) => r && r.ok && !r.redirected && r.type === 'basic';

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const url of CASCA) {
        try {
          const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
          if (guardavel(r)) await cache.put(url, r);
        } catch {}
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const caminho = url.pathname.replace(/\/+$/, '');
  if (!CASCA.includes(caminho)) return; // API e resto do site: direto na rede
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const r = await fetch(e.request);
        if (guardavel(r)) await cache.put(caminho, r.clone());
        return r;
      } catch {
        return (await cache.match(caminho)) || Response.error();
      }
    })(),
  );
});
