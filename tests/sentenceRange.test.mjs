import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    test(`sentence A-B playback bounds in ${file}`, () => {
        const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
        const block = source.slice(source.indexOf('    const sentenceTimelineRef ='), source.indexOf('    const clearSurvivalPauseTimer ='));
        const sub = { id: 1, start: 10, end: 15, text: 'Example.' };
        const effects = [];
        const context = {
            useRef: current => ({ current }),
            useState: () => [0, () => {}],
            useEffect: callback => effects.push(callback),
            subtitles: [sub], currentIndex: 0, currentTrackIndex: 0,
            playbackMode: 'sentence', duration: 100, timePadding: 0,
            isSmartMode: true, echoModeRef: { current: false },
            subtitlesRef: { current: [sub] }
        };
        const api = vm.runInNewContext(block + '\n({ adjustSentenceMarker, getBufferedRange, sentenceTimelineRef, sentenceRangeRef })', context);
        effects[0]();
        api.sentenceTimelineRef.current = { getBoundingClientRect: () => ({ left: 0, width: 110 }) };
        assert.equal(api.getBufferedRange(sub).start, 10);
        assert.equal(api.getBufferedRange(sub).end, 15);
        api.adjustSentenceMarker('A', { clientX: 0 });
        api.adjustSentenceMarker('B', { clientX: 110 });
        assert.equal(api.getBufferedRange(sub).start, 7);
        assert.equal(api.getBufferedRange(sub).end, 18);
        api.adjustSentenceMarker('A', { clientX: 999 });
        assert.ok(api.getBufferedRange(sub).end - api.getBufferedRange(sub).start >= 0.079);
        context.playbackMode = 'continuous';
        assert.equal(api.getBufferedRange(sub).start, 10);
        assert.equal(api.getBufferedRange(sub).end, 15);
        context.playbackMode = 'sentence';
        context.currentIndex = 1;
        const next = { id: 2, start: 20, end: 25, text: 'Next.' };
        context.subtitles.push(next);
        effects[0]();
        assert.equal(api.sentenceRangeRef.current.sub, next);
        assert.equal(api.getBufferedRange(next).start, 20);
        assert.equal(api.getBufferedRange(next).end, 25);
    });
}
