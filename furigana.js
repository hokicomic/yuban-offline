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
 if(document?.projectedAnnotations)return document.projectedAnnotations;
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
// Transfer ruby from the subtitle resolver's selected ranges. Track exact
// character matches across all minimum-cost alignments and skip ambiguous ones.
const projectedRubyCache=new WeakMap();
export function projectAlignedRuby(text, document, ranges) {
 if (!ranges?.length) return [];
 const cached=projectedRubyCache.get(ranges);
 if(cached?.document===document && cached.text===text)return cached.readings;
 const readings=mapAlignedRuby(text,document,ranges);
 projectedRubyCache.set(ranges,{document,text,readings});
 return readings;
}

function mapAlignedRuby(text, document, ranges) {
 if (!document?.annotations?.length || !ranges?.length) return [];
 const lines=document.text.split('\n'),starts=[0],raw=[];
 for (const line of lines) starts.push(starts.at(-1)+line.length+1);
 for (const range of ranges) {
  const line=lines[range.sourceLine];
  if (line?.slice(range.start,range.end)!==range.text) return [];
  let offset=starts[range.sourceLine]+range.start;
  for (const ch of range.text) {raw.push({ch,offset});offset+=ch.length;}
 }
 const a=raw.filter(({ch})=>/[\p{L}\p{M}\p{N}]/u.test(ch)),b=[];
 let offset=0;
 for (const ch of text) {if (/[\p{L}\p{M}\p{N}]/u.test(ch)) b.push({ch,offset});offset+=ch.length;}
 const n=a.length,m=b.length,w=m+1;
 if (!n || !m || (n+1)*w>400000) return [];
 for(const item of [...a,...b])item.key=item.ch.normalize('NFKC');
 const equal=(i,j)=>a[i].key===b[j].key;
 const pre=new Uint16Array((n+1)*w),post=new Uint16Array((n+1)*w);
 for(let i=0;i<=n;i++) for(let j=0;j<=m;j++) pre[i*w+j]=i&&j?Math.min(pre[(i-1)*w+j]+1,pre[i*w+j-1]+1,pre[(i-1)*w+j-1]+(equal(i-1,j-1)?0:1)):i+j;
 for(let i=n;i>=0;i--) for(let j=m;j>=0;j--) post[i*w+j]=i<n&&j<m?Math.min(post[(i+1)*w+j]+1,post[i*w+j+1]+1,post[(i+1)*w+j+1]+(equal(i,j)?0:1)):n-i+m-j;
 const cost=pre[n*w+m],mapping=new Map();
 for(let i=0;i<n;i++){
  let match=null,ambiguous=false;
  for(let j=0;j<=m;j++){
   const budget=cost-pre[i*w+j];
   if(1+post[(i+1)*w+j]===budget){ambiguous=true;break;}
   if(j===m)continue;
   const same=equal(i,j);
   if((same?0:1)+post[(i+1)*w+j+1]!==budget)continue;
   if(!same || match!==null){ambiguous=true;break;}
   match=j;
  }
  if(!ambiguous && match!==null)mapping.set(a[i].offset,b[match].offset);
 }
 const quantityPrefix=(value,start)=>value.slice(0,start).match(/[0-9０-９]+[かカヶケ箇]?$/u)?.[0].normalize('NFKC').replace(/[かカヶケ箇]$/u,'') || '';
 return document.annotations.flatMap(item=>{
  const start=mapping.get(item.start);
  if(start===undefined || text.slice(start,start+item.base.length)!==item.base) return [];
  let delta=0;
  for(const ch of item.base){if(mapping.get(item.start+delta)!==start+delta)return [];delta+=ch.length;}
  // A retained counter kanji may now belong to a different word (26日 → 今日).
  if(quantityPrefix(document.text,item.start)!==quantityPrefix(text,start))return [];
  return [{...item,start,end:start+item.base.length,source:'original',origin:'aligned'}];
 });
}

function trimDictionaryOkurigana(item) {
 const kana=/^[\p{Script=Hiragana}\p{Script=Katakana}ー]+/u;
 const trailing=/[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
 const lead=item.base.match(kana)?.[0] || '',tail=item.base.match(trailing)?.[0] || '';
 if(!lead && !tail) return item;
 const prefix=toHiragana(lead),suffix=toHiragana(tail);
 if(!item.reading.startsWith(prefix) || !item.reading.endsWith(suffix) || item.reading.length<=prefix.length+suffix.length) return item;
 return {...item,start:item.start+lead.length,end:item.end-tail.length,
  base:item.base.slice(lead.length,item.base.length-tail.length),reading:item.reading.slice(prefix.length,item.reading.length-suffix.length)};
}

export function buildFuriganaReadings(text,document,tokenizer,overrides={}) {
 const result=[...originalReadingsForText(text,document)],tokens=tokenizer?tokenizer.tokenize(text):[];
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
 add(whole.filter(item=>!blocked.some(other=>overlaps(item,other))).map(trimDictionaryOkurigana));
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
