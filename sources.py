"""Источники и правила скоринга.

Уровни доверия (tier):
  official — первоисточник (ФРС, SEC, Белый дом, ЕЦБ). Это то же самое, что они публикуют в X,
             только напрямую с их сайтов.
  wire     — информагентства и деловые издания первого эшелона (Reuters, AP, Bloomberg, WSJ, FT).
  major    — крупные СМИ (BBC, CNN, CNBC, Guardian).
  crypto   — профильные крипто-издания с редакционной политикой (CoinDesk, The Block).
"""

TIER_WEIGHT = {"official": 3.0, "wire": 2.5, "major": 2.0, "crypto": 1.5}

# Google News RSS используется только как «транспорт» для изданий без своего RSS,
# и всегда жёстко ограничен доменом через site:
def gnews(query: str) -> str:
    from urllib.parse import quote_plus
    return ("https://news.google.com/rss/search?q=" + quote_plus(query + " when:1d")
            + "&hl=en-US&gl=US&ceid=US:en")


FEEDS = [
    # --- Официальные первоисточники ---
    {"outlet": "White House", "tier": "official", "url": "https://www.whitehouse.gov/news/feed/"},
    {"outlet": "White House", "tier": "official", "url": "https://www.whitehouse.gov/presidential-actions/feed/"},
    {"outlet": "Federal Reserve", "tier": "official", "url": "https://www.federalreserve.gov/feeds/press_all.xml"},
    {"outlet": "Federal Reserve", "tier": "official", "url": "https://www.federalreserve.gov/feeds/speeches.xml"},
    {"outlet": "SEC", "tier": "official", "url": "https://www.sec.gov/news/pressreleases.rss"},
    {"outlet": "ECB", "tier": "official", "url": "https://www.ecb.europa.eu/rss/press.html"},
    {"outlet": "US Treasury", "tier": "official", "url": gnews("site:home.treasury.gov OR site:ofac.treasury.gov")},

    # --- Информагентства / деловые издания ---
    {"outlet": "Reuters", "tier": "wire", "url": gnews("site:reuters.com (markets OR economy OR Fed OR tariffs OR sanctions OR oil)")},
    {"outlet": "Reuters", "tier": "wire", "url": gnews("site:reuters.com (world OR war OR China OR Iran OR Russia)")},
    {"outlet": "AP", "tier": "wire", "url": gnews("site:apnews.com (economy OR markets OR tariffs OR sanctions OR war)")},
    {"outlet": "Bloomberg", "tier": "wire", "url": "https://feeds.bloomberg.com/markets/news.rss"},
    {"outlet": "Bloomberg", "tier": "wire", "url": "https://feeds.bloomberg.com/economics/news.rss"},
    {"outlet": "WSJ", "tier": "wire", "url": "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain"},
    {"outlet": "FT", "tier": "wire", "url": "https://www.ft.com/markets?format=rss"},

    # --- Крупные СМИ ---
    {"outlet": "BBC", "tier": "major", "url": "https://feeds.bbci.co.uk/news/business/rss.xml"},
    {"outlet": "BBC", "tier": "major", "url": "https://feeds.bbci.co.uk/news/world/rss.xml"},
    {"outlet": "CNN", "tier": "major", "url": gnews("site:cnn.com (markets OR economy OR stocks OR tariffs OR Fed OR war)")},
    {"outlet": "CNBC", "tier": "major", "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html"},
    {"outlet": "CNBC", "tier": "major", "url": "https://www.cnbc.com/id/20910258/device/rss/rss.html"},
    {"outlet": "Guardian", "tier": "major", "url": "https://www.theguardian.com/business/rss"},

    # --- Крипта ---
    {"outlet": "CoinDesk", "tier": "crypto", "url": "https://www.coindesk.com/arc/outboundfeeds/rss/"},
    {"outlet": "The Block", "tier": "crypto", "url": "https://www.theblock.co/rss.xml"},
]

# Темы: (эмодзи+название, вес, regex-паттерны). Матчинг по границам слов, без учёта регистра.
THEMES = [
    ("🏦 Ставки и ЦБ", 5.0, [
        r"fed", r"federal reserve", r"fomc", r"powell", r"rate cuts?", r"rate hikes?", r"interest rates?",
        r"basis points?", r"monetary policy", r"ecb", r"lagarde", r"bank of england", r"boj", r"bank of japan",
        r"pboc", r"central banks?", r"treasury yields?", r"bond yields?", r"quantitative (easing|tightening)",
        r"rate decision", r"dot plot"]),
    ("📊 Макро", 4.0, [
        r"cpi", r"inflation", r"pce", r"jobs report", r"nonfarm", r"payrolls?", r"unemployment", r"gdp",
        r"recession", r"retail sales", r"pmi", r"jobless claims", r"consumer (confidence|sentiment)",
        r"producer prices", r"ppi", r"stagflation"]),
    ("🌐 Торговля/тарифы", 4.5, [
        r"tariffs?", r"trade war", r"trade (deal|talks|agreement)", r"export controls?", r"import dut(y|ies)",
        r"chip exports?", r"wto", r"reciprocal"]),
    ("⚔️ Геополитика", 4.0, [
        r"sanctions?", r"war", r"missiles?", r"invasion", r"ceasefire", r"military", r"nato", r"taiwan",
        r"iran", r"israel", r"ukraine", r"russia", r"north korea", r"troops", r"nuclear", r"hormuz",
        r"red sea", r"coup", r"embargo", r"airstrikes?", r"drone attacks?", r"escalat\w*", r"blockade",
        r"security agreement", r"peace (deal|talks|plan)"]),
    ("🛢 Нефть/сырьё", 3.5, [
        r"oil", r"opec\+?", r"brent", r"crude", r"natural gas", r"lng", r"gold", r"copper", r"commodit\w+"]),
    ("🏛 Политика США", 3.0, [
        r"executive orders?", r"white house", r"trump", r"congress", r"senate", r"shutdown", r"debt ceiling",
        r"fiscal", r"treasury secretary", r"bessent", r"stimulus", r"tax (cuts?|bill|hikes?)", r"budget deal"]),
    ("⚖️ Регулирование", 4.0, [
        r"sec", r"securities and exchange commission", r"cftc", r"etfs?", r"stablecoins?", r"clarity act",
        r"genius act", r"market structure", r"antitrust", r"tokeniz\w+", r"innovation exemption"]),
    ("₿ Крипта", 3.0, [
        r"bitcoin", r"btc", r"ether", r"ethereum", r"crypto\w*", r"solana", r"xrp", r"binance", r"coinbase",
        r"tether", r"usdc", r"microstrategy", r"hacks?", r"exploit\w*", r"liquidations?", r"defi"]),
    ("💼 Рынки/компании", 2.0, [
        r"earnings", r"guidance", r"nvidia", r"apple", r"microsoft", r"tesla", r"amazon", r"alphabet",
        r"meta", r"s&p 500", r"nasdaq", r"dow", r"stocks?", r"wall street", r"sell-?off", r"rall(y|ies)",
        r"record highs?", r"ipo", r"mergers?", r"acquisitions?", r"bankrupt\w*", r"defaults?", r"downgrad\w+",
        r"bond market", r"dollar", r"yuan", r"yen"]),
]

# Слова, усиливающие значимость
INTENSIFIERS = [r"surg\w+", r"plung\w+", r"crash\w*", r"record", r"emergency", r"unexpected\w*", r"surpris\w+",
                r"halt\w*", r"collaps\w+", r"soar\w*", r"tumbl\w+", r"slump\w*", r"biggest", r"historic",
                r"breaking", r"imposes?", r"announces?", r"bans?", r"approv\w+"]

# Шум: снижает оценку
NOISE = [r"football", r"soccer", r"premier league", r"celebrity", r"recipe", r"oscars?", r"royal family",
         r"horoscope", r"quiz", r"podcast", r"obituary", r"dies at", r"fashion", r"netflix series",
         r"approval of application", r"enforcement actions? with", r"termination of enforcement",
         r"app store", r"how to", r"best \w+ to buy", r"deals? of the day", r"opinion", r"newsletter",
         r"live:", r"watch:", r"video:", r"found dead"]

# Экономический календарь: какие валюты интересны
CALENDAR_COUNTRIES = {"USD", "EUR", "CNY", "GBP", "JPY", "ALL"}
