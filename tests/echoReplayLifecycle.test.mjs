import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
for(const file of ['yuban-original.jsx','語伴20260713.1-codex.js']) {
 const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
 test('three consecutive echo replays seek only to A and ignore paused or old-position events: '+file,()=>{
  const handlers=new Map(),assignments=[],plays=[],timers=new Map();let timerId=0;
  const player={src:'blob:audio',readyState:4,paused:true,seeking:false,actual:10.08,
   get currentTime(){return this.actual;},set currentTime(value){assignments.push(value);this.seeking=true;},
   pause(){this.paused=true;},
   addEventListener(name,fn){if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);},
   removeEventListener(name,fn){handlers.get(name)?.delete(fn);},
   emit(name){for(const fn of [...(handlers.get(name)||[])])fn({type:name});}};
  const noop=()=>{},effects=[];
  const c={playerRef:{current:player},isEchoMode:true,echoModeRef:{current:true},echoPhaseRef:{current:'ready'},
   echoSessionTokenRef:{current:0},echoStartRef:{current:10},echoEndRef:{current:10.08},
   mediaSeekRef:{current:{active:false}},getEchoPlaybackRange:(start=10,end=10.08)=>({start,end}),
   cancelWorkerTimer:noop,setEchoPhase:noop,setEchoNotice:noop,setIsPlaying:noop,setCurrentTime:noop,
   useEffect:fn=>effects.push(fn),Date,setTimeout:(fn,ms)=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)};
  const helpers=source.slice(source.indexOf('const performVerifiedMediaSeek ='),source.indexOf('// Keep one playback request alive'));
  const api=vm.runInNewContext(helpers+'\n({performVerifiedMediaSeek})',c);
  c.seekThenMaybePlay=(target,play,callback,options)=>{
   const session={active:true};c.mediaSeekRef.current=session;
   api.performVerifiedMediaSeek(player,target,{tolerance:options.seekTolerance,isCurrent:()=>c.mediaSeekRef.current===session,
    onLocated:()=>{session.active=false;player.paused=false;plays.push(player.currentTime);},onFailure:()=>assert.fail('unexpected seek failure')});
  };
  const start=source.indexOf('    const playEchoRangeOnce =');
  const actions=source.slice(start,source.indexOf('    const startEchoMode =',start));
  const marker="    useEffect(() => {\n        const player = playerRef.current;\n        if (!isEchoMode";
  const effectStart=source.indexOf(marker,start);
  const effect=source.slice(effectStart,source.indexOf('    const requestMediaPlay =',effectStart));
  const echo=vm.runInNewContext(actions+effect+'\n({playEchoRangeOnce})',c);effects[0]();
  for(let pass=0;pass<3;pass++){
   echo.playEchoRangeOnce();assert.equal(plays.length,pass);
   player.seeking=false;player.actual=10.08;player.emit('timeupdate');
   assert.equal(plays.length,pass,'the previous B is not close enough to A for a short clip');
   player.actual=10;player.seeking=false;player.emit('seeked');assert.equal(plays.length,pass+1);
   player.actual=10.08;player.emit('timeupdate');assert.equal(player.paused,true);
   const count=assignments.length;player.emit('timeupdate');player.emit('timeupdate');
   assert.equal(assignments.length,count,'paused end events must not start repeated B seeks');
   assert.equal(c.echoPhaseRef.current,'ready');
  }
  assert.ok(assignments.length>=3);assert.ok(assignments.every(target=>target===10),'only replay starts may seek; never B');assert.deepEqual(plays,[10,10,10]);assert.equal(timers.size,0);
 });
}
