import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    test('saved buffer values default safely and stay within 0–60 seconds: ' + file, () => {
        const code = source.slice(source.indexOf('const normalizeSentenceTimelineBuffers ='), source.indexOf('const parsePlaybackTimeInput ='));
        const normalize = vm.runInNewContext(code + '\nnormalizeSentenceTimelineBuffers');
        for (const value of [undefined, null, {}, { before: 'bad', after: null }]) {
            const actual = normalize(value);
            assert.equal(actual.before, 3); assert.equal(actual.after, 3);
        }
        assert.equal(normalize({ before: -10, after: 100 }).before, 0);
        assert.equal(normalize({ before: -10, after: 100 }).after, 60);
        assert.equal(normalize({ before: 7.5, after: 12 }).before, 7.5);
        assert.equal(normalize({ before: 7.5, after: 12 }).after, 12);
    });
    test('independent larger buffers affect dragging, actual playback and inherited offsets: ' + file, () => {
        const effects = [];
        const sub = { start: 10, end: 15 };
        const next = { start: 25, end: 30 };
        const c = { useRef: current => ({ current }), useState: initial => [initial, () => {}],
            useEffect: effect => effects.push(effect), subtitles: [sub, next], currentIndex: 0,
            currentTrackIndex: 0, playbackMode: 'sentence', duration: 100,
            sentenceTimelineBuffers: { before: 10, after: 8 }, echoModeRef: { current: false } };
        const code = source.slice(source.indexOf('    const sentenceTimelineRef ='), source.indexOf('    const clearSurvivalPauseTimer ='));
        const api = vm.runInNewContext(code + '\n({adjustSentenceMarker, getBufferedRange, sentenceRangeRef, sentenceTimelineRef, sentenceTimelineStart, sentenceTimelineEnd})', c);
        effects[0]();
        assert.equal(api.sentenceTimelineStart, 0); assert.equal(api.sentenceTimelineEnd, 23);
        assert.equal(api.getBufferedRange(sub).start, 10, 'increasing buffers does not auto-extend playback');
        assert.equal(api.getBufferedRange(sub).end, 15);
        api.sentenceTimelineRef.current = { getBoundingClientRect: () => ({ left: 0, width: 230 }) };
        api.adjustSentenceMarker('A', { clientX: 0 });
        assert.equal(api.getBufferedRange(sub).start, 0);
        assert.equal(api.getBufferedRange(sub).end, 5);
        api.adjustSentenceMarker('B', { clientX: 230 });
        assert.equal(api.getBufferedRange(sub).start, 18);
        assert.equal(api.getBufferedRange(sub).end, 23);
        assert.equal(api.getBufferedRange(next).start, 33, 'next sentence inherits the allowed 8-second offset');
        c.sentenceTimelineBuffers = { before: 2, after: 1 };
        effects[0]();
        assert.equal(api.getBufferedRange(sub).start, 11);
        assert.equal(api.getBufferedRange(sub).end, 16, 'shrinking buffers keeps the selection inside the new timeline');
        assert.equal(api.getBufferedRange(next).start, 26);
        c.currentIndex = 1; c.currentTrackIndex = 1; effects[0]();
        assert.equal(api.getBufferedRange(next).start, 25, 'offset never transfers between media files');
    });
    test('visible buffers remain complete while draggable audio respects media boundaries: ' + file, () => {
        const c = { useRef: current => ({ current }), useState: initial => [initial, () => {}], useEffect() {},
            subtitles: [{ start: 2, end: 7 }], currentIndex: 0, currentTrackIndex: 0,
            playbackMode: 'sentence', duration: 10, sentenceTimelineBuffers: { before: 60, after: 60 } };
        const code = source.slice(source.indexOf('    const sentenceTimelineRef ='), source.indexOf('    const getBufferedRange ='));
        const bounds = vm.runInNewContext(code + '\n({start:sentenceTimelineStart,end:sentenceTimelineEnd,playableStart:sentencePlayableStart,playableEnd:sentencePlayableEnd,adjustSentenceMarker,sentenceRangeRef,sentenceTimelineRef})', c);
        assert.equal(bounds.start, -58); assert.equal(bounds.end, 67);
        assert.equal(bounds.playableStart, 0); assert.equal(bounds.playableEnd, 10);
        bounds.sentenceTimelineRef.current = { getBoundingClientRect: () => ({ left: 0, width: 125 }) };
        bounds.adjustSentenceMarker('A', { clientX: 0 });
        assert.equal(bounds.sentenceRangeRef.current.start, 0, 'unavailable front buffer cannot seek before zero');
        bounds.adjustSentenceMarker('B', { clientX: 125 });
        assert.equal(bounds.sentenceRangeRef.current.end, 10, 'unavailable tail buffer cannot seek past EOF');
    });
}
