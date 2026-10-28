import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const setup = () => {
        const requests = [];
        const timers = [];
        const player = { time: 15, paused: false, seeking: false, ended: false,
            get currentTime() { return this.time; },
            set currentTime(time) { requests.push(time); this.seeking = true; },
            pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
        const state = { player, isPlaying: true, isGapPausingRef: { current: false },
            subtitles: [{ start: 10, end: 15 }], currentIndex: 0,
            loopMode: 'single', playbackMode: 'sentence', isShadowing: false,
            isWaitingShadowRef: { current: false }, currentRepeatRef: { current: 0 },
            playbackRate: 1, shadowGapAdjustment: 0, isShadowGapOriginal: false,
            shadowRepeatCount: 2, getBufferedRange: sub => sub,
            setIsPlaying: value => { state.isPlaying = value; },
            setIsWaitingShadow() {}, setShadowCountdown() {},
            worker: { postMessage: msg => timers.push(msg) } };
        const c = { workerRef: { current: {} }, latestStateRef: { current: state },
            progressSeekRef: { current: { dragging: false, pendingIndex: null } },
            mediaSeekRef: { current: { active: false } }, timerTokenRef: { current: 0 },
            setCurrentTime() {}, seekThenMaybePlay: (time, resume) => {
                c.mediaSeekRef.current = { active: true, target: time, resume };
                state.isPlaying = false;
                player.pause();
            } };
        const start = source.indexOf('        workerRef.current.onmessage =', source.indexOf('// Re-implement the'));
        const end = source.indexOf('\n        };', start) + '\n        };'.length;
        vm.runInNewContext(source.slice(start, end), c);
        const send = (type, token = c.timerTokenRef.current) => c.workerRef.current.onmessage({ data: { type, token } });
        const located = () => { player.time = c.mediaSeekRef.current.target; player.seeking = false;
            c.mediaSeekRef.current.active = false; player.paused = false; state.isPlaying = true; };
        return { c, player, state, requests, timers, send, located };
    };
    test('single sentence repeats through multiple slow verified seeks: ' + file, () => {
        const { c, player, state, requests, timers, send, located } = setup();
        for (let cycle = 0; cycle < 3; cycle++) {
            player.time = 15.1;
            send('TICK');
            assert.equal(player.paused, true);
            assert.equal(state.isGapPausingRef.current, true);
            assert.equal(timers.at(-1).payload.delay, 400);
            assert.equal(requests.length, 0, 'pausing at B must not start another seek');
            state.isPlaying = false; // native pause event arrives before timer
            player.seeking = true; // even a delayed native seek must not discard TIMER_DONE
            send('TIMER_DONE');
            assert.equal(state.isGapPausingRef.current, false);
            assert.equal(c.mediaSeekRef.current.target, 10);
            send('TICK');
            assert.equal(timers.length, cycle + 1, 'no boundary checks while locating');
            located();
            send('TICK');
            assert.equal(player.paused, false);
            assert.equal(timers.length, cycle + 1);
        }
    });
    test('EOF still starts single-sentence repetition after native pause: ' + file, () => {
        const { player, state, send, timers, c } = setup();
        player.ended = true; player.paused = true; state.isPlaying = false;
        send('TICK');
        assert.equal(timers.length, 1);
        send('TIMER_DONE', c.timerTokenRef.current - 1);
        assert.equal(state.isGapPausingRef.current, true, 'stale timer cannot unlock');
        send('TIMER_DONE');
        assert.equal(c.mediaSeekRef.current.target, 10);
    });
    test('shadow repeats stay in the selected sentence after the repeat count: ' + file, () => {
        const { c, state, player, send, located } = setup();
        state.isShadowing = true;
        const jumps = [];
        state.jumpToSubtitle = index => jumps.push(index);
        send('TICK');
        assert.equal(state.isWaitingShadowRef.current, true);
        send('TIMER_DONE');
        assert.equal(c.mediaSeekRef.current.target, 10);
        assert.equal(state.currentRepeatRef.current, 1);
        located(); player.time = 15;
        send('TICK'); send('TIMER_DONE');
        assert.deepEqual(jumps, [0]);
        assert.equal(state.currentRepeatRef.current, 0);
    });
    test('native ended dispatches a sentence tick or advances the continuous playlist: ' + file, () => {
        const { c, state, player, timers } = setup();
        let transitions = 0;
        Object.assign(c, { loopModeRef: { current: 'single' }, markAllSubtitlesWatched() {},
            handlePlaylistEnd() { transitions++; } });
        const body = source.match(/onEnded=\{\(\) => \{([\s\S]*?)\}\} \/>/)[1];
        const ended = vm.runInNewContext('() => {' + body + '}', c);
        player.ended = true; player.paused = true; state.isPlaying = false;
        player.time = 14.9; // subtitle B can slightly exceed media duration
        ended();
        assert.equal(timers.length, 1);
        assert.equal(transitions, 0);
        state.playbackMode = 'continuous';
        ended();
        assert.equal(transitions, 1);
    });
    test('manual replay cancels gap lock and verifies A before playing: ' + file, () => {
        const { c, state, player } = setup();
        Object.assign(c, { trackLoadRef: { current: { active: false } }, mediaPlayRef: { current: { active: false } }, playerRef: { current: player }, isGapPausing: state.isGapPausingRef,
            subtitles: state.subtitles, currentIndex: 0, playbackMode: 'sentence',
            isWaitingShadowRef: state.isWaitingShadowRef, currentRepeatRef: state.currentRepeatRef,
            getBufferedRange: state.getBufferedRange, setIsPlaying: state.setIsPlaying,
            setIsWaitingShadow() {}, setShadowCountdown() {}, setSeekNotice() {} });
        const cancelStart = source.indexOf('    const cancelWorkerTimer =');
        const cancelEnd = source.indexOf('    const clampEchoTime =', cancelStart);
        const toggleStart = source.indexOf('    const togglePlay =');
        const toggleEnd = source.indexOf('    // --- WORKER INTEGRATION ---', toggleStart);
        c.workerRef.current.postMessage = () => {};
        c.mediaSeekRef.current.cancel = () => {};
        const toggle = vm.runInNewContext(source.slice(cancelStart, cancelEnd) + source.slice(toggleStart, toggleEnd) + '\ntogglePlay', c);
        player.paused = true; state.isGapPausingRef.current = true;
        toggle();
        assert.equal(state.isGapPausingRef.current, false);
        assert.equal(c.mediaSeekRef.current.target, 10);
        assert.equal(player.paused, true);
    });
}
