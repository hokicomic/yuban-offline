"""NHK Easy: preserve original ruby and download the matching narrated audio.

Installed beside media_dl_17.py. Uses its existing, read-only Chrome snapshot and
its downloader/integrity checks. No cookies, hidden APIs or guessed audio URLs.
"""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urljoin, parse_qs, unquote
from datetime import datetime, timezone
import json
import re
import time


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []


class Tree(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in {'br', 'img', 'meta', 'link', 'source', 'input', 'hr', 'wbr'}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def walk(node):
    if isinstance(node, Node):
        yield node
        for child in node.children:
            yield from walk(child)


def render(node, annotated=False):
    if isinstance(node, str):
        return node
    if node.tag in {'rt', 'rp', 'script', 'style', 'nav', 'button', 'iframe'}:
        return ''
    if node.tag == 'ruby':
        base = ''.join(render(child) for child in node.children)
        reading = ''.join(''.join(render(c) for c in item.children)
                          for item in walk(node) if item.tag == 'rt').strip()
        if annotated and reading:
            return f'｜{base}《{reading}》'
        return base
    if node.tag == 'br':
        return '\n'
    text = ''.join(render(child, annotated) for child in node.children)
    return text + ('\n' if node.tag in {'p', 'div', 'section', 'h1'} else '')


def extract_article(source):
    nodes = list(walk(Tree(source).root))
    body = next((n for n in nodes if n.attrs.get('id') == 'js-article-body'), None)
    if body is None:
        body = next((n for n in nodes if 'article-body' in n.attrs.get('class', '').split()), None)
    title = next((n for n in nodes if n.tag == 'h1'), None)
    if body is None or not any(n.tag == 'rt' for n in walk(body)):
        raise ValueError('找不到 NHK 完整正文與原始振假名；請先在 Chrome 正常開啟文章。')
    # Strip only layout whitespace between paragraphs; inline text stays intact.
    paragraphs = [n for n in body.children if isinstance(n, Node) and n.tag == 'p'] or [body]
    plain = '\n\n'.join(render(n).strip() for n in paragraphs).strip()
    annotated = '\n\n'.join(render(n, True).strip() for n in paragraphs).strip()
    if not plain:
        raise ValueError('NHK 正文為空，未匯出。')
    return {'text': plain, 'annotatedText': annotated,
            'title': render(title).strip() if title else '',
            'rubyCount': sum(n.tag == 'rt' for n in walk(body))}


def article_id(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in {'news.web.nhk', 'www3.nhk.or.jp'}:
        return None
    match = re.fullmatch(r'/news/easy/([A-Za-z0-9_-]+)/\1\.html', parsed.path)
    return match[1] if match else None


def audio_asset_identity(url, identifier):
    """Master/variant playlists and direct audio share a voice asset, not a URL."""
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'media.vd.st.nhk':
        return None
    prefix = '/news/easy_audio/'
    if not parsed.path.startswith(prefix) or not re.search(r'\.(?:m3u8|m4a|mp3)$', parsed.path):
        return None
    asset = parsed.path[len(prefix):].split('/')[0]
    asset = re.sub(r'\.(?:m4a|mp3)$', '', asset)
    return asset if re.match(re.escape(identifier) + r'(?:_|$)', asset) else None


def declared_voice_asset(source, identifier):
    # The article's audio iframe declares the voice ID actually requested by
    # this page. Never infer it from a historical network request or video.
    voices = set()
    for node in walk(Tree(source).root):
        if node.tag != 'iframe':
            continue
        parsed = urlsplit(urljoin('https://news.web.nhk/', node.attrs.get('src', '')))
        if parsed.hostname not in {'news.web.nhk', 'www3.nhk.or.jp'} or not parsed.path.startswith('/news/easy/player/'):
            continue
        for voice in parse_qs(parsed.query).get('voiceId', []):
            asset = re.sub(r'\.(?:m4a|mp3)$', '', voice)
            if re.fullmatch(re.escape(identifier) + r'_[A-Za-z0-9_-]+', asset):
                voices.add(asset)
    if len(voices) > 1:
        raise ValueError('文章宣告多個不同朗讀 ID，請重新載入朗讀播放器後重試。')
    return next(iter(voices), None)


def audio_url_expiry(url):
    matches = re.findall(r'(?:[?&~=])exp=(\d+)', unquote(url))
    return min(map(int, matches)) if matches else None


class AudioRefreshNeeded(ValueError):
    """The normal player must renew the source before a download can start."""


def is_root_audio_url(url):
    tail = urlsplit(url).path.removeprefix('/news/easy_audio/').split('/')
    return len(tail) <= 2


def select_audio_source(pages, identifier, expected_asset=None):
    candidates = []
    for page in pages:
        times = {item.get('url'): item.get('start', 0) for item in page.get('resource_records', []) if isinstance(item, dict)}
        # DOM media is current playback evidence; resource timing is history.
        for active, values in ((False, page.get('resources', [])), (True, page.get('media', []))):
            for raw in values:
                if not isinstance(raw, str):
                    continue
                url = urljoin(page.get('url') or 'https://news.web.nhk/', raw)
                asset = audio_asset_identity(url, identifier)
                if not asset or expected_asset and asset != expected_asset:
                    continue
                candidates.append(dict(url=url, asset=asset, active=active, order=len(candidates), time=times.get(raw, 0)))
    if not candidates:
        raise AudioRefreshNeeded('正文已找到，但尚無對應朗讀音檔來源；請在 Chrome 按「ニュースを聞く」，等播放器載入後重試。')
    active_assets = {item['asset'] for item in candidates if item['active']}
    assets = active_assets or {item['asset'] for item in candidates}
    if len(assets) != 1:
        raise ValueError('找到多個不同朗讀 ID，未自行選取；請重新載入此文章的朗讀播放器。')
    asset = next(iter(assets))
    now = datetime.now(timezone.utc).timestamp()
    def ready(item):
        if item['asset'] != asset or not is_root_audio_url(item['url']):
            return False
        expiry = audio_url_expiry(item['url'])
        # NHK's unsigned data-hlsurl is the player's starting point, not a
        # downloadable source. Wait until its normal player supplies a token.
        if urlsplit(item['url']).path.endswith('.m3u8') and expiry is None:
            return False
        return expiry is None or expiry > now + 30
    valid = [item for item in candidates if ready(item)]
    if not valid:
        raise AudioRefreshNeeded('NHK 主清單已過期或只剩歷史子清單，需要更新朗讀播放器。')
    def rank(item):
        parsed = urlsplit(item['url'])
        # Prefer a currently declared source, then a top-level HLS manifest.
        # Signed URLs for the same path may refresh without changing identity.
        return (is_root_audio_url(item['url']), item['active'], parsed.path.endswith('.m3u8'), -parsed.path.count('/'),
                audio_url_expiry(item['url']) or 0, item['time'], item['order'])
    return max(valid, key=rank)['url']


def extract_snapshot(snapshot, page_url):
    identifier = article_id(page_url)
    if not identifier:
        raise ValueError('不是 NHK Easy 文章網址')
    pages = (snapshot or {}).get('pages', [])
    main = next((p for p in pages if p.get('url', '').split('#')[0] == page_url.split('#')[0]), None)
    if not main:
        raise ValueError('請在 Chrome 開啟相同的 NHK 文章，並按「ニュースを聞く」載入朗讀後再下載。')
    article = extract_article(main.get('html', ''))
    expected = declared_voice_asset(main.get('html', ''), identifier)
    return article, select_audio_source(pages, identifier, expected)


def refreshed_snapshot(app, page_url):
    app.ui_log('🔄 更新此文章的朗讀播放器，保留播放位置與播放／暫停狀態；重新取得短效連結。\n')
    try:
        result = app.read_chrome_playback_page(page_url, _nhk_refresh=True)
    except TypeError:
        raise ValueError('下載器仍執行舊版程式，請完全退出後重新開啟新版再試。')
    if not result or not result.get('reloading'):
        raise ValueError('無法更新朗讀播放器；請在 Chrome 按「ニュースを聞く」載入音訊後再下載。')
    deadline = time.monotonic() + 12
    for _ in range(30):
        if time.monotonic() >= deadline:
            break
        time.sleep(0.4)
        snapshot = app.read_chrome_playback_page(page_url)
        try:
            article, url = extract_snapshot(snapshot, page_url)
            return article, url
        except AudioRefreshNeeded:
            continue
    raise ValueError('朗讀播放器更新逾時；請確認 Chrome 此文章能正常播放後重試。')


def save_text_exclusive(path, text):
    path = Path(path)
    if path.exists():
        if path.read_text(encoding='utf-8') != text:
            raise ValueError(f'已存在不同內容，未覆寫：{path.name}')
        return
    with path.open('x', encoding='utf-8') as handle:
        handle.write(text)


def download_nhk_easy(app, ydl_opts, page_url):
    try:
        try:
            article, audio_url = extract_snapshot(app.read_chrome_playback_page(page_url), page_url)
        except AudioRefreshNeeded:
            article, audio_url = refreshed_snapshot(app, page_url)
        identifier = article_id(page_url)
        home = Path((ydl_opts.get('paths') or {}).get('home') or '.')
        template = ydl_opts.get('outtmpl')
        if isinstance(template, str) and Path(template).is_absolute():
            home = Path(template).parent
        home.mkdir(parents=True, exist_ok=True)
        home = home.resolve()
        title = app.sanitize_filename_component(article['title'], fallback=identifier)
        base = home / f'{title} [{identifier}]'
        txt = base.with_name(base.name + '.ruby.txt')
        meta = base.with_name(base.name + '.media.json')
        audio = base.with_name(base.name + '.m4a')
        # Detect conflicts before starting a potentially expensive download.
        if txt.exists() and txt.read_text(encoding='utf-8') != article['annotatedText']:
            raise ValueError(f'已有不同的原文檔，未覆寫：{txt.name}')
        metadata = dict(schemaVersion=1, sourceUrl=page_url, articleId=identifier,
                        title=article['title'], text=article['text'], rubyCount=article['rubyCount'],
                        rubyFile=txt.name, audioFile=audio.name)
        if meta.exists():
            existing = json.loads(meta.read_text(encoding='utf-8'))
            if existing.get('sourceUrl') != page_url or existing.get('text') != article['text']:
                raise ValueError(f'已有不同的來源記錄，未覆寫：{meta.name}')
        opts = dict(ydl_opts)
        for key in ('external_downloader', 'external_downloader_args', 'force_generic_extractor', '_media_selection'):
            opts.pop(key, None)
        opts.update(format='bestaudio/best', outtmpl=str(base).replace('%', '%%') + '.%(ext)s',
                    postprocessors=[{'key': 'FFmpegExtractAudio', 'preferredcodec': 'm4a'}],
                    http_headers=app.get_browser_headers(page_url),
                    hls_prefer_native=True, skip_unavailable_fragments=False,
                    overwrites=False, continuedl=True, writeinfojson=False)
        app.ui_log(f'📖 NHK 原文振假名 {article["rubyCount"]} 處；下載對應朗讀音訊。\n')
        if audio.exists():
            complete, reason = app.is_complete_media_file(str(audio), require_video=False, require_audio=True)
            if not complete:
                raise ValueError(f'已有音檔未通過完整性檢查，請另行處理後重試（未刪除）：{reason}')
        elif not app.run_download_with_integrity_check(opts, [audio_url], expected_path=str(audio), require_audio=True):
            app.ui_log('⚠️ 音訊來源未能下載，更新播放器連結後再試一次。\n')
            refreshed_article, audio_url = refreshed_snapshot(app, page_url)
            if refreshed_article['text'] != article['text']:
                raise ValueError('重新載入後文章內容已變更，未混用兩份文本。')
            # No output existed on entering this branch. Only retry this job's
            # incomplete audio; never replace a pre-existing user audio file.
            retry_opts = dict(opts, overwrites=True, continuedl=False)
            if not app.run_download_with_integrity_check(retry_opts, [audio_url], expected_path=str(audio), require_audio=True):
                return False
        save_text_exclusive(txt, article['annotatedText'])
        if not meta.exists():
            metadata['exportedAt'] = datetime.now(timezone.utc).isoformat()
            save_text_exclusive(meta, json.dumps(metadata, ensure_ascii=False, indent=2))
        app.ui_log(f'✅ 已保存同名 .m4a／.ruby.txt／.media.json；用音檔產生同名 LRC 後即可在語伴對照。\n')
        return True
    except (ValueError, OSError) as error:
        app.ui_log(f'❌ NHK 朗讀與原文未完成：{error}\n')
        return False
