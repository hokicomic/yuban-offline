import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),kuromoji=require('kuromoji');
const rubySource=readFileSync(new URL('../furigana.js',import.meta.url),'utf8');
const ruby=await import('data:text/javascript;base64,'+Buffer.from(rubySource).toString('base64'));
const dictionary=await new Promise((resolve,reject)=>kuromoji.builder({dicPath:fileURLToPath(new URL('../assets/kuromoji/dict/',import.meta.url))}).build((error,value)=>error?reject(error):resolve(value)));
const worker=readFileSync(new URL('../furigana-worker.js',import.meta.url),'utf8');
const enrich=vm.runInNewContext(worker.slice(worker.indexOf('const enrichJapaneseReadingTokens='),worker.indexOf('self.onmessage='))+'\nenrichJapaneseReadingTokens');
const tokenizer={tokenize:async text=>enrich(text,dictionary)};
for(const file of ['yuban-original.jsx','語伴20260713.1-codex.js']) {
 const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
 const marker=source.split('\n').find(line=>line.startsWith('const KNOWLEDGE_ORIGINAL_MARKER_RE ='));
 const sentence=source.slice(source.indexOf('const isAbbreviation ='),source.indexOf('const extractJsonObjectFromText ='));
 const helpers=source.slice(source.indexOf('const normalizeKnowledgeAlignmentText ='),source.indexOf('const MarkdownView ='));
 const api=vm.runInNewContext(marker+'\n'+sentence+helpers+'\n({splitSubtitleByReferenceSentences,prepareSubtitleReadingProfile,createSubtitleReferenceResolver,buildKnowledgeOriginalSearchIndex,applySubtitleReferencePreference,normalizeSubtitleUnicode})',{buildFuriganaReadings:ruby.buildFuriganaReadings});
 const setup=async(ref,raw)=>{
  const document=ruby.parseRubyDocument('[原文]\n'+ref),index=api.buildKnowledgeOriginalSearchIndex(document.text),cue={text:raw,start:2,end:45};
  const profile=await api.prepareSubtitleReadingProfile(index,document,[cue],tokenizer);
  return {document,index,cue,profile,resolver:api.createSubtitleReferenceResolver({...index,readingProfile:profile})};
 };
 test('captured Momotaro paragraph aligns across seven sentences without caption periods: '+file,async()=>{
  const ref='むかしむかし、ある｜村《むら》に、おじいさんとおばあさんがいました。\nある｜日《ひ》、おじいさんは｜山《やま》へ｜行《い》きました。\nおばあさんは｜川《かわ》へ｜洗濯《せんたく》に｜行《い》きました。\nおばあさんが｜川《かわ》で｜洗濯《せんたく》をしていました。\nすると、｜川《かわ》の｜上《うえ》のほうから、｜大《おお》きな｜桃《もも》が｜流《なが》れてきました。\n「まあ、｜大《おお》きい｜桃《もも》！」\nおばあさんは｜桃《もも》を｜家《いえ》へ｜持《も》って｜帰《かえ》りました。';
  const raw='昔々、ある村に、おじいさんとおばあさんがいました ある日、おじいさんは山へ行きました おばあさんは川へ選択に行きました おばあさんが川で選択をしていました すると、川の上の方から大きな桃が流れてきました まあ、大きい桃 おばあさんはももを家へ持って帰りました。';
  const {document,index,cue,resolver,profile}=await setup(ref,raw);
  assert.notEqual(api.createSubtitleReferenceResolver(index).resolve(cue).aligned,true,'literal-only matching cannot establish this paragraph');
  const result=resolver.resolve(cue);
  assert.equal(result.aligned,true,JSON.stringify(result));assert.equal(result.alignmentMethod,'reading_context');assert.equal(result.trusted,false);
  assert.equal(result.ranges.length,7);assert.equal(result.raw,raw);assert.equal(result.text,raw);
  for(const range of result.ranges)assert.equal(document.text.split('\n')[range.sourceLine].slice(range.start,range.end),range.text);
  assert.ok(result.reviewDifferences.some(item=>item.edit.from.includes('選択') && item.edit.to.includes('洗濯')));
  assert.ok(result.reviewDifferences.some(item=>item.edit.from.includes('昔々') && item.edit.to.includes('むかしむかし')));
  const provisional=api.applySubtitleReferencePreference(result);
  assert.match(provisional.text,/洗濯/);assert.equal(provisional.trusted,false);assert.ok(provisional.reviewDifferences.length);
  const accepted=api.applySubtitleReferencePreference(result,new Set(result.reviewDifferences.map(item=>item.signature)));
  assert.equal(accepted.referenceTextApplied,true);assert.match(accepted.text,/いました。\nある日/);
  const split=api.splitSubtitleByReferenceSentences(cue,result,index,profile);
  assert.equal(split.length,7);assert.equal(split[0].start,2);assert.equal(split.at(-1).end,45);
  assert.equal(split.map(part=>api.normalizeSubtitleUnicode(part.text).key).join(''),api.normalizeSubtitleUnicode(raw).key);
  assert.ok(split.every((part,i)=>part.end>part.start && (!i || part.start===split[i-1].end) && part.referenceTimingEstimated));
  assert.ok(split.every(part=>part.sourceCues[0]===cue));
  assert.equal(split[2].referenceSentenceText,'おばあさんは川へ洗濯に行きました。');
  const splitResolver=api.createSubtitleReferenceResolver({...index,baseIndex:index,readingProfile:profile});
  assert.equal(splitResolver.resolve(split[2]).trusted,false);
  assert.ok(splitResolver.resolve(split[2]).reviewDifferences.length);
  assert.equal(cue.text,raw);assert.equal(cue.start,2);assert.equal(cue.end,45);
 });
 test('captured rabbit paragraph locates small ASR errors but keeps them reviewable: '+file,async()=>{
  const ref='ある｜森《もり》に、ウサギとカメがいました。\nウサギは｜足《あし》がとても｜速《はや》いです。\nカメは｜足《あし》がとても｜遅《おそ》いです。\nある｜日《ひ》、ウサギがカメに｜言《い》いました。\n「カメさん、あなたは｜本当《ほんとう》に｜遅《おそ》いですね。」\nカメは｜少《すこ》し｜悲《かな》しくなりました。\nでも、カメは｜言《い》いました。「では、わたしと｜競争《きょうそう》しませんか。」';
  const raw='ある森にうさぎと亀がいました うさぎは足がとても早いです 亀は足がとても遅いです ある日うさぎが亀にいます 亀さんあなたは本当に遅いですね 亀は少し悲しくなりました でも亀は言いました では私と競争しませんか';
  const {cue,index,profile,resolver}=await setup(ref,raw),result=resolver.resolve(cue);
  assert.equal(result.aligned,true,JSON.stringify(result));assert.equal(result.trusted,false);
  assert.equal(result.alignmentMethod,'reading_context');
  const split=api.splitSubtitleByReferenceSentences(cue,result,index,profile);
  assert.equal(split?.length,8,JSON.stringify(split));
  assert.equal(split[3].referenceSentenceText,'ある日、ウサギがカメに言いました。');
  assert.ok(split[3].referenceSplitProjection.reviewDifferences.length,'verb error must require confirmation');
  assert.ok(split[1].referenceSplitProjection.reviewDifferences.length,'homophonic spelling must require confirmation');
  assert.equal(split.at(-1).end,cue.end);assert.equal(cue.text,raw);
 });
 test('sentence boundaries remain Unicode based across writing systems: '+file,async()=>{
  for(const ref of ['Hello, world! This is another sentence.','مرحبا بالعالم؟ هذا اختبار آخر.','यह एक वाक्य है। यह दूसरा वाक्य है।','Café déjà vu! Encore une phrase.','第一句。第二句！']){
   const {cue,index,resolver}=await setup(ref,ref),result=resolver.resolve(cue);
   assert.equal(result.aligned,true,ref);
   const split=api.splitSubtitleByReferenceSentences(cue,result,index);
   assert.equal(split?.length,2,ref);assert.equal(split[0].start,2);assert.equal(split[1].end,45);
   assert.equal(split.map(part=>part.referenceSentenceText).join(''),ref.replace(/(?<=[!.؟।]) /gu,''));
  }
 });
 test('missing punctuation alone does not require whole-sentence segmentation: '+file,async()=>{
  const ref='昔々、ある村に、おじいさんがいました。\nある日、おじいさんは山へ行きました。';
  const raw=ref.replaceAll('。','').replaceAll('\n',' ');
  const {resolver,cue,index}=await setup(ref,raw);const result=resolver.resolve(cue);
  assert.equal(result.aligned,true);assert.equal(result.alignmentMethod,'unicode_exact');assert.equal(result.reviewDifferences.length,0);assert.equal(result.ranges.length,2);
  const originalParts=[{text:'昔々、ある村に、おじいさんがいました',start:2,end:18},{text:'ある日、おじいさんは山へ行きました',start:18,end:45}];
  const grouped={...cue,sourceCues:originalParts},split=api.splitSubtitleByReferenceSentences(grouped,result,index);
  assert.equal(split[0].end,18);assert.equal(split[1].start,18);
  assert.ok(split.every(part=>part.referenceTimingEstimated===false));
  assert.equal(originalParts[0].text,'昔々、ある村に、おじいさんがいました');
 });
 test('homophones locate for review but negation, dates and repeated locations stay protected: '+file,async()=>{
  const ref='おばあさんは川へ｜洗濯《せんたく》に行きました。';
  const raw='おばあさんは川へ選択に行きました';
  const {resolver,cue,profile,document}=await setup(ref,raw);const result=resolver.resolve(cue);
  assert.equal(result.aligned,true);assert.equal(result.trusted,false);assert.ok(result.reviewDifferences.length);
  const duplicated=api.buildKnowledgeOriginalSearchIndex(document.text+'\n'+document.text.split('\n').slice(1).join('\n'));
  const duplicateProfile=await api.prepareSubtitleReadingProfile(duplicated,ruby.parseRubyDocument('[原文]\n'+ref+'\n'+ref),[cue],tokenizer);
  assert.equal(api.createSubtitleReferenceResolver({...duplicated,readingProfile:duplicateProfile}).resolve(cue).reason,'ambiguous');
  for(const [reference,raw] of [['今日は26日に行きました。','今日は今日に行きました。'],['わたしは鬼の島へ行きません。','わたしは鬼の島へ行きます。']]){
   const value=await setup(reference,raw),found=value.resolver.resolve(value.cue);
   assert.notEqual(found.trusted,true,reference);assert.notEqual(found.alignmentMethod,'reading_context',reference);
  }
 });
}
