import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const lrc = `[24:06.94]Penzius and Wilson's finding pushed our acquaintance with a visible universe to
[24:11.24]within half an inch of the lobby floor.
[24:15.05]Still unaware of what caused the noise, Wilson and Penzius phoned Dickie at
[24:20.50]Princeton and described their problem to him in the hope that he might suggest a
[24:24.75]solution.
[24:25.90]Dickie realized at once what the two young men had found.
[24:29.29]Well, boys, we've just been scooped, he told his colleagues as he hung up the
[24:33.98]phone.`;
const previous = "Penzias and Wilson’s finding pushed our acquaintance with the visible7 universe to within half an inch of the lobby floor.";
const sentence = 'Still unaware of what caused the noise, Wilson and Penzias phoned Dicke at Princeton and described their problem to him in the hope that he might suggest a solution.';
const rawSentence = sentence.replace('Penzias', 'Penzius').replace('Dicke', 'Dickie');
const following = 'Dicke realized at once what the two young men had found.';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const marker = source.split('\n').find(line => line.startsWith('const KNOWLEDGE_ORIGINAL_MARKER_RE ='));
    const helpers = marker + '\n' +
        source.slice(source.indexOf('const clampSubtitles ='), source.indexOf('const normalizeSentenceTimelineBuffers =')) +
        source.slice(source.indexOf('const parseLRC ='), source.indexOf('const extractJsonObjectFromText =')) +
        source.slice(source.indexOf('const normalizeKnowledgeAlignmentText ='), source.indexOf('const MarkdownView ='));
    const api = vm.runInNewContext(helpers + '\n({parseLRC, generateSmartSubtitles, createSubtitleReferenceResolver, buildKnowledgeOriginalSearchIndex, applySubtitleReferencePreference})');
    const jump = source.slice(source.indexOf('    const jumpToSubtitle ='), source.indexOf('    const resetShadowStateForSeek ='));
    const next = source.slice(source.indexOf('    const handleNextPlaybackControl ='), source.indexOf('    const getMatchingSubtitleFiles ='));
    for (const mode of ['covered', 'cue-merged']) {
        test('LRC → next sentence → sequential reference correction preserves the complete clause: ' + mode + ' / ' + file, () => {
            const raw = api.parseLRC(lrc);
            const subtitles = api.generateSmartSubtitles(raw, 0.2, 3, 3, 'en-US', mode);
            assert.equal(subtitles.map(cue => cue.text).join(' '), raw.map(cue => cue.text).join(' '));
            const engine = api.createSubtitleReferenceResolver(api.buildKnowledgeOriginalSearchIndex('[原文]\n' + [previous, sentence, following].join('\n')));
            const preceding = engine.resolve(subtitles[0]);
            const seeks = [];
            const context = {
                subtitles, currentIndex: 0, playbackMode: 'single',
                playerRef: {current: {paused: false, seeking: false, ended: false}},
                currentRepeatRef: {current: 0}, isWaitingShadowRef: {current: false}, isGapPausing: {current: false},
                cancelWorkerTimer() {}, setIsWaitingShadow() {}, setShadowCountdown() {},
                jumpTrackByOffset() { throw new Error('must not skip to another track'); },
                setCurrentIndex(index) { context.currentIndex = index; },
                getBufferedRange: cue => ({start: cue.start, end: cue.end}),
                seekThenMaybePlay(start, resume, callback, {bufferedEnd}) { seeks.push({start, end: bufferedEnd, resume}); }
            };
            const control = vm.runInNewContext(jump + next + '\nhandleNextPlaybackControl', context);
            control();
            assert.equal(context.currentIndex, 1);
            assert.deepEqual(seeks[0], {start: 1455.05, end: 1465.9, resume: true});
            const cue = subtitles[context.currentIndex];
            assert.equal(cue.text, rawSentence);
            const projection = engine.resolve(cue, {sourceLine: preceding.ranges[0].sourceLine, sequential: true});
            const display = api.applySubtitleReferencePreference(projection);
            assert.equal(display.text, sentence);
            assert.equal(display.ranges[0].text, sentence.slice(0, -1));
            assert.ok(display.edits.every(edit => ['Penzius', 'Dickie'].includes(edit.from)));
            assert.equal(cue.text, rawSentence, 'original cue remains available with correction disabled');
            control();
            assert.equal(context.currentIndex, 2);
            assert.deepEqual(seeks[1], {start: 1465.9, end: 1469.29, resume: true});
            assert.equal(engine.resolve(subtitles[2], {sourceLine: display.ranges[0].sourceLine, sequential: true}).text, following);
        });
    }
}
