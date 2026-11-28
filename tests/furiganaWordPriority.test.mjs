import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const api=await import('data:text/javascript;base64,'+Buffer.from(readFileSync(new URL('../furigana.js',import.meta.url),'utf8')).toString('base64'));
const enrich=vm.runInNewContext(readFileSync(new URL('../furigana-worker.js',import.meta.url),'utf8')+'\nenrichJapaneseReadingTokens;', {importScripts(){},self:{},URL});
const dictionary=await new Promise((resolve,reject)=>require('kuromoji').builder({dicPath:fileURLToPath(new URL('../assets/kuromoji/dict/',import.meta.url))}).build((e,t)=>e?reject(e):resolve(t)));
const analyze=text=>{const tokens=enrich(text,dictionary);return {tokenize:()=>tokens};};
const readings=(text,raw='',overrides={})=>api.buildFuriganaReadings(text,api.parseRubyDocument(raw),analyze(text),overrides);
test('今日 receives its full contextual dictionary reading instead of imported 今 and 日 ruby',()=>{
 const doc=api.parseRubyDocument('｜今《いま》もテントです。26｜日《にち》になりました。');
 assert.equal(api.originalReadingsForText('今日で3か月になりました。',doc).length,0);
 const result=api.buildFuriganaReadings('今日で3か月になりました。',doc,analyze('今日で3か月になりました。'));
 assert.equal(result.find(x=>x.base==='今日')?.reading,'きょう');assert.ok(!result.some(x=>x.base==='今'||x.base==='日'));
 assert.equal(api.buildFuriganaReadings('今日',doc,null).length,0,'do not briefly show borrowed characters while the dictionary loads');
});
test('whole entries for 一人 and 二人 come from the installed lexicon, not example substitutions',()=>{
 for(const [word,reading] of [['一人','ひとり'],['二人','ふたり']]){
  const result=readings(word+'で学校へ行きます。','｜一《いち》｜人《にん》です。');
  assert.equal(result.find(x=>x.base===word)?.reading,reading);
  assert.ok(!result.some(x=>x.base==='一'||x.base==='人'));
 }
});
test('aligned publisher ruby is preserved even when dictionary segmentation or reading differs',()=>{
 const doc=api.parseRubyDocument('｜今日《こんにち》の問題です。26｜日《にち》に会います。');
 const result=api.buildFuriganaReadings(doc.text,doc,analyze(doc.text));
 assert.equal(result.find(x=>x.base==='今日')?.reading,'こんにち');assert.equal(result.find(x=>x.base==='今日')?.origin,'aligned');
 assert.equal(result.find(x=>x.base==='日')?.reading,'にち');
});
test('same whole-word ruby wins before dictionary words, but cannot replace part of a longer word',()=>{
 const result=readings('学校へ行きます。','別の｜学校《がくこう》があります。');
 assert.equal(result.find(x=>x.base==='学校')?.reading,'がくこう');assert.equal(result.find(x=>x.base==='学校')?.origin,'same-word');
 const longer=readings('小学校へ行きます。','｜学校《がくこう》です。');
 assert.ok(!longer.some(x=>x.base==='学校'));assert.equal(longer.find(x=>x.base==='小学校')?.reading,'しょうがっこう');
});
test('polyphonic whole-word ruby elsewhere does not overrule this sentence’s morphological reading',()=>{
 assert.equal(readings('今日で3か月です。','｜今日《こんにち》の情勢を論じます。').find(x=>x.base==='今日')?.reading,'きょう');
 const ambiguous=readings('今日で3か月です。','｜今日《こんにち》の問題。｜今日《きょう》の予定。');
 assert.equal(ambiguous.find(x=>x.base==='今日')?.source,'dictionary');
});
test('dates and counters reuse complete source groups; missing whole readings stay unresolved',()=>{
 for(const [word,reading] of [['26日','にじゅうろくにち'],['二十日','はつか'],['一本','いっぽん'],['三本','さんぼん'],['三人','さんにん']]){
  const raw='別の記録では｜'+word+'《'+reading+'》でした。';
  const result=readings(word+'です。',raw);
  assert.equal(result.find(x=>x.base===word)?.reading,reading,word);
 }
 for(const word of ['26日','二十日','一本','三本','三人']){
  const result=readings(word+'です。','｜日《ひ》｜本《ほん》｜人《にん》です。');
  assert.ok(!result.some(x=>x.start<word.length),word+' must not fabricate a counter reading by concatenating individual entries or proper names');
 }
});
test('source characters cannot overwrite a conflicting single-character dictionary reading',()=>{
 const result=readings('日が短いです。','26｜日《にち》に来ます。');
 assert.ok(!result.some(x=>x.base==='日'&&x.reading==='にち'));
});
test('same-source offsets and manual overrides remain scoped and Unicode-safe',()=>{
 const text='😀一人で学校へ行きます。',result=readings(text,'',{'2:一人':'ひとりずつ'});
 assert.equal(result.find(x=>x.base==='一人')?.source,'manual');
 for(const item of result)assert.equal(text.slice(item.start,item.end),item.base);
});

test('a personal-name reading cannot transfer into an ordinary numeric counter',()=>{
 const result=readings('一人で学校へ行きます。','｜一人《かずと》さんが来ました。');
 assert.equal(result.find(x=>x.base==='一人')?.reading,'ひとり');
});
test('ambiguous whole entries without a contextual selection do not borrow an unrelated date reading',()=>{
 const text='一日休みます。',document=api.parseRubyDocument('毎月｜一日《ついたち》です。');
 const tokens=[{surface_form:'一',word_position:1,reading:'イチ',pos_detail_1:'数'},{surface_form:'日',word_position:2,reading:'ニチ',pos_detail_2:'助数詞'},
  {surface_form:'一日',word_position:1,reading:'',wholeCandidate:true,dictionaryReadings:['イチニチ','ツイタチ']},
  {surface_form:'一日',word_position:1,reading:'',unresolvedCompound:true}];
 assert.equal(api.buildFuriganaReadings(text,document,{tokenize:()=>tokens}).length,0);
});
