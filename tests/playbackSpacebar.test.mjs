import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('const createPlaybackShortcutHandler ='), source.indexOf('const SubtitlePractice ='));
    const create = vm.runInNewContext(code + '\ncreatePlaybackShortcutHandler');
    const event = (editor = null, extra = {}) => ({ key: ' ', code: 'Space', target: { closest: () => editor },
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
    const blank = { hasAttribute: name => name === 'data-subtitle-blank' };
    const editor = { hasAttribute: () => false };
    test('Space toggles normal playback from body, controls and auto-focused caption blanks: ' + file, () => {
        let playing = false, toggles = 0;
        const handler = create(() => ({ enabled: true, toggle() { playing = !playing; toggles++; } }));
        const start = event(blank); handler(start);
        assert.equal(playing, true); assert.equal(start.prevented, true); assert.equal(start.stopped, true);
        handler(event()); assert.equal(playing, false); assert.equal(toggles, 2);
        const held = event(blank, { repeat: true }); handler(held);
        assert.equal(toggles, 2); assert.equal(held.prevented, true);
    });
    test('Space replays the current echo fragment every time and reads the latest mode: ' + file, () => {
        let toggles = 0, repeats = 0;
        const state = { enabled: true, echoMode: false, toggle: () => toggles++, replayEcho: () => repeats++ };
        const handler = create(() => state);
        handler(event()); state.echoMode = true;
        handler(event(blank)); handler(event(blank));
        assert.equal(toggles, 1); assert.equal(repeats, 2);
    });
    test('Minus/slash use current previous/next controls and echo backward/forward actions: ' + file, () => {
        const calls = [];
        const state = { enabled: true, echoMode: false, previous: () => calls.push('previous'), next: () => calls.push('next'), shiftEcho: delta => calls.push(delta) };
        const handler = create(() => state);
        handler(event(null, { key: '-', code: 'Minus' })); handler(event(null, { key: '/', code: 'Slash' }));
        state.echoMode = true;
        handler(event(null, { key: '-', code: 'Minus' })); handler(event(null, { key: '/', code: 'Slash' }));
        assert.deepEqual(calls, ['previous', 'next', -1, 1]);
    });
    test('navigation shortcuts preserve Z/X typing and do not repeat while held: ' + file, () => {
        let calls = 0;
        const handler = create(() => ({ enabled: true, previous: () => calls++, next: () => calls++ }));
        for (const target of [blank, editor]) {
            for (const key of ['z', 'x']) {
                const input = event(target, { key, code: 'Key' + key.toUpperCase() }); handler(input);
                assert.equal(input.prevented, undefined);
            }
        }
        const held = event(null, { key: '/', code: 'Slash', repeat: true }); handler(held);
        assert.equal(held.prevented, true); assert.equal(calls, 0);
        const composing = event(null, { key: '-', code: 'Minus', isComposing: true }); handler(composing);
        assert.equal(composing.prevented, undefined); assert.equal(calls, 0);
    });
    test('dictation blanks handle punctuation from both hardware and software keyboards exactly once: ' + file, () => {
        const calls = [], state = { enabled: true, previous: () => calls.push('-'), next: () => calls.push('/') };
        const handler = create(() => state);
        const target = { closest: () => blank };
        handler(event(blank, { target, key: '-', code: 'Minus', type: 'keydown' }));
        const duplicate = event(blank, { target: { closest: () => blank }, key: undefined, code: '', type: 'beforeinput', inputType: 'insertText', data: '-' });
        handler(duplicate); assert.deepEqual(calls, ['-']); assert.equal(duplicate.prevented, true);
        handler(event(blank, { type: 'keyup' }));
        const soft = event(blank, { key: undefined, code: '', type: 'beforeinput', inputType: 'insertText', data: '/' });
        handler(soft); assert.deepEqual(calls, ['-', '/']); assert.equal(soft.prevented, true);
        const paste = event(blank, { type: 'beforeinput', inputType: 'insertFromPaste', data: '/', code: '' });
        handler(paste); assert.equal(paste.prevented, undefined);
        const editing = event(editor, { key: '/', code: 'Slash' }); handler(editing);
        assert.equal(editing.prevented, undefined);
        state.echoMode = true; state.shiftEcho = direction => calls.push(direction);
        handler(event(blank, { type: 'beforeinput', inputType: 'insertText', data: '-', code: '' }));
        assert.equal(calls.at(-1), -1);
    });
    test('period toggles echo only during dictation and deduplicates software keyboard input: ' + file, () => {
        let toggles = 0;
        const state = { enabled: true, blankMode: true, toggleEcho() { toggles++; } };
        const handler = create(() => state);
        handler(event(blank, { type: 'keydown', key: '.', code: 'Period' }));
        const duplicate = event(blank, { type: 'beforeinput', inputType: 'insertText', data: '.', code: '' });
        handler(duplicate); assert.equal(toggles, 1); assert.equal(duplicate.prevented, true);
        handler(event(blank, { type: 'keyup' }));
        handler(event(blank, { type: 'beforeinput', inputType: 'insertText', data: '.', code: '' }));
        assert.equal(toggles, 2);
        for (const extra of [{repeat:true}, {isComposing:true}, {ctrlKey:true}]) handler(event(blank, {key:'.',code:'Period',...extra}));
        assert.equal(toggles, 2);
        state.blankMode = false;
        const full = event(null, {key:'.',code:'Period'}); handler(full);
        assert.equal(full.prevented, undefined); assert.equal(toggles, 2);
        state.blankMode = true;
        const ordinaryEditor = event(editor, {key:'.',code:'Period'}); handler(ordinaryEditor);
        assert.equal(ordinaryEditor.prevented, undefined); assert.equal(toggles, 2);
    });
    test('typing spaces, composition, modified shortcuts and open overlays are left alone: ' + file, () => {
        let calls = 0; const state = { enabled: true, toggle: () => calls++ };
        const handler = create(() => state);
        for (const input of [event(editor), event(blank, { isComposing: true }), event(blank, { keyCode: 229 }),
            event(null, { ctrlKey: true }), event(null, { metaKey: true }), event(null, { altKey: true }), event(null, { shiftKey: true }),
            event(null, { key: 'Enter', code: 'Enter' }), event(null, { defaultPrevented: true })]) {
            handler(input); assert.equal(input.prevented, undefined);
        }
        state.enabled = false; const blocked = event(blank); handler(blocked);
        assert.equal(blocked.prevented, undefined); assert.equal(calls, 0);
    });
}
