import importlib.util
import json
import tempfile
import subprocess
import ast
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'tools/nhk_easy_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
URL = 'https://news.web.nhk/news/easy/20261126de81736/20261126de81736.html'
AUDIO = 'https://media.vd.st.nhk/news/easy_audio/20261126de81736_sample/index.m3u8?token=temporary'
HTML = '''<main><article><h1>テスト<ruby>記事<rt>きじ</rt></ruby></h1><p>date</p>
<div id="js-article-body"><p><span><ruby>日本人<rt>にっぽんじん</rt></ruby></span>がいます。</p>
<p><ruby>家<rp>(</rp><rt>いえ</rt><rp>)</rp></ruby>で A&amp;B。</p></div><nav>ignore</nav></article></main>'''
SNAPSHOT = {'pages': [{'url': URL, 'html': HTML, 'media': ['https://media.vd.st.nhk/news/nd/other/index.m3u8']},
                      {'url': 'https://news.web.nhk/player', 'html': '', 'media': ['blob:ignored', AUDIO]}]}


class BridgeTest(unittest.TestCase):
    def test_original_ruby_and_body_only(self):
        article = bridge.extract_article(HTML)
        self.assertEqual(article['text'], '日本人がいます。\n\n家で A&B。')
        self.assertEqual(article['annotatedText'], '｜日本人《にっぽんじん》がいます。\n\n｜家《いえ》で A&B。')
        self.assertEqual(article['rubyCount'], 2)
        self.assertEqual(article['title'], 'テスト記事')

    def test_gates_and_wrong_article_rejected(self):
        for source in ['<h1>同意してください</h1>', '<div id="js-article-body">plain</div>']:
            with self.assertRaises(ValueError):
                bridge.extract_article(source)
        with self.assertRaises(ValueError):
            bridge.extract_snapshot({'pages': []}, URL)
        self.assertIsNone(bridge.article_id(URL.replace('news.web.nhk', 'evil.example')))

    def test_audio_matches_article_not_regular_video(self):
        self.assertEqual(bridge.extract_snapshot(SNAPSHOT, URL)[1], AUDIO)
        no_audio = {'pages': SNAPSHOT['pages'][:1]}
        with self.assertRaises(ValueError):
            bridge.extract_snapshot(no_audio, URL)
        wrong = {'pages': [SNAPSHOT['pages'][0], dict(SNAPSHOT['pages'][1], media=[AUDIO.replace('de81736', 'de81737')])]}
        with self.assertRaises(ValueError):
            bridge.extract_snapshot(wrong, URL)

    def test_same_path_signature_refresh_and_ambiguous_audio(self):
        refreshed = dict(SNAPSHOT['pages'][1], media=[AUDIO, AUDIO + '2'])
        self.assertEqual(bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], refreshed]}, URL)[1], AUDIO + '2')
        refreshed['media'].append(AUDIO.replace('sample', 'other'))
        with self.assertRaises(ValueError):
            bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], refreshed]}, URL)

    def test_master_and_variant_paths_are_one_voice_asset(self):
        variant = AUDIO.replace('/index.m3u8', '/audio/128000/index.m3u8')
        page = dict(SNAPSHOT['pages'][1], resources=[AUDIO, variant])
        self.assertEqual(bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], page]}, URL)[1], AUDIO)
        # Even if both are DOM sources, the top-level manifest is preferred.
        page['media'] = [AUDIO, variant]
        self.assertEqual(bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], page]}, URL)[1], AUDIO)

    def test_nhk_tokenized_variant_directory_is_same_audio(self):
        variant = AUDIO.replace('/index.m3u8?token=temporary', '/hdntl=exp=4102444800~acl=%2f*~hmac=redacted/index_64k.m3u8')
        page = dict(SNAPSHOT['pages'][1], resources=[AUDIO, variant])
        self.assertEqual(bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], page]}, URL)[1], AUDIO)

    def test_current_dom_audio_beats_historical_resource_from_other_voice(self):
        other = AUDIO.replace('_sample', '_historic')
        page = dict(SNAPSHOT['pages'][1], resources=[other], resource_records=[{'url': other, 'start': 9999}])
        self.assertEqual(bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], page]}, URL)[1], AUDIO)

    def test_article_iframe_voice_id_disambiguates_history_only(self):
        main = dict(SNAPSHOT['pages'][0], html=HTML + '<iframe src="/news/easy/player/audio-v6.html?voiceId=20261126de81736_sample.m4a&amp;title=x"></iframe>')
        page = dict(SNAPSHOT['pages'][1], media=[], resources=[AUDIO, AUDIO.replace('_sample', '_other')])
        self.assertEqual(bridge.extract_snapshot({'pages': [main, page]}, URL)[1], AUDIO)

    def test_valid_current_url_not_replaced_by_expired_history(self):
        expired = AUDIO + '&hdnts=exp=1~acl=/*'
        page = dict(SNAPSHOT['pages'][1], resources=[expired])
        self.assertEqual(bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], page]}, URL)[1], AUDIO)
        # Resources for another voice cannot rescue an expired current voice.
        page = dict(SNAPSHOT['pages'][1], media=[expired], resources=[AUDIO.replace('_sample', '_other')])
        with self.assertRaisesRegex(ValueError, '過期'):
            bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], page]}, URL)

    def test_encoded_expiry_and_wrong_host_are_not_accepted(self):
        expired = AUDIO + '&hdnts=exp%3D1~acl%3D/*'
        page = dict(SNAPSHOT['pages'][1], media=[expired])
        with self.assertRaisesRegex(ValueError, '過期'):
            bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], page]}, URL)
        self.assertIsNone(bridge.audio_asset_identity(AUDIO.replace('media.vd.st.nhk', 'media.vd.st.nhk.example'), '20261126de81736'))

    def test_direct_audio_and_hls_share_voice_identity(self):
        direct = AUDIO.replace('/index.m3u8', '.m4a')
        page = dict(SNAPSHOT['pages'][1], media=[AUDIO, direct])
        self.assertEqual(bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], page]}, URL)[1], AUDIO)

    def test_resources_only_different_voices_remain_ambiguous(self):
        page = dict(SNAPSHOT['pages'][1], media=[], resources=[AUDIO, AUDIO.replace('_sample', '_other')])
        with self.assertRaisesRegex(ValueError, '不同朗讀 ID'):
            bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], page]}, URL)

    def test_installer_updates_visible_version_even_when_already_installed(self):
        root = Path(__file__).parents[1]
        injection = """        # NHK Easy: keep the official ruby text with its narrated audio.
        from nhk_easy_bridge import article_id, download_nhk_easy
        if article_id(page_url):
            return download_nhk_easy(self, ydl_opts, page_url)
"""
        for already_installed in [False, True]:
            with self.subTest(already_installed=already_installed), tempfile.TemporaryDirectory() as folder:
                target = Path(folder) / 'media_dl_17.py'
                old = '# VERSION: v15.8 (NHK)\n# DATE: 2026-11-18\nimport tkinter as tk\nclass App:\n    def __init__(self, root):\n        root.title("影音下載轉檔器 v15.7")\n    def run_web_media_download(self, ydl_opts, page_url):\n' + (injection if already_installed else '') + '        return True\n'
                target.write_text(old, encoding='utf-8')
                subprocess.run(['python3', str(root / 'tools/install-nhk-bridge.py'), str(target)], check=True, capture_output=True)
                updated = target.read_text(encoding='utf-8')
                ast.parse(updated)
                self.assertIn('APP_VERSION = "v15.9"', updated)
                self.assertIn('root.title(f"影音下載轉檔器 {APP_VERSION}")', updated)
                self.assertNotIn('v15.7', updated)
                self.assertEqual(updated.count(injection), 1)
                self.assertEqual(next(Path(folder).glob('*.bak')).read_text(encoding='utf-8'), old)
                self.assertEqual((Path(folder) / 'nhk_easy_bridge.py').read_bytes(), (root / 'tools/nhk_easy_bridge.py').read_bytes())
                subprocess.run(['python3', str(root / 'tools/install-nhk-bridge.py'), str(target)], check=True, capture_output=True)
                self.assertEqual(target.read_text(encoding='utf-8'), updated)
                self.assertEqual(len(list(Path(folder).glob('*.bak'))), 1)

    def test_expired_signed_audio_requires_refresh(self):
        expired = dict(SNAPSHOT['pages'][1], media=[AUDIO + '&hdnts=exp=1~acl=/*'])
        with self.assertRaisesRegex(ValueError, '過期'):
            bridge.extract_snapshot({'pages': [SNAPSHOT['pages'][0], expired]}, URL)

    def test_download_same_stem_idempotency_and_no_signed_url_saved(self):
        with tempfile.TemporaryDirectory() as root:
            class App:
                calls = 0
                def read_chrome_playback_page(self, url): return SNAPSHOT
                def sanitize_filename_component(self, title, fallback): return title
                def get_browser_headers(self, url): return {'Referer': url}
                def ui_log(self, text): pass
                def is_complete_media_file(self, *args, **kwargs): return True, 'ok'
                def run_download_with_integrity_check(self, opts, urls, **kwargs):
                    self.calls += 1
                    self.opts = opts
                    Path(kwargs['expected_path']).write_bytes(b'audio')
                    return True
            app = App()
            opts = {'paths': {'home': root}, 'postprocessors': [{'key': 'wrong'}], '_media_selection': {'x': 1}}
            self.assertTrue(bridge.download_nhk_easy(app, opts, URL))
            files = list(Path(root).iterdir())
            self.assertEqual(len(files), 3)
            self.assertEqual(app.opts['postprocessors'][0]['key'], 'FFmpegExtractAudio')
            self.assertNotIn('_media_selection', app.opts)
            self.assertFalse(app.opts['writeinfojson'])
            metadata = json.loads(next(Path(root).glob('*.media.json')).read_text())
            self.assertNotIn('token', json.dumps(metadata))
            self.assertEqual(metadata['rubyFile'].removesuffix('.ruby.txt'), metadata['audioFile'].removesuffix('.m4a'))
            self.assertTrue(bridge.download_nhk_easy(app, opts, URL))
            self.assertEqual(app.calls, 1)
            text = next(Path(root).glob('*.ruby.txt'))
            text.write_text('user edited', encoding='utf-8')
            self.assertFalse(bridge.download_nhk_easy(app, opts, URL))
            self.assertEqual(text.read_text(), 'user edited')

    def test_download_failure_never_reports_complete_pair(self):
        with tempfile.TemporaryDirectory() as root:
            class App:
                def read_chrome_playback_page(self, url): return SNAPSHOT
                def sanitize_filename_component(self, title, fallback): return title
                def get_browser_headers(self, url): return {}
                def ui_log(self, text): pass
                def run_download_with_integrity_check(self, *args, **kwargs): return False
            self.assertFalse(bridge.download_nhk_easy(App(), {'paths': {'home': root}}, URL))
            self.assertEqual(list(Path(root).iterdir()), [])

if __name__ == '__main__': unittest.main()
