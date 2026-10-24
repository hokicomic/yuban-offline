import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    test('worker follows actual media time and ignores unfinished seeks: ' + file, () => {
        const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
        const start = source.indexOf('        workerRef.current.onmessage =', source.indexOf('// Re-implement the'));
        const end = source.indexOf('\n        };', start) + '\n        };'.length;
        const player = { currentTime: 5400, seeking: false };
        const state = { player, isPlaying: true, isGapPausingRef: { current: false },
            subtitles: [{ start: 0, end: 10 }, { start: 7200, end: 7210 }],
            currentIndex: 0, isEchoMode: false, isShadowing: false, playbackMode: 'continuous',
            setCurrentIndex: index => { state.currentIndex = index; } };
        const c = { workerRef: { current: {} }, latestStateRef: { current: state },
            progressSeekRef: { current: { dragging: false, pendingIndex: null } },
            mediaSeekRef: { current: { active: true } }, setCurrentTime() {} };
        vm.runInNewContext(source.slice(start, end), c);
        c.workerRef.current.onmessage({ data: { type: 'TICK' } });
        assert.equal(state.currentIndex, 0);
        c.mediaSeekRef.current.active = false;
        c.workerRef.current.onmessage({ data: { type: 'TICK' } });
        assert.equal(state.currentIndex, -1);
        player.currentTime = 7202;
        c.workerRef.current.onmessage({ data: { type: 'TICK' } });
        assert.equal(state.currentIndex, 1);
    });

    test('long-file seeking stays exact across mode switches: ' + file, () => {
        const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
        const seeks = [];
        let token = 0;
        let preview;
        const player = { currentTime: 30, duration: 14400, paused: false,
            pause() { this.paused = true; } };
        const c = {
            playerRef: { current: player }, duration: 14400, isPlaying: true,
            subtitles: [{ start: 0, end: 10 }, { start: 3600, end: 3610 }, { start: 7200, end: 7210 }],
            currentIndex: 0, currentTrackIndex: 0, playbackMode: 'sentence',
            progressSeekRef: { current: { dragging: false, pendingIndex: null } },
            mediaSeekRef: { current: { active: false } },
            lastUserSeekValueRef: { current: 0 }, latestStateRef: { current: { playbackMode: 'sentence' } },
            cancelWorkerTimer: () => { token += 1; }, resetShadowStateForSeek() {},
            setCurrentIndex: index => { c.currentIndex = index; },
            setCurrentTime: time => { c.time = time; },
            setProgressPreview: time => { preview = time; },
            setIsPlaying: playing => { c.isPlaying = playing; },
            setPlaybackMode: mode => { c.playbackMode = mode; },
            seekThenMaybePlay: (time, resume, located) => { seeks.push({ time, resume, token, located }); }
        };
        c.subtitlesRef = { current: c.subtitles };
        const seekCode = source.slice(source.indexOf('    const seekToSubtitleByTime ='), source.indexOf('    const seekByContinuousOffset ='));
        const switchCode = source.slice(source.indexOf('    const togglePlaybackMode ='), source.indexOf('    // [NEW] Survival Mode Logic'));
        const api = vm.runInNewContext(seekCode + switchCode +
            '\n({beginProgressSeek, handleProgressInput, commitProgressSeek, cancelProgressSeek, togglePlaybackMode, seekToSubtitleByTime})', c);
        let captured;
        api.beginProgressSeek({ pointerId: 7, currentTarget: { setPointerCapture: id => { captured = id; } } });
        assert.equal(captured, 7);
        assert.equal(player.paused, true);
        api.handleProgressInput({ currentTarget: { value: '5400' } });
        c.setCurrentTime(31); // Playback updates must not overwrite the preview.
        assert.equal(preview, 5400);
        api.togglePlaybackMode();
        assert.equal(c.playbackMode, 'continuous');
        assert.equal(c.latestStateRef.current.playbackMode, 'continuous');
        assert.equal(seeks.at(-1).time, 5400);
        assert.equal(seeks.at(-1).resume, true);
        assert.equal(seeks.at(-1).token, token); // Switching must not cancel the new seek.
        assert.equal(c.currentIndex, 0); // Do not move subtitles before media confirms.
        seeks.at(-1).located(5400);
        assert.equal(c.currentIndex, -1); // Caption gaps show no future/previous sentence.
        assert.equal(preview, null);
        const count = seeks.length;
        api.commitProgressSeek(5400);
        assert.equal(seeks.length, count);
        api.togglePlaybackMode();
        assert.equal(c.latestStateRef.current.playbackMode, 'sentence');
        c.isPlaying = false;
        api.seekToSubtitleByTime(9000);
        assert.equal(seeks.at(-1).time, 9000);
        assert.equal(seeks.at(-1).resume, false);
        seeks.at(-1).located(9000);
        assert.equal(c.currentIndex, -1);
        api.beginProgressSeek();
        api.handleProgressInput({ currentTarget: { value: '10000' } });
        api.cancelProgressSeek();
        assert.equal(seeks.at(-1).time, 30);
        seeks.at(-1).located(30);
        assert.equal(preview, null);
        c.mediaSeekRef.current = { active: true, target: 6000, resume: true };
        api.togglePlaybackMode();
        assert.equal(seeks.at(-1).time, 6000);
        assert.equal(seeks.at(-1).resume, true);
    });
}
