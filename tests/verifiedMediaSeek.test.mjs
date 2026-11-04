import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('const parsePlaybackTimeInput ='), source.indexOf('const parseSRT ='));
    const setup = () => {
        let now = 0;
        let id = 0;
        const timers = new Map();
        const c = {
            Date: { now: () => now },
            setTimeout: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; },
            clearTimeout: key => timers.delete(key)
        };
        const api = vm.runInNewContext(code + '\n({performVerifiedMediaSeek, parsePlaybackTimeInput})', c);
        const advance = ms => {
            const end = now + ms;
            while (true) {
                const first = [...timers.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!first) break;
                timers.delete(first[0]);
                now = first[1].at;
                first[1].fn();
            }
            now = end;
        };
        const handlers = new Map();
        const player = {
            src: 'blob:long-audiobook', readyState: 4, seeking: false,
            actual: 30, paused: false, requests: [],
            get currentTime() { return this.actual; },
            set currentTime(time) { this.requests.push(time); this.seeking = true; },
            pause() { this.paused = true; },
            addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
            removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
            emit(name) { for (const fn of [...(handlers.get(name) || [])]) fn({ type: name }); }
        };
        return { api, advance, player, timers };
    };

    test('slow mobile seek never resumes at the old 650ms timeout: ' + file, () => {
        const { api, advance, player, timers } = setup();
        const located = [];
        const failed = [];
        api.performVerifiedMediaSeek(player, 5400, { isCurrent: () => true,
            onLocated: time => located.push(time), onFailure: time => failed.push(time) });
        advance(2000);
        assert.equal(located.length, 0);
        assert.equal(player.paused, true);
        player.actual = 5400;
        player.seeking = false;
        player.readyState = 1;
        player.emit('seeked');
        assert.equal(located.length, 0);
        player.readyState = 4;
        player.emit('canplay');
        assert.deepEqual(located, [5400]);
        assert.equal(failed.length, 0);
        assert.equal(timers.size, 0);
    });

    test('wrong position times out paused; stale seeks cannot complete: ' + file, () => {
        const { api, advance, player } = setup();
        const located = [];
        const failed = [];
        let current = true;
        api.performVerifiedMediaSeek(player, 5400, { isCurrent: () => current,
            onLocated: time => located.push(time), onFailure: time => failed.push(time), timeoutMs: 1500 });
        player.seeking = false;
        player.emit('seeked'); // Browser ended a seek at the wrong position.
        advance(1600);
        assert.equal(located.length, 0);
        assert.deepEqual(failed, [30]);
        assert.equal(player.paused, true);
        player.seeking = false;
        api.performVerifiedMediaSeek(player, 7200, { isCurrent: () => current,
            onLocated: time => located.push(time), onFailure: time => failed.push(time) });
        current = false;
        player.actual = 7200;
        player.seeking = false;
        player.emit('seeked');
        advance(16000);
        assert.equal(located.length, 0);
        assert.equal(failed.length, 1);
    });

    test('a new target supersedes an unfinished old seek immediately: ' + file, () => {
        const { api, player, advance } = setup();
        player.seeking = true;
        const located=[];
        api.performVerifiedMediaSeek(player,7200,{isCurrent:()=>true,onLocated:t=>located.push(t),onFailure(){assert.fail();}});
        assert.deepEqual(player.requests,[7200]);
        advance(1600);
        assert.equal(player.requests.length,2,'bounded stall retry without playing early');
        assert.equal(located.length,0);assert.equal(player.paused,true);
        player.actual=7200;player.seeking=false;player.emit('seeked');
        assert.deepEqual(located,[7200]);
    });

    test('stalled media reloads once, restores rate and verifies after fresh metadata: ' + file, () => {
        const { api, player, advance, timers } = setup();
        let loads=0;const located=[],failures=[];
        player.playbackRate=1.25;
        player.load=()=>{loads++;player.actual=0;player.readyState=0;player.seeking=false;player.playbackRate=1;player.emit('emptied');};
        api.performVerifiedMediaSeek(player,5400,{isCurrent:()=>true,onLocated:t=>located.push(t),onFailure:t=>failures.push(t)});
        advance(5300);
        assert.equal(loads,1);assert.equal(player.playbackRate,1.25);
        assert.equal(located.length,0);assert.equal(failures.length,0);
        player.readyState=1;player.emit('loadedmetadata');
        assert.equal(player.requests.at(-1),5400);
        player.actual=5400;player.seeking=false;player.readyState=4;player.emit('seeked');
        assert.deepEqual(located,[5400]);assert.equal(timers.size,0);
        advance(20000);assert.equal(loads,1);
    });

    test('cancelled recovery never reloads or publishes a late position: ' + file, () => {
        const { api, player, advance, timers } = setup();let loads=0;
        player.load=()=>loads++;
        const cancel=api.performVerifiedMediaSeek(player,5400,{isCurrent:()=>true,onLocated(){assert.fail();},onFailure(){assert.fail();}});
        cancel();advance(20000);player.actual=5400;player.seeking=false;player.emit('seeked');
        assert.equal(loads,0);assert.equal(timers.size,0);
    });

    test('time input supports hours, long minutes, seconds and decimals: ' + file, () => {
        const { api } = setup();
        for (const [input, expected] of [['1:23:45', 5025], ['90:00', 5400], ['5400', 5400], ['00:00:00', 0], ['1:02:03.5', 3723.5]]) {
            assert.equal(api.parsePlaybackTimeInput(input), expected);
        }
        for (const input of ['', '-1', '1:60', '1:99:00', 'abc', '1:2:3:4']) assert.equal(api.parsePlaybackTimeInput(input), null);
    });
}
