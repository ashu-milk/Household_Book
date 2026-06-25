// sw.js — オフラインキャッシュと「アンインストール不要の自動更新」を担う
//
// 更新の仕組み:
// 1. このファイル(sw.js)の中身を1バイトでも変えてデプロイすると、
//    ブラウザが起動時に自動でその差分を検知する(これはブラウザの標準動作)。
// 2. 新しいSWは install 時に新キャッシュ(CACHE_NAME)へ最新ファイル一式を取得する。
// 3. self.skipWaiting() により、ユーザー操作なしで即座に「待機中」をスキップして有効化。
// 4. activate 時に古いバージョンのキャッシュを削除し、self.clients.claim() で
//    今開いているページの制御も新SWに引き継ぐ。
// 5. app.js 側の 'controllerchange' イベントで1回だけ自動リロードし、
//    新しいHTML/CSS/JSが画面に反映される。
//
// → ユーザーはアプリを開くだけで、何もしなくても最新版に切り替わる。
//
// 【重要】コードを更新するたびに、下の CACHE_VERSION の数字を1つ増やしてください。
// このファイルのバイト内容が変わることで、ブラウザが更新を検知できます。
const CACHE_VERSION = 25;
const CACHE_NAME = `kakeibo-cache-v${CACHE_VERSION}`;

const APP_SHELL = [
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/charts.js',
  './js/export-import.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/header-icon-square.png',
  './icons/header-icon-square@2x.png',
  './icons/header-icon-square@3x.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// fetch戦略:
// - ナビゲーション（画面そのものを開くリクエスト）: 常に index.html を明示的に返す
//   ※ './' のような相対パスでキャッシュしたキーと、実際のリクエストURLの
//     キャッシュキーが一致しないことがあり、それが原因で誤ったキャッシュ内容
//     （JSファイルなど）が画面に表示されてしまう不具合を防ぐための対策。
// - 同一オリジンのその他アプリファイル: stale-while-revalidate（キャッシュを即返しつつ裏で最新化）
// - Google Fonts等の外部リソース: network-first、失敗時はキャッシュ
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ページ本体を開くリクエスト（タブを開く・リロードする等）は必ず index.html を返す
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        try {
          const fresh = await fetch('./index.html', { cache: 'no-store' });
          if (fresh && fresh.status === 200) {
            cache.put('./index.html', fresh.clone());
            return fresh;
          }
        } catch (err) {
          // オフライン時はキャッシュにフォールバック
        }
        const cachedIndex = await cache.match('./index.html');
        return cachedIndex || Response.error();
      })
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(req);
        const networkFetch = fetch(req)
          .then(res => {
            if (res && res.status === 200) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  } else {
    event.respondWith(
      fetch(req)
        .then(res => {
          caches.open(CACHE_NAME).then(cache => cache.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
