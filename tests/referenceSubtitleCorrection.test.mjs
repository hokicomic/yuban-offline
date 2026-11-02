import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../', import.meta.url));
for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const marker = source.split('\n').find(line => line.startsWith('const KNOWLEDGE_ORIGINAL_MARKER_RE ='));
    const sentenceHelpers = source.slice(source.indexOf('const isAbbreviation ='), source.indexOf('const extractJsonObjectFromText ='));
    const helpers = source.slice(source.indexOf('const normalizeKnowledgeAlignmentText ='), source.indexOf('const MarkdownView ='));
    const api = vm.runInNewContext(marker + '\n' + sentenceHelpers + helpers + '\n({createSubtitleReferenceResolver, buildKnowledgeOriginalSearchIndex, findKnowledgePreciseSubtitleRanges})');
    const resolver = text => api.createSubtitleReferenceResolver(api.buildKnowledgeOriginalSearchIndex('[原文]\n' + text));
    test('context corrects ASR spelling without changing timing, punctuation or the original subtitle: ' + file, () => {
        const cue = { id: 7, start: 10, end: 15, text: 'All the sinatures agreed to join the block tomorrow.' };
        const original = JSON.stringify(cue);
        const engine = resolver('All the signatories agreed to join the bloc tomorrow. Another unspoken sentence follows.');
        const result = engine.resolve(cue);
        assert.equal(result.text, 'All the signatories agreed to join the bloc tomorrow.');
        assert.equal(result.edits.length, 2); assert.equal(result.trusted, true);
        assert.equal(result.ranges[0].text, 'All the signatories agreed to join the bloc tomorrow');
        assert.equal(JSON.stringify(cue), original);
        for (let i = 0; i < 100; i++) assert.equal(engine.resolve(cue), result, 'media ticks and replay reuse the same projection');
    });
    test('a partial cue cannot borrow the rest of a sentence or fill internal missing words: ' + file, () => {
        const text = 'The member states agreed to join the bloc and strengthen their common policy.';
        const result = resolver(text).resolve({ text: 'The member states agreed to join the block' });
        assert.equal(result.text, 'The member states agreed to join the bloc');
        assert.equal(result.ranges[0].text, 'The member states agreed to join the bloc');
        const missing = 'The member states agreed to join the bloc.';
        const reject = resolver('The member states finally agreed to join the bloc.').resolve({ text: missing });
        assert.equal(reject.text, missing); assert.equal(reject.trusted, false);
        assert.equal(resolver(text).resolve({ text: 'the block' }).changed, false);
    });
    test('adjacent duplicate tokens can be removed, while actual repetition and punctuation are preserved: ' + file, () => {
        const text = 'The member states agreed to join the bloc.';
        const result = resolver(text).resolve({ text: 'The member member states agreed to join the bloc.' });
        assert.equal(result.text, text); assert.equal(result.edits[0].kind, 'duplicate');
        const repeated = 'They were very very pleased with the final result.';
        assert.equal(resolver(repeated).resolve({ text: repeated }).text, repeated);
        assert.equal(resolver('They were very pleased with the final result.').resolve({ text: repeated }).changed, false, 'emphasis cannot be disproven by a reference omitting it');
        const separated = 'The member, member states agreed to join the bloc.';
        assert.equal(resolver(text).resolve({ text: separated }).changed, false);
        const end = resolver('All the signatories reached agreement today.').resolve({ text: 'All the signatories reached agreement today today.' });
        assert.equal(end.text, 'All the signatories reached agreement today.');
    });
    test('uncertain wording, numbers, negation and distant sequential jumps retain the raw cue: ' + file, () => {
        const ambiguous = 'The member states agreed to join the blocc tomorrow.';
        const result = resolver('The member states agreed to join the bloc tomorrow.\nThe member states agreed to join the block tomorrow.').resolve({ text: ambiguous }, { sourceLine: 1 });
        assert.equal(result.changed, false); assert.equal(result.text, ambiguous);
        for (const [ref, raw] of [
            ['The member states paid 200 million dollars yesterday.', 'The member states paid 100 million dollars yesterday.'],
            ['The member states did not sign the treaty.', 'The member states did now sign the treaty.'],
            ['The member states increased trade in the region.', 'The member states decreased trade in the region.']
        ]) assert.equal(resolver(ref).resolve({ text: raw }).changed, false);
        const distant = resolver(Array.from({ length: 90 }, (_, i) => `Unrelated section ${i}.`).join('\n') + '\nThe member states agreed to join the bloc tomorrow.');
        const cue = { text: 'The member states agreed to join the block tomorrow.' };
        assert.equal(distant.resolve(cue, { sourceLine: 1, sequential: true }).changed, false);
        const examples = api.createSubtitleReferenceResolver(api.buildKnowledgeOriginalSearchIndex('=== Examples\nThe member states agreed to join the bloc tomorrow.'));
        assert.equal(examples.resolve(cue).changed, false, 'knowledge explanations are not original-text evidence');
    });
    test('accepted multi-line cues expose only the actual mapped part of each line: ' + file, () => {
        const result = resolver('Earlier context. The signatories agreed to join the bloc\nbefore negotiations begin on Monday. Unspoken ending.').resolve({ text: 'The sinatures agreed to join the block before negotiations begin on Monday.' });
        assert.equal(result.text, 'The signatories agreed to join the bloc before negotiations begin on Monday.');
        assert.equal(result.ranges.length, 2);
        assert.equal(result.ranges[0].text, 'The signatories agreed to join the bloc');
        assert.equal(result.ranges[1].text, 'before negotiations begin on Monday');
    });
    test('precise ranges do not expand partial cues to the rest of a source sentence: ' + file, () => {
        const text = 'Now the two Gulf powers are under siege. Another sentence follows.';
        const ranges = api.findKnowledgePreciseSubtitleRanges(text, 'the two Gulf powers');
        assert.deepEqual(Array.from(ranges, range => text.slice(range.start, range.end)), ['the two Gulf powers']);
        const duplicate = 'The member states agreed to join the bloc. The member states agreed to join the bloc.';
        assert.equal(api.findKnowledgePreciseSubtitleRanges(duplicate, 'The member states agreed to join the block.').length, 0);
    });
    const compiled = await build({ stdin: { contents: source + '\nexport { MarkdownView };', loader: 'jsx', resolveDir: root }, bundle: true,
        platform: 'node', format: 'cjs', external: ['react'], write: false, logLevel: 'silent' });
    const module = { exports: {} };
    vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require, console, setTimeout, clearTimeout });
    test('the actual document renderer uses per-line cue portions and never backfills unspoken sentences: ' + file, () => {
        const text = '[原文]\nThe member states agreed to join the bloc and strengthen their common policy.\nBefore negotiations begin on Monday. Unspoken ending.';
        const markup = renderToStaticMarkup(React.createElement(module.exports.MarkdownView, {
            content: text, activeKnowledgeSourceLines: [1, 2], activeKnowledgeSubtitleText: 'The member states agreed to join the block before negotiations begin on Monday.',
            activeKnowledgeLineTexts: [{ sourceLine: 1, text: 'The member states agreed to join the bloc' }, { sourceLine: 2, text: 'before negotiations begin on Monday' }]
        }));
        const marked = [...markup.matchAll(/<mark[^>]*>([\s\S]*?)<\/mark>/g)].map(match => match[1].replace(/<[^>]*>/g, ''));
        assert.deepEqual(marked, ['The member states agreed to join the bloc', 'Before negotiations begin on Monday']);
        assert.ok(!marked.join(' ').includes('strengthen')); assert.ok(!marked.join(' ').includes('Unspoken'));
    });
}
