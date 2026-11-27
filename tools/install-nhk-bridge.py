"""Install the reviewed NHK bridge into the user's existing downloader."""
from pathlib import Path
import ast
import hashlib
import re
import shutil
import sys

VERSION = 'v15.9'
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
if re.search(r'^APP_VERSION\s*=', patched, re.M):
    patched = re.sub(r'^APP_VERSION\s*=.*$', f'APP_VERSION = "{VERSION}"', patched, count=1, flags=re.M)
else:
    patched = patched.replace('import tkinter as tk', f'APP_VERSION = "{VERSION}"\n\nimport tkinter as tk', 1)
patched, title_count = re.subn(r'root\.title\(["\']影音下載轉檔器 v[\d.]+["\']\)', 'root.title(f"影音下載轉檔器 {APP_VERSION}")', patched, count=1)
if title_count != 1 and 'root.title(f"影音下載轉檔器 {APP_VERSION}")' not in patched:
    raise SystemExit('Cannot locate the window title; nothing changed.')
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
