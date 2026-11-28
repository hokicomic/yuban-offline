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
// Position-bound annotations only. A bare word occurring elsewhere is not
// proof that this cue is aligned to that occurrence.
export function originalReadingsForText(text,document) {
 if(!document?.annotations?.length || !text)return [];
 const first=document.text.indexOf(text);
 if(first<0 || (text!==document.text && Array.from(text).length<8))return [];
 const positions=[];
 for(let at=first;at>=0;at=document.text.indexOf(text,at+1))positions.push(at);
 const result=[];
 for(const item of document.annotations){
  const start=item.start-first,end=item.end-first;
  if(start<0 || end>text.length || text.slice(start,end)!==item.base)continue;
  if(positions.every(at=>document.annotations.some(other=>other.start===at+start && other.end===at+end && other.reading===item.reading)))
   result.push({...item,start,end,source:'original',origin:'aligned'});
 }
 return result;
}
export function buildFuriganaReadings(text,document,tokenizer,overrides={}) {
 const result=originalReadingsForText(text,document),tokens=tokenizer?tokenizer.tokenize(text):[];
 const overlaps=(a,b)=>a.start<b.end && a.end>b.start;
 const covered=item=>result.some(other=>overlaps(item,other));
 const span=token=>({start:Number(token.word_position)-1,end:Number(token.word_position)-1+String(token.surface_form || '').length,base:token.surface_form,reading:toHiragana(token.reading || ''),source:'dictionary'});
 const validToken=token=>{const item=span(token);return text.slice(item.start,item.end)===item.base && /\p{Script=Han}/u.test(item.base) && rubyReadingValid(item.reading);};
 const blocked=tokens.filter(t=>t.unresolvedCompound).map(span);
 const bounds=new Set([0,text.length]);
 if(tokens.length)for(const token of tokens.filter(t=>!t.wholeCandidate && !t.unresolvedCompound)){const item=span(token);bounds.add(item.start);bounds.add(item.end);}
 else {try{for(const word of new Intl.Segmenter('ja',{granularity:'word'}).segment(text)){bounds.add(word.index);bounds.add(word.index+word.segment.length);}}catch(_){}}
 const library=document?.libraryAnnotations || document?.annotations || [];
 const groups=new Map();
 for(const item of library){const set=groups.get(item.base) || new Set();set.add(item.reading);groups.set(item.base,set);}
 const borrowed=[];
 for(const [base,choices] of tokenizer?groups:[]){
  if(choices.size!==1 || Array.from(base).length<2)continue;
  const reading=[...choices][0];
  for(let at=text.indexOf(base);at>=0;at=text.indexOf(base,at+1)){
   const item={start:at,end:at+base.length,base,reading,source:'original',origin:'same-word'};
   if(!bounds.has(item.start) || !bounds.has(item.end) || blocked.some(other=>overlaps(item,other) && (item.start!==other.start || item.end!==other.end)))continue;
   // A polyphonic dictionary entry must follow this sentence's analysis,
   // rather than borrowing the only reading seen elsewhere in a book.
   const contextToken=tokens.find(t=>!t.wholeCandidate && span(t).start===item.start && span(t).end===item.end);
   const lexical=tokens.find(t=>t.wholeCandidate && span(t).start===item.start && span(t).end===item.end);
   const alternatives=contextToken?.dictionaryReadings || lexical?.dictionaryReadings || [];
   if(alternatives.length>1 && (!contextToken || toHiragana(contextToken.reading)!==reading))continue;
   if(contextToken?.pos_detail_1==='固有名詞' && toHiragana(contextToken.reading)!==reading)continue;
   if(lexical?.numericCompound && alternatives.length && !alternatives.map(toHiragana).includes(reading))continue;
   borrowed.push(item);
  }
 }
 const add=items=>{for(const item of items.sort((a,b)=>(b.end-b.start)-(a.end-a.start) || a.start-b.start))if(!covered(item))result.push(item);};
 add(borrowed);
 const whole=tokens.filter(t=>validToken(t) && Array.from(t.surface_form).length>1).map(span);
 add(whole.filter(item=>!blocked.some(other=>overlaps(item,other))));
 // Only after whole-word sources are exhausted may a single-character ruby
 // transfer across positions, and only as an independent word, not a compound.
 const independent=token=>token.surface_form?.length===1 && token.pos_detail_1!=='数' && token.pos_detail_2!=='助数詞';
 for(const token of tokens.filter(independent)){
  const item=span(token),choices=groups.get(item.base);
  if(choices?.size===1 && (!rubyReadingValid(item.reading) || item.reading===[...choices][0]) && !blocked.some(other=>overlaps(item,other)))add([{...item,reading:[...choices][0],source:'original',origin:'same-word'}]);
 }
 add(tokens.filter(t=>validToken(t) && Array.from(t.surface_form).length===1).map(span).filter(item=>!blocked.some(other=>overlaps(item,other))));
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
  const worker=new Worker(new URL('./furigana-worker.js?v=whole-word-2',document.baseURI).href);
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
