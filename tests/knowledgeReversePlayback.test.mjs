import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
 const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
 const marker=source.split('\n').find(line=>line.startsWith('const KNOWLEDGE_ORIGINAL_MARKER_RE ='));
 const helpers=source.slice(source.indexOf('const isAbbreviation ='),source.indexOf('const extractJsonObjectFromText ='))+
  source.slice(source.indexOf('const normalizeKnowledgeAlignmentText ='),source.indexOf('const MarkdownView ='));
 const api=vm.runInNewContext(marker+'\n'+helpers+'\n({createKnowledgeReverseLookup,cleanKnowledgeReverseSelection,captureKnowledgeReverseSelection,getKnowledgeReverseReadingView,installKnowledgeReverseSelectionCapture})');
 const cue=(text,index)=>({text,start:index*5,end:index*5+5});
 const first='The researchers carefully examined the evidence and described their important discovery.';
 const next='The signatories agreed to join the bloc after the final meeting yesterday.';
 test('selected original locates actual cue timestamps across LRC/SRT boundaries: '+file,()=>{
  const subtitles=[cue('Unrelated introductory material in this chapter.',0),cue(first,1),cue(next,2)];
  const lookup=api.createKnowledgeReverseLookup(subtitles);
  const result=lookup.find(first+' '+next);
  assert.equal(result.status,'found');assert.equal(result.index,1);assert.equal(result.endIndex,2);assert.equal(result.start,5);
  assert.equal(lookup.find('carefully examined the evidence and described their important discovery').index,1);
  assert.equal(JSON.stringify(subtitles),JSON.stringify([cue('Unrelated introductory material in this chapter.',0),cue(first,1),cue(next,2)]));
 });
 test('frequent words still locate a unique phrase throughout a full-length track: '+file,()=>{
  const query='There is of course a great deal we don’t know, and much of what we think we know';
  const filler=Array.from({length:180},(_,i)=>cue(`There is a great deal we think we know about subject ${i} of course but the evidence changes.`,i));
  const target=cue("There is, of course, a great deal we don't know, and much of what we think we know we haven't known for long.",180);
  const lookup=api.createKnowledgeReverseLookup([...filler,target]);
  assert.equal(lookup.find(query).status,'found');assert.equal(lookup.find(query).index,180);
  const fuzzy=query.replace('great deal','great dael');
  assert.equal(lookup.find(fuzzy).status,'found');assert.equal(lookup.find(fuzzy).index,180);
  assert.equal(api.createKnowledgeReverseLookup([...filler,target,{...target,start:9999}]).find(query).status,'ambiguous');
  assert.equal(lookup.find('The researchers explored the frozen glaciers and found a completely different geological history.').status,'missing');
  assert.equal(lookup.find(query).index,180,'failed searches do not poison the next query');
 });
 test('ASR spelling, names, numbers and punctuation share the existing alignment rules: '+file,()=>{
  const source="Officials from Pakistan, Saudi Arabia and Turkey, the three signatories to the new Mecca pact, travelled to Tehran to meet Iran’s security chief and president.";
  const asr=source.replace('signatories','signatures').replace('travelled','traveled');
  const result=api.createKnowledgeReverseLookup([cue(asr,4)]).find(source);
  assert.equal(result.status,'found');assert.equal(result.start,20);
  const text='The delegates counted three hundred confirmed votes in the latest regional election yesterday.';
  assert.equal(api.createKnowledgeReverseLookup([cue(text,2)]).find(text.replace('three hundred','300')).status,'found');
 });
 test('a different recording, partial coverage and ambiguous repetitions never choose a guessed time: '+file,()=>{
  const lookup=api.createKnowledgeReverseLookup([cue(first,0)]);
  assert.equal(lookup.find('The bakery sold fresh bread after the farmer arrived with baskets of apples.').status,'missing');
  assert.equal(lookup.find(first+' Completely unrelated closing material describes polar penguins and frozen glaciers.').status,'missing');
  assert.equal(api.createKnowledgeReverseLookup([cue(first,0),cue('Some intervening remarks.',1),cue(first,2)]).find(first).status,'ambiguous');
  assert.equal(lookup.find('the important discovery').status,'short');
 });
 test('interleaved Chinese translations are excluded instead of contributing their quoted English: '+file,()=>{
  const text=first+'\n中譯：研究人員說 discovery 很重要。\n'+next+'\n翻譯：這裡有 meeting 一詞。';
  assert.equal(api.cleanKnowledgeReverseSelection(text),first+' '+next);
  assert.equal(api.createKnowledgeReverseLookup([cue(first,0),cue(next,1)]).find(text).status,'found');
 });
 test('long selections require ordered coverage of every overlapping chunk: '+file,()=>{
  const captions=Array.from({length:12},(_,i)=>cue(`The expedition carefully examined specimen ${i+1} beside the remote mountain village yesterday.`,i));
  const query=captions.map(c=>c.text).join(' ');
  const result=api.createKnowledgeReverseLookup(captions).find(query);
  assert.equal(result.status,'found');assert.equal(result.index,0);assert.equal(result.endIndex,11);
  assert.notEqual(api.createKnowledgeReverseLookup(captions.slice(0,8)).find(query).status,'found');
  assert.equal(api.createKnowledgeReverseLookup(captions).find('unmatched '.repeat(601)).status,'long');
 });
 test('DOM capture restricts selection to original source lines and clips partial paragraphs: '+file,()=>{
  const make=(line,text)=>({getAttribute:()=>String(line),firstElementChild:{text},ownerDocument:{createRange:()=>({selectNodeContents(){},startContainer:{},startOffset:0,endContainer:{},endOffset:0})}});
  const nodes=[make(1,first),make(2,'中譯：研究人員'),make(7,'This English vocabulary example is not original prose.')];
  const range={commonAncestorContainer:{},intersectsNode:()=>true,cloneRange(){return {compareBoundaryPoints:()=>0,toString:()=>first}}};
  const container={contains:()=>true,querySelectorAll:()=>nodes};
  assert.equal(api.captureKnowledgeReverseSelection(container,{rangeCount:1,isCollapsed:false,getRangeAt:()=>range},[1]),first);
  assert.equal(api.captureKnowledgeReverseSelection(container,{rangeCount:1,isCollapsed:true},[1]),'');
  assert.equal(api.captureKnowledgeReverseSelection({...container,contains:()=>false},{rangeCount:1,isCollapsed:false,getRangeAt:()=>range},[1]),'');
 });
 test('selection reading view stays stable across playback ticks and retry notices, then resumes: '+file,()=>{
  const original={content:'book',activeKnowledgeSubtitleText:'first'};
  const changed={content:'book',activeKnowledgeSubtitleText:'second'};
  assert.equal(api.getKnowledgeReverseReadingView(changed,original,true),original);
  assert.equal(api.getKnowledgeReverseReadingView(changed,original,false),changed);
  const different={content:'new book'};assert.equal(api.getKnowledgeReverseReadingView(different,original,true),different);
 });
 test('selection listener survives multiple captures and retries and cleans up after document changes: '+file,()=>{
  const listeners=new Map(),timers=new Map();let nextTimer=0,begins=0,captures=[];
  let selected=first;
  const win={getSelection:()=>({rangeCount:1,isCollapsed:false,getRangeAt:()=>range}),
   setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer},clearTimeout:id=>timers.delete(id)};
  const doc={defaultView:win,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const line={getAttribute:()=> '1',firstElementChild:{},ownerDocument:{createRange:()=>({selectNodeContents(){}})}};
  const range={commonAncestorContainer:{},intersectsNode:()=>true,cloneRange:()=>({compareBoundaryPoints:()=>0,toString:()=>selected})};
  const container={ownerDocument:doc,contains:()=>true,querySelectorAll:()=>[line]};
  const cleanup=api.installKnowledgeReverseSelectionCapture(container,[1],()=>begins++,text=>captures.push(text));
  listeners.get('selectionchange')();assert.equal(begins,1);assert.equal(captures.length,0);
  listeners.get('pointerup')();assert.equal(captures.at(-1),first);
  selected=next;listeners.get('selectionchange')();listeners.get('pointerup')();assert.equal(captures.at(-1),next);
  selected='中譯：其他內容';listeners.get('selectionchange')();listeners.get('keyup')();assert.equal(captures.at(-1),'');
  cleanup();assert.equal(listeners.size,0);assert.equal(timers.size,0);
 });
 test('play command resets old AB offsets and exits echo; missing/changed-track lookups leave playback untouched: '+file,()=>{
  const code=source.slice(source.indexOf('    const playKnowledgeReverseSelection ='),source.indexOf('    const embeddedKnowledgeViewProps ='));
  const jumps=[],notices=[];const subtitles=[cue(first,3)];
  const c={knowledgeReverseRequestRef:{current:0},knowledgeReverseSelection:first,subtitles,
   knowledgeReverseLookupRef:{current:null},setKnowledgeReverseNotice:t=>notices.push(t),window:{getSelection:()=>({removeAllRanges(){}})},
   createKnowledgeReverseLookup:api.createKnowledgeReverseLookup,isEchoMode:true,stopEchoMode:()=>{c.stopped=true},
   setKnowledgeReverseSelecting:value=>{c.selecting=value},sentenceRangeRef:{current:{start:99}},jumpToSubtitle:i=>jumps.push(i),formatTime:t=>String(t)};
  const run=vm.runInNewContext(code+'\nplayKnowledgeReverseSelection',c);
  run();assert.deepEqual(jumps,[0]);assert.equal(c.sentenceRangeRef.current,null);assert.equal(c.stopped,true);
  c.knowledgeReverseSelection='A different book describes the distant stars and unexplored galaxies above the mountains.';
  run();assert.deepEqual(jumps,[0]);assert.match(notices.at(-1),/找不到/);
  c.knowledgeReverseSelection=first;c.subtitles=[cue('Another recording contains no part of this scientific report.',0)];run();assert.deepEqual(jumps,[0]);
 });
}
