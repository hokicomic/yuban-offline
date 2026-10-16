import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const noop = () => {};
    test('sentence linking defaults on and preserves duration at bounds: ' + file, () => {
        const effects = [];
        const sub = { start: 10, end: 15 };
        const c = { useRef: current => ({ current }), useState: initial => [initial, noop],
            useEffect: effect => effects.push(effect), subtitles: [sub], currentIndex: 0,
            currentTrackIndex: 0, playbackMode: 'sentence', duration: 100 };
        const code = source.slice(source.indexOf('    const sentenceTimelineRef ='), source.indexOf('    const getBufferedRange ='));
        const api = vm.runInNewContext(code + '\n({sentenceAbLinked, sentenceTimelineRef, sentenceRangeRef, adjustSentenceMarker})', c);
        assert.equal(api.sentenceAbLinked, true);
        effects[0]();
        api.sentenceTimelineRef.current = { getBoundingClientRect: () => ({ left: 0, width: 110 }) };
        api.adjustSentenceMarker('A', { clientX: 0 });
        assert.equal(api.sentenceRangeRef.current.start, 7);
        assert.equal(api.sentenceRangeRef.current.end, 12);
        api.adjustSentenceMarker('B', { clientX: 110 });
        assert.equal(api.sentenceRangeRef.current.start, 13);
        assert.equal(api.sentenceRangeRef.current.end, 18);
        api.adjustSentenceMarker('A', { clientX: 110 });
        assert.equal(api.sentenceRangeRef.current.end - api.sentenceRangeRef.current.start, 5);
    });

    test('echo enters once, shifts once, and replays only on drag release: ' + file, () => {
        const handlers = {};
        const seeks = [];
        const c = { subtitles: [{ start: 10, end: 15 }], currentIndex: 0, duration: 100,
            echoBounds: { start: 7, end: 18 }, playbackRate: 0.75,
            getBufferedRange: () => ({ start: 10, end: 15 }),
            playerRef: { current: { duration: 100, playbackRate: 0.75, pause: noop } },
            cancelWorkerTimer: noop, seekThenMaybePlay: (start, play) => seeks.push({ start, play }),
            echoTimelineRef: { current: { getBoundingClientRect: () => ({ left: 0, width: 110 }) } },
            window: { addEventListener: (name, fn) => { handlers[name] = fn; },
                removeEventListener: name => { delete handlers[name]; } }
        };
        for (const name of ['echoSessionTokenRef', 'echoModeRef', 'echoPhaseRef', 'echoStartRef',
            'echoEndRef', 'echoHasStartRef', 'echoHasEndRef', 'echoOriginalBoundsRef', 'echoWindowRef', 'echoBufferRef', 'isGapPausing']) c[name] = { current: 0 };
        for (const name of ['setEchoPhase', 'setEchoNotice', 'setEchoBounds', 'setEchoStart',
            'setEchoEnd', 'setEchoHasStart', 'setEchoHasEnd', 'setIsEchoMode', 'setIsPlaying', 'setIsToolbarVisible', 'setEchoBuffers']) c[name] = noop;
        const code = source.slice(source.indexOf('    const clampEchoTime ='), source.indexOf('    useEffect(() => {\n        const player = playerRef.current;\n        if (!isEchoMode', source.indexOf('    const clampEchoTime =')));
        const api = vm.runInNewContext(code + '\n({startEchoMode, shiftEchoRange, startEchoMarkerDrag, getEchoPlaybackRange, toggleEchoBuffer, playEchoRangeOnce})', c);
        api.startEchoMode();
        assert.equal(c.echoHasStartRef.current, true);
        assert.equal(c.echoHasEndRef.current, true);
        assert.equal(c.echoPhaseRef.current, 'listening');
        assert.equal(seeks.length, 1);
        api.shiftEchoRange(1);
        assert.equal(c.echoStartRef.current, 15);
        assert.equal(c.echoEndRef.current, 20);
        assert.equal(seeks.length, 1);
        assert.equal(c.echoPhaseRef.current, 'ready');
        api.shiftEchoRange(-1);
        assert.equal(c.echoStartRef.current, 10);
        assert.equal(c.echoEndRef.current, 15);
        api.startEchoMarkerDrag('A', { clientX: 20, preventDefault: noop });
        handlers.pointermove({ clientX: 10 });
        assert.equal(seeks.length, 2);
        handlers.pointerup();
        assert.equal(seeks.length, 3);
        assert.equal(seeks[2].start, 10);
        assert.equal(api.getEchoPlaybackRange(8, 12).start, 10);
        assert.equal(api.getEchoPlaybackRange(13, 17).end, 15);
        api.toggleEchoBuffer('before');
        assert.equal(api.getEchoPlaybackRange(8, 12).start, 8);
        assert.equal(api.getEchoPlaybackRange(13, 17).end, 15);
        api.toggleEchoBuffer('after');
        assert.equal(api.getEchoPlaybackRange(13, 17).end, 17);
        assert.equal(api.getEchoPlaybackRange(-5, 105).start, 7);
        assert.equal(api.getEchoPlaybackRange(-5, 105).end, 18);
        api.toggleEchoBuffer('before');
        api.toggleEchoBuffer('after');
        const validSeeks = seeks.length;
        // Outside the fixed window, keep virtual A/B and allow moving back.
        c.echoStartRef.current = 0;
        c.echoEndRef.current = 5;
        api.shiftEchoRange(-1);
        assert.equal(c.echoStartRef.current, -5);
        assert.equal(c.echoEndRef.current, 0);
        api.shiftEchoRange(1);
        assert.equal(c.echoStartRef.current, 0);
        assert.equal(c.echoEndRef.current, 5);
        c.echoStartRef.current = 95;
        c.echoEndRef.current = 100;
        api.shiftEchoRange(1);
        assert.equal(c.echoStartRef.current, 100);
        assert.equal(c.echoEndRef.current, 105);
        assert.equal(seeks.length, validSeeks);
        c.echoStartRef.current = 8;
        c.echoEndRef.current = 15;
        assert.equal(c.playerRef.current.playbackRate, 0.75);
        assert.equal(c.echoEndRef.current, 15);
        // Reaching B must pause and become ready rather than loop back to A.
        let tick;
        let pauses = 0;
        c.isEchoMode = true;
        c.setCurrentTime = noop;
        c.useEffect = fn => fn();
        c.playerRef.current.pause = () => { pauses += 1; };
        c.playerRef.current.addEventListener = (_name, fn) => { tick = fn; };
        c.playerRef.current.removeEventListener = noop;
        c.playerRef.current.currentTime = 15;
        const effectStart = source.indexOf('    useEffect(() => {\n        const player = playerRef.current;\n        if (!isEchoMode', source.indexOf('    const clampEchoTime ='));
        vm.runInNewContext(source.slice(effectStart, source.indexOf('    const seekThenMaybePlay =', effectStart)), c);
        tick();
        assert.equal(pauses, 1);
        assert.equal(c.echoPhaseRef.current, 'ready');
        assert.equal(seeks.length, validSeeks);
    });
}
