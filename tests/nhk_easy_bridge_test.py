import importlib.util
import json
import tempfile
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
