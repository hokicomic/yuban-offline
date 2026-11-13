import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const cancel = source.slice(source.indexOf('    const cancelWorkerTimer ='), source.indexOf('    const clampEchoTime ='));
    const toggle = source.slice(source.indexOf('    const togglePlay ='), source.indexOf('    // --- WORKER INTEGRATION ---'));
    for (const active of ['play', 'seek']) {
        test(`pause can cancel an unresolved ${active} request and resume with a fresh click: ${file}`, () => {
            const notices = [], messages = [], retired = [];
            let pauses = 0, plays = 0;
            const player = { paused: false, currentTime: 10783,
                pause() { this.paused = true; pauses++; } };
            const c = { reviewPlaybackRef:{current:{enabled:false}}, playerRef: { current: player }, trackLoadRef: { current: { active: false } },
                mediaPlayRef: { current: { active: active === 'play', cancel: () => retired.push('play') } },
                mediaSeekRef: { current: { active: active === 'seek', cancel: () => retired.push('seek') } },
                workerRef: { current: { postMessage: message => messages.push(message) } },
                timerTokenRef: { current: 7 }, autoplayOnLoadRef: { current: true },
                isGapPausing: { current: true }, isWaitingShadowRef: { current: false },
                subtitles: [{ start: 10768.78, end: 10785.79 }], currentIndex: 0, playbackMode: 'sentence',
                setIsWaitingShadow() {}, setShadowCountdown() {}, getBufferedRange: sub => sub,
                setSeekNotice: text => notices.push(text), setIsPlaying: value => { c.playing = value; },
                requestMediaPlay: () => plays++, seekThenMaybePlay: () => assert.fail('resume must not rewind a mid-sentence pause') };
            const run = vm.runInNewContext(cancel + toggle + '\ntogglePlay', c);
            run();
            assert.ok(pauses > 0); assert.equal(player.paused, true);
            assert.equal(c.mediaPlayRef.current.active, false); assert.equal(c.mediaSeekRef.current.active, false);
            assert.ok(retired.includes(active)); assert.equal(c.timerTokenRef.current, 8);
            assert.equal(c.playing, false); assert.equal(c.autoplayOnLoadRef.current, false);
            assert.equal(notices.at(-1), ''); assert.equal(plays, 0);
            run(); assert.equal(plays, 1, 'the next user click can issue a new play request');
        });
    }
    test('exported playback diagnostics identify the exact running release: ' + file, () => {
        const code = source.slice(source.indexOf('    const recordPCloudDebug ='), source.indexOf('    const loadPCloudFolder ='));
        const c = { APP_VERSION: 'test-version', useCallback: fn => fn,
            pCloudDebugLogRef: { current: [] }, pCloudDebugLogText: '',
            setPCloudDebugLogText: value => { c.exported = JSON.parse(value); }, setPCloudDebugLogNotice() {},
            console: { info() {} }, setTimeout() {}, navigator: { clipboard: { writeText: text => { c.copied = JSON.parse(text); } } } };
        const api = vm.runInNewContext(code + '\n({recordPCloudDebug,copyPCloudDebugLog})', c);
        api.recordPCloudDebug('media.example', { currentTime: 10783 });
        assert.equal(c.exported.appVersion, 'test-version');
        api.copyPCloudDebugLog(); assert.equal(c.copied.appVersion, 'test-version');
        assert.equal(c.copied.entries[0].event, 'media.example');
    });
}
