"""Install the reviewed NHK bridge into the user's existing downloader."""
from pathlib import Path
import ast
import hashlib
import shutil
import sys

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
if injection not in source:
    patched = source.replace(marker, marker + injection, 1)
    patched = patched.replace('# VERSION: v15.7 (Complete Source Discovery and HLS Quality Families)', '# VERSION: v15.8 (NHK Easy Original Ruby and Narrated Audio)', 1)
    patched = patched.replace('# DATE: 2026-11-18', '# DATE: 2026-11-27', 1)
    ast.parse(patched)
    digest = hashlib.sha256(source.encode()).hexdigest()[:12]
    backup = path.with_name(path.name + f'.before-nhk-{digest}.bak')
    if not backup.exists():
        shutil.copy2(path, backup)
    helper = Path(__file__).with_name('nhk_easy_bridge.py')
    ast.parse(helper.read_text(encoding='utf-8'))
    shutil.copy2(helper, path.with_name('nhk_easy_bridge.py'))
    path.write_text(patched, encoding='utf-8')
    print(f'Updated {path}\nBackup: {backup}')
else:
    shutil.copy2(Path(__file__).with_name('nhk_easy_bridge.py'), path.with_name('nhk_easy_bridge.py'))
    print('Bridge already installed; helper refreshed.')
