import test from 'node:test';
import assert from 'node:assert/strict';
import {getReviewPlaybackIndices,stepReviewIndex,tickReviewPlayback} from '../subtitleReview.js';
const subtitles=Array.from({length:6},(_,i)=>({start:i*10,end:i*10+5,text:'Sentence '+i}));
const state=()=>{
    const jumps=[],times=[];let stops=0;
    return {enabled:true,echo:false,indices:[1,3,5],currentIndex:1,playing:true,pending:null,
        mode:'continuous',loop:'all',player:{currentTime:12,seeking:false},busy:()=>false,
        range:i=>subtitles[i],onTime:t=>times.push(t),jump:i=>jumps.push(i),stop:()=>stops++,jumps,times,get stops(){return stops;}};
};
test('pending review cues are sorted and deduplicated, excluding mastered or unmappable records',()=>{
    const entries=[5,1,3,1].map(i=>({...subtitles[i],originalText:subtitles[i].text,mastered:i===3}));
    entries.push({start:999,end:1000,originalText:'missing',mastered:false});
    assert.deepEqual(getReviewPlaybackIndices(subtitles,{entries}),[1,5]);
});
test('next and previous wrap within the error group, including when outside the group',()=>{
    const indices=[1,3,5];
    assert.equal(stepReviewIndex(indices,5),1);assert.equal(stepReviewIndex(indices,1,-1),5);
    assert.equal(stepReviewIndex(indices,2),3);assert.equal(stepReviewIndex(indices,2,-1),1);
    assert.equal(stepReviewIndex([],2),-1);
});
test('continuous mode skips normal sentences and wraps at the last error even with single loop selected',()=>{
    const s=state();s.loop='single';s.player.currentTime=15;
    assert.equal(tickReviewPlayback(s),true);assert.deepEqual(s.jumps,[3]);
    tickReviewPlayback(s);assert.deepEqual(s.jumps,[3],'slow index commits cannot issue duplicate seeks');
    s.currentIndex=3;s.player.currentTime=31;tickReviewPlayback(s);assert.equal(s.pending,null);
    s.currentIndex=5;s.player.currentTime=55;tickReviewPlayback(s);assert.equal(s.jumps.at(-1),1);
});
test('single-sentence mode repeats its current error; all/none traversal remains inside the error group',()=>{
    const s=state();s.mode='sentence';s.loop='single';s.player.currentTime=15;tickReviewPlayback(s);assert.deepEqual(s.jumps,[1]);
    for(const loop of ['all','none']){const a=state();a.mode='sentence';a.loop=loop;a.player.currentTime=15;tickReviewPlayback(a);assert.deepEqual(a.jumps,[3]);}
});
test('native EOF wraps errors after pause without falling through to the next track',()=>{
    const s=state();s.currentIndex=5;s.playing=false;s.player.currentTime=55;
    assert.equal(tickReviewPlayback(s,true),true);assert.deepEqual(s.jumps,[1]);
});
test('empty review groups stop rather than falling back to ordinary playback',()=>{
    const s=state();s.indices=[];assert.equal(tickReviewPlayback(s),true);assert.equal(s.stops,1);assert.deepEqual(s.jumps,[]);
});
test('unfinished media seeks, pauses and disabled filters never trigger unexpected review jumps',()=>{
    const s=state();s.player.currentTime=15;s.player.seeking=true;tickReviewPlayback(s);assert.deepEqual(s.jumps,[]);
    s.player.seeking=false;s.busy=()=>true;tickReviewPlayback(s);assert.deepEqual(s.jumps,[]);
    s.busy=()=>false;s.playing=false;tickReviewPlayback(s);assert.deepEqual(s.jumps,[]);
    s.enabled=false;assert.equal(tickReviewPlayback(s),false);
    s.enabled=true;s.echo=true;assert.equal(tickReviewPlayback(s),false);
});
test('a playing cue outside the group is redirected to a real review cue, without sequential leakage',()=>{
    const s=state();s.currentIndex=2;s.player.currentTime=21;tickReviewPlayback(s);assert.deepEqual(s.jumps,[3]);
});
