import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const compiled=await build({entryPoints:[fileURLToPath(new URL('../FuriganaView.jsx',import.meta.url))],bundle:true,write:false,format:'cjs',platform:'node',packages:'external'});
function harness({hidden=false}={}){
 const slots=[],effects=[],storage=new Map(),bus=new EventTarget();bus.innerWidth=390;
 let cursor=0,dirty=false;
 const memo=(fn,deps)=>{const i=cursor++,old=slots[i];if(!old || deps.some((v,j)=>!Object.is(v,old.deps[j]))){slots[i]={value:fn(),deps};}return slots[i].value;};
 const react={Fragment:Symbol('fragment'),createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}}),
  useRef:value=>memo(()=>({current:value}),[]),useMemo:memo,
  useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>{const next=typeof value==='function'?value(slots[i]):value;if(!Object.is(next,slots[i])){slots[i]=next;dirty=true;}}]},
  useEffect:(fn,deps)=>memo(()=>{effects.push(fn)},deps)};
 const module={exports:{}};
 new Function('require','module','exports','localStorage','window',compiled.outputFiles[0].text)(name=>name==='react'?react:require(name),module,module.exports,{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},bus);
 const text='日本人',props={text,hidden,settings:{enabled:true,document:{text,annotations:[{start:0,end:3,base:text,reading:'にっぽんじん',source:'original'}]}}};
 let tree;
 const render=()=>{for(let n=0;n<8;n++){cursor=0;dirty=false;tree=module.exports.FuriganaView(props);for(const fn of effects.splice(0))fn();if(!dirty)break;}return tree;};
 const nodes=(node=tree)=>node&&typeof node==='object'?[node,...(node.props?.children||[]).flatMap(child=>nodes(child))]:[];
 const find=predicate=>nodes().find(predicate);
 const click=node=>{node.props.onClick({stopPropagation(){}});render();};
 const input=()=>find(n=>n.type==='input');
 const key=(value,{composing=false,tagName='INPUT'}={})=>{const editor=find(n=>n.props?.['data-furigana-editor']!==undefined);editor.props.onKeyDown({key:value,nativeEvent:{isComposing:composing},target:{value:input()?.props.value,tagName},stopPropagation(){},preventDefault(){}});render();};
 render();
 return {find,click,input,key,storage,render,tree:()=>tree,change:value=>{input().props.onChange({target:{value}});render()},open:()=>click(find(n=>n.props?.['data-furigana-reading']!==undefined))};
}
test('clicking a reading creates its editor within rt; Enter saves without an icon or trailing editor',()=>{
 const h=harness();h.open();assert.ok(h.input());assert.ok(h.find(n=>n.type==='rt').props.children.some(n=>n.props?.['data-furigana-editor']!==undefined));
 h.change('にほんじん');h.key('Enter');assert.equal(h.input(),undefined);assert.match([...h.storage.values()][0],/にほんじん/);
});
test('IME confirmation does not prematurely save, and Escape never commits via a later blur',()=>{
 const h=harness();h.open();h.change('にほんじん');h.input().props.onCompositionStart();h.key('Enter',{composing:true});assert.ok(h.input());assert.equal(h.storage.size,0);
 h.input().props.onCompositionEnd();const oldInput=h.input();h.key('Escape');oldInput.props.onBlur({currentTarget:{value:'にほんじん',parentElement:{contains:()=>false}},relatedTarget:null});assert.equal(h.storage.size,0);
});
test('invalid reading stays editable; valid blur saves; toolbar Enter does not submit the wrong action',()=>{
 const h=harness();h.open();h.change('abc');h.key('Enter');assert.ok(h.input());assert.equal(h.storage.size,0);
 h.change('にほんじん');h.key('Enter',{tagName:'BUTTON'});assert.ok(h.input());assert.equal(h.storage.size,0);
 h.input().props.onBlur({currentTarget:{value:'にほんじん',parentElement:{contains:()=>false}},relatedTarget:null});h.render();assert.equal(h.input(),undefined);assert.match([...h.storage.values()][0],/にほんじん/);
});
test('blank readings remain hidden until clicked and can be edited at the same hint position',()=>{
 const h=harness({hidden:true});assert.equal(h.find(n=>n.props?.['data-furigana-reading']!==undefined),undefined);h.click(h.find(n=>n.props?.['data-furigana-reveal']!==undefined));h.open();assert.ok(h.input());h.change('ニホンジン');h.key('Enter');assert.match([...h.storage.values()][0],/にほんじん/);
});
