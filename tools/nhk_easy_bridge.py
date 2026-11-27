"""NHK Easy: preserve original ruby and download the matching narrated audio.

Installed beside media_dl_17.py. Uses its existing, read-only Chrome snapshot and
its downloader/integrity checks. No cookies, hidden APIs or guessed audio URLs.
"""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urljoin
from datetime import datetime, timezone
import json
import re


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


def extract_snapshot(snapshot, page_url):
    identifier = article_id(page_url)
    if not identifier:
        raise ValueError('不是 NHK Easy 文章網址')
    pages = (snapshot or {}).get('pages', [])
    main = next((p for p in pages if p.get('url', '').split('#')[0] == page_url.split('#')[0]), None)
    if not main:
        raise ValueError('請在 Chrome 開啟相同的 NHK 文章，並按「ニュースを聞く」載入朗讀後再下載。')
    article = extract_article(main.get('html', ''))
    candidates = []
    for page in pages:
        # The same article also contains the regular-news video. Only accept
        # the Easy narrated-audio path whose ID matches this article exactly.
        for raw in page.get('media', []) + page.get('resources', []):
            url = urljoin(page.get('url', page_url), raw)
            parsed = urlsplit(url)
            if (parsed.scheme == 'https' and parsed.hostname == 'media.vd.st.nhk'
                    and re.match(r'/news/easy_audio/' + re.escape(identifier) + r'[_/.]', parsed.path)
                    and re.search(r'\.(?:m3u8|m4a|mp3)$', parsed.path)):
                if url not in candidates:
                    candidates.append(url)
    if not candidates:
        raise ValueError('正文已找到，但尚無朗讀音檔來源；請在 Chrome 按「ニュースを聞く」，等播放器載入後重試。')
    # A refreshed signed URL for the same path is the same audio; prefer newest.
    by_path = {urlsplit(url).path: url for url in candidates}
    if len(by_path) != 1:
        raise ValueError('找到多個不同朗讀來源，未自行選取；請重新載入此文章的朗讀播放器。')
    chosen = list(by_path.values())[0]
    expiry = re.search(r'(?:[?&~=])exp=(\d+)', chosen)
    if expiry and int(expiry[1]) <= datetime.now(timezone.utc).timestamp():
        raise ValueError('NHK 朗讀網址已過期；請關閉再開啟「ニュースを聞く」播放器，載入後重試。')
    return article, chosen


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
        article, audio_url = extract_snapshot(app.read_chrome_playback_page(page_url), page_url)
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
                    overwrites=False, continuedl=True)
        app.ui_log(f'📖 NHK 原文振假名 {article["rubyCount"]} 處；下載對應朗讀音訊。\n')
        if audio.exists():
            complete, reason = app.is_complete_media_file(str(audio), require_video=False, require_audio=True)
            if not complete:
                raise ValueError(f'已有音檔未通過完整性檢查，請另行處理後重試（未刪除）：{reason}')
        elif not app.run_download_with_integrity_check(opts, [audio_url], expected_path=str(audio), require_audio=True):
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
