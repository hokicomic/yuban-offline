import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const helpers = source.slice(source.indexOf('// Only reuse the light replay path'), source.indexOf('const parseSRT ='));
    const actions = source.slice(source.indexOf('    const requestMediaPlay ='), source.indexOf('    const jumpTrackByOffset ='));
    const navigation = source.slice(source.indexOf('    const jumpToSubtitle ='), source.indexOf('    const resetShadowStateForSeek ='));
    const cancel = source.slice(source.indexOf('    const cancelWorkerTimer ='), source.indexOf('    const clampEchoTime ='));
    const toggle = source.slice(source.indexOf('    const togglePlay ='), source.indexOf('    // --- WORKER INTEGRATION ---'));
    const healthCallbacks = source.match(/return monitorMediaPlayback\(player, (\{[\s\S]*?\n        \})\);/)[1];
    const setup = (ranges = [[0, 100]]) => {
        const requests = [], plays = [], notices = [], timers = new Map(), listeners = new Map();
        let id = 0, pauses = 0, loads = 0;
        const player = { src: 'blob:chapter', duration: 100, actual: 15, paused: true, seeking: false, readyState: 4, error: null,
            buffered: { get length() { return ranges.length; }, start: index => ranges[index][0], end: index => ranges[index][1] },
            get currentTime() { return this.actual; },
            set currentTime(value) { requests.push(value); this.seeking = true; },
            play() { return new Promise((resolve, reject) => plays.push({ resolve, reject })); },
            pause() { pauses++; this.paused = true; },
            load() { loads++; this.actual = 0; this.readyState = 0; this.seeking = false; this.emit('emptied'); },
            playbackRate: 1.25,
            addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
            removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
            emit(name) { for (const fn of [...(listeners.get(name) || [])]) fn({ type: name }); } };
        const c = { queueMicrotask, setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
            clearTimeout: key => timers.delete(key), player, playerRef: { current: player }, duration: 100,
            trackLoadRef: { current: { active: false } }, autoplayOnLoadRef: { current: false },
            progressSeekRef: { current: { dragging: false } }, echoModeRef: { current: false }, echoPhaseRef: { current: 'ready' },
            showModal: false, isSurvivalMode: false, playbackMode: 'sentence',
            mediaPlayRef: { current: { active: false } }, mediaSeekRef: { current: { active: false } },
            timerTokenRef: { current: 0 }, workerRef: { current: null },
            subtitles: [{ start: 0, end: 5 }, { start: 10, end: 15 }, { start: 20, end: 25 }], currentIndex: 1,
            currentRepeatRef: { current: 0 }, isGapPausing: { current: false }, isWaitingShadowRef: { current: false },
            setIsWaitingShadow() {}, setShadowCountdown() {}, getBufferedRange: sub => sub,
            setCurrentIndex: index => { c.currentIndex = index; }, jumpTrackByOffset: offset => { c.trackOffset = offset; },
            setSeekNotice: value => notices.push(value),
            setIsPlaying: value => { c.playing = value; }, setMediaError() {},
            setCurrentTime: value => { c.time = value; }, recordPCloudDebug() {} };
        const api = vm.runInNewContext(helpers + '\n' + actions + cancel + navigation + toggle + '\n({seekThenMaybePlay,jumpToSubtitle,togglePlay,health:' + healthCallbacks + '})', c);
        const locate = time => { player.actual = time; player.seeking = false; player.emit('seeked'); };
        const startPlaying = async () => { player.paused = false; plays.at(-1).resolve(); player.emit('playing'); await flush(); };
        return { api, c, player, requests, plays, notices, timers, locate, startPlaying, pauses: () => pauses, loads: () => loads };
    };
    test('cached sentence repeats with one native rewind and no verification polling or extra pause: ' + file, async () => {
        const { api, c, player, requests, plays, notices, timers, locate, startPlaying, pauses } = setup();
        for (let cycle = 0; cycle < 3; cycle++) {
            player.actual = 15; player.paused = true;
            api.seekThenMaybePlay(10, true, null, { bufferedEnd: 15 });
            assert.equal(requests.length, cycle + 1);
            assert.equal(c.timerTokenRef.current, cycle + 1, 'completed timer cannot trigger a duplicate replay');
            assert.equal(plays.length, cycle + 1, 'play request immediately follows the buffered rewind');
            assert.equal(c.mediaSeekRef.current.active, false);
            assert.ok(![...timers.values()].some(timer => timer.delay === 250), 'no seek verification poll');
            assert.equal(pauses(), 0, 'boundary pause must not be repeated by the replay helper');
            locate(10); await startPlaying();
            assert.equal(c.playing, true); assert.equal(c.time, 10);
            assert.equal(timers.size, 0);
        }
        assert.ok(notices.every(value => value === ''), 'normal repeat must not flash locating/loading notices');
    });
    test('buffered next and previous preserve running native playback without pause or redundant play: ' + file, async () => {
        const { api, c, player, requests, plays, notices, pauses, locate } = setup();
        player.paused = false;
        for (const [index, target] of [[2, 20], [1, 10]]) {
            api.jumpToSubtitle(index);
            assert.equal(c.currentIndex, index);
            assert.equal(c.mediaSeekRef.current.active, false);
            assert.equal(requests.at(-1), target);
            assert.equal(plays.length, 0, 'an already-playing native element does not need another play()');
            locate(target); await flush();
            assert.equal(c.playing, true);
            c.isGapPausing.current = false;
        }
        assert.deepEqual(requests, [20, 10]);
        assert.equal(pauses(), 0);
        assert.ok(notices.every(value => value === ''));
    });
    test('native pause during a buffered next seek resumes once without a second rewind: ' + file, async () => {
        const { api, c, player, requests, plays, locate, startPlaying, timers, pauses } = setup();
        player.paused = false; api.jumpToSubtitle(2);
        player.paused = true; player.emit('pause');
        assert.equal(plays.length, 0, 'wait for asynchronous native seek to finish');
        locate(20); assert.equal(plays.length, 1);
        player.emit('canplay'); assert.equal(plays.length, 1);
        await startPlaying();
        assert.equal(c.playing, true); assert.deepEqual(requests, [20]);
        assert.equal(pauses(), 0); assert.equal(timers.size, 0);
    });
    test('a cancelled buffered seek must not restart a deliberate user pause: ' + file, async () => {
        const { api, c, player, plays, locate, timers } = setup();
        player.paused = false; api.jumpToSubtitle(2);
        c.mediaSeekRef.current.cancel(); player.paused = true; locate(20); await flush();
        assert.equal(plays.length, 0); assert.equal(timers.size, 0);
    });
    test('buffered startup deadline never interrupts a long sentence when native events are missing: ' + file, async () => {
        const { api, c, player, plays, timers, requests, notices } = setup();
        player.paused = false;
        api.seekThenMaybePlay(10, true, null, { bufferedEnd: 40 });
        player.actual = 25; player.seeking = false; // 15 seconds of speech, no native startup events
        [...timers.values()][0].fn(); await flush();
        assert.equal(player.paused, false); assert.equal(c.playing, true);
        assert.equal(plays.length, 0); assert.deepEqual(requests, [10]);
        assert.ok(notices.every(value => value === '')); assert.equal(timers.size, 0);
    });
    test('timed-out buffered playback retires a late play promise before showing failure: ' + file, async () => {
        const { api, c, player, requests, plays, notices, timers, locate } = setup();
        api.seekThenMaybePlay(10, true, null, { bufferedEnd: 15 }); locate(10);
        const timeout = [...timers.values()][0]; timeout.fn();
        player.paused = false; plays[0].resolve(); await flush();
        assert.notEqual(c.playing, true); assert.equal(c.mediaPlayRef.current.active, false);
        assert.deepEqual(requests, [10]); assert.ok(notices.at(-1).includes('未恢復'));
        assert.equal(timers.size, 0);
    });
    test('stalled-clock recovery reopens the source and waits at the exact stopped position before playing: ' + file, async () => {
        const { api, c, player, requests, plays, timers, locate, startPlaying, loads } = setup();
        player.actual = 22.33; player.paused = false;
        api.health.onRecover();
        assert.equal(loads(), 1); assert.equal(player.actual, 0);
        assert.equal(c.mediaSeekRef.current.active, true); assert.equal(plays.length, 0, 'never play the beginning after a reload');
        assert.equal(player.playbackRate, 1.25);
        player.readyState = 1; player.emit('loadedmetadata');
        assert.deepEqual(requests, [22.33]);
        player.readyState = 4; locate(22.33); await startPlaying();
        assert.equal(c.time, 22.33); assert.equal(c.playing, true);
        assert.equal(c.mediaPlayRef.current.recoverySource, player.src, 'playing event alone cannot declare decoder recovery');
        api.health.onState('playing');
        assert.equal(c.mediaPlayRef.current.recoverySource, null);
        api.jumpToSubtitle(2); locate(20); player.emit('playing');
        assert.equal(loads(), 1, 'normal buffered next remains fast after actual clock progression');
        assert.equal(plays.length, 1); assert.equal(timers.size, 0);
    });
    test('failure retires stale starts and manual retry reloads the saved position even if the native clock reset to zero: ' + file, async () => {
        const { api, c, player, requests, plays, locate, startPlaying, loads } = setup();
        player.actual = 22.33; player.paused = false; api.health.onRecover();
        player.readyState = 1; player.emit('loadedmetadata'); player.readyState = 4; locate(22.33);
        assert.equal(plays.length, 1);
        api.health.onFailure(); player.actual = 0;
        assert.equal(c.mediaPlayRef.current.active, false); assert.equal(c.mediaSeekRef.current.active, false);
        api.togglePlay(); assert.equal(loads(), 2); assert.equal(plays.length, 1);
        plays[0].resolve(); await flush(); assert.equal(c.playing, false, 'cancelled recovery cannot revive an old request');
        player.readyState = 1; player.emit('loadedmetadata'); player.readyState = 4; locate(22.33); await startPlaying();
        assert.deepEqual(requests, [22.33, 22.33]); assert.equal(c.time, 22.33);
        assert.equal(c.playing, true);
    });
    test('manual pause during a newly recovered start remains a pause rather than another reload: ' + file, async () => {
        const { api, player, locate, startPlaying, loads } = setup();
        player.actual = 22.33; player.paused = false; api.health.onRecover();
        player.readyState = 1; player.emit('loadedmetadata'); player.readyState = 4; locate(22.33); await startPlaying();
        api.togglePlay(); assert.equal(player.paused, true); assert.equal(loads(), 1);
    });
    test('a reload exception releases the seek lock and permits another manual retry: ' + file, async () => {
        const { api, c, player, locate, startPlaying, loads } = setup();
        player.actual = 22.33; player.paused = false;
        const reload = player.load; player.load = () => { throw Error('temporary file read error'); };
        api.health.onRecover(); assert.equal(c.mediaSeekRef.current.active, false);
        player.load = reload; api.togglePlay(); assert.equal(loads(), 1);
        player.readyState = 1; player.emit('loadedmetadata'); player.readyState = 4; locate(22.33); await startPlaying();
        assert.equal(c.time, 22.33); assert.equal(c.playing, true);
    });
    test('next sentence supersedes recovery without playing an old target or resetting to file start: ' + file, async () => {
        const { api, c, player, requests, plays, locate, startPlaying, loads } = setup();
        player.actual = 22.33; player.paused = false; api.health.onRecover();
        api.jumpToSubtitle(2); assert.equal(loads(), 2); assert.equal(plays.length, 0);
        player.readyState = 1; player.emit('loadedmetadata'); player.readyState = 4; locate(20); await startPlaying();
        assert.deepEqual(requests, [20]); assert.equal(c.currentIndex, 2); assert.equal(c.time, 20);
        assert.equal(c.playing, true);
    });
    test('uncached next sentence remains verified and crossing tracks still loads the adjacent track: ' + file, () => {
        const { api, c, requests, plays } = setup([[0, 15]]);
        api.jumpToSubtitle(2);
        assert.equal(c.mediaSeekRef.current.active, true);
        assert.equal(plays.length, 0);
        assert.deepEqual(requests, [20]);
        c.mediaSeekRef.current.cancel();
        api.jumpToSubtitle(3);
        assert.equal(c.trackOffset, 1);
        assert.deepEqual(requests, [20]);
    });
    test('same-cue restart keeps the heartbeat running and avoids the full seek when buffered: ' + file, async () => {
        const { api, c, player, plays, locate } = setup();
        const messages = [];
        c.workerRef.current = { postMessage: message => messages.push(message.type) };
        player.paused = false;
        api.jumpToSubtitle(1);
        assert.equal(c.mediaSeekRef.current.active, false);
        assert.equal(c.isGapPausing.current, false);
        assert.ok(!messages.includes('STOP_HEARTBEAT'));
        locate(10); await flush();
        assert.equal(plays.length, 0);
        assert.equal(c.playing, true);
    });
    test('uncached or partially cached sentences use verified seeking: ' + file, async () => {
        for (const ranges of [[], [[11, 100]], [[0, 12], [13, 100]]]) {
            const { api, c, plays, notices, locate, startPlaying } = setup(ranges);
            api.seekThenMaybePlay(10, true, null, { bufferedEnd: 15 });
            assert.equal(c.mediaSeekRef.current.active, true); assert.equal(plays.length, 0);
            assert.ok(notices.includes('正在定位…'));
            locate(10); assert.equal(plays.length, 1);
            await startPlaying(); assert.equal(c.playing, true);
        }
    });
    test('manual seeks stay verified even when the selected range is buffered: ' + file, () => {
        const { api, c, plays } = setup();
        api.seekThenMaybePlay(10, true);
        assert.equal(c.mediaSeekRef.current.active, true); assert.equal(plays.length, 0);
        c.mediaSeekRef.current.cancel();
    });
    test('late play completion after spoken words never rewinds the sentence again: ' + file, async () => {
        for (const elapsed of [0.6, 1.5, 3]) {
            const { api, c, player, requests, locate, startPlaying, pauses } = setup();
            api.seekThenMaybePlay(10, true, null, { bufferedEnd: 15 });
            locate(10);
            player.actual = 10 + elapsed; // audio already spoke these words before the promise callback
            await startPlaying();
            assert.equal(c.mediaSeekRef.current.active, false);
            assert.deepEqual(requests, [10], 'no corrective second seek after audio has started');
            assert.equal(c.time, 10 + elapsed);
            assert.equal(pauses(), 0);
            assert.equal(c.playing, true);
        }
    });
    test('next sentence retires a late start callback without pausing audio already in progress: ' + file, async () => {
        const { api, c, player, requests, plays, locate, pauses } = setup();
        api.seekThenMaybePlay(10, true, null, { bufferedEnd: 15 });
        locate(10);
        player.paused = false; player.actual = 10.7; // speech began, but play promise is still pending
        api.jumpToSubtitle(2);
        assert.deepEqual(requests, [10, 20]);
        assert.equal(plays.length, 1, 'continue playback rather than making another play request');
        assert.equal(pauses(), 0);
        locate(20);
        plays[0].resolve(); await flush();
        assert.deepEqual(requests, [10, 20], 'late completion cannot start another seek');
        assert.equal(c.mediaSeekRef.current.active, false);
        assert.equal(c.playing, true);
    });
    test('new manual seek cancels a pending buffered replay and ignores its late play completion: ' + file, async () => {
        const { api, c, plays, locate, startPlaying } = setup();
        api.seekThenMaybePlay(10, true, null, { bufferedEnd: 15 });
        api.seekThenMaybePlay(30, true);
        plays[0].resolve(); await flush();
        assert.equal(c.mediaSeekRef.current.active, true);
        assert.notEqual(c.playing, true);
        locate(30); await startPlaying();
        assert.equal(c.time, 30); assert.equal(c.playing, true);
    });
}
