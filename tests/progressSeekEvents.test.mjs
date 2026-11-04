import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for(const file of ['yuban-original.jsx','語伴20260713.1-codex.js']){
    const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const code=source.slice(source.indexOf('    const seekToSubtitleByTime ='),source.indexOf('    const seekByContinuousOffset ='));
    const setup=()=>{
        const seeks=[];const player={currentTime:30,duration:70000,paused:false,pause(){this.paused=true;}};
        const c={playerRef:{current:player},duration:70000,isPlaying:true,currentTrackIndex:0,
            progressSeekRef:{current:{dragging:false,pendingIndex:null}},lastUserSeekValueRef:{current:0},
            mediaSeekRef:{current:{active:false}},mediaPlayRef:{current:{active:false}},
            subtitlesRef:{current:[{start:7496.55,end:7513.88}]},
            resetShadowStateForSeek(){},setProgressPreview(){},setIsPlaying(v){c.isPlaying=v;},setCurrentIndex(i){c.index=i;},setCurrentTime(){},
            cancelWorkerTimer(){c.mediaSeekRef.current.cancel?.();c.mediaSeekRef.current.active=false;},
            seekThenMaybePlay(time,resume,located){const session={active:true,target:time,resume,cancel(){session.cancelled=true;}};c.mediaSeekRef.current=session;seeks.push({time,resume,located,session});}
        };
        const api=vm.runInNewContext(code+';({beginProgressSeek,handleProgressInput,commitProgressSeek'+(code.includes('const handleProgressChange =')?',handleProgressChange':'')+'})',c);
        const event=value=>({currentTarget:{value:String(value),setPointerCapture(){}}});
        return {c,api,seeks,event};
    };
    test('late duplicate range input cannot cancel a just-committed seek: '+file,()=>{
        const {c,api,seeks,event}=setup();
        api.beginProgressSeek({...event(30),pointerId:1});api.handleProgressInput(event(7500));api.commitProgressSeek(7500);
        api.handleProgressInput(event(7500));
        assert.equal(seeks.length,1);assert.equal(seeks[0].session.cancelled,undefined);
        assert.equal(c.progressSeekRef.current.dragging,false,'no orphaned interaction after pointerup');
        assert.equal(c.mediaSeekRef.current.active,true);
    });
    test('final iOS change after pointerup commits its final value and preserves resume: '+file,()=>{
        const {c,api,seeks,event}=setup();assert.equal(typeof api.handleProgressChange,'function');
        api.beginProgressSeek({...event(30),pointerId:1});api.handleProgressInput(event(7200));api.commitProgressSeek(7200);
        api.handleProgressInput(event(7500));api.handleProgressChange(event(7500));
        assert.equal(seeks.at(-1).time,7500);assert.equal(seeks.at(-1).resume,true);
        assert.equal(c.progressSeekRef.current.dragging,false);assert.equal(c.mediaSeekRef.current.active,true);
        seeks.at(-1).located(7500);assert.equal(c.index,0);
    });
    test('accessibility-only range changes commit without a pointer sequence: '+file,()=>{
        const {c,api,seeks,event}=setup();assert.equal(typeof api.handleProgressChange,'function');
        api.handleProgressInput(event(7500));api.handleProgressChange(event(7500));
        assert.equal(seeks.at(-1).time,7500);assert.equal(c.progressSeekRef.current.dragging,false);
    });
}
