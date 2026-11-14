/* 学习小站的后台缓存：断网也能打开，图片和字体看到过就留着 */
var CACHE = "fish-study-v4";

var CORE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./vendor/katex/katex.min.css",
  "./vendor/katex/katex.min.js",
  "./vendor/katex/auto-render.min.js",
  "./vendor/pdfjs/pdf.min.js",
  "./vendor/pdfjs/pdf.worker.min.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 单个文件失败不整锅端
      return Promise.all(CORE.map(function (u) {
        return c.add(u).catch(function () { /* 少一个也能跑 */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;

  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 只接管自己站内的东西；智谱那些接口一个字都别碰
  if (url.origin !== self.location.origin) return;

  // 页面导航：断网时退回缓存的首页
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match("./index.html");
      })
    );
    return;
  }

  // 站内资源：先要最新的，网络不行了才退回缓存。
  // 以前是先给旧的、后台再更新，结果改一次代码要刷两遍才生效。
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) {
          c.put(req, copy).catch(function () {});
        });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || caches.match("./index.html");
      });
    })
  );
});
