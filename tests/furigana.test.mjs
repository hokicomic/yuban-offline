import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../furigana.js',import.meta.url),'utf8');
const api=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const {parseRubyDocument,originalReadingsForText,buildFuriganaReadings}=api;

test('ruby source becomes immutable plain text with UTF-16 offsets; rt/rp stay outside answers',()=>{
 const raw='😀<ruby>日本人<rp>(</rp><rt>ニッポンジン</rt><rp>)</rp></ruby>は｜家《いえ》にいます。';
 const doc=parseRubyDocument(raw);
 assert.equal(doc.text,'😀日本人は家にいます。');
 assert.deepEqual(doc.annotations.map(x=>[x.start,x.end,x.base,x.reading]),[[2,5,'日本人','にっぽんじん'],[6,7,'家','いえ']]);
 assert.equal(raw.includes('<rt>'),true);
});
test('non-Japanese text, combining characters and RTL retain their exact plain text',()=>{
 for(const text of ['cafe\u0301 — café','العربية ١٢:٣٠','中文測試。','한국어 문장','English and 日本語'])assert.equal(parseRubyDocument(text).text,text);
 assert.equal(parseRubyDocument('<ruby>&amp;字<rt>じ</rt></ruby>').text,'&字');
 assert.equal(parseRubyDocument('｜東京《<script>alert(1)</script>》').annotations.length,0);
});
test('original reading overrides dictionary; explicit occurrence edit overrides original',()=>{
 const doc=parseRubyDocument('｜日本人《にっぽんじん》と猫。');
 const tokenizer={tokenize:()=>[{surface_form:'日本人',word_position:1,reading:'ニホンジン'},{surface_form:'猫',word_position:5,reading:'ネコ'}]};
 const readings=buildFuriganaReadings(doc.text,doc,tokenizer);
 assert.deepEqual(readings.map(x=>[x.reading,x.source]),[['にっぽんじん','original'],['ねこ','dictionary']]);
 assert.equal(buildFuriganaReadings(doc.text,doc,tokenizer,{'0:日本人':'にほんじん'})[0].source,'manual');
 assert.equal(buildFuriganaReadings(doc.text,doc,tokenizer,{'0:日本人':'invalid'})[0].reading,'にっぽんじん');
});
test('polyphonic original readings follow exact occurrence and reject insufficient context',()=>{
 const doc=parseRubyDocument('今日は｜一日《いちにち》休む。毎月｜一日《ついたち》に来る。');
 assert.equal(originalReadingsForText('毎月一日に来る。',doc)[0].reading,'ついたち');
 assert.equal(originalReadingsForText('一日',doc).length,0);
 assert.equal(originalReadingsForText('今日は一日休む。',doc)[0].reading,'いちにち');
});
test('unknown dictionary words and invalid positions never invent a reading',()=>{
 const tokenizer={tokenize:()=>[{surface_form:'猫',word_position:1,reading:'*'},{surface_form:'犬',word_position:99,reading:'イヌ'}]};
 assert.deepEqual(buildFuriganaReadings('猫犬',{text:'',annotations:[]},tokenizer),[]);
});
const compiled=await build({entryPoints:[fileURLToPath(new URL('../FuriganaView.jsx',import.meta.url))],bundle:true,write:false,format:'cjs',platform:'node',packages:'external'});
const m={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(require,m,m.exports);
const View=m.exports.FuriganaView;
test('blank reading is absent from DOM until explicit click, even with global toggle enabled',()=>{
 const doc=parseRubyDocument('｜日本人《にっぽんじん》');
 const html=renderToStaticMarkup(React.createElement(View,{text:doc.text,settings:{enabled:true,document:doc},hidden:true}));
 assert.match(html,/點擊顯示本格讀音/);
 assert.doesNotMatch(html,/にっぽんじん|日本人|<rt/);
});
test('reading mode renders semantic ruby from original while disabled mode retains plain source',()=>{
 const doc=parseRubyDocument('｜日本人《にっぽんじん》');
 const html=renderToStaticMarkup(React.createElement(View,{text:doc.text,settings:{enabled:true,document:doc}}));
 assert.match(html,/<ruby[^>]*data-furigana-source="original"/);
 assert.match(html,/にっぽんじん/);
 const disabled=renderToStaticMarkup(React.createElement(View,{text:doc.text,settings:{enabled:false,document:doc}}));
 assert.equal(disabled,doc.text);
});
test('blank context projects the correct polyphonic occurrence',()=>{
 const doc=parseRubyDocument('毎月｜一日《ついたち》に来る。今日は｜一日《いちにち》休む。');
 const html=renderToStaticMarkup(React.createElement(View,{text:'一日',contextText:'今日は一日休む。',contextOffset:3,settings:{enabled:true,document:doc}}));
 assert.match(html,/いちにち/);assert.doesNotMatch(html,/ついたち/);
});
test('offline worker converts supplementary Unicode positions into reference offsets',async()=>{
 const kuromoji=require('kuromoji');
 const tokenizer=await new Promise((resolve,reject)=>kuromoji.builder({dicPath:fileURLToPath(new URL('../assets/kuromoji/dict/',import.meta.url))}).build((err,t)=>err?reject(err):resolve(t)));
 const text='😀私は学校に行く。';
 const tokens=tokenizer.tokenize(text).map(t=>({...t,word_position:Array.from(text).slice(0,t.word_position-1).join('').length+1}));
 const readings=buildFuriganaReadings(text,{text:'',annotations:[]},{tokenize:()=>tokens});
 assert.ok(readings.some(x=>x.base==='学校'&&x.reading==='がっこう'));
 for(const item of readings)assert.equal(text.slice(item.start,item.end),item.base);
});
