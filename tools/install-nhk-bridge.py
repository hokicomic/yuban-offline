"""Install the reviewed NHK bridge into the user's existing downloader."""
from pathlib import Path
import ast
import hashlib
import re
import shutil
import sys

VERSION = 'v15.10'
path = Path(sys.argv[1]).expanduser().resolve()
source = path.read_text(encoding='utf-8')
marker = '    def run_web_media_download(self, ydl_opts, page_url):\n'
injection = '''        # NHK Easy: keep the official ruby text with its narrated audio.
        from nhk_easy_bridge import article_id, download_nhk_easy
        if article_id(page_url):
            return download_nhk_easy(self, ydl_opts, page_url)
'''
if source.count(marker) != 1:
    raise SystemExit('Cannot locate a unique downloader entry point; nothing changed.')
patched = source if injection in source else source.replace(marker, marker + injection, 1)
patched = re.sub(r'^# VERSION:.*$', f'# VERSION: {VERSION} (NHK Easy Current Audio Source Selection)', patched, count=1, flags=re.M)
patched = re.sub(r'^# DATE:.*$', '# DATE: 2026-11-27', patched, count=1, flags=re.M)
# The visible title must use the same constant as the release metadata, even
# when the bridge was installed by an earlier installer. Keep this idempotent.
refresh_script = Path(__file__).with_name('nhk-refresh-audio.js').read_text(encoding='utf-8')
refresh_assignment = 'NHK_AUDIO_REFRESH_SCRIPT = ' + repr(refresh_script)
if re.search(r'^NHK_AUDIO_REFRESH_SCRIPT\s*=', patched, re.M):
    patched = re.sub(r'^NHK_AUDIO_REFRESH_SCRIPT\s*=.*$', lambda _match: refresh_assignment, patched, count=1, flags=re.M)
else:
    patched = patched.replace('import tkinter as tk', refresh_assignment + '\n\nimport tkinter as tk', 1)
if re.search(r'^APP_VERSION\s*=', patched, re.M):
    patched = re.sub(r'^APP_VERSION\s*=.*$', f'APP_VERSION = "{VERSION}"', patched, count=1, flags=re.M)
else:
    patched = patched.replace('import tkinter as tk', f'APP_VERSION = "{VERSION}"\n\nimport tkinter as tk', 1)
patched, title_count = re.subn(r'root\.title\(["\']影音下載轉檔器 v[\d.]+["\']\)', 'root.title(f"影音下載轉檔器 {APP_VERSION}")', patched, count=1)
if title_count != 1 and 'root.title(f"影音下載轉檔器 {APP_VERSION}")' not in patched:
    raise SystemExit('Cannot locate the window title; nothing changed.')
# The normal read path remains read-only. A separate explicit flag reloads
# only the NHK audio iframe when its short-lived source needs renewal.
old_signature = '    def read_chrome_playback_page(self, page_url):'
new_signature = '    def read_chrome_playback_page(self, page_url, _nhk_refresh=False):'
if old_signature in patched:
    patched = patched.replace(old_signature, new_signature, 1)
if new_signature not in patched:
    raise SystemExit('Cannot locate the Chrome snapshot method; nothing changed.')
start = patched.index(new_signature)
end = patched.index('    def resolve_web_media(', start) if '    def resolve_web_media(' in patched[start:] else len(patched)
method = patched[start:end]
if 'if _nhk_refresh:' not in method:
    anchor = '        def applescript_string(value):'
    if method.count(anchor) != 1:
        raise SystemExit('Cannot locate the browser script entry; nothing changed.')
    method = method.replace(anchor, '        if _nhk_refresh:\n            javascript = NHK_AUDIO_REFRESH_SCRIPT\n\n' + anchor, 1)
    method = method.replace('僅讀取網址吻合的已開啟分頁，不切頁、不播放、也不執行網站程式碼。', '讀取網址吻合的分頁；明確要求 NHK 更新時，僅重載朗讀框並還原播放狀態。')
    patched = patched[:start] + method + patched[end:]
ast.parse(patched)
helper = Path(__file__).with_name('nhk_easy_bridge.py')
ast.parse(helper.read_text(encoding='utf-8'))
if patched != source:
    digest = hashlib.sha256(source.encode()).hexdigest()[:12]
    backup = path.with_name(path.name + f'.before-nhk-{digest}.bak')
    if not backup.exists():
        shutil.copy2(path, backup)
    print(f'Backup: {backup}')
shutil.copy2(helper, path.with_name('nhk_easy_bridge.py'))
if patched != source:
    path.write_text(patched, encoding='utf-8')
print(f'Updated {path}; window title and helper synchronized to {VERSION}.')
