import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../tools/nhk-refresh-audio.js',import.meta.url),'utf8');
const url='https://news.web.nhk/news/easy/20261126de81736/20261126de81736.html';
function fixture({paused=true,wrongPage=false,wrongPlayer=false,missingFrame=false}={}){
 const old={paused,currentTime:12.5,volume:.35,muted:true},media={readyState:1,pauseCalls:0,playCalls:0,pause(){this.pauseCalls++},play(){this.playCalls++;return Promise.resolve()}};
 let onLoad,tick,cleared=false,src='https://news.web.nhk/news/easy/player/audio-v6.html?voiceId=sample.m4a',reloads=0;
 const oldDoc={querySelector:()=>old},newDoc={querySelector:()=>media};
 const frame={contentDocument:oldDoc,addEventListener(type,handler){assert.equal(type,'load');onLoad=handler},get src(){return wrongPlayer?'https://other.example/player':src},set src(value){reloads++;src=value;this.contentDocument=newDoc;onLoad()}};
 const context={URL,location:{href:wrongPage?'https://other.example/':url},document:{querySelector(selector){assert.equal(selector,'#js-audio-inner iframe');return missingFrame?null:frame}},setInterval(fn){tick=fn;return 1},clearInterval(){cleared=true}};
 const result=JSON.parse(vm.runInNewContext(code,context));
 return {result,media,frame,get reloads(){return reloads},tick:()=>tick?.(),get cleared(){return cleared}};
}
test('NHK renewal reloads only the audio frame and restores paused position/volume',()=>{
 const f=fixture();assert.equal(f.result.reloading,true);assert.equal(f.reloads,1);f.tick();
 assert.equal(f.media.currentTime,12.5);assert.equal(f.media.volume,.35);assert.equal(f.media.muted,true);assert.equal(f.media.pauseCalls,1);assert.equal(f.media.playCalls,0);assert.equal(f.cleared,true);
});
test('NHK renewal preserves a playing session',()=>{const f=fixture({paused:false});f.tick();assert.equal(f.media.playCalls,1);assert.equal(f.media.pauseCalls,0);assert.equal(f.media.currentTime,12.5)});
test('renewal refuses wrong site, wrong player and unopened audio',()=>{
 for(const options of [{wrongPage:true},{wrongPlayer:true},{missingFrame:true}]){const f=fixture(options);assert.equal(f.result.reloading,false);assert.equal(f.reloads,0)}
});
test('restoration polling stops when media never becomes ready',()=>{const f=fixture();f.media.readyState=0;for(let i=0;i<60;i++)f.tick();assert.equal(f.cleared,true);assert.equal(f.media.playCalls,0)});
