"""Старый адрес (GitHub Pages) после переезда на Cloudflare Pages.

python tools/redirect_site.py site ghp https://mcqcryptonews.pages.dev/ /marketnews999/

• Внутри Telegram мини-приложение остаётся на старом адресе: Telegram связывает мини-приложение с адресом,
  с которого его открыли (кнопки в старых сообщениях, меню), и после перехода на другой домен часть клиентов
  перестаёт принимать команды приложения (openLink, «Назад», оплата). Поэтому здесь лежит полная копия приложения.
• Всех остальных (браузер, установленное приложение) страница сразу переводит на новый адрес —
  путь, параметры и #hash сохраняются.
• sw.js снимает себя и чистит кэш, чтобы установленное со старого адреса приложение тоже ушло на новый.
• data/ лежит как есть — внешние скрипты читают data/app.json по старой ссылке.
"""
import html
import json
import os
import re
import shutil
import sys

# в Telegram данные запуска приходят в #tgWebAppData=… (или уже сохранены telegram-web-app.js в sessionStorage)
GO = """<script>
(function () {{
  var always = {always_js};
  var inTG = /tgWebApp/.test(location.hash) || /tgWebApp/.test(location.search);
  try {{ inTG = inTG || !!sessionStorage.getItem("__telegram__initParams"); }} catch (e) {{}}
  if (inTG && !always) return;
  var to = {url_js}, base = {base_js}, p = location.pathname;
  var rest = p.indexOf(base) === 0 ? p.slice(base.length) : p.replace(/^\\//, "");
  if (rest === "index.html") rest = "";
  location.replace(to + rest + location.search + location.hash);
}})();
</script>"""

PAGE = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>McQCryptoNews переехал</title>
<link rel="canonical" href="{url_attr}">
{go}
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
    shutil.copytree(site, out)
    go = GO.format(url_js=json.dumps(url), base_js=json.dumps(base), always_js="false")
    go_always = GO.format(url_js=json.dumps(url), base_js=json.dumps(base), always_js="true")
    # приложение: переадресация для всех, кроме Telegram — первым скриптом в <head>
    idx = os.path.join(out, "index.html")
    with open(idx, encoding="utf-8") as f:
        s = f.read()
    s, n = re.subn(r"(<meta charset=[^>]*>)", lambda m: m.group(1) + "\n" + go, s, count=1)
    if not n:
        s, n = re.subn(r"(<head[^>]*>)", lambda m: m.group(1) + "\n" + go, s, count=1)
    if not n:
        raise SystemExit("index.html: нет <head>")
    with open(idx, "w", encoding="utf-8") as f:
        f.write(s)
    page = PAGE.format(url_attr=html.escape(url, quote=True), go=go_always,
                       host=html.escape(url.split("//", 1)[-1].rstrip("/")))
    for name in ("404.html", "privacy.html"):
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            f.write(page)
    with open(os.path.join(out, "sw.js"), "w", encoding="utf-8") as f:
        f.write(SW)
    open(os.path.join(out, ".nojekyll"), "w").close()
    print(f"old address: {out} → {url} (base {base}); Telegram stays on the old address")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise SystemExit("usage: redirect_site.py SITE_DIR OUT_DIR NEW_URL [OLD_BASE_PATH]")
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")
