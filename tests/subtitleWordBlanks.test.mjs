import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const flatten = node => Array.isArray(node) ? node.flatMap(flatten)
    : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];
for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('const tokenizeSubtitlePractice ='), source.indexOf('const SubtitlePractice ='));
    const api = vm.runInNewContext(code + '\n({tokenizeSubtitlePractice, updateSubtitlePracticeAnswer, isSubtitlePracticeAnswerCorrect, isSubtitlePracticeTextHit})');
    const tokens = text => api.tokenizeSubtitlePractice(text, 'en-US');
    const join = items => items.map(item => item.kind === 'literal' ? item.text : item.parts.map(part => part.text).join('')).join('');
    test('blanks preserve punctuation, whitespace, contractions and multilingual text: ' + file, () => {
        for (const text of ['“Don’t stop,” she said.\nIt’s 2026!', '你好，世界！日本語です。', 'café — déjà vu? 3.14']) {
            const parts = tokens(text);
            assert.equal(join(parts), text);
            for (const word of parts.filter(item => item.kind === 'word')) {
                for (const part of word.parts.filter(item => item.kind === 'letters')) assert.match(part.text, /^[\p{L}\p{M}\p{N}]+$/u);
            }
        }
        const fallback = vm.runInNewContext(code + '\ntokenizeSubtitlePractice', { Intl: {} });
        assert.equal(join(fallback("Don't stop!\n再見。")), "Don't stop!\n再見。");
    });
    test('only the complete word is correct, and ? reveals the entire word: ' + file, () => {
        const word = tokens("don't").find(item => item.kind === 'word');
        let answer = api.updateSubtitlePracticeAnswer(word, null, 0, 'don');
        assert.equal(api.isSubtitlePracticeAnswerCorrect(word, answer), false);
        answer = api.updateSubtitlePracticeAnswer(word, answer, 1, 't');
        assert.equal(api.isSubtitlePracticeAnswerCorrect(word, answer), true);
        answer = api.updateSubtitlePracticeAnswer(word, answer, 1, '?', true);
        assert.equal(answer.revealed, false, 'IME composition must complete before a hint is applied');
        answer = api.updateSubtitlePracticeAnswer(word, answer, 1, '?');
        assert.equal(answer.revealed, true);
        assert.deepEqual(Array.from(answer.values), ['don', 't']);
        assert.equal(api.isSubtitlePracticeAnswerCorrect(word, answer), false, 'a hint is never scored as a correct answer');
        const accented = tokens('café')[0];
        assert.equal(api.isSubtitlePracticeAnswerCorrect(accented, { values: ['cafe\u0301'] }), true);
    });
    test('mode switching accepts blank space but excludes inputs and actual text glyphs: ' + file, () => {
        const node = { nodeType: 3, length: 4, textContent: 'Text' };
        const doc = { getSelection: () => ({ isCollapsed: true }), caretRangeFromPoint: () => ({ startContainer: node, startOffset: 4 }),
            createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [{ left: 10, right: 20, top: 10, bottom: 20 }] }) };
        const event = { target: { ownerDocument: doc, closest: () => false }, currentTarget: { contains: () => true }, clientX: 15, clientY: 15 };
        assert.equal(api.isSubtitlePracticeTextHit(event), true);
        assert.equal(api.isSubtitlePracticeTextHit({ ...event, clientX: 35 }), false);
        assert.equal(api.isSubtitlePracticeTextHit({ ...event, target: { closest: () => true } }), true);
        doc.getSelection = () => ({ isCollapsed: false, toString: () => 'selected text' });
        assert.equal(api.isSubtitlePracticeTextHit({ ...event, clientX: 35 }), true, 'selecting or copying text cannot toggle the mode');
    });
    const compiled = await build({ stdin: { contents: source + '\nexport { SubtitlePractice };', loader: 'jsx', resolveDir: root },
        bundle: true, platform: 'node', format: 'cjs', external: ['react'], write: false, logLevel: 'silent' });
    const setup = () => {
        let cursor = 0, effects = []; const slots = [];
        const memo = (fn, deps) => { const at = cursor++; if (!slots[at] || deps.some((dep, i) => !Object.is(dep, slots[at].deps[i]))) slots[at] = { deps, value: fn() }; return slots[at].value; };
        const runtime = { ...React, useMemo: memo, useRef: value => { const at = cursor++; return slots[at] ||= { current: value }; },
            useState: initial => { const at = cursor++; if (!(at in slots)) slots[at] = initial; return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }]; },
            useLayoutEffect: (fn, deps) => memo(() => { effects.push(fn); }, deps) };
        const module = { exports: {} };
        vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? runtime : require(name), console, setTimeout, clearTimeout });
        return props => {
            cursor = 0; effects = [];
            const nodes = flatten(module.exports.SubtitlePractice.type(props));
            for (const node of nodes) if (node.props?.contentEditable && node.props.ref) node.props.ref.current = { textContent: '' };
            effects.forEach(fn => fn()); return nodes;
        };
    };
    const base = () => ({ subtitle: { text: "Hello, don't stop!" }, text: "Hello, don't stop!", language: 'en-US', blankMode: true,
        fontSize: 24, textRef: { current: null }, editsRef: { current: new WeakMap() } });
    const fields = nodes => nodes.filter(node => node.type === 'input');
    const type = (field, value) => field.props.onChange({ target: { value }, nativeEvent: {} });
    test('typing updates real input props, correct/revealed colors, and retains drafts across modes and cues: ' + file, () => {
        const render = setup(), props = base();
        let inputs = fields(render(props));
        assert.equal(inputs.length, 4); assert.ok(inputs.every(input => input.props.value === ''));
        type(inputs[0], 'Hell'); inputs = fields(render(props));
        assert.equal(inputs[0].props.style.color, '#334155');
        type(inputs[0], 'Hello'); inputs = fields(render(props));
        assert.equal(inputs[0].props.style.color, '#166534');
        type(inputs[1], '?'); inputs = fields(render(props));
        assert.equal(inputs[1].props.value, 'don'); assert.equal(inputs[2].props.value, 't');
        assert.equal(inputs[1].props.style.color, '#dc2626'); assert.equal(inputs[2].props.readOnly, true);
        assert.equal(fields(render({ ...props, blankMode: false })).length, 0);
        const next = { ...props, subtitle: { text: 'Next sentence.' }, text: 'Next sentence.' };
        assert.ok(fields(render(next)).every(input => input.props.value === ''));
        inputs = fields(render(props));
        assert.equal(inputs[0].props.value, 'Hello'); assert.equal(inputs[1].props.style.color, '#dc2626');
    });
    test('full subtitle editing is preserved and edited text becomes the next exercise: ' + file, () => {
        const render = setup(), props = base();
        const editor = render({ ...props, blankMode: false }).find(node => node.props?.role === 'textbox');
        assert.equal(editor.props.ref.current.textContent, props.text);
        editor.props.onInput({ currentTarget: { textContent: 'Edited, text.' } });
        assert.equal(fields(render(props)).length, 2);
        const full = render({ ...props, blankMode: false }).find(node => node.props?.role === 'textbox');
        assert.equal(full.props.ref.current.textContent, 'Edited, text.');
    });
}
