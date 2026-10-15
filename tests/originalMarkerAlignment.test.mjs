import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const marker = source.split('\n').find(line => line.startsWith('const KNOWLEDGE_ORIGINAL_MARKER_RE ='));
    const sentenceHelpers = source.slice(source.indexOf('const isAbbreviation ='), source.indexOf('const extractJsonObjectFromText ='));
    const helpers = source.slice(source.indexOf('const normalizeKnowledgeAlignmentText ='), source.indexOf('const MarkdownView ='));
    const api = vm.runInNewContext(marker + '\n' + sentenceHelpers + helpers +
        '\n({ buildKnowledgeOriginalSearchIndex, findKnowledgeSubtitleMatches, findKnowledgeExactSubtitleRanges, KNOWLEDGE_ORIGINAL_MARKER_RE })');

    test('ordinary prose must not become an Original section: ' + file, () => {
        for (const prose of ['Originally, geological history was divided into four spans.', 'Originality matters.', 'Original sin is discussed here.']) {
            assert.equal(api.KNOWLEDGE_ORIGINAL_MARKER_RE.test(prose), false);
        }
        for (const heading of ['[原文]', '[Original]', 'Original', 'Original: text', '原文：正文']) {
            assert.equal(api.KNOWLEDGE_ORIGINAL_MARKER_RE.test(heading), true);
        }
        const content = 'Welcome. And congratulations.\nFor the next many years (we hope) these tiny particles will uncomplainingly engage in all the billions of deft, cooperative efforts necessary to keep you intact and let you experience the supremely agreeable but generally underappreciated state known as existence.\nOriginally, geological history was divided into four spans.';
        const index = api.buildKnowledgeOriginalSearchIndex(content, { allowWholeDocumentFallback: true });
        assert.equal(index.originalMarkerCount, 0);
        assert.equal(index.useWholeDocument, true);
        assert.equal(index.entries.length, 3);
        // Both consecutive LRC fragments belong to the same book paragraph.
        for (const cue of [
            'For the next many years, we hope, these tiny particles will uncomplainingly engage in all the billions of deft, cooperative efforts necessary to keep you intact',
            'and let you experience the supremely agreeable, but generally underappreciated state known as existence.'
        ]) {
            const matches = api.findKnowledgeSubtitleMatches(content, cue, null, { index, startLine: 1, endLine: 2 });
            assert.ok(matches.some(match => match.sourceLine === 1));
            assert.ok(api.findKnowledgeExactSubtitleRanges(content.split('\n')[1], cue).length > 0);
        }
        const knowledge = 'metadata\n[原文]\nThis is the spoken original sentence.\n=== Vocabulary\nThis is an explanation.';
        const structured = api.buildKnowledgeOriginalSearchIndex(knowledge, { allowWholeDocumentFallback: true });
        assert.equal(structured.useWholeDocument, false);
        assert.equal(structured.entries.length, 1);
        assert.equal(structured.entries[0].sourceLine, 2);
    });
}
