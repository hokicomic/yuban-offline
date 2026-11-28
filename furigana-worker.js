// Kuromoji dictionary decompression/tokenization stays off the playback thread.
importScripts('./assets/kuromoji/kuromoji.js');
let tokenizer,loading;
const cache=new Map();
// Whole lexical entries are retrieved from the installed dictionary, never
// a list of example-specific replacements. Proper names cannot repair a
// common numeric/counter phrase merely because their kanji happen to match.
const enrichJapaneseReadingTokens=(text,analyzer)=>{
 const cpOffsets=[0];for(const ch of text)cpOffsets.push(cpOffsets.at(-1)+ch.length);
 const tokens=analyzer.tokenize(text).map(token=>({...token,word_position:cpOffsets[token.word_position-1]+1}));
 const boundaries=new Set([0,text.length]);for(const t of tokens){boundaries.add(t.word_position-1);boundaries.add(t.word_position-1+t.surface_form.length);}
 const additions=[];
 for(let at=0;at<text.length;at++){
  if(!boundaries.has(at) || !/[\p{Script=Han}々\p{N}]/u.test(text[at]))continue;
  for(const hit of analyzer.viterbi_builder.trie.commonPrefixSearch(text.slice(at,at+32))){
   if(Array.from(hit.k).length<2 || !boundaries.has(at+hit.k.length))continue;
   const readings=new Set();
   for(const id of analyzer.token_info_dictionary.target_map[hit.v] || []){
    const fields=analyzer.token_info_dictionary.getFeatures(id).split(',');
    if(fields[2]!=='固有名詞' && fields[8] && fields[8]!=='*')readings.add(fields[8]);
   }
   const existing=tokens.find(t=>t.word_position===at+1 && t.surface_form===hit.k);
   if(existing)existing.dictionaryReadings=[...readings];
   else if(readings.size)additions.push({surface_form:hit.k,word_position:at+1,reading:readings.size===1?[...readings][0]:'',dictionaryReadings:[...readings],wholeCandidate:true});
  }
 }
 const unresolved=[];
 for(let i=0;i<tokens.length;i++){
  if(tokens[i].pos_detail_1!=='数')continue;
  let last=i;
  while(last+1<tokens.length && tokens[last+1].pos_detail_1==='数' && tokens[last].word_position-1+tokens[last].surface_form.length===tokens[last+1].word_position-1)last++;
  const counter=tokens[last+1];
  if(counter?.pos_detail_2!=='助数詞' || tokens[last].word_position-1+tokens[last].surface_form.length!==counter.word_position-1)continue;
  const start=tokens[i].word_position-1,end=counter.word_position-1+counter.surface_form.length,base=text.slice(start,end);
  const whole=[...tokens,...additions].filter(t=>t.word_position===start+1 && t.surface_form===base);
  for(const token of whole)token.numericCompound=true;
  if(!whole.some(t=>t.reading && (t.wholeCandidate || t.pos_detail_1!=='数')))
   unresolved.push({surface_form:base,word_position:start+1,reading:'',unresolvedCompound:true});
  i=last+1;
 }
 return [...tokens,...additions,...unresolved];
};
self.onmessage=async event=>{
 const {id,text}=event.data;
 try {
  if(!loading)loading=new Promise((resolve,reject)=>kuromoji.builder({dicPath:new URL('./assets/kuromoji/dict/',self.location.href).pathname}).build((error,value)=>error?reject(error):resolve(value)));
  tokenizer=await loading;
  if(text===null){postMessage({id,ready:true});return;}
  if(!cache.has(text)){
   const tokens=enrichJapaneseReadingTokens(text,tokenizer);
   if(cache.size>=256)cache.delete(cache.keys().next().value);cache.set(text,tokens);
  }
  postMessage({id,tokens:cache.get(text)});
 } catch(error){postMessage({id,error:String(error?.message || error)});}
};
