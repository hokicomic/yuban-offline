import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const makeDocument=()=>{
 let doc;
 const node=(tag,text='')=>({tag,children:[],style:{},attributes:{},ownerDocument:doc,_text:text,
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');},
  set textContent(value){this._text=value;this.children=[];},
  appendChild(child){this.children.push(child);},setAttribute(k,v){this.attributes[k]=v;},
  replaceChildren(fragment){this._text='';this.children=[...fragment.children];}});
 doc={createDocumentFragment:()=>node('fragment'),createElement:tag=>node(tag),createElementNS:(_,tag)=>node(tag),createTextNode:text=>node('#text',text)};
 return doc;
};
const flatten=node=>[node,...node.children.flatMap(flatten)];
for (const file of ['yuban-original.jsx','語伴20260713.1-codex.js']) {
 const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
 const code=source.slice(source.indexOf('const getSubtitleCorrectionDisplayRanges ='),source.indexOf('const tokenizeSubtitlePractice ='));
 const api=vm.runInNewContext(code+'\n({getSubtitleCorrectionDisplayRanges,getSubtitleCorrectionDeletionMarkers,paintSubtitleReferenceCorrections})');
 test('corrected words alone are readable blue, without altering text or escaping it as HTML: '+file,()=>{
  const raw='The member member joins the block.';
  const projection={raw,text:'The member joins the bloc.',changed:true,edits:[
   {start:10,end:17,text:'',kind:'duplicate'}, {start:28,end:33,text:'bloc',kind:'spelling'}
  ]};
  const doc=makeDocument(),editor=doc.createElement('span');
  api.paintSubtitleReferenceCorrections(editor,projection.text,projection);
  assert.equal(editor.textContent,projection.text);
  assert.deepEqual(editor.children.filter(child=>child.style?.color).map(child=>[child.textContent,child.style.color]),[['member','#2563eb'],['bloc','#2563eb']]);
  api.paintSubtitleReferenceCorrections(editor,'User edit <text>',projection);
  assert.equal(editor.textContent,'User edit <text>');assert.equal(editor.children.length,0);
  api.paintSubtitleReferenceCorrections(editor,raw,null);assert.equal(editor.textContent,raw);
 });
 test('deleted words have a blue mark under the surviving space with hover, focus and tap details: '+file,()=>{
  const raw='Thanks to Bernard, I know that green is for glass and blue is for cardboard and paper.';
  const at=raw.indexOf('for cardboard');
  const edit={start:at-1,end:at+3,text:'',from:'for',to:'',kind:'extra'};
  const projection={raw,text:raw.slice(0,edit.start)+raw.slice(edit.end),changed:true,edits:[edit]};
  const doc=makeDocument(),editor=doc.createElement('span'),inspections=[];
  api.paintSubtitleReferenceCorrections(editor,projection.text,projection,(...args)=>inspections.push(args));
  const nodes=flatten(editor),gap=nodes.find(node=>node.attributes['data-subtitle-deletion-gap']);
  const button=nodes.find(node=>node.attributes['data-subtitle-deletion-marker']);
  assert.equal(editor.textContent,projection.text,'selecting caption text never includes the icon or deleted answer');
  assert.equal(gap.textContent,' ');assert.equal(gap.style.position,'relative');
  assert.equal(button.style.color,'#2563eb');assert.equal(button.style.position,'absolute');
  assert.equal(button.title,'已刪除：for');assert.equal(button.attributes['aria-label'],'已刪除：for');
  assert.ok(button.children.some(node=>node.tag==='svg'));assert.equal(button.textContent,'');
  button.onpointerenter({pointerType:'mouse'});button.onpointerleave({pointerType:'mouse'});button.onfocus();
  let prevented=0,stopped=0;button.onclick({preventDefault(){prevented++;},stopPropagation(){stopped++;}});
  assert.deepEqual(inspections,[['for'],[null],['for'],['for',true]]);
  assert.equal(prevented,1);assert.equal(stopped,1,'tapping the mark cannot switch caption modes');
  assert.equal(api.getSubtitleCorrectionDeletionMarkers(projection)[0].start,projection.text.indexOf(' cardboard'));
 });
 test('deletion positions account for other edits, merge adjacent removals, and preserve boundary punctuation: '+file,()=>{
  const raw='The block has extra useful words today.';
  const at=raw.indexOf(' extra');
  const edits=[{start:4,end:9,text:'bloc',kind:'spelling'},{start:at,end:at+6,text:'',from:'extra',kind:'extra'}];
  let text=raw;for(const edit of [...edits].reverse())text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);
  const projection={raw,text,changed:true,edits};
  assert.equal(api.getSubtitleCorrectionDeletionMarkers(projection)[0].start,text.indexOf(' useful'));
  const doc=makeDocument(),editor=doc.createElement('span');api.paintSubtitleReferenceCorrections(editor,text,projection);
  assert.equal(editor.textContent,text);assert.equal(flatten(editor).filter(node=>node.attributes['data-subtitle-deletion-marker']).length,1);
  const grouped={raw:'We agree extra needless today.',text:'We agree today.',changed:true,edits:[
   {start:8,end:14,text:'',from:'extra',kind:'extra'},{start:14,end:23,text:'',from:'needless',kind:'extra'}]};
  const markers=api.getSubtitleCorrectionDeletionMarkers(grouped);
  assert.equal(markers.length,1);assert.equal(markers[0].deleted,'extra needless');
  api.paintSubtitleReferenceCorrections(editor,grouped.text,grouped);assert.equal(editor.textContent,grouped.text);
  for(const boundary of [
   {raw:'Extra We agree.',text:'We agree.',edits:[{start:0,end:6,text:'',from:'Extra',kind:'extra'}]},
   {raw:'We agree extra.',text:'We agree.',edits:[{start:8,end:14,text:'',from:'extra',kind:'extra'}]}
  ]){
   api.paintSubtitleReferenceCorrections(editor,boundary.text,{...boundary,changed:true});
   assert.equal(editor.textContent,boundary.text);assert.equal(flatten(editor).filter(node=>node.attributes['data-subtitle-deletion-marker']).length,1);
  }
 });
 test('original-subtitle choices and correction-off display remove deletion decorations: '+file,()=>{
  const doc=makeDocument(),editor=doc.createElement('span');
  const projection={raw:'We agree extra today.',text:'We agree today.',changed:true,edits:[{start:8,end:14,text:'',from:'extra',kind:'extra'}]};
  api.paintSubtitleReferenceCorrections(editor,projection.text,projection);
  assert.ok(flatten(editor).some(node=>node.attributes['data-subtitle-deletion-marker']));
  api.paintSubtitleReferenceCorrections(editor,projection.raw,null);assert.equal(editor.textContent,projection.raw);
  assert.ok(!flatten(editor).some(node=>node.attributes['data-subtitle-deletion-marker']));
  api.paintSubtitleReferenceCorrections(editor,projection.raw,{...projection,text:projection.raw,changed:false,edits:[]});
  assert.equal(editor.textContent,projection.raw);assert.ok(!flatten(editor).some(node=>node.attributes['data-subtitle-deletion-marker']));
 });
}
