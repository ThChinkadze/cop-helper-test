// Работа без интернета. Этот файл браузер держит в фоне отдельно от страницы.
// Правило одно: сначала сеть, сохранённая копия — только когда сеть не ответила.
// Поэтому при работающем интернете сайт всегда свежий, как и без этого файла, а без интернета открывается
// таким, каким был загружен в последний раз. Статьи хранит сама страница (core.js) — здесь только файлы сайта и шрифт.
const CACHE = 'cop-helper-files-v1';
// Сколько ждать сеть, если сохранённая копия уже есть
const NETWORK_WAIT_MS = 5000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
    const request = e.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    const isOwn = url.origin === self.location.origin;
    const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
    // Таблица с базой и всё прочее идут мимо, как обычно
    if (!isOwn && !isFont) return;

    // У своих файлов метка времени (?v=…, ?fresh=…) в ключ не входит: копия у каждого файла одна
    const key = isOwn ? url.origin + url.pathname : request.url;
    // Если здесь что-то пойдёт не так, запрос уходит в сеть, как будто этого файла нет
    e.respondWith(networkFirst(request, key).catch(() => fetch(request)));
});

async function networkFirst(request, key) {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(key);

    const controller = new AbortController();
    const timer = saved ? setTimeout(() => controller.abort(), NETWORK_WAIT_MS) : null;
    try {
        const response = await fetch(request, { signal: controller.signal });
        if (response.ok) cache.put(key, response.clone()).catch(() => {});
        return response;
    } catch (error) {
        if (saved) return saved;
        throw error;
    } finally {
        clearTimeout(timer);
    }
}
