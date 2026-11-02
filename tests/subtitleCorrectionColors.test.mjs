import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for (const file of ['yuban-original.jsx','語伴20260713.1-codex.js']) {
 const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
 const code=source.slice(source.indexOf('const getSubtitleCorrectionDisplayRanges ='),source.indexOf('const tokenizeSubtitlePractice ='));
 const api=vm.runInNewContext(code+'\n({getSubtitleCorrectionDisplayRanges,paintSubtitleReferenceCorrections})');
 test('corrected words alone are readable blue, without altering text or escaping it as HTML: '+file,()=>{
  const raw='The member member joins the block.';
  const projection={raw,text:'The member joins the bloc.',changed:true,edits:[
   {start:10,end:17,text:'',kind:'duplicate'}, {start:28,end:33,text:'bloc',kind:'spelling'}
  ]};
  const node=()=>({children:[],style:{},attributes:{},appendChild(child){this.children.push(child)},setAttribute(k,v){this.attributes[k]=v;}});
  const doc={createDocumentFragment:node,createElement:node,createTextNode:text=>({textContent:text})};
  const editor={ownerDocument:doc,replaceChildren(fragment){this.children=fragment.children;}};
  api.paintSubtitleReferenceCorrections(editor,projection.text,projection);
  assert.equal(editor.children.map(child=>child.textContent).join(''),projection.text);
  assert.deepEqual(editor.children.filter(child=>child.style?.color).map(child=>[child.textContent,child.style.color]),[['member','#2563eb'],['bloc','#2563eb']]);
  api.paintSubtitleReferenceCorrections(editor,'User edit <text>',projection);
  assert.equal(editor.textContent,'User edit <text>');
  api.paintSubtitleReferenceCorrections(editor,raw,null);assert.equal(editor.textContent,raw);
 });
}
