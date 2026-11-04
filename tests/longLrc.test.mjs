import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for (const file of ['yuban-original.jsx','語伴20260713.1-codex.js']) {
    const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const clamp=source.slice(source.indexOf('const clampSubtitles ='),source.indexOf('const normalizeSentenceTimelineBuffers ='));
    const parser=source.slice(source.indexOf('const parseLRC ='),source.indexOf('const isAbbreviation ='));
    const parse=vm.runInNewContext(clamp+parser+';parseLRC');
    test('keep cumulative minutes beyond 99 and 999 for nineteen-hour audiobooks: '+file,()=>{
        const cues=parse('[00:00.00]Intro\n[99:58.43]Before the old cutoff\n[100:00.00]Beyond 100 minutes\n[124:56.55]Two-hour context\n[125:03.27]Two-hour next cue\n[1000:02.50]Beyond 1000 minutes\n[1139:10.67]Final credits');
        assert.equal(cues.length,7);
        assert.equal(cues[2].start,6000);
        assert.equal(cues[3].start,7496.55);
        assert.equal(cues[3].end,7503.27);
        assert.equal(cues[5].start,60002.5);
        assert.equal(cues[6].start,68350.67);
        assert.equal(cues.find(s=>7500>=s.start&&7500<s.end).text,'Two-hour context');
    });
    test('support explicit hours, fractions and multiple time tags without breaking ordinary LRC: '+file,()=>{
        const cues=parse('\uFEFF[ar:Artist]\r\n[0:03.5]Short minutes\r\n[01:02:03.456]Explicit hours\n[125:03.27][18:59:10.67]Repeated lyric');
        assert.equal(cues.length,4);
        assert.deepEqual(Array.from(cues,s=>s.start),[3.5,3723.456,7503.27,68350.67]);
        assert.equal(cues[2].text,'Repeated lyric');assert.equal(cues[3].text,'Repeated lyric');
    });
    test('reject invalid seconds/hour minutes and preserve chronological boundaries: '+file,()=>{
        const cues=parse('[125:60.00]Invalid seconds\n[1:60:00]Invalid hour minutes\n[101:05.2]Later\n[100:02.00]Earlier\n[00:00.00]');
        assert.equal(cues.length,2);assert.equal(cues[0].text,'Earlier');assert.equal(cues[0].end,6065.2);
        assert.equal(parse(null).length,0);
    });
}
