import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../yuban-original.jsx', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('const isAbbreviation ='), source.indexOf('const extractJsonObjectFromText ='));
const generate = vm.runInNewContext(helpers + '\n generateSmartSubtitles');
const cue = (start, end, text) => ({ start, end, text });
const split = (cues, mode = 'covered', overlap = 0, cap = 8) =>
    generate(cues, overlap, 3, cap, 'en-US', mode);

test('neither mode adds punctuation to grammatical fragments', () => {
    for (const mode of ['covered', 'cue-merged']) {
        const result = split([cue(0, 2, 'I went to'), cue(2, 4, 'New York')], mode);
        assert.equal(result.map(s => s.text).join(' '), 'I went to New York');
    }
});

test('source punctuation does not make an unfinished trailing fragment into a sentence', () => {
    for (const mode of ['covered', 'cue-merged']) {
        const result = split([
            cue(0, 2, 'When the bell rang, we left.'),
            cue(2, 4, 'But the next morning')
        ], mode);
        assert.equal(result[0].text, 'When the bell rang, we left.');
        assert.equal(result[1].text, 'But the next morning');
        assert.equal(result[1].text.endsWith('.'), false);
    }
});

test('an observed cue boundary survives nonuniform speaking rates', () => {
    const result = split([cue(0, 10, 'He spoke very slowly'),
        cue(10, 12, 'and stopped. Next thought.')]);
    assert.equal(result.length, 2);
    assert.ok(result[0].end > 10 && result[0].end < 12);
    assert.equal(result[0].end, result[1].start);
    assert.equal(result[1].end, 12);
});

test('short sentences are not stretched to three seconds', () => {
    const result = split([cue(0, 0.5, 'Yes.'), cue(0.5, 5, 'We can proceed.')]);
    assert.equal(result[0].end, 0.5);
    assert.equal(result[1].start, 0.5);
});

test('zero overlap means adjoining internal estimates, even for short sentences', () => {
    const result = split([cue(0, 10, 'Yes. This is a substantially longer reply.')]);
    assert.equal(result.length, 2);
    assert.equal(result[0].end, result[1].start);
    assert.ok(result[0].end < 3);
});

test('reader groups respect cap and genuine subtitle gaps without inserting periods', () => {
    const result = split([cue(0, 1, 'we are'), cue(1, 2, 'still here'),
        cue(2, 3, 'and waiting'), cue(6, 7, 'for you')], 'cue-merged', 0, 2);
    assert.equal(result.length, 3);
    assert.equal(result[0].text, 'we are still here');
    assert.equal(result[1].end, 3);
    assert.equal(result[2].start, 6);
});

test('abbreviations remain intact, and curly quotes and CJK sentence marks split', () => {
    const result = split([cue(0, 8, 'Dr. Smith said “Hello.” Then left.')]);
    assert.equal(result.length, 2);
    assert.equal(result[0].text, 'Dr. Smith said “Hello.”');
    assert.equal(split([cue(0, 4, '你好。再見。')]).length, 2);
});
