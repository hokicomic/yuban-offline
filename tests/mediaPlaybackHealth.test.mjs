import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('const monitorMediaPlayback ='), source.indexOf('// A seek request is not proof'));
    const setup = ({ restartNative = false } = {}) => {
        let now = 0, id = 0, suppressed = false;
        const timers = new Map(), listeners = new Map(), states = [], diagnostics = [];
        const player = { src: 'blob:book', currentTime: 7500, paused: false, seeking: false, readyState: 4,
            pause() { this.paused = true; this.emit('pause'); },
            addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
            removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
            emit(type) { for (const fn of [...(listeners.get(type) || [])]) fn({ type }); } };
        const api = vm.runInNewContext(code + '\nmonitorMediaPlayback', {
            Date: { now: () => now },
            setTimeout: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; },
            clearTimeout: key => timers.delete(key)
        });
        let recoveries = 0, failures = 0;
        const stop = api(player, { isSuppressed: () => suppressed,
            onState: state => states.push(state), onRecover: () => { recoveries++; if (restartNative) { player.pause(); player.paused = false; } }, onFailure: () => failures++,
            onDiagnostic: details => diagnostics.push(details) });
        const advance = ms => {
            const end = now + ms;
            while (true) {
                const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
                if (!entry || entry[1].at > end) break;
                now = entry[1].at; timers.delete(entry[0]); entry[1].fn();
            }
            now = end;
        };
        return { player, states, diagnostics, timers, listeners, stop, advance,
            suppress: value => { suppressed = value; }, recoveries: () => recoveries, failures: () => failures };
    };
    test('a frozen native clock retries once without changing the target, then stops visibly: ' + file, () => {
        const h = setup();
        h.player.emit('waiting');
        assert.equal(h.states.at(-1), 'waiting');
        h.advance(2000);
        assert.equal(h.recoveries(), 1);
        assert.equal(h.player.currentTime, 7500, 'recovery must not rewind already spoken words');
        h.advance(3200);
        assert.equal(h.recoveries(), 1); assert.equal(h.failures(), 1);
        assert.equal(h.player.paused, true); assert.equal(h.states.at(-1), 'paused');
        assert.ok(h.diagnostics.some(entry => entry.stage === 'stalled-clock-failed'));
        assert.equal(h.diagnostics.at(-1).stage, 'native-paused');
        h.advance(10000); assert.equal(h.failures(), 1);
        h.stop(); assert.equal(h.timers.size, 0);
    });
    test('pause/play recovery cannot repeatedly retry a frozen decoder: ' + file, () => {
        const h = setup({ restartNative: true }); h.advance(20000);
        assert.equal(h.recoveries(), 1); assert.equal(h.failures(), 1);
        assert.equal(h.player.currentTime, 7500); assert.equal(h.player.paused, true);
        h.stop();
    });
    test('data arriving after a stall resumes the icon and permits subsequent sentence monitoring: ' + file, () => {
        const h = setup(); h.advance(2000);
        assert.equal(h.recoveries(), 1);
        h.player.currentTime += 0.25; h.player.emit('timeupdate');
        assert.equal(h.states.at(-1), 'playing');
        h.advance(1200); assert.equal(h.failures(), 0);
        h.advance(800); assert.equal(h.recoveries(), 2, 'a later independent stall has its own bounded attempt');
        h.stop();
    });
    test('manual play after a failed recovery remains monitored: ' + file, () => {
        const h = setup(); h.advance(5200); assert.equal(h.failures(), 1);
        h.player.paused = false; h.player.currentTime += 0.5; h.player.emit('timeupdate');
        assert.equal(h.states.at(-1), 'playing');
        h.advance(5200); assert.equal(h.failures(), 2); h.stop();
    });
    test('manual pauses, shadow gaps and managed seeking never auto-resume: ' + file, () => {
        const h = setup(); h.player.pause(); h.advance(6000);
        assert.equal(h.recoveries(), 0); assert.equal(h.states.at(-1), 'paused');
        h.suppress(true); h.player.pause(); assert.equal(h.diagnostics.at(-1).managedOperation, true);
        h.player.paused = false; h.advance(20000);
        assert.equal(h.recoveries(), 0); assert.equal(h.failures(), 0);
        h.suppress(false); h.advance(1200); assert.equal(h.recoveries(), 0);
        h.player.currentTime += 0.25; h.player.emit('timeupdate');
        assert.equal(h.states.at(-1), 'playing'); h.stop();
    });
    test('source replacement and unmount discard pending recovery and event listeners: ' + file, () => {
        const h = setup(); h.player.src = 'blob:next'; h.player.emit('canplay'); h.advance(10000);
        assert.equal(h.recoveries(), 0); assert.equal(h.timers.size, 0);
        assert.ok([...h.listeners.values()].every(set => set.size === 0));
        const other = setup(); other.stop(); other.advance(10000);
        assert.equal(other.recoveries(), 0);
    });
    test('a delayed pause event after playback restarted cannot stop the UI heartbeat: ' + file, () => {
        const c = { setIsPlaying: value => { c.playing = value; } };
        const body = source.match(/onPause=\{\(event\) => \{([^\n]+?)\}\} onRateChange=/)[1];
        const pause = vm.runInNewContext('(event) => {' + body + '}', c);
        pause({ currentTarget: { paused: false } }); assert.notEqual(c.playing, false);
        pause({ currentTarget: { paused: true } }); assert.equal(c.playing, false);
    });
    test('a queued native playing event cannot claim a paused or still-seeking player is running: ' + file, () => {
        const c = { mediaSeekRef: { current: { active: false } }, setIsPlaying: value => { c.playing = value; } };
        const body = source.match(/onPlaying=\{\(event\) => \{([^\n]+?)\}\} onPause=/)[1];
        const playing = vm.runInNewContext('(event) => {' + body + '}', c);
        for (const state of [{ paused: true, seeking: false, readyState: 4 }, { paused: false, seeking: true, readyState: 4 }]) {
            playing({ currentTarget: state }); assert.notEqual(c.playing, true);
        }
        playing({ currentTarget: { paused: false, seeking: false, readyState: 4 } }); assert.equal(c.playing, true);
    });
}
