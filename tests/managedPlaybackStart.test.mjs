import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const helper = source.slice(source.indexOf('const performManagedMediaPlay ='), source.indexOf('const parseSRT ='));
    const setup = () => {
        const listeners = new Map();
        const timers = new Map();
        let timerId = 0;
        const api = vm.runInNewContext(helper + '\nperformManagedMediaPlay', {
            queueMicrotask, setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
            clearTimeout: id => timers.delete(id)
        });
        const calls = [];
        const events = [];
        const player = { src: 'blob:local-book', currentTime: 100, readyState: 0, paused: true, error: null,
            play() { this.paused = false; return new Promise((resolve, reject) => calls.push({ resolve, reject })); },
            pause() { this.paused = true; },
            addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
            removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
            emit(name) { for (const fn of [...(listeners.get(name) || [])]) fn(); } };
        const start = () => api(player, { isCurrent: () => true,
            onPlaying: () => events.push('playing'), onFailure: err => events.push(err.name) });
        return { player, calls, events, timers, listeners, start };
    };
    test('slow local data keeps the original play request and cleans up on success: ' + file, async () => {
        const { player, calls, events, timers, listeners, start } = setup();
        start();
        assert.equal(calls.length, 1, 'play starts synchronously in the click handler');
        player.emit('loadeddata'); player.emit('canplay');
        assert.equal(calls.length, 1, 'readiness events must not start duplicate playback');
        player.readyState = 4; calls[0].resolve(); await flush();
        assert.deepEqual(events, ['playing']);
        assert.equal(timers.size, 0);
        assert.ok([...listeners.values()].every(set => set.size === 0));
    });
    test('one interrupted play retries only when data is ready: ' + file, async () => {
        const { player, calls, events, start } = setup(); start();
        calls[0].reject({ name: 'AbortError' }); await flush();
        assert.equal(calls.length, 1);
        player.readyState = 2; player.emit('canplay'); player.emit('canplay');
        assert.equal(calls.length, 2);
        calls[1].resolve(); await flush();
        assert.deepEqual(events, ['playing']);
    });
    test('permission denial is explicit and never automatically retried: ' + file, async () => {
        const { player, calls, events, start } = setup(); start();
        calls[0].reject({ name: 'NotAllowedError' }); await flush();
        player.readyState = 4; player.emit('canplay');
        assert.equal(calls.length, 1);
        assert.equal(player.paused, true);
        assert.deepEqual(events, ['NotAllowedError']);
    });
    test('cancelled or replaced source cannot revive playback state: ' + file, async () => {
        const { player, calls, events, timers, start } = setup();
        const cancel = start(); cancel();
        calls[0].resolve(); await flush();
        assert.equal(player.paused, true); assert.deepEqual(events, []);
        assert.equal(timers.size, 0);
        start(); player.src = 'blob:next-book'; calls[1].reject({ name: 'AbortError' }); await flush();
        player.readyState = 4; player.emit('canplay');
        assert.equal(calls.length, 2); assert.deepEqual(events, []);
    });
    test('timeout and decoding failures stop with a reason: ' + file, async () => {
        const { player, calls, events, timers, start } = setup(); start();
        [...timers.values()][0](); calls[0].resolve(); await flush();
        assert.deepEqual(events, ['TimeoutError']); assert.equal(player.paused, true);
        start(); player.error = { code: 3, message: 'decode failed' }; player.emit('error');
        calls[1].reject({ name: 'NotSupportedError' }); await flush();
        assert.deepEqual(events, ['TimeoutError', 'MediaError']);
    });
    test('already located media plays in the same click without another seek: ' + file, () => {
        const seek = source.slice(source.indexOf('const performVerifiedMediaSeek ='), source.indexOf('// Keep one playback request'));
        let assignments = 0; let located = 0;
        const player = { src: 'blob:local', readyState: 2, seeking: false,
            get currentTime() { return 100; }, set currentTime(_) { assignments++; this.seeking = true; },
            pause() {}, addEventListener() {}, removeEventListener() {} };
        const run = vm.runInNewContext(seek + '\nperformVerifiedMediaSeek', { setTimeout, clearTimeout });
        run(player, 100, { isCurrent: () => true, onLocated: () => located++, onFailure() { assert.fail(); } });
        assert.equal(assignments, 0); assert.equal(located, 1);
    });
}

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('    const finishMediaLoad ='), source.indexOf('    const handlePlaylistEnd ='));
    const setup = (tracks) => {
        const readers = [];
        const sources = [];
        const captions = [];
        const plays = [];
        const c = { playlist: tracks, mediaSrc: null,
            trackLoadRef: { current: { token: 0, active: false } },
            playerRef: { current: { pause() {} } },
            currentTrackIndexRef: { current: -1 }, playlistRef: { current: tracks },
            currentRepeatRef: { current: 0 }, suppressNextAutoWatchRef: { current: false },
            tailMarkedRef: { current: false }, isWaitingShadowRef: { current: false },
            autoplayOnLoadRef: { current: false },
            cancelWorkerTimer() {}, setIsPlaying() {}, setMediaError() {}, setSeekNotice() {},
            setWatchedSegments() {}, setCurrentTime() {}, setCurrentTrackIndex() {},
            setMediaSrc: src => sources.push(src), recordPCloudDebug() {},
            setRawSubtitles: subs => { if (subs.length) captions.push(subs); }, setSubtitles() {}, setCurrentIndex() {},
            setTrackLanguage() {}, detectTrackLanguageGlobal: () => 'en-US', isSmartMode: false,
            setIsWaitingShadow() {}, parseLRC: text => [text], parseSRT: text => [text],
            requestMediaPlay: () => plays.push('play'),
            URL: { createObjectURL: file => 'blob:' + file.name, revokeObjectURL() {} },
            FileReader: class { constructor() { readers.push(this); } readAsText() {} }
        };
        const api = vm.runInNewContext(code + '\n({loadTrack, finishMediaLoad})', c);
        return { c, api, readers, sources, captions, plays };
    };
    test('first tap during local loading waits for both media metadata and captions: ' + file, async () => {
        const { c, api, readers, plays } = setup([{ name: 'book', mediaFile: { name: 'book.m4a' }, subFile: { name: 'book.lrc' } }]);
        await api.loadTrack(0);
        const toggleCode = source.slice(source.indexOf('    const togglePlay ='), source.indexOf('    // --- WORKER INTEGRATION ---'));
        const toggle = vm.runInNewContext(toggleCode + '\ntogglePlay', c);
        toggle(); toggle();
        assert.equal(c.autoplayOnLoadRef.current, true);
        c.trackLoadRef.current.metadataReady = true; api.finishMediaLoad();
        assert.equal(plays.length, 0);
        readers[0].onload({ target: { result: 'new subtitles' } });
        assert.equal(plays.length, 1); assert.equal(c.trackLoadRef.current.active, false);
        api.finishMediaLoad(); assert.equal(plays.length, 1);
    });
    test('mobile first tap can start data loading without waiting for metadata: ' + file, async () => {
        const { c, api, sources, plays } = setup([{ name: 'book', mediaFile: { name: 'book.m4a' } }]);
        await api.loadTrack(0);
        c.playerRef.current.src = sources[0];
        const toggleCode = source.slice(source.indexOf('    const togglePlay ='), source.indexOf('    // --- WORKER INTEGRATION ---'));
        const toggle = vm.runInNewContext(toggleCode + '\ntogglePlay', c);
        toggle();
        assert.equal(plays.length, 1, 'the original click calls play before metadata');
        c.trackLoadRef.current.metadataReady = true; api.finishMediaLoad();
        assert.equal(plays.length, 1, 'metadata must not duplicate the pending play');
    });
    test('late remote loads and old subtitle readers cannot overwrite the selected track: ' + file, async () => {
        let oldSource;
        const tracks = [
            { name: 'remote', mediaFile: { isRemotePCloud: true, getStreamUrl: () => new Promise(resolve => { oldSource = resolve; }) } },
            { name: 'local', mediaFile: { name: 'local.m4a' }, subFile: { name: 'local.lrc' } },
            { name: 'next', mediaFile: { name: 'next.m4a' }, subFile: { name: 'next.lrc' } }
        ];
        const { api, c, readers, sources, captions } = setup(tracks);
        const pending = api.loadTrack(0);
        await api.loadTrack(1); await api.loadTrack(2);
        oldSource('https://example.com/obsolete'); await pending;
        assert.deepEqual(sources, ['blob:local.m4a', 'blob:next.m4a']);
        readers[0].onload({ target: { result: 'old captions' } });
        assert.equal(captions.length, 0);
        readers[1].onload({ target: { result: 'current captions' } });
        assert.equal(captions.at(-1)[0], 'current captions');
        assert.equal(c.trackLoadRef.current.token, 3);
    });
    test('native local-media errors are recorded with the browser failure details: ' + file, () => {
        const records = [];
        const c = { trackLoadRef: { current: { active: true } }, autoplayOnLoadRef: { current: true },
            currentPlaylistTrack: { name: 'local.m4a', mediaFile: {} },
            setIsPlaying() {}, setSeekNotice() {}, setMediaError() {}, buildMediaPlaybackErrorMessage() {},
            recordPCloudDebug: (event, details) => records.push({ event, details }) };
        const body = source.match(/onError=\{\(e\) => \{([\s\S]*?)\}\} onPlaying=/)[1];
        const onError = vm.runInNewContext('(e) => {' + body + '}', c);
        onError({ currentTarget: { currentTime: 100, readyState: 1, error: { code: 2, message: 'read interrupted' } } });
        assert.equal(records[0].event, 'media.error');
        assert.equal(records[0].details.sourceKind, 'local-file');
        assert.equal(records[0].details.code, 2);
        assert.equal(records[0].details.message, 'read interrupted');
        assert.equal(c.trackLoadRef.current.active, false);
    });
}
