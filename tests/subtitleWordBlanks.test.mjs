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
    const api = vm.runInNewContext(code + '\n({tokenizeSubtitlePractice, updateSubtitlePracticeAnswer, isSubtitlePracticeAnswerCorrect, isSubtitlePracticeTextHit, getSubtitlePracticeProgress, findSubtitlePracticeBlank, focusSubtitlePracticeBlank, installSubtitlePracticeFocus, getSubtitlePracticeLetterHints, syncSubtitlePracticeLetterOverlay, getSubtitlePracticeLetterAlignment, copySubtitlePracticeField})');
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
    test('letter hints align noncontiguous ordered letters without changing what was typed: ' + file, () => {
        const runs = (answer, typed) => Array.from(api.getSubtitlePracticeLetterHints(answer, typed), run => ({ text: run.text, matched: run.matched }));
        assert.deepEqual(runs('afternoon', 'aftex'), [{ text: 'afte', matched: true }, { text: 'x', matched: false }]);
        assert.deepEqual(runs('afternoon', 'xternooy'), [{ text: 'x', matched: false }, { text: 'ternoo', matched: true }, { text: 'y', matched: false }]);
        assert.deepEqual(runs('attending', 'tten'), [{ text: 'tten', matched: true }]);
        assert.deepEqual(runs('abc', 'xyz'), [{ text: 'xyz', matched: false }]);
        assert.deepEqual(runs('banana', 'anaxban'), [{ text: 'ana', matched: true }, { text: 'xba', matched: false }, { text: 'n', matched: true }], 'repeated letters map once in answer order');
        assert.deepEqual(runs('CAFÉ', 'xCafe\u0301y'), [{ text: 'x', matched: false }, { text: 'Cafe\u0301', matched: true }, { text: 'y', matched: false }]);
        assert.deepEqual(runs('word', ''), []);
        const fallback = vm.runInNewContext(code + '\ngetSubtitlePracticeLetterHints', { Intl: {} });
        assert.equal(fallback('CAFÉ', 'cafe\u0301')[0].matched, true);
    });
    test('answer-position slots show every missing letter and do not reuse repeated characters: ' + file, () => {
        const pattern = alignment => Array.from(alignment.slots, slot => slot.matched ? slot.text : '_').join('');
        assert.equal(pattern(api.getSubtitlePracticeLetterAlignment('afternoon', 'ftn')), '_ft__n___');
        assert.equal(pattern(api.getSubtitlePracticeLetterAlignment('afternoon', 'aon')), 'a_____o_n');
        const repeated = api.getSubtitlePracticeLetterAlignment('noon', 'oooo');
        assert.equal(pattern(repeated), '_oo_'); assert.equal(repeated.matchedCount, 2);
        assert.equal(pattern(api.getSubtitlePracticeLetterAlignment('word', 'xyz')), '____');
        assert.equal(pattern(api.getSubtitlePracticeLetterAlignment('CAFÉ', 'cFe\u0301')), 'C_FÉ');
    });
    test('copy selects the field and supports Clipboard API, fallback and explicit failure: ' + file, async () => {
        const writes = []; let selections = 0, fallbacks = 0;
        const field = { value: 'Good', focus() {}, select() { selections++; }, ownerDocument: {
            defaultView: { navigator: { clipboard: { writeText: async value => writes.push(value) } } },
            execCommand: name => { assert.equal(name, 'copy'); fallbacks++; return true; }
        } };
        assert.equal(await api.copySubtitlePracticeField(field), true);
        assert.deepEqual(writes, ['Good']); assert.equal(selections, 1); assert.equal(fallbacks, 0);
        field.ownerDocument.defaultView.navigator.clipboard.writeText = async () => { throw Error('denied'); };
        assert.equal(await api.copySubtitlePracticeField(field), true); assert.equal(fallbacks, 1);
        field.ownerDocument.execCommand = () => false;
        assert.equal(await api.copySubtitlePracticeField(field), false);
    });
    test('letter overlays follow the native input horizontal scroll: ' + file, () => {
        const overlay = { scrollLeft: 0 };
        const field = { scrollLeft: 37, parentElement: { querySelector: () => overlay } };
        api.syncSubtitlePracticeLetterOverlay(field); assert.equal(overlay.scrollLeft, 37);
        field.scrollLeft = 0; api.syncSubtitlePracticeLetterOverlay(field); assert.equal(overlay.scrollLeft, 0);
    });
    test('bracketed stage directions are visible literals and excluded from exercise totals: ' + file, () => {
        const source = '[ Applause ] - Good afternoon. [Music, laughing\ncontinues] ［掌聲］';
        const parts = tokens(source);
        assert.equal(join(parts), source);
        assert.deepEqual(Array.from(parts.filter(part => part.kind === 'word'), word => word.parts.map(part => part.text).join('')), ['Good', 'afternoon']);
        assert.equal(api.getSubtitlePracticeProgress(parts, {}).total, 2);
        assert.equal(tokens('[Applause]').filter(part => part.kind === 'word').length, 0);
        const fallback = vm.runInNewContext(code + '\ntokenizeSubtitlePractice', { Intl: {} });
        assert.equal(fallback(source).filter(part => part.kind === 'word').length, 2);
    });
    test('case differences are accepted and replaced by the original subtitle casing: ' + file, () => {
        for (const [target, typed] of [['Good', 'good'], ['afternoon', 'AFTERNOON'], ['iPhone', 'IPHONE'], ['CAFÉ', 'cafe\u0301']]) {
            const word = tokens(target)[0];
            const answer = api.updateSubtitlePracticeAnswer(word, null, 0, typed);
            assert.equal(answer.values[0], target);
            assert.equal(api.isSubtitlePracticeAnswerCorrect(word, answer), true);
            assert.equal(api.isSubtitlePracticeAnswerCorrect(word, { values: [typed] }), true);
            assert.equal(answer.revealed, false);
        }
        const word = tokens('Hope')[0];
        assert.equal(api.isSubtitlePracticeAnswerCorrect(word, api.updateSubtitlePracticeAnswer(word, null, 0, 'hop')), false);
        assert.equal(api.isSubtitlePracticeAnswerCorrect(word, api.updateSubtitlePracticeAnswer(word, null, 0, 'hoped')), false);
        const composing = api.updateSubtitlePracticeAnswer(word, null, 0, 'hope', true);
        assert.equal(composing.values[0], 'hope', 'do not rewrite IME input before composition ends');
        assert.equal(api.updateSubtitlePracticeAnswer(word, composing, 0, 'hope').values[0], 'Hope');
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
    test('sentence completion includes hints but excludes wrong or missing words: ' + file, () => {
        const words = tokens('One, two!').filter(token => token.kind === 'word');
        const answers = { 0: api.updateSubtitlePracticeAnswer(words[0], null, 0, 'One') };
        assert.equal(api.getSubtitlePracticeProgress(words, answers).done, false);
        answers[1] = api.updateSubtitlePracticeAnswer(words[1], null, 0, 'wrong');
        assert.equal(api.getSubtitlePracticeProgress(words, answers).done, false);
        answers[1] = api.updateSubtitlePracticeAnswer(words[1], null, 0, '?');
        const progress = api.getSubtitlePracticeProgress(words, answers);
        assert.equal(progress.done, true); assert.equal(progress.hints, 1); assert.equal(progress.completed, 2);
        assert.equal(api.getSubtitlePracticeProgress(tokens('?!'), {}).done, false);
    });
    test('focus returns after replay, prefers the first empty word, and respects other editors: ' + file, () => {
        const frames = new Map(), listeners = new Map(), winListeners = new Map(); let id = 0;
        const win = { navigator: { userAgent: 'Chrome', platform: 'MacIntel', maxTouchPoints: 0 }, matchMedia: () => ({ matches: false }),
            requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: key => frames.delete(key),
            addEventListener: (type, fn) => winListeners.set(type, fn), removeEventListener: type => winListeners.delete(type) };
        const button = { closest: () => null }, otherEditor = { closest: () => ({}) };
        const doc = { defaultView: win, activeElement: button, getSelection: () => ({ toString: () => '' }),
            addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
        const make = (value, complete = false, readOnly = false) => ({ value, readOnly, dataset: { subtitlePartComplete: String(complete) },
            focus() { doc.activeElement = this; }, blur() { doc.activeElement = button; } });
        const fields = [make('correct', true), make('wrong'), make('', false, true), make(''), make('')];
        const container = { ownerDocument: doc, contains: node => fields.includes(node), querySelectorAll: () => fields };
        const flush = () => { const tasks = [...frames.values()]; frames.clear(); tasks.forEach(fn => fn()); };
        const cleanup = api.installSubtitlePracticeFocus(container); flush();
        assert.equal(doc.activeElement, fields[3]);
        const replay = { closest: () => ({ closest: () => ({}) }) };
        doc.activeElement = button; listeners.get('click')({ target: replay }); flush();
        assert.equal(doc.activeElement, fields[3], 'same-cue replay restores input without another click');
        doc.activeElement = otherEditor; listeners.get('click')({ target: replay }); flush();
        assert.equal(doc.activeElement, otherEditor, 'settings inputs keep their focus');
        fields[3].value = 'filled'; fields[4].value = 'filled';
        assert.equal(api.findSubtitlePracticeBlank(fields), fields[1], 'when none are empty, return to the earliest unresolved word');
        assert.equal(api.findSubtitlePracticeBlank(fields, fields[3]), fields[4], 'correct answers advance after the current blank before wrapping');
        doc.activeElement = button; listeners.get('click')({ target: replay });
        assert.equal(doc.activeElement, fields[1], 'focus is restored synchronously inside the playback gesture');
        doc.activeElement = button; cleanup(); flush();
        assert.equal(doc.activeElement, button); assert.equal(listeners.size, 0); assert.equal(winListeners.size, 0);
        for (const nav of [
            { userAgent: 'iPhone Safari', platform: 'iPhone', maxTouchPoints: 5 },
            { userAgent: 'Macintosh Safari', platform: 'MacIntel', maxTouchPoints: 5 },
            { userAgent: 'Android Chrome', platform: 'Linux', maxTouchPoints: 5, userAgentData: { mobile: true } }
        ]) {
            win.navigator = nav; win.matchMedia = () => ({ matches: true });
            doc.activeElement = button;
            const stop = api.installSubtitlePracticeFocus(container);
            assert.equal(doc.activeElement, fields[1], nav.userAgent + ' focuses its first unresolved input immediately');
            assert.equal(listeners.size, 1); flush();
            doc.activeElement = button; listeners.get('click')({ target: replay });
            assert.equal(doc.activeElement, fields[1], nav.userAgent + ' restores focus during the replay tap');
            stop(); flush();
            assert.equal(listeners.size, 0);
        }
        fields.forEach(field => { field.dataset.subtitlePartComplete = 'true'; });
        doc.activeElement = fields[4];
        api.focusSubtitlePracticeBlank(container);
        assert.equal(doc.activeElement, fields[4], 'finishing a sentence does not dismiss the mobile keyboard');
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
        const memo = (fn, deps) => { const at = cursor++; if (!slots[at] || (!deps || deps.some((dep, i) => !Object.is(dep, slots[at].deps?.[i])))) slots[at] = { deps, value: fn() }; return slots[at].value; };
        const runtime = { ...React, useMemo: memo, useRef: value => { const at = cursor++; return slots[at] ||= { current: value }; },
            useState: initial => { const at = cursor++; if (!(at in slots)) slots[at] = initial; return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }]; },
            useLayoutEffect: (fn, deps) => memo(() => { effects.push(fn); }, deps),
            useEffect: (fn, deps) => memo(() => { effects.push(fn); }, deps) };
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
        assert.equal(inputs[0].props.style.color, 'transparent', 'partial matches are painted by the letter overlay');
        type(inputs[0], 'Hello'); inputs = fields(render(props));
        assert.equal(inputs[0].props.style.color, '#2f7d57');
        type(inputs[1], '?'); inputs = fields(render(props));
        assert.equal(inputs[1].props.value, 'don'); assert.equal(inputs[2].props.value, 't');
        assert.equal(inputs[1].props.style.color, '#dc2626'); assert.equal(inputs[2].props.readOnly, true);
        assert.equal(fields(render({ ...props, blankMode: false })).length, 0);
        const next = { ...props, subtitle: { text: 'Next sentence.' }, text: 'Next sentence.' };
        assert.ok(fields(render(next)).every(input => input.props.value === ''));
        inputs = fields(render(props));
        assert.equal(inputs[0].props.value, 'Hello'); assert.equal(inputs[1].props.style.color, '#dc2626');
    });
    test('mixed letter colors stay hints until the whole blank is correct, and IME retains native text: ' + file, () => {
        const render = setup(); const props = { ...base(), text: 'Afternoon', subtitle: { text: 'Afternoon' } };
        let input = fields(render(props))[0];
        type(input, 'aftex'); let nodes = render(props); input = fields(nodes)[0];
        assert.equal(input.props.value, 'aftex'); assert.equal(input.props['data-subtitle-part-complete'], false);
        assert.equal(input.props.style.caretColor, '#6b4c9a');
        const overlay = nodes.find(node => node.props?.['data-subtitle-letter-overlay'] !== undefined);
        assert.ok(overlay); assert.equal(String(overlay.props['aria-hidden']), 'true');
        const colored = flatten(overlay).filter(node => node.type === 'span' && typeof node.props.children === 'string');
        assert.deepEqual(colored.map(node => [node.props.children, node.props.style.color]), [['afte', '#2f7d57'], ['x', '#6b4c9a']]);
        assert.equal(nodes.some(node => node.props?.role === 'status'), false);
        input.props.onCompositionStart({ currentTarget: { value: 'aftex' } }); nodes = render(props); input = fields(nodes)[0];
        assert.equal(input.props.style.color, '#6b4c9a');
        assert.equal(nodes.some(node => node.props?.['data-subtitle-letter-overlay'] !== undefined), false);
        input.props.onCompositionEnd({ currentTarget: { value: 'afternoon' } }); nodes = render(props); input = fields(nodes)[0];
        assert.equal(input.props.value, 'Afternoon'); assert.equal(input.props.style.color, '#2f7d57');
        assert.ok(nodes.some(node => node.props?.role === 'status'));
        assert.equal(nodes.some(node => node.props?.['data-subtitle-letter-overlay'] !== undefined), false);
    });
    test('double-click reveals empty fields, clears incorrect drafts and selects/copies correct or revealed text: ' + file, async () => {
        const render = setup(), props = base(), copied = [];
        const event = value => ({ preventDefault() {}, stopPropagation() {}, currentTarget: { value,
            focus() {}, select() { this.selectionStart = 0; this.selectionEnd = value.length; },
            ownerDocument: { defaultView: { navigator: { clipboard: { writeText: async text => copied.push(text) } } } } } });
        let input = fields(render(props))[0];
        await input.props.onDoubleClick(event('')); let inputs = fields(render(props));
        assert.equal(inputs[0].props.value, 'Hello'); assert.equal(inputs[0].props.style.color, '#dc2626');
        await inputs[0].props.onDoubleClick(event('Hello'));
        assert.deepEqual(copied, ['Hello']);
        assert.ok(render(props).some(node => node.props?.role === 'status' && node.props.children === '已複製'));
        inputs = fields(render(props)); type(inputs[1], 'wrong'); inputs = fields(render(props));
        await inputs[1].props.onDoubleClick(event('wrong')); inputs = fields(render(props));
        assert.equal(inputs[1].props.value, '');
        type(inputs[3], 'stop'); inputs = fields(render(props));
        const copyEvent = event('stop'); await inputs[3].props.onDoubleClick(copyEvent);
        assert.equal(copyEvent.currentTarget.selectionStart, 0); assert.equal(copyEvent.currentTarget.selectionEnd, 4);
        assert.deepEqual(copied, ['Hello', 'stop']);
    });
    test('touch double-tap reveals once and ignores the following synthesized double-click: ' + file, async () => {
        const render = setup(), props = base(); let copied = 0;
        const field = { value: '', focus() {}, select() {}, ownerDocument: { defaultView: { navigator: { clipboard: { writeText: async () => copied++ } } } } };
        const event = () => ({ pointerType: 'touch', clientX: 10, clientY: 10, currentTarget: field, preventDefault() {}, stopPropagation() {} });
        let input = fields(render(props))[0];
        await input.props.onPointerUp(event()); await input.props.onPointerUp(event());
        input = fields(render(props))[0]; assert.equal(input.props.value, 'Hello');
        field.value = 'Hello'; await input.props.onDoubleClick(event()); render(props);
        assert.equal(copied, 0, 'synthetic double-click must not copy the just-revealed answer');
    });
    test('position guide preserves editable draft while showing missing slots, and loading has no copy notice: ' + file, () => {
        const render = setup();
        assert.equal(fields(render({ ...base(), subtitle: undefined, text: 'Load File...' })).length, 0);
        const props = { ...base(), text: 'afternoon', subtitle: { text: 'afternoon' } };
        let input = fields(render(props))[0]; type(input, 'ftn');
        const nodes = render(props); input = fields(nodes)[0]; assert.equal(input.props.value, 'ftn');
        const note = nodes.find(node => node.props?.['data-subtitle-letter-guide'] !== undefined);
        assert.match(note.props['aria-label'], /_ f t _ _ n _ _ _/);
        assert.equal(nodes.some(node => node.props?.role === 'status'), false);
        assert.equal(input.props['data-subtitle-part-complete'], false);
    });
    test('each correct blank becomes green before the whole contraction is finished: ' + file, () => {
        const render = setup(), props = base();
        let inputs = fields(render(props));
        type(inputs[1], 'DON'); inputs = fields(render(props));
        assert.equal(inputs[1].props.value, 'don');
        assert.equal(inputs[1].props.style.color, '#2f7d57');
        assert.match(inputs[1].props['aria-label'], /正確/);
        assert.equal(inputs[2].props.style.color, '#6b4c9a');
        assert.equal(inputs[2].props.value, '');
        assert.equal(render(props).some(node => node.props?.role === 'status'), false);
        type(inputs[2], 'T'); inputs = fields(render(props));
        assert.equal(inputs[2].props.style.color, '#2f7d57');
        assert.equal(inputs[2].props.value, 't');
    });
    test('completion badge remains visible with hinted words and both modes share their font: ' + file, () => {
        const render = setup(), props = base();
        let inputs = fields(render(props));
        assert.equal(inputs[0].props.style.fontFamily, 'inherit');
        assert.equal(inputs[0].props.style.fontWeight, 'inherit');
        type(inputs[0], 'Hello'); inputs = fields(render(props));
        type(inputs[1], '?'); inputs = fields(render(props));
        assert.equal(render(props).some(node => node.props?.role === 'status'), false);
        type(inputs[3], 'stop');
        const badge = render(props).find(node => node.props?.role === 'status');
        assert.ok(badge); assert.match(JSON.stringify(badge.props.children), /本句完成/); assert.match(JSON.stringify(badge.props.children), /含 1 字提示/);
        assert.ok(render({ ...props, blankMode: false }).some(node => node.props?.role === 'status'));
        const other = { ...props, subtitle: { text: 'Other.' }, text: 'Other.' };
        assert.equal(render(other).some(node => node.props?.role === 'status'), false);
    });
    test('annotation display, case correction and sentence completion work together in the input component: ' + file, () => {
        const render = setup();
        const text = '[Applause] Good afternoon!';
        const props = { ...base(), text, subtitle: { text } };
        let nodes = render(props), inputs = fields(nodes);
        assert.equal(inputs.length, 2);
        assert.ok(nodes.some(node => node.type === 'span' && node.props.children === '[Applause]'));
        type(inputs[0], 'good'); inputs = fields(render(props));
        assert.equal(inputs[0].props.value, 'Good');
        assert.equal(inputs[0].props.style.color, '#2f7d57');
        assert.equal(inputs[0].props['data-subtitle-part-complete'], true);
        type(inputs[1], 'AFTERNOON'); nodes = render(props);
        assert.equal(fields(nodes)[1].props.value, 'afternoon');
        const badge = nodes.find(node => node.props?.role === 'status');
        assert.ok(badge); assert.doesNotMatch(JSON.stringify(badge.props.children), /字提示/);
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
