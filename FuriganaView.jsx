import React, {useState,useEffect,useRef,useMemo} from 'react';
import {buildFuriganaReadings,originalReadingsForText,projectAlignedRuby,loadJapaneseTokenizer,rubyReadingValid,toHiragana} from './furigana.js';
const rubyKey=text=>{let hash=2166136261;for(const ch of text)hash=Math.imul(hash^ch.codePointAt(0),16777619);return (hash>>>0).toString(16)+':'+text.length;};
export const FuriganaView = ({text,settings,hidden=false,contextText=null,contextOffset=0, referenceRanges=null,renderText=(value)=>value}) => {
 const source=String(text || ''),originalDocument=settings?.document || {text:'',annotations:[]};
 const documentData=useMemo(()=>{
  if(!referenceRanges?.length && contextText===null)return originalDocument;
  const context=contextText ?? source,start=contextText===null?0:contextOffset;
  const annotations=referenceRanges?.length?projectAlignedRuby(context,originalDocument,referenceRanges):originalReadingsForText(context,originalDocument);
  return {text:source,libraryAnnotations:originalDocument.annotations,projectedAnnotations:annotations
    .filter(item=>item.start>=start && item.end<=start+source.length)
    .map(item=>({...item,start:item.start-start,end:item.end-start}))};
 },[originalDocument,source,contextText,contextOffset,referenceRanges]);
 const enabled=Boolean(settings?.enabled),host=useRef(null),editingRef=useRef(null),composingEdit=useRef(false);
 const [revealed,setRevealed]=useState(false),[visible,setVisible]=useState(false),[tokenizer,setTokenizer]=useState(null),[error,setError]=useState(''),[revision,setRevision]=useState(0),[editing,setEditing]=useState(null),[editValue,setEditValue]=useState(''),[editorSide,setEditorSide]=useState('left');
 const context=contextText ?? source,documentAt=originalDocument.text.indexOf(context);
 const documentOffset=context && documentAt>=0 && originalDocument.text.indexOf(context,documentAt+1)<0?documentAt+contextOffset:null;
 const storageKey='yuban-furigana:'+rubyKey(originalDocument.text)+':'+(documentOffset!==null?'document':rubyKey(context)+':'+contextOffset+':'+rubyKey(source));
 const revealKey=storageKey+':'+documentOffset+':'+contextOffset+':'+source;
 const active=hidden?revealed===revealKey:enabled;
 useEffect(()=>{setRevealed(false);setTokenizer(null);setError('');setEditing(null);editingRef.current=null;composingEdit.current=false;},[source,storageKey,hidden,documentOffset,contextOffset]);
 useEffect(()=>{
  if(!active)return;
  if(typeof IntersectionObserver==='undefined'){setVisible(true);return;}
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'120px'});
  if(host.current)observer.observe(host.current);return ()=>observer.disconnect();
 },[active,source]);
 const originals=useMemo(()=>originalReadingsForText(source,documentData),[source,documentData]);
 const needsDictionary=Array.from(source.matchAll(/\p{Script=Han}/gu)).some(match=>!originals.some(item=>match.index>=item.start && match.index<item.end));
 useEffect(()=>{
  if(!active || !visible || !needsDictionary)return;
  let cancelled=false;loadJapaneseTokenizer().then(value=>value.tokenize(contextText ?? source)).then(tokens=>{if(!cancelled){const start=contextText===null?0:contextOffset,end=start+source.length;const projected=tokens.flatMap(token=>{const at=token.word_position-1,last=at+token.surface_form.length;if(token.unresolvedCompound && at<end && last>start){const a=Math.max(start,at),b=Math.min(end,last);return [{...token,surface_form:source.slice(a-start,b-start),word_position:a-start+1}];}return at>=start && last<=end?[{...token,word_position:at-start+1}]:[];});setTokenizer({tokenize:()=>projected});}}).catch(reason=>{if(!cancelled)setError(reason.message);});return ()=>{cancelled=true;};
 },[active,visible,needsDictionary,source,contextText,contextOffset]);
 useEffect(()=>{
  const changed=event=>{if(event.detail===storageKey)setRevision(n=>n+1);};window.addEventListener('yuban-furigana-changed',changed);return ()=>window.removeEventListener('yuban-furigana-changed',changed);
 },[storageKey]);
 const [overrides,storageError]=useMemo(()=>{try{return [JSON.parse(localStorage.getItem(storageKey)||'{}'),''];}catch(_){return [{},'讀音更正暫存不可用'];}},[storageKey,revision]);
 const localOverrides=useMemo(()=>documentOffset===null?overrides:Object.fromEntries(Object.entries(overrides).map(([key,value])=>{const colon=key.indexOf(':');return [(Number(key.slice(0,colon))-documentOffset)+key.slice(colon),value];})),[overrides,documentOffset]);
 const readings=useMemo(()=>buildFuriganaReadings(source,documentData,tokenizer,localOverrides),[source,documentData,tokenizer,localOverrides]);
 const edit=item=>{editingRef.current=item;composingEdit.current=false;setEditing(item);setEditValue(item.reading || '');};
 const cancelEdit=()=>{editingRef.current=null;setEditing(null);setError('');};
 const saveEdit=(value=editValue)=>{
  const item=editingRef.current;if(!item)return;
  const next={...overrides},key=(item.start+(documentOffset ?? 0))+':'+item.base;
  if(!value.trim())delete next[key];
  else if(!rubyReadingValid(value)){setError('請輸入平假名或片假名讀音');return;}
  else next[key]=toHiragana(value.trim());
  try{localStorage.setItem(storageKey,JSON.stringify(next));window.dispatchEvent(new CustomEvent('yuban-furigana-changed',{detail:storageKey}));setError('');editingRef.current=null;setEditing(null);}
  catch(_){setError('更正未保存，請確認瀏覽器可使用本機儲存');}
 };
 if(!/\p{Script=Han}/u.test(source))return hidden?null:renderText(source,0);
 if(!active)return hidden?<button type="button" data-furigana-reveal onPointerDown={event=>event.preventDefault()} onClick={event=>{event.stopPropagation();setRevealed(revealKey);}} aria-label="點擊顯示本格讀音" className="text-slate-500" style={{fontSize:'0.45em',lineHeight:1}}>讀音</button>:source;
 const unknown=[...source.matchAll(/[\p{Script=Han}々]+/gu)].filter(match=>!readings.some(item=>match.index<item.end && match.index+match[0].length>item.start));
 const unknownItems=(!needsDictionary || tokenizer || error)?unknown.map(match=>({start:match.index,end:match.index+match[0].length,base:match[0],reading:'',source:'manual'})):[];
 const readingControl=item=>editing?.start===item.start?<span data-furigana-editor style={{position:'relative',display:'inline-block',fontSize:'inherit',lineHeight:1.15}} onClick={event=>event.stopPropagation()} onKeyDown={event=>{
  event.stopPropagation();if(composingEdit.current || event.nativeEvent.isComposing || event.keyCode===229)return;
  if(event.key==='Escape'){event.preventDefault();cancelEdit();}
  if(event.key==='Enter' && event.target.tagName==='INPUT'){event.preventDefault();saveEdit(event.target.value);}
 }}>
  <input aria-label={`更正${item.base}讀音`} data-furigana-edit-input autoFocus value={editValue} onFocus={event=>{event.currentTarget.select();setEditorSide(window.innerWidth-event.currentTarget.getBoundingClientRect().left<180?'right':'left');}}
   onChange={event=>setEditValue(event.target.value)} onCompositionStart={()=>{composingEdit.current=true;}} onCompositionEnd={()=>{composingEdit.current=false;}}
   onBlur={event=>{if(!composingEdit.current && !event.currentTarget.parentElement?.contains(event.relatedTarget))saveEdit(event.currentTarget.value);}}
   style={{font:'inherit',lineHeight:1.15,width:`${Math.max(3,Array.from(editValue).length+1)}em`,maxWidth:'70vw',padding:'0 0.15em',border:'1px solid #60a5fa',borderRadius:3,background:'#eff6ff',color:'#0f172a'}}/>
  <span role="group" aria-label="讀音編輯操作" style={{position:'absolute',top:'100%',left:editorSide==='left'?0:undefined,right:editorSide==='right'?0:undefined,display:'flex',gap:6,maxWidth:'calc(100vw - 24px)',padding:4,whiteSpace:'nowrap',fontSize:12,lineHeight:1.3,background:'white',border:'1px solid #93c5fd',borderRadius:4,zIndex:90,boxShadow:'0 2px 5px #0002'}} onPointerDown={event=>event.preventDefault()}>
   <button type="button" onClick={()=>saveEdit()}>保存</button><button type="button" onClick={()=>saveEdit('')}>恢復來源</button><button type="button" onClick={cancelEdit}>取消</button>
   {error && <span role="status" style={{whiteSpace:'normal',minWidth:80,maxWidth:160}}>{error}</span>}
  </span>
 </span>:<button type="button" data-furigana-reading aria-label={`更正${item.base}讀音`} title={`讀音來源：${item.source==='original'?(item.origin==='same-word'?'原文同詞（其他位置）':'原文對應位置'):item.source==='manual'?'手動更正':'離線字典推測'}；點擊原位編輯`}
  onClick={event=>{event.stopPropagation();edit(item);}} style={{font:'inherit',color:'inherit',lineHeight:'inherit',padding:0,border:0,background:'transparent',cursor:'text'}}>{item.reading || '補讀音'}</button>;
 const nodes=[];let cursor=0;
 for(const item of [...readings,...unknownItems].sort((a,b)=>a.start-b.start)){
  if(item.start>cursor)nodes.push(renderText(source.slice(cursor,item.start),cursor));
  nodes.push(<ruby key={item.start} data-furigana-source={item.source} style={{rubyPosition:'over',rubyAlign:'center'}}><span style={{display:'ruby-base'}}>{renderText(item.base,item.start)}</span><rt style={{textAlign:'center',fontSize:'0.5em',fontWeight:400,lineHeight:1.15}}>{readingControl(item)}</rt></ruby>);cursor=item.end;
 }
 if(cursor<source.length)nodes.push(renderText(source.slice(cursor),cursor));
 return <span ref={host} data-furigana-view style={{lineHeight:1.9}}>
  {hidden?<span style={{fontSize:'0.55em',fontWeight:400}}>{readings.length?readings.map(item=><React.Fragment key={item.start}>{readingControl(item)}{' '}</React.Fragment>):unknownItems.length?readingControl(unknownItems[0]):tokenizer?'讀音未收錄':'讀音載入中…'}</span>:nodes}
  {error && !editing && <span role="status" style={{fontSize:'0.5em'}}>{error}</span>}
  {storageError && <span role="status" style={{fontSize:'0.5em'}}>{storageError}</span>}
  {hidden && <button type="button" aria-label="隱藏本格讀音" onClick={event=>{event.stopPropagation();cancelEdit();setRevealed(false);}} style={{fontSize:'0.4em'}}>隱藏</button>}
 </span>;
};
