import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
for(const file of ['yuban-original.jsx','語伴20260713.1-codex.js']){
 const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
 const code=source.slice(source.indexOf('const canCollapseBlankReferencePanel ='),source.indexOf('const createSubtitleReferenceResolver ='));
 const api=vm.runInNewContext(code+'\n({canCollapseBlankReferencePanel,getSubtitleReferenceStatus})');
 test('blank reference panel remains open for missing, loading or failed references: '+file,()=>{
  const state={documentMode:true,blankMode:true,text:'',loading:false,error:''};
  assert.equal(api.canCollapseBlankReferencePanel(state),false);
  assert.equal(api.canCollapseBlankReferencePanel({...state,text:'  '}),false);
  assert.equal(api.canCollapseBlankReferencePanel({...state,text:'reference',loading:true}),false);
  assert.equal(api.canCollapseBlankReferencePanel({...state,text:'reference',error:'failed'}),false);
  assert.equal(api.canCollapseBlankReferencePanel({...state,text:'reference'}),true);
  assert.equal(api.canCollapseBlankReferencePanel({...state,text:'reference',blankMode:false}),false);
  assert.equal(api.canCollapseBlankReferencePanel({...state,text:'reference',documentMode:false}),false);
 });
 test('status distinguishes loading, no mapping, unchanged, corrected, pending and disabled correction: '+file,()=>{
  const state={loading:false,error:'',hasText:true,active:true,hasCue:true,enabled:true,projection:null};
  const label=extra=>api.getSubtitleReferenceStatus({...state,...extra}).text;
  assert.equal(label({loading:true}),'文本載入中');assert.equal(label({error:'failed'}),'文本載入失敗');
  assert.equal(label({hasText:false}),'未載入文本');assert.equal(label({active:false}),'對照未啟用');
  assert.equal(label({hasCue:false}),'尚無字幕');assert.equal(label({}),'本句未對到文本');
  assert.equal(label({projection:{aligned:true}}),'已對到文本・無需校正');
  assert.equal(label({projection:{trusted:true,changed:true}}),'已對到文本・已校正');
  assert.equal(label({enabled:false,projection:{aligned:true,changed:true}}),'已對到文本・校正關閉');
  assert.equal(label({projection:{aligned:true,reviewDifferences:[{}]}}),'已對到文本・有差異待確認');
  assert.equal(label({projection:{aligned:true,boundaryOmissions:[{}]}}),'已對到文本・有漏字待確認');
 });
}
