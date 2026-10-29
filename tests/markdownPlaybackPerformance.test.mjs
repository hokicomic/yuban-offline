import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import React from 'react';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const flatten = node => Array.isArray(node) ? node.flatMap(flatten)
    : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];
const entry = (term, back = 'meaning') => ({ term, latinOnly: true,
    items: [{ id: term, category: term.includes(' ') ? 'usage' : 'vocab', front: term, back }] });

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const instrumented = source.replace('const findMatchedMultiUsageItemKeys = (sourceText = "") => {',
        'const findMatchedMultiUsageItemKeys = (sourceText = "") => { globalThis.__performanceCounters.multiUsageScans++;');
    const compiled = await build({ stdin: { contents: instrumented + '\nexport { MarkdownView };', loader: 'jsx', resolveDir: root },
        bundle: true, platform: 'node', format: 'cjs', external: ['react'], write: false, logLevel: 'silent' });
    const setup = () => {
        let cursor = 0, layouts = [], effects = [];
        const slots = [];
        const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
        const memo = (factory, deps) => {
            const index = cursor++;
            if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
            return slots[index].value;
        };
        const ref = initial => { const index = cursor++; return slots[index] ||= { current: initial }; };
        const effect = (fn, deps, queue) => {
            const index = cursor++;
            if (!slots[index] || !same(slots[index].deps, deps)) { slots[index] = { deps }; queue.push(fn); }
        };
        const runtime = { ...React, useMemo: memo, useRef: ref,
            useEffect: (fn, deps) => effect(fn, deps, effects), useLayoutEffect: (fn, deps) => effect(fn, deps, layouts) };
        const module = { exports: {} };
        const counters = { multiUsageScans: 0 };
        vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
            require: name => name === 'react' ? runtime : require(name),
            __performanceCounters: counters, setTimeout, clearTimeout, console });
        return { counters, render: props => {
            cursor = 0; layouts = []; effects = [];
            const tree = module.exports.MarkdownView(props);
            layouts.forEach(fn => fn()); effects.forEach(fn => fn());
            return flatten(tree);
        } };
    };
    const content = '[原文]\nTheir commerce is vital.\nTrade is under siege.\nColor is disrupting the pattern.\n=== 單字 ===\nExplanation only.';
    const entries = ['commerce', 'vital', 'under siege', 'colour', 'disrupt'].map(term => entry(term));
    const props = { content, knowledgeTermEntries: entries, enableKnowledgeTermLinks: true,
        onKnowledgeTermClick() {}, activeKnowledgeSourceLines: [1], activeKnowledgeSubtitleText: 'Their commerce is vital.' };
    test('document-wide usage matching is not repeated for playback ticks or cue changes: ' + file, () => {
        const { render, counters } = setup();
        render(props);
        assert.equal(counters.multiUsageScans, 1);
        for (let i = 0; i < 10; i++) render(props);
        render({ ...props, activeKnowledgeSourceLines: [2], activeKnowledgeSubtitleText: 'Trade is under siege.' });
        assert.equal(counters.multiUsageScans, 1);
        render({ ...props, content: content + '\nNew document text.' });
        assert.equal(counters.multiUsageScans, 2, 'a changed document invalidates the cached evidence');
    });
    test('cached links retain inflections and dispatch through the current cue handler: ' + file, () => {
        const { render } = setup(); const clicks = [];
        const first = render({ ...props, onKnowledgeTermClick: value => clicks.push(['first', value.term]) });
        const color = first.find(node => node.type === 'button' && node.props.children === 'Color');
        assert.ok(color, 'colour dictionary entry must still match Color');
        assert.ok(first.some(node => node.type === 'button' && node.props.children === 'disrupting'));
        const second = render({ ...props, activeKnowledgeSourceLines: [2], activeKnowledgeSubtitleText: 'Trade is under siege.',
            onKnowledgeTermClick: value => clicks.push(['second', value.term]) });
        const cached = second.find(node => node.type === 'button' && node.props.children === 'Color');
        assert.equal(cached, color, 'unchanged source lines reuse link nodes');
        cached.props.onClick({ preventDefault() {}, stopPropagation() {} });
        assert.deepEqual(clicks, [['second', 'Color']]);
    });
    test('new dictionary contents invalidate links, and active terms follow the selected sentence: ' + file, () => {
        const { render } = setup(); const reported = [], clicked = [];
        render({ ...props, onActiveKnowledgeTermsChange: value => reported.push(value) });
        assert.equal(reported.at(-1).items.length, 2);
        assert.match(reported.at(-1).term, /commerce.*vital/);
        const next = render({ ...props, knowledgeTermEntries: [entry('commerce', 'updated meaning')],
            onKnowledgeTermClick: value => clicked.push(value) });
        next.find(node => node.type === 'button' && node.props.children === 'commerce').props.onClick({ preventDefault() {}, stopPropagation() {} });
        assert.equal(clicked[0].items[0].back, 'updated meaning');
    });
}
