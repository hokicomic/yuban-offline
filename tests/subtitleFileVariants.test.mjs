import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const { match, label } = vm.runInNewContext(source.slice(source.indexOf('    const getMatchingSubtitleFiles ='), source.indexOf('    const pickSubtitleFile =')) + '\n({ match: getMatchingSubtitleFiles, label: getSubtitleVariantLabel })');
    const make = name => ({ name });
    test('pairs complete media names with exact, language and arbitrary subtitle suffixes: ' + file, () => {
        const media = make('Amazing Anna - SNL [3CQ4Qm6O58A].mp4');
        const stem = media.name.slice(0, -4);
        const candidates = [stem + '.en-nP7-2PuUl7o.srt', stem + '.zh-TW.srt', stem + '.edited.lrc', stem + '.lrc', stem + '_English.srt', stem + '-corrected.srt'].map(make);
        const files = [media, ...candidates, make(stem + '.txt'), make('Other.en.srt')];
        assert.deepEqual(Array.from(match(media, files), f => f.name).sort(), candidates.map(f => f.name).sort());
        assert.equal(match(media, files)[0].name, stem + '.lrc', 'exact name is the first default candidate');
    });
    test('shows the distinguishing suffix first even for long media names: ' + file, () => {
        const media = make('Amazing Anna - SNL [3CQ4Qm6O58A].mp4');
        assert.equal(label(make('Amazing Anna - SNL [3CQ4Qm6O58A].en-nP7-2PuUl7o.srt'), media), 'en-nP7-2PuUl7o.srt');
        assert.equal(label(make('Amazing Anna - SNL [3CQ4Qm6O58A].lrc'), media), '同檔名.lrc');
    });
    test('does not pair similarly named episodes or another media file’s subtitles: ' + file, () => {
        const files = ['Lesson 1.mp4', 'Lesson 10.mp4', 'Lesson 1 - extra.mp4', 'Lesson 1.en.srt', 'Lesson 10.en.srt', 'Lesson 1 - extra.en.srt'].map(make);
        for (const media of files.slice(0, 3)) {
            assert.deepEqual(Array.from(match(media, files), f => f.name), [media.name.replace('.mp4', '.en.srt')]);
        }
    });
    test('respects folder boundaries and Unicode/case differences: ' + file, () => {
        const media = { name: 'Café.MP4', webkitRelativePath: 'root/A/Café.MP4' };
        const good = { name: 'CAFE\u0301.EN-US.SRT', webkitRelativePath: 'root/A/CAFE\u0301.EN-US.SRT' };
        const other = { ...good, webkitRelativePath: 'root/B/CAFE\u0301.EN-US.SRT' };
        assert.deepEqual(Array.from(match(media, [media, good, other])), [good]);
    });

    const setup = () => {
        const readers = [], updates = [], mediaChanges = [];
        const captions = [make('Show.en.srt'), make('Show.zh.lrc')];
        const track = { name: 'Show.mp4', mediaFile: make('Show.mp4'), subFile: captions[0], subtitleFiles: captions };
        const player = { currentTime: 42, paused: false, src: 'blob:unchanged' };
        const c = { trackLoadRef: { current: { token: 1, active: false } }, playerRef: { current: player },
            currentTrackIndexRef: { current: 0 }, playlistRef: { current: [track] },
            currentRepeatRef: { current: 0 }, isWaitingShadowRef: { current: false }, setIsWaitingShadow() {},
            setPlaylist: list => { c.playlistRef.current = list; }, cancelWorkerTimer() {},
            setRawSubtitles() {}, setSubtitles: subs => updates.push(subs), setCurrentIndex: index => { c.index = index; },
            setMediaError: value => { c.error = value; }, setSeekNotice() {}, setTrackLanguage() {},
            setMediaSrc: src => mediaChanges.push(src), recordPCloudDebug() {},
            detectTrackLanguageGlobal: () => 'en-US', isSmartMode: false,
            parseLRC: text => [{ start: 40, end: 45, text }], parseSRT: text => [{ start: 0, end: 10, text }, { start: 40, end: 45, text }],
            FileReader: class { constructor() { readers.push(this); } readAsText(file) { this.file = file; } }
        };
        const code = source.slice(source.indexOf('    const finishMediaLoad ='), source.indexOf('    const loadTrack ='));
        const api = vm.runInNewContext(code + '\n({ selectTrackSubtitle, loadTrackSubtitles })', c);
        return { c, api, readers, updates, mediaChanges, player, track, captions };
    };
    test('manual selection replaces captions at the current time without reloading or rewinding media: ' + file, () => {
        const { c, api, readers, updates, mediaChanges, player, captions } = setup();
        api.selectTrackSubtitle('1');
        assert.equal(c.playlistRef.current[0].subFile, captions[1]);
        readers[0].onload({ target: { result: '中文' } });
        assert.equal(updates.at(-1)[0].text, '中文'); assert.equal(c.index, 0);
        assert.deepEqual(mediaChanges, []); assert.equal(player.currentTime, 42); assert.equal(player.paused, false);
        assert.equal(player.src, 'blob:unchanged');
        api.selectTrackSubtitle('0'); readers[1].onload({ target: { result: 'English' } });
        assert.equal(c.index, 1); assert.equal(updates.at(-1)[1].text, 'English');
    });
    test('rapid subtitle changes ignore late local reads and retain each track’s selection: ' + file, () => {
        const { c, api, readers, updates, captions } = setup();
        api.selectTrackSubtitle('1'); api.selectTrackSubtitle('0');
        readers[1].onload({ target: { result: 'new' } });
        readers[0].onload({ target: { result: 'obsolete' } });
        assert.equal(updates.at(-1)[1].text, 'new');
        assert.equal(c.playlistRef.current[0].subFile, captions[0]);
        c.trackLoadRef.current.token++;
        readers[1].onload({ target: { result: 'previous track' } });
        assert.equal(updates.at(-1)[1].text, 'new');
    });
    test('pCloud subtitle switching uses the same guarded reader and reports errors: ' + file, async () => {
        const { c, api, updates, captions } = setup(); let resolve, reject;
        captions[1].isRemotePCloud = true;
        captions[1].text = () => new Promise((a, b) => { resolve = a; reject = b; });
        api.selectTrackSubtitle('1'); resolve('remote captions'); await Promise.resolve();
        assert.equal(updates.at(-1)[0].text, 'remote captions');
        api.selectTrackSubtitle('0'); api.selectTrackSubtitle('1');
        reject(new Error('temporary network failure')); await Promise.resolve(); await Promise.resolve();
        assert.equal(c.error, 'temporary network failure'); assert.equal(c.index, -1);
    });
}
