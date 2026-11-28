import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const rubyApi=await import('data:text/javascript;base64,'+Buffer.from(readFileSync(new URL('../furigana.js',import.meta.url),'utf8')).toString('base64'));
for(const file of ['yuban-original.jsx','語伴20260713.1-codex.js']) {
    const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const marker=source.split('\n').find(line=>line.startsWith('const KNOWLEDGE_ORIGINAL_MARKER_RE ='));
    const sentenceHelpers=source.slice(source.indexOf('const isAbbreviation ='),source.indexOf('const extractJsonObjectFromText ='));
    const helpers=source.slice(source.indexOf('const normalizeKnowledgeAlignmentText ='),source.indexOf('const MarkdownView ='));
    const api=vm.runInNewContext(marker+'\n'+sentenceHelpers+helpers+'\n({groupSubtitlesByReferenceSentences,createSubtitleReferenceResolver,buildKnowledgeOriginalSearchIndex,applySubtitleReferencePreference,findKnowledgePreciseSubtitleRanges,normalizeSubtitleUnicode})');
    const engine=book=>api.createSubtitleReferenceResolver(api.buildKnowledgeOriginalSearchIndex('[原文]\n'+book));
    test('long unchanged Japanese context locates a short factual ASR substitution for confirmation: '+file,()=>{
        const reference='今年8月、ネパールと中国の国境の近くで、大きい土石流が起こってから、26日で3か月になりました。';
        const raw=reference.replace('26日','今日');
        const result=engine(reference).resolve({text:raw});
        assert.equal(result.aligned,true);assert.equal(result.reviewDifferences.length,1);
        assert.equal(result.reviewDifferences[0].edit.from,'今');assert.equal(result.reviewDifferences[0].edit.to,'26');
        assert.equal(result.trusted,false);assert.equal(result.raw,raw);
        assert.equal(engine(reference+'\n'+reference).resolve({text:raw}).reason,'ambiguous');
    });
    test('actual NHK subtitle has both a date error and a kana counter difference: '+file,()=>{
        const ref='今年8月、ネパールと中国の国境の近くで、大きい土石流が起こってから、26日で3か月になりました。';
        const raw='今年8月 、ネパールと中国の国境の近くで 、大きい土石流が起こってから 、今日で3ヶ月になりました 。';
        const resolver=engine(ref),cue={text:raw},result=resolver.resolveWithNeighbours(cue,null,{text:'ネパールと中国で今までに1500人以上が亡くなりました。'});
        assert.equal(result.aligned,true,JSON.stringify(result));assert.equal(result.reviewDifferences.length,2);
        let corrected=raw;for(const item of [...result.reviewDifferences].sort((a,b)=>b.edit.start-a.edit.start))corrected=corrected.slice(0,item.edit.start)+item.edit.text+corrected.slice(item.edit.end);
        assert.equal(api.normalizeSubtitleUnicode(corrected).key,api.normalizeSubtitleUnicode(ref).key);
    });
    test('mixed correction choices retain positional NHK month ruby through the subtitle resolver: '+file,()=>{
        const doc=rubyApi.parseRubyDocument('[原文]\n今年8｜月《がつ》、ネパールと中国の国境の近くで、大きい土石流が起こってから、26｜日《にち》で3か｜月《げつ》になりました。');
        const resolver=api.createSubtitleReferenceResolver(api.buildKnowledgeOriginalSearchIndex(doc.text));
        const raw=doc.text.split('\n')[1].replaceAll('、',' 、').replace('26日','今日').replace('3か月','3ヶ月');
        const aligned=resolver.resolveWithNeighbours({text:raw},null,null);
        const date=aligned.reviewDifferences.find(item=>item.edit.to.includes('26'));
        assert.ok(date);
        const display=api.applySubtitleReferencePreference(aligned,null,new Set([date.signature]));
        assert.match(display.text,/今日で3か月/);
        const result=rubyApi.projectAlignedRuby(display.text,doc,display.ranges);
        assert.deepEqual(result.map(item=>[item.base,item.reading]),[['月','がつ'],['月','げつ']]);
    });
    test('Japanese user heading and long sentence ignore Markdown and typographic spacing: '+file,()=>{
        const title='第一回 小説家は寛容な人種なのか';
        const raw='* 第一回 *小説家は寛容な人種なのか?';
        const book='目次\n'+title+'\n第二回 小説家になった頃';
        const cue={text:raw,start:15,end:20};
        const result=api.applySubtitleReferencePreference(engine(book).resolve(cue));
        assert.equal(result.aligned,true,JSON.stringify(result));assert.equal(result.text,title);
        assert.equal(result.raw,raw);assert.equal(result.referenceTextApplied,true);
        assert.equal(cue.text,raw);assert.equal(cue.start,15);assert.equal(cue.end,20);
        assert.equal(result.ranges[0].sourceLine,2);assert.equal(result.ranges[0].start,0);
        assert.equal(result.ranges[0].text,title);
        const ref='小説について語ります、というと最初から話の間口が広くなりすぎてしまいそうなので、まずとりあえず小説家というものについて語ります。';
        const subtitle='小説について語ります 、というと最初から話の間口が広くなりすぎてしまいそうなので 、まずとりあえず小説家というものについて語ります 。';
        const full=engine(ref+'その方が具体的だし、目にも見えるし、比較的話が進めやすいのではないかと思います。').resolve({text:subtitle});
        assert.equal(full.aligned,true);assert.equal(full.text,ref);assert.equal(full.ranges[0].text,ref.slice(0,-1));
        const ranges=api.findKnowledgePreciseSubtitleRanges(ref,subtitle);
        assert.equal(ranges.length,1);assert.equal(ref.slice(ranges[0].start,ranges[0].end),ref.slice(0,-1));
    });
    test('Unicode offsets retain combining marks, RTL, unspaced scripts, widths and mixed-language text: '+file,()=>{
        const fixtures=[
            ['「これは日本語の引用文です。」','*これは日本語の引用文です*'],
            ['한글 문장을 정확하게 비교합니다.','**한글 문장을 정확하게 비교합니다**'],
            ['السَّلَامُ عَلَيْكُمْ جميعاً.','*السَّلَامُ عَلَيْكُمْ جميعاً*'],
            ['यह एक सरल परीक्षण वाक्य है।','**यह एक सरल परीक्षण वाक्य है**'],
            ['นี่คือข้อความสำหรับทดสอบภาษาไทย','*นี่คือข้อความสำหรับทดสอบภาษาไทย*'],
            ['Это точное предложение для проверки.','**Это точное предложение для проверки**'],
            ['AIモデルを２０２６年に検証します。','*AIモデルを2026年に検証します*'],
            ['日本語とcaféを比較します。','日本語とcafe\u0301を比較します'],
            ['😀序文\n第一回 **小説家**は寛容な人種なのか','*第一回*小説家は寛容な人種なのか']
        ];
        for(const [ref,raw] of fixtures){
            const result=engine(ref).resolve({text:raw});
            assert.equal(result.aligned,true,ref+' '+JSON.stringify(result));
            for(const range of result.ranges)assert.equal(ref.split('\n')[range.sourceLine-1].slice(range.start,range.end),range.text);
            let reconstructed=raw;
            for(const edit of [...result.edits].sort((a,b)=>b.start-a.start))reconstructed=reconstructed.slice(0,edit.start)+edit.text+reconstructed.slice(edit.end);
            assert.equal(reconstructed,result.text);
            assert.equal(result.text.includes('*'),false);
        }
        assert.notEqual(api.normalizeSubtitleUnicode('السَّلَامُ').key,api.normalizeSubtitleUnicode('السلام').key,'do not erase meaningful combining marks');
        assert.notEqual(api.normalizeSubtitleUnicode('한글 문장').key,api.normalizeSubtitleUnicode('한글문장').key,'retain word boundaries where meaningful');
    });
    test('multilingual complete-sentence grouping keeps exact contiguous audio and refuses missing speech: '+file,()=>{
        const first='小説について語ります、というと話が広くなりすぎるので、';
        const tail='まず小説家について語ります。';
        const next='その方が具体的だと思います。';
        const cues=[{text:first,start:10,end:15},{text:'*'+tail+'*',start:15,end:20},{text:next,start:20,end:25}];
        const index=api.buildKnowledgeOriginalSearchIndex('[原文]\n'+first+tail+next);
        const grouped=api.groupSubtitlesByReferenceSentences(cues,index);
        assert.equal(grouped.length,2);assert.equal(grouped[0].start,10);assert.equal(grouped[0].end,20);
        assert.equal(grouped[0].sourceCues[0],cues[0]);assert.equal(cues.length,3);
        assert.equal(engine(first+tail).resolve(grouped[0]).text,first+tail);
        assert.equal(api.groupSubtitlesByReferenceSentences([{...cues[0]},{...cues[1],start:18}],index).length,2,'a gap cannot be covered by invented audio');
        assert.equal(api.groupSubtitlesByReferenceSentences([{text:first.replace('話が',''),start:10,end:15},cues[1]],index).length,2,'missing content stays separate');
    });
    test('repeated Unicode positions need real neighbour evidence and invalid semantics never auto-match: '+file,()=>{
        const title='第一回 小説家は寛容な人種なのか';
        const next='ここから小説について語ります。';
        const middle='別の段落が続きます。';
        const book=title+'\n'+middle+'\n'+title+'\n'+next;
        const resolver=engine(book),cue={text:'*第一回* 小説家は寛容な人種なのか?'};
        const ambiguous=resolver.resolve(cue);
        assert.equal(ambiguous.reason,'ambiguous');assert.equal(ambiguous.candidateCount,2);
        assert.equal(ambiguous.candidates[0].ranges[0].sourceLine,1);assert.equal(ambiguous.candidates[1].ranges[0].sourceLine,3);
        const located=resolver.resolveWithNeighbours(cue,null,{text:next});
        assert.equal(located.aligned,true);assert.equal(located.ranges[0].sourceLine,3);
        const following=resolver.resolveWithNeighbours({text:next},cue,null);
        assert.equal(following.aligned,true);assert.equal(following.ranges[0].sourceLine,4);
        assert.notEqual(engine('日本語の数値は3.14です。').resolve({text:'日本語の数値は314です。'}).trusted,true);
        assert.notEqual(engine('日本語の数値は-3です。').resolve({text:'日本語の数値は3です。'}).trusted,true);
        assert.notEqual(engine('これは正しくありません。').resolve({text:'これは正しいです。'}).trusted,true);
        assert.notEqual(engine('日本語とcaféを比較します。').resolve({text:'日本語とcafeを比較します。'}).trusted,true);
        const partial=engine('前の言葉。小説について語ります。その方が具体的です。').resolve({text:'小説について'});
        assert.equal(partial.aligned,true);assert.equal(partial.text,'小説について');
    });
}
