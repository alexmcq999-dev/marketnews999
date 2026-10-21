"""Старый адрес (GitHub Pages) после переезда на Cloudflare Pages.

python tools/redirect_site.py site ghp https://mcqcryptonews.pages.dev/

• любая страница старого адреса → тот же путь, query и #hash на новом адресе (в Telegram в #hash лежат данные входа);
• data/ копируется как есть — внешние скрипты (бот сигналов) продолжают читать data/app.json по старой ссылке;
• sw.js чистит кэш установленного приложения и снимает себя, чтобы старый PWA тоже ушёл на новый адрес.
"""
import html
import json
import os
import shutil
import sys

PAGE = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>McQCryptoNews переехал</title>
<link rel="canonical" href="{url_attr}">
<script>
(function () {{
  var to = {url_js};
  var base = {base_js};
  var p = location.pathname;
  var rest = p.indexOf(base) === 0 ? p.slice(base.length) : p.replace(/^\\//, "");
  if (rest === "index.html") rest = "";
  location.replace(to + rest + location.search + location.hash);
}})();
</script>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fafafa;
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;padding:24px}}
a{{color:#f5c451}}</style>
</head><body>
<p>McQCryptoNews переехал на новый адрес.<br><a href="{url_attr}">Открыть {host}</a></p>
</body></html>
"""

SW = """/* старый адрес: чистим кэш и снимаем service worker — приложение уйдёт на новый адрес */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
    .then(() => self.registration.unregister())
    .then(() => self.clients.matchAll({ type: "window" }))
    .then((cs) => cs.forEach((c) => c.navigate(c.url))));
});
"""


def main(site: str, out: str, url: str, base: str) -> None:
    url = url.rstrip("/") + "/"
    base = "/" + base.strip("/") + "/" if base.strip("/") else "/"
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    page = PAGE.format(url_attr=html.escape(url, quote=True), url_js=json.dumps(url), base_js=json.dumps(base),
                       host=html.escape(url.split("//", 1)[-1].rstrip("/")))
    for name in ("index.html", "404.html", "privacy.html"):
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            f.write(page)
    with open(os.path.join(out, "sw.js"), "w", encoding="utf-8") as f:
        f.write(SW)
    if os.path.isdir(os.path.join(site, "data")):
        shutil.copytree(os.path.join(site, "data"), os.path.join(out, "data"))
    open(os.path.join(out, ".nojekyll"), "w").close()
    print(f"redirect site: {out} → {url} (base {base})")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise SystemExit("usage: redirect_site.py SITE_DIR OUT_DIR NEW_URL [OLD_BASE_PATH]")
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")
