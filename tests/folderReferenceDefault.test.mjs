import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
for(const filename of ['yuban-original.jsx','語伴20260713.1-codex.js']){
 const source=readFileSync(new URL('../'+filename,import.meta.url),'utf8');
 const helper=source.slice(source.indexOf('const getFolderReferenceTxt ='),source.indexOf('const getKnowledgeVerifiedHighlightRanges ='));
 const choose=vm.runInNewContext(helper+'\ngetFolderReferenceTxt;');
 const txt={name:'Common book.TXT'},audio={name:'Chapter 01.m4a',type:'audio/mp4'},video={name:'Chapter 01.mp4',type:'video/mp4'};
 test('one folder TXT opens only when no video is already displayed; multiple texts are never guessed: '+filename,()=>{
  assert.equal(choose([audio,txt]),txt);assert.equal(choose([txt]),txt);
  assert.equal(choose([video,txt],{mediaFile:video,videoVisible:false}),txt,'a hidden media area may default to the book');
  assert.equal(choose([video,txt],{mediaFile:video,videoVisible:true}),null,'preserve an existing visible video');
  assert.equal(choose([audio,txt],{mediaFile:audio,videoVisible:true}),txt,'audio alone is not a visible movie');
  assert.equal(choose([audio,txt,{name:'Another.txt'}]),null);assert.equal(choose([audio]),null);
  assert.equal(choose([audio,txt,{name:'._Common book.TXT'},{name:'chapter.lrc'},{name:'chapter.yuban-index'}]),txt);
 });
 test('multiple TXT files choose the current media companion, including original ruby text: '+filename,()=>{
  const other={name:'Another.txt'},exact={name:'Chapter 01.txt'},ruby={name:'Chapter 01.ruby.txt'};
  assert.equal(choose([audio,other,exact],{mediaFile:audio}),exact);
  assert.equal(choose([audio,other,ruby],{mediaFile:audio}),ruby);
  assert.equal(choose([audio,other,exact,ruby],{mediaFile:audio}),ruby,'annotated original is preferred when both companions exist');
  assert.equal(choose([audio,other,exact],{mediaFile:video,videoVisible:true}),null);
  assert.equal(choose([audio,other,exact],{mediaFile:{name:'Chapter 02.m4a'}}),null,'never fuzzy-match a different chapter');
  assert.equal(choose([txt],{mediaFile:audio,exactOnly:true}),null,'sole unrelated TXT is a fallback, not an exact match');
 });
 test('folder matching preserves Unicode names, excludes sibling directories and refuses duplicate companions: '+filename,()=>{
  const media={name:'Café 日本語.m4a',webkitRelativePath:'book/ch1/Café 日本語.m4a'};
  const right={name:'Cafe\u0301 日本語.TXT',webkitRelativePath:'book/ch1/Cafe\u0301 日本語.TXT'},wrong={...right,webkitRelativePath:'book/ch2/Cafe\u0301 日本語.TXT'};
  assert.equal(choose([wrong,right],{mediaFile:media}),right);
  assert.equal(choose([right,{...right}],{mediaFile:media}),null);
  assert.equal(choose([wrong,{name:'other.txt'}],{mediaFile:media}),null);
  for(const stem of ['العربية','한국어','中文']){const file={name:stem+'.txt'};assert.equal(choose([file,{name:'other.txt'}],{mediaFile:{name:stem+'.mp3'}}),file);}
 });
 test('exact current-track companion beats selected or heuristic text on track changes: '+filename,async()=>{
  const code=source.slice(source.indexOf('    const probeKnowledgeFileForCurrentTrack ='),source.indexOf('    const recordPCloudDebug ='))+'\nprobeKnowledgeFileForCurrentTrack;';
  const first={name:'Chapter 01.txt'},second={name:'Chapter 02.ruby.txt'},playlist=[{name:audio.name,mediaFile:audio},{name:'Chapter 02.m4a',mediaFile:{name:'Chapter 02.m4a'}}];
  const c=vm.createContext({playlist,currentTrackIndex:0,selectedFolderSessionRef:{current:{files:[first,second]}},selectedFolderFilesRef:{current:{}},
   getTrackKnowledgeBaseCandidates:track=>[track.name.replace(/\.[^.]+$/,'')],getFolderReferenceTxt:choose,
   getSelectedKnowledgeTxtFileFromFolderMap:()=>{throw Error('exact companion must be checked first');}});
  const probe=vm.runInContext(code,c);
  assert.equal((await probe()).file,first);c.currentTrackIndex=1;assert.equal((await probe()).file,second);
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
 const effectCode=source.slice(source.indexOf('    folderReferenceLoaderRef.current=loadEmbeddedKnowledgePanel;'),source.indexOf('    const mediaSeekLabel ='));
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
  const exact={name:'Chapter 01.ruby.txt'},matched=effect({...session,files:[audio,txt,exact]});assert.equal(matched.calls[0].fallbackFile,exact);
  const preserve=effect({...session,files:[video,txt],mediaFile:video,videoVisible:true});assert.equal(preserve.calls.length,0);assert.equal(preserve.opened.length,0);
 });
}
