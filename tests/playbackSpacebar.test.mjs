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
    test('period toggles echo in reading and dictation modes and deduplicates software keyboard input: ' + file, () => {
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
        assert.equal(full.prevented, true); assert.equal(toggles, 3);
        state.blankMode = true;
        const ordinaryEditor = event(editor, {key:'.',code:'Period'}); handler(ordinaryEditor);
        assert.equal(ordinaryEditor.prevented, undefined); assert.equal(toggles, 3);
    });
    test('a focused read-only caption supports echo entry and exit without affecting editable text: '+file,()=>{
        let echo=false,toggles=0;
        const state={enabled:true,blankMode:false,toggleEcho(){echo=!echo;toggles++;}};
        const handler=create(()=>state);
        const reading={hasAttribute:name=>name==='data-subtitle-reading'};
        const target={dataset:{subtitleComposing:'false'},closest:()=>reading};
        for(const key of ['.','。']){
            const press=event(reading,{target,key,code:'Period',keyCode:key==='。'?229:190});handler(press);
            assert.equal(press.prevented,true);handler(event(reading,{type:'keyup',target}));
        }
        assert.equal(toggles,2);assert.equal(echo,false,'the same key exits echo too');
        const edit=event(editor,{key:'.',code:'Period'});handler(edit);
        assert.equal(edit.prevented,undefined);assert.equal(toggles,2);
    });
    test('Space remains a playback shortcut inside a partially typed phrase answer: ' + file, () => {
        let calls=0;
        const handler=create(()=>({enabled:true,echoMode:true,replayEcho:()=>calls++}));
        const target={dataset:{subtitlePhraseAnswer:JSON.stringify(["He's been",'spin'])},value:"He's",closest:()=>blank};
        const keydown=event(blank,{type:'keydown',target});handler(keydown);
        assert.equal(calls,1);assert.equal(keydown.prevented,true);
        const before=event(blank,{type:'beforeinput',inputType:'insertText',data:' ',target});handler(before);
        assert.equal(before.prevented,true);assert.equal(calls,1,'beforeinput does not replay twice');
    });
    test('idle IME blanks reserve Period and Space, active conversion keeps both keys: '+file,()=>{
        let echoes=0,plays=0;
        const handler=create(()=>({enabled:true,blankMode:true,toggleEcho:()=>echoes++,toggle:()=>plays++}));
        const target={dataset:{subtitleComposing:'false'},closest:()=>blank};
        const period=event(blank,{key:'。',code:'Period',keyCode:229,target});handler(period);
        assert.equal(echoes,1);assert.equal(period.prevented,true);
        const space=event(blank,{key:'Process',code:'Space',keyCode:229,target});handler(space);
        assert.equal(plays,1);assert.equal(space.prevented,true);
        const release=event(blank,{type:'keyup',target});handler(release);
        const software=event(blank,{type:'beforeinput',inputType:'insertText',data:'。',target});handler(software);
        assert.equal(echoes,2);assert.equal(software.prevented,true);
        target.dataset.subtitleComposing='true';
        for(const code of ['Period','Space']) {
            const input=event(blank,{key:code==='Period'?'。':' ',code,keyCode:229,target});handler(input);
            assert.equal(input.prevented,undefined);
        }
        target.dataset.subtitleComposing='false';target.dataset.subtitleCompositionEndedAt=String(Date.now());
        const commit=event(blank,{key:'Process',code:'Space',keyCode:229,target});handler(commit);
        assert.equal(commit.prevented,undefined);assert.equal(echoes,2);assert.equal(plays,1);
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
