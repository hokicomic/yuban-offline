// Original text stays immutable. Offsets below use JavaScript UTF-16 indexes,
// just like subtitles and the reference highlighter.
export const toHiragana = text => String(text || '').normalize('NFC').replace(/[ァ-ヶ]/gu,c=>String.fromCharCode(c.charCodeAt(0)-0x60));
const entities = text => String(text).replace(/&#(x[\da-f]+|\d+);/giu,(_,v)=>{const n=v[0].toLowerCase()==='x'?parseInt(v.slice(1),16):Number(v);return n<=0x10ffff?String.fromCodePoint(n):'';}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,v)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[v]);
export const rubyReadingValid = value => /^[\p{Script=Hiragana}\p{Script=Katakana}\p{M}ー・\s]+$/u.test(value) && value.trim().length>0 && value.length<=120;
export function parseRubyDocument(value) {
 const source=String(value || '').replace(/\r\n?/g,'\n'),annotations=[];let text='';
 const pattern=/<ruby\b[^>]*>[\s\S]*?<\/ruby\s*>|｜([^\n《]+)《([^\n》]+)》/giu;
 let cursor=0;
 for(const match of source.matchAll(pattern)) {
  text+=source.slice(cursor,match.index);let base,reading;
  if(match[1]!==undefined){base=match[1];reading=match[2];}
  else {
   reading=[...match[0].matchAll(/<rt\b[^>]*>([\s\S]*?)<\/rt\s*>/giu)].map(m=>entities(m[1].replace(/<[^>]*>/g,''))).join('');
   base=entities(match[0].replace(/<(?:rt|rp)\b[^>]*>[\s\S]*?<\/(?:rt|rp)\s*>/giu,'').replace(/<[^>]*>/g,''));
  }
  const start=text.length;text+=base;
  if(base && rubyReadingValid(reading))annotations.push({start,end:text.length,base,reading:toHiragana(reading.trim()),source:'original'});
  cursor=match.index+match[0].length;
 }
 text+=source.slice(cursor);return {text,annotations};
}
export function originalReadingsForText(text,document) {
 if(!document?.annotations?.length)return [];
 const first=document.text.indexOf(text),unique=first>=0 && document.text.indexOf(text,first+1)<0;
 const result=[];
 for(const annotation of document.annotations) {
  for(let at=text.indexOf(annotation.base);at>=0;at=text.indexOf(annotation.base,at+1)) {
   const candidates=document.annotations.filter(item=>item.base===annotation.base);
   let selected;
   if(unique)selected=candidates.find(item=>item.start===first+at);
   else if(new Set(candidates.map(item=>item.reading)).size===1)selected=annotation;
   else {
    const score=item=>{
     let n=0;
     for(let k=1;k<=12;k++){if(at-k<0 || item.start-k<0 || text[at-k]!==document.text[item.start-k])break;n++;}
     for(let k=0;k<12;k++){if(at+annotation.base.length+k>=text.length || item.end+k>=document.text.length || text[at+annotation.base.length+k]!==document.text[item.end+k])break;n++;}
     return n;
    };
    const ranked=candidates.map(item=>({item,score:score(item)})).sort((a,b)=>b.score-a.score);
    if(ranked[0]?.score>=3 && (!ranked[1] || ranked[0].score>ranked[1].score))selected=ranked[0].item;
   }
   if(selected && !result.some(item=>item.start===at && item.end===at+annotation.base.length))result.push({...selected,start:at,end:at+annotation.base.length});
  }
 }
 return result;
}
export function buildFuriganaReadings(text,document,tokenizer,overrides={}) {
 const result=originalReadingsForText(text,document);
 const covered=(start,end)=>result.some(item=>start<item.end && end>item.start);
 if(tokenizer)for(const token of tokenizer.tokenize(text)) {
  const base=token.surface_form,start=Number(token.word_position)-1,end=start+base.length;
  if(text.slice(start,end)!==base || !/\p{Script=Han}/u.test(base) || !rubyReadingValid(token.reading || '') || covered(start,end))continue;
  result.push({start,end,base,reading:toHiragana(token.reading),source:'dictionary'});
 }
 // Explicit user edits have highest priority, scoped to the displayed sentence
 // and occurrence, so correcting a name cannot alter another reading elsewhere.
 for(const [key,value] of Object.entries(overrides)) {
  const at=key.indexOf(':');if(at<0)continue;
  const start=Number(key.slice(0,at)),base=key.slice(at+1),end=start+base.length;
  if(text.slice(start,end)!==base || !rubyReadingValid(value))continue;
  for(let i=result.length-1;i>=0;i--)if(start<result[i].end && end>result[i].start)result.splice(i,1);
  result.push({start,end,base,reading:toHiragana(value),source:'manual'});
 }
 const sorted=result.sort((a,b)=>a.start-b.start || b.end-a.end),kept=[];
 for(const item of sorted)if(!kept.length || item.start>=kept[kept.length-1].end)kept.push(item);
 return kept;
}
let tokenizerPromise;
export function loadJapaneseTokenizer() {
 if(tokenizerPromise)return tokenizerPromise;
 tokenizerPromise=(async()=>{
  // All assets are served with the app. Never send learning text to a service.
  if(location.protocol!=='file:' && navigator.serviceWorker) {
   try {const registration=await navigator.serviceWorker.register('./furigana-sw.js');await new Promise(resolve=>{if(registration.active)return resolve();const timer=setTimeout(resolve,10000);const worker=registration.installing || registration.waiting;if(!worker){clearTimeout(timer);return resolve();}worker.addEventListener('statechange',()=>{if(worker.state==='activated' || worker.state==='redundant'){clearTimeout(timer);resolve();}});});}catch(_){}
  }
  const worker=new Worker(new URL('./furigana-worker.js',document.baseURI).href);
  let nextId=0;const pending=new Map();
  const fail=error=>{for(const task of pending.values()){clearTimeout(task.timer);task.reject(error);}pending.clear();worker.terminate();tokenizerPromise=null;};
  worker.onerror=()=>fail(Error('離線字典工作程序載入失敗；原文讀音仍可使用'));
  worker.onmessage=event=>{const task=pending.get(event.data.id);if(!task)return;pending.delete(event.data.id);clearTimeout(task.timer);event.data.error?task.reject(Error(event.data.error)):task.resolve(event.data.tokens);};
  const request=text=>new Promise((resolve,reject)=>{
   const id=++nextId,timer=setTimeout(()=>fail(Error('離線字典載入逾時，可稍後再試')),90000);
   pending.set(id,{resolve,reject,timer});worker.postMessage({id,text});
  });
  await request(null);return {tokenize:request};
 })().catch(error=>{tokenizerPromise=null;throw error;});return tokenizerPromise;
}
