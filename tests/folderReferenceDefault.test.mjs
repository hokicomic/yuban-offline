import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
for(const filename of ['yuban-original.jsx','語伴20260713.1-codex.js']){
 const source=readFileSync(new URL('../'+filename,import.meta.url),'utf8');
 const helper=source.slice(source.indexOf('const getSingleFolderReferenceTxt ='),source.indexOf('const getKnowledgeVerifiedHighlightRanges ='));
 const choose=vm.runInNewContext(helper+'\ngetSingleFolderReferenceTxt;');
 const txt={name:'Common book.TXT'},audio={name:'Chapter 01.m4a',type:'audio/mp4'},video={name:'Chapter 01.mp4',type:'video/mp4'};
 test('one folder TXT opens only when no video is already displayed; multiple texts are never guessed: '+filename,()=>{
  assert.equal(choose([audio,txt]),txt);assert.equal(choose([txt]),txt);
  assert.equal(choose([video,txt],{mediaFile:video,videoVisible:false}),txt,'a hidden media area may default to the book');
  assert.equal(choose([video,txt],{mediaFile:video,videoVisible:true}),null,'preserve an existing visible video');
  assert.equal(choose([audio,txt],{mediaFile:audio,videoVisible:true}),txt,'audio alone is not a visible movie');
  assert.equal(choose([audio,txt,{name:'Another.txt'}]),null);assert.equal(choose([audio]),null);
  assert.equal(choose([audio,txt,{name:'._Common book.TXT'},{name:'chapter.lrc'},{name:'chapter.yuban-index'}]),txt);
 });
 const panelCode=source.slice(source.indexOf('    const loadEmbeddedKnowledgePanel ='),source.indexOf('    const openEmbeddedKnowledgeTxtByName ='))+'\nloadEmbeddedKnowledgePanel;';
 const panel=({hit={exists:false},text='',probe=null}={})=>{
  const calls=[],errors=[],loading=[];
  const c={useCallback:fn=>fn,canShowEmbeddedKnowledgePanel:true,currentTrackIndex:0,trackLanguage:'en-US',embeddedKnowledgeText:text,
   embeddedKnowledgePreferSeriesStartRef:{current:true},probeKnowledgeFileForCurrentTrack:probe || (async()=>hit),
   loadEmbeddedKnowledgeTxtFile:async(file,options)=>{calls.push({file,options});return {ok:options.isCurrent()};},
   loadKnowledgeBankFromTxtFile(){},buildQuizKnowledgeTxt:()=>'',setEmbeddedKnowledgeLoading:value=>loading.push(value),setEmbeddedKnowledgeError:value=>errors.push(value),
   setEmbeddedKnowledgeText(){},setEmbeddedKnowledgeFileInfo(){},setSelectedKnowledgeTxtName(){},setActiveTrackKnowledgeTabName(){},extractKnowledgeTxtDeclaredLanguage:()=>''};
  return {load:vm.runInNewContext(panelCode,c),calls,errors,loading};
 };
 test('normal reference lookup wins before the sole-TXT fallback, and forced folder loads discard old text: '+filename,async()=>{
  const matched={name:'Matched knowledge.txt'};
  const a=panel({hit:{exists:true,file:matched},text:'old folder text'});
  assert.equal(await a.load({fallbackFile:txt}),true);assert.equal(a.calls.length,0,'an ordinary open may retain loaded text');
  assert.equal(await a.load({force:true,fallbackFile:txt}),true);assert.equal(a.calls[0].file,matched,'matching file has priority');
  const b=panel();assert.equal(await b.load({force:true,fallbackFile:txt}),true);assert.equal(b.calls[0].file,txt);
 });
 test('a stale folder probe cannot load a reference or overwrite a new folder’s loading/error state: '+filename,async()=>{
  let finish,valid=true;
  const state=panel({probe:()=>new Promise(resolve=>finish=resolve)});
  const pending=state.load({force:true,fallbackFile:txt,isCurrent:()=>valid});
  valid=false;finish({exists:true,file:{name:'Old.txt'}});
  assert.equal(await pending,false);assert.equal(state.calls.length,0);assert.deepEqual(state.loading,[true]);
  assert.deepEqual(state.errors,['']);
 });
 const effectCode=source.slice(source.indexOf('    // Reuse the normal matching loader first,'),source.indexOf('    const mediaSeekLabel ='));
 const effect=(session,loader=async()=>true)=>{
  const opened=[],masked=[],calls=[];let cleanup;
  const c=vm.createContext({selectedFolderSession:session,selectedFolderSessionRef:{current:session},handledFolderReferenceRef:{current:null},
   folderReferenceLoaderRef:{current:null},currentTrackIndex:0,playlist:session.mediaFile?[{mediaFile:session.mediaFile}]:[],
   useEffect:fn=>{cleanup=fn();},loadEmbeddedKnowledgePanel:options=>{calls.push(options);return loader(options);},
   setTopPanelMode:value=>opened.push(value),setIsVideoMasked:value=>masked.push(value),setEmbeddedKnowledgeError(){}});
  vm.runInContext(helper,c);
  const run=()=>vm.runInContext(effectCode,c);run();
  return {c,calls,opened,masked,run,cleanup:()=>cleanup?.()};
 };
 test('folder default opens once at playlist index zero, and is invalidated immediately by a new folder: '+filename,async()=>{
  const session={files:[audio,txt],mediaFile:audio,videoVisible:false};
  const state=effect(session);assert.deepEqual(state.opened,['document']);assert.deepEqual(state.masked,[false]);
  assert.equal(state.calls[0].force,true);assert.equal(state.calls[0].fallbackFile,txt);assert.equal(state.calls[0].isCurrent(),true);
  await flush();state.cleanup();state.run();assert.equal(state.calls.length,1,'text rerenders cannot reopen a manually closed panel');
  let finish;const stale=effect(session,()=>new Promise(resolve=>finish=resolve));
  stale.c.selectedFolderSessionRef.current={files:[]};assert.equal(stale.calls[0].isCurrent(),false);
  finish(true);await flush();assert.notEqual(stale.c.handledFolderReferenceRef.current,session);
  const preserve=effect({...session,files:[video,txt],mediaFile:video,videoVisible:true});assert.equal(preserve.calls.length,0);assert.equal(preserve.opened.length,0);
 });
}
