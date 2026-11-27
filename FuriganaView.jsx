import React, {useState,useEffect,useRef,useMemo} from 'react';
import {buildFuriganaReadings,originalReadingsForText,loadJapaneseTokenizer,rubyReadingValid,toHiragana} from './furigana.js';
const rubyKey=text=>{let hash=2166136261;for(const ch of text)hash=Math.imul(hash^ch.codePointAt(0),16777619);return (hash>>>0).toString(16)+':'+text.length;};
export const FuriganaView = ({text,settings,hidden=false,contextText=null,contextOffset=0,renderText=(value)=>value}) => {
 const source=String(text || ''),originalDocument=settings?.document || {text:'',annotations:[]};
 const documentData=useMemo(()=>contextText===null?originalDocument:{text:source,annotations:originalReadingsForText(contextText,originalDocument)
    .filter(item=>item.start>=contextOffset && item.end<=contextOffset+source.length)
    .map(item=>({...item,start:item.start-contextOffset,end:item.end-contextOffset}))},[originalDocument,source,contextText,contextOffset]);
 const enabled=Boolean(settings?.enabled),host=useRef(null);
 const [revealed,setRevealed]=useState(false),[visible,setVisible]=useState(false),[tokenizer,setTokenizer]=useState(null),[error,setError]=useState(''),[revision,setRevision]=useState(0),[editing,setEditing]=useState(null),[editValue,setEditValue]=useState('');
 const context=contextText ?? source,documentAt=originalDocument.text.indexOf(context);
 const documentOffset=context && documentAt>=0 && originalDocument.text.indexOf(context,documentAt+1)<0?documentAt+contextOffset:null;
 const storageKey='yuban-furigana:'+rubyKey(originalDocument.text)+':'+(documentOffset!==null?'document':rubyKey(context)+':'+contextOffset+':'+rubyKey(source));
 const revealKey=storageKey+':'+documentOffset+':'+contextOffset+':'+source;
 const active=hidden?revealed===revealKey:enabled;
 useEffect(()=>{setRevealed(false);setTokenizer(null);setError('');setEditing(null);},[source,storageKey,hidden,documentOffset,contextOffset]);
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
  let cancelled=false;loadJapaneseTokenizer().then(value=>value.tokenize(source)).then(tokens=>{if(!cancelled)setTokenizer({tokenize:()=>tokens});}).catch(reason=>{if(!cancelled)setError(reason.message);});return ()=>{cancelled=true;};
 },[active,visible,needsDictionary,source]);
 useEffect(()=>{
  const changed=event=>{if(event.detail===storageKey)setRevision(n=>n+1);};window.addEventListener('yuban-furigana-changed',changed);return ()=>window.removeEventListener('yuban-furigana-changed',changed);
 },[storageKey]);
 const [overrides,storageError]=useMemo(()=>{try{return [JSON.parse(localStorage.getItem(storageKey)||'{}'),''];}catch(_){return [{},'讀音更正暫存不可用'];}},[storageKey,revision]);
 const localOverrides=useMemo(()=>documentOffset===null?overrides:Object.fromEntries(Object.entries(overrides).map(([key,value])=>{const colon=key.indexOf(':');return [(Number(key.slice(0,colon))-documentOffset)+key.slice(colon),value];})),[overrides,documentOffset]);
 const readings=useMemo(()=>buildFuriganaReadings(source,documentData,tokenizer,localOverrides),[source,documentData,tokenizer,localOverrides]);
 const edit=item=>{setEditing(item);setEditValue(item.reading || '');};
 const saveEdit=()=>{
  if(!editing)return;
  const item=editing,value=editValue;
  const next={...overrides},key=(item.start+(documentOffset ?? 0))+':'+item.base;
  if(!value.trim())delete next[key];
  else if(!rubyReadingValid(value)){setError('請輸入平假名或片假名讀音');return;}
  else next[key]=toHiragana(value.trim());
  try{localStorage.setItem(storageKey,JSON.stringify(next));window.dispatchEvent(new CustomEvent('yuban-furigana-changed',{detail:storageKey}));setError('');setEditing(null);}
  catch(_){setError('更正未保存，請確認瀏覽器可使用本機儲存');}
 };
 if(!/\p{Script=Han}/u.test(source))return hidden?null:source;
 if(!active)return hidden?<button type="button" data-furigana-reveal onPointerDown={event=>event.preventDefault()} onClick={event=>{event.stopPropagation();setRevealed(revealKey);}} aria-label="點擊顯示本格讀音" className="text-slate-500" style={{fontSize:'0.45em',lineHeight:1}}>讀音</button>:source;
 const nodes=[];let cursor=0;
 for(const item of readings){
  if(item.start>cursor)nodes.push(renderText(source.slice(cursor,item.start),cursor));
  nodes.push(<ruby key={item.start} data-furigana-source={item.source} style={{rubyPosition:'over'}}>{renderText(item.base,item.start)}<rt style={{fontSize:'0.5em',fontWeight:400,lineHeight:1.15}}>{item.reading}<button type="button" aria-label={`更正${item.base}讀音`} title={`讀音來源：${item.source==='original'?'原文':item.source==='manual'?'手動更正':'離線字典推測'}；點擊更正`} onClick={event=>{event.stopPropagation();edit(item);}} style={{fontSize:'0.8em',paddingInline:'0.15em'}}>✎</button></rt></ruby>);cursor=item.end;
 }
 if(cursor<source.length)nodes.push(renderText(source.slice(cursor),cursor));
 const unknown=[...source.matchAll(/[\p{Script=Han}々]+/gu)].filter(match=>!readings.some(item=>match.index<item.end && match.index+match[0].length>item.start));
 return <span ref={host} data-furigana-view onClick={event=>event.stopPropagation()} style={{lineHeight:1.9}}>
  {hidden?<span style={{fontSize:'0.55em',fontWeight:400}}>{readings.length?readings.map(item=>item.reading).join(' '):tokenizer?'讀音未收錄':'讀音載入中…'}</span>:nodes}
  {hidden && readings.map(item=><button type="button" key={item.start} aria-label={`更正${item.base}讀音`} onClick={()=>edit(item)} style={{fontSize:'0.4em'}}>✎</button>)}
  {unknown.length>0 && (!needsDictionary || tokenizer || error) && <button type="button" onClick={()=>edit({base:unknown[0][0],start:unknown[0].index,reading:''})} style={{fontSize:'0.5em'}} title="字典沒有可靠讀音，可手動指定">補讀音</button>}
  {error && <span role="status" style={{fontSize:'0.5em'}}>{error}</span>}
  {editing && <span role="dialog" aria-label="更正讀音" onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')setEditing(null);if(event.key==='Enter' && !event.nativeEvent.isComposing){event.preventDefault();saveEdit();}}} style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:14,padding:6,background:'#eff6ff',border:'1px solid #94a3b8',borderRadius:6}}><label>「{editing.base}」<input aria-label="讀音更正值" autoFocus value={editValue} onChange={event=>setEditValue(event.target.value)} style={{width:'10em',color:'#0f172a',background:'white'}}/></label><button type="button" onClick={saveEdit}>保存</button><button type="button" onClick={()=>{setEditValue('');}}>恢復來源</button><button type="button" onClick={()=>setEditing(null)}>取消</button></span>}
  {storageError && <span role="status" style={{fontSize:'0.5em'}}>{storageError}</span>}
  {hidden && <button type="button" aria-label="隱藏本格讀音" onClick={()=>setRevealed(false)} style={{fontSize:'0.4em'}}>隱藏</button>}
 </span>;
};
