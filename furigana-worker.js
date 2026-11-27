// Kuromoji dictionary decompression/tokenization stays off the playback thread.
importScripts('./assets/kuromoji/kuromoji.js');
let tokenizer,loading;
const cache=new Map();
self.onmessage=async event=>{
 const {id,text}=event.data;
 try {
  if(!loading)loading=new Promise((resolve,reject)=>kuromoji.builder({dicPath:new URL('./assets/kuromoji/dict/',self.location.href).pathname}).build((error,value)=>error?reject(error):resolve(value)));
  tokenizer=await loading;
  if(text===null){postMessage({id,ready:true});return;}
  if(!cache.has(text)){
   const tokens=tokenizer.tokenize(text);
   // Kuromoji positions count Unicode code points, not UTF-16 units.
   for(const token of tokens)token.word_position=Array.from(text).slice(0,token.word_position-1).join('').length+1;
   if(cache.size>=256)cache.delete(cache.keys().next().value);cache.set(text,tokens);
  }
  postMessage({id,tokens:cache.get(text)});
 } catch(error){postMessage({id,error:String(error?.message || error)});}
};
