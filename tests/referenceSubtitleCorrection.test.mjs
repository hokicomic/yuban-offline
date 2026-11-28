import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import {getReferenceDecisionCueKey,getReferenceDecisionChangeKey,getReferenceDecisionChoices} from '../subtitleReview.js';
const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../', import.meta.url));
for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const marker = source.split('\n').find(line => line.startsWith('const KNOWLEDGE_ORIGINAL_MARKER_RE ='));
    const sentenceHelpers = source.slice(source.indexOf('const isAbbreviation ='), source.indexOf('const extractJsonObjectFromText ='));
    const helpers = source.slice(source.indexOf('const normalizeKnowledgeAlignmentText ='), source.indexOf('const MarkdownView ='));
    const api = vm.runInNewContext(marker + '\n' + sentenceHelpers + helpers + source.slice(source.indexOf('const tokenizeSubtitlePractice ='),source.indexOf('const splitSubtitlePracticeGraphemes =')) + source.slice(source.indexOf('const getSubtitleCorrectionDisplayRanges ='),source.indexOf('const SUBTITLE_DELETION_GAP_STYLE =')) + '\n({buildSubtitleReferenceDisplayEdits,getSubtitleCorrectionDeletionMarkers,applyCompleteSentenceReferencePreference,groupSubtitlesByReferenceSentences,getSubtitleReferenceSentenceText,buildSubtitlePracticeDualTokens,createSubtitleReferenceResolver, buildKnowledgeOriginalSearchIndex, findKnowledgePreciseSubtitleRanges, applySubtitleReferenceBoundaryAcceptance, applySubtitleReferencePreference, getSubtitleReferenceStatus})');
    const resolver = text => api.createSubtitleReferenceResolver(api.buildKnowledgeOriginalSearchIndex('[原文]\n' + text));
    test('full-reference sentence practice joins adjacent timed cues and retains raw captions: ' + file, () => {
        const first='After a quick wash, Vera dons her morning gear—a polo shirt with a Ralph Lauren logo so big that it covers her entire left breast';
        const tail='(well, okay, thanks to the ravages of time and gravity, it covers the top half of her breast) and sweatpants.';
        const next='Arm sleeves are yanked on and adjusted so that there is no exposed skin.';
        const rawFirst=first.replace('gear—','gear, ')+'.',rawTail=tail.replace(/[()]/g,'');
        const cues=[{text:rawFirst,start:10,end:20},{text:rawTail,start:20,end:30},{text:next,start:30,end:36}];
        const snapshot=JSON.stringify(cues);
        const index=api.buildKnowledgeOriginalSearchIndex('[原文]\n'+first+' '+tail+' '+next);
        const grouped=api.groupSubtitlesByReferenceSentences(cues,index);
        assert.equal(grouped.length,2);assert.equal(grouped[0].start,10);assert.equal(grouped[0].end,30);
        assert.equal(grouped[0].text,rawFirst+' '+rawTail);assert.equal(grouped[0].sourceCues.length,2);
        assert.equal(JSON.stringify(cues),snapshot,'raw subtitles and their timestamps are immutable');
        const corrected=api.applySubtitleReferencePreference(api.createSubtitleReferenceResolver(index).resolve(grouped[0]));
        assert.equal(corrected.text,first+' '+tail);
        const blanks=api.buildSubtitlePracticeDualTokens(corrected.text,'en-US',null,corrected);
        assert.equal(blanks.map(token=>token.text || token.parts?.map(part=>part.text).join('') || '').join(''),first+' '+tail);
        assert.equal(api.groupSubtitlesByReferenceSentences(cues.slice(0,1),index).length,1,'no missing audio words are added');
        const gap=[cues[0],{...cues[1],start:25,end:35}];
        assert.equal(api.groupSubtitlesByReferenceSentences(gap,index),gap,'do not bridge missing audio or large gaps');
        assert.equal(api.groupSubtitlesByReferenceSentences(cues,api.buildKnowledgeOriginalSearchIndex('[原文]\nA different book has nothing to do with this sentence.')),cues);
        assert.equal(grouped[1],cues[2],'the following complete sentence stays separate');
        const short=[{text:'After a quick',start:10,end:12},{text:rawFirst.slice('After a quick '.length),start:12,end:20},cues[1]];
        assert.equal(api.groupSubtitlesByReferenceSentences(short,index)[0].sourceCues.length,3,'a short opening cue can gather its anchor from the following cue');
    });
    test('reference grouping respects nested parentheses, abbreviations and sentence boundaries: ' + file, () => {
        const ref='Dr. Vera reviewed the report (including the notes (which were long)) and signed it. She went home.';
        const cues=[{text:'Dr. Vera reviewed the report.',start:1,end:4},{text:'Including the notes which were long and signed it.',start:4,end:8},{text:'She went home.',start:8,end:10}];
        const grouped=api.groupSubtitlesByReferenceSentences(cues,api.buildKnowledgeOriginalSearchIndex('[原文]\n'+ref));
        assert.equal(grouped.length,2);assert.equal(grouped[0].end,8);assert.equal(grouped[1],cues[2]);
        const repeat=api.groupSubtitlesByReferenceSentences(cues,api.buildKnowledgeOriginalSearchIndex('[原文]\n'+ref+' '+ref));
        assert.equal(repeat.length,2,'identical source sentences do not create different audio groups');
    });
    test('a missing sentence prefix does not prevent merging through the original sentence ending: ' + file, () => {
        const first='Sleeves on, Vera nods at her reflection and marches to the kitchen, where she gulps down a pint of room-temperature water';
        const tail='—cold water, Vera believes, would freeze the fats in your arteries and give you heart disease.';
        const full=first+tail;
        const next='At the door, Vera dons her orthopedic sneakers and her tortoiseshell sunglasses.';
        const index=api.buildKnowledgeOriginalSearchIndex('[原文]\n'+full+' '+next);
        const cues=[{text:first.replace('Sleeves on,','On,')+'.',start:100,end:110},{text:tail.slice(1),start:110,end:116},{text:next,start:116,end:122}];
        const grouped=api.groupSubtitlesByReferenceSentences(cues,index);
        assert.equal(grouped.length,2);assert.equal(grouped[0].end,116);assert.equal(grouped[0].referenceSentencePrefix,'Sleeves ');
        const engine=api.createSubtitleReferenceResolver(index);
        const projection=engine.resolveWithNeighbours(grouped[0],null,grouped[1]);
        const fixed=api.applyCompleteSentenceReferencePreference(projection,grouped[0]);
        assert.equal(fixed.text,full,JSON.stringify(fixed));assert.equal(fixed.autoCompletedPrefix,'Sleeves');
        assert.equal(fixed.boundaryOmissions.length,0);assert.equal(fixed.referenceTextApplied,true);
        assert.match(fixed.ranges[0].text,/^Sleeves on/);
        assert.equal(cues[0].text.startsWith('On,'),true,'raw cues are immutable');
        const single=[{text:full.replace('Sleeves on,','On,'),start:100,end:116}];
        const one=api.groupSubtitlesByReferenceSentences(single,index);
        assert.equal(api.applyCompleteSentenceReferencePreference(engine.resolve(one[0]),one[0]).text,full,'a complete single cue can recover its prefix too');
        const repeated=api.buildKnowledgeOriginalSearchIndex('[原文]\n'+full+'\n'+full.replace('Sleeves on,','Shoes on,'));
        assert.equal(api.groupSubtitlesByReferenceSentences(cues,repeated),cues,'competing prefixes must not be guessed');
        const preceding=[{text:'She pulls her sleeves',start:98,end:100},...cues];
        assert.equal(api.groupSubtitlesByReferenceSentences(preceding,index),preceding,'do not duplicate a word already in the preceding cue');
        assert.equal(api.groupSubtitlesByReferenceSentences([cues[0]],index)[0],cues[0],'no sentence ending audio means no completed exercise');
        const negated=api.buildKnowledgeOriginalSearchIndex('[原文]\nNot '+full.toLowerCase());
        assert.equal(api.groupSubtitlesByReferenceSentences([{text:full.toLowerCase(),start:1,end:10}],negated)[0].referenceSentencePrefix,undefined,'negation is not silently added');
    });
    test('joining cues preserves Cold as cold instead of reporting a deletion: ' + file, () => {
        const first='Sleeves on, Vera nods at her reflection and marches to the kitchen, where she gulps down a pint of room-temperature water';
        const tail='cold water, Vera believes, would freeze the fats in your arteries and give you heart disease.';
        const full=first+'—'+tail;
        const index=api.buildKnowledgeOriginalSearchIndex('[原文]\n'+full);
        const raw=[{text:first.replace('Sleeves on,','On,')+'.',start:10,end:20},{text:'Cold'+tail.slice(4),start:20,end:27}];
        const grouped=api.groupSubtitlesByReferenceSentences(raw,index);
        const result=api.applyCompleteSentenceReferencePreference(api.createSubtitleReferenceResolver(index).resolve(grouped[0]),grouped[0]);
        assert.equal(result.text,full);
        assert.equal(api.getSubtitleCorrectionDeletionMarkers(result).length,0,JSON.stringify(result.edits));
        for(const [before,after] of [
            ['water. Cold water.','water—cold water.'],
            ['First clause. Next clause.','First clause; next clause.'],
            ['“HELLO,” she said.','“Hello,” she said.'],
            ['We stopped. Then we returned.','We stopped, then we returned.']
        ]) {
            const edits=api.buildSubtitleReferenceDisplayEdits(before,after);
            let restored=before;
            for(const edit of [...edits].sort((a,b)=>b.start-a.start))restored=restored.slice(0,edit.start)+edit.text+restored.slice(edit.end);
            assert.equal(restored,after);
            assert.equal(api.getSubtitleCorrectionDeletionMarkers({raw:before,text:after,changed:true,edits}).length,0,before);
        }
        const before='We chose cold cold water.',after='We chose cold water.';
        const markers=api.getSubtitleCorrectionDeletionMarkers({raw:before,text:after,changed:true,edits:api.buildSubtitleReferenceDisplayEdits(before,after)});
        assert.equal(markers.length,1);assert.equal(markers[0].deleted,'cold','real duplicate deletion remains visible');
        assert.equal(api.getSubtitleCorrectionDeletionMarkers({raw:'Water.',text:'Water',changed:true,edits:[{start:5,end:6,text:'',from:'.'}]}).length,0,'punctuation deletion is not a word deletion');
    });
    test('a joined reference compound cannot veto punctuation for the complete practice sentence: ' + file, () => {
        const first='At the door, Vera dons her orthopedic sneakers and her tortoiseshell sunglasses, and finally, the last and perhaps most vital article of clothing';
        const tail='—a visor so enormous that there is no way that a single ray of freckle-causing, wrinkle-making sunlight could snake its way onto her face.';
        const reference=first+tail;
        const rawFirst='At the door, Vera dons her orthopedic sneakers and her tortoise shell sunglasses. And finally, the last and perhaps most vital article of clothing,';
        const rawTail=tail.slice(1).replace('that there','that There');
        const cues=[{text:rawFirst,start:10,end:20},{text:rawTail,start:20,end:30}];
        const index=api.buildKnowledgeOriginalSearchIndex('[原文]\n'+reference+' Then, without a backward glance, Vera strides out into the world.');
        const grouped=api.groupSubtitlesByReferenceSentences(cues,index);
        assert.equal(grouped.length,1);
        const projection=api.createSubtitleReferenceResolver(index).resolve(grouped[0]);
        assert.equal(projection.trusted,true);
        const result=api.applyCompleteSentenceReferencePreference(projection,grouped[0]);
        const expected=reference.replace('tortoiseshell','tortoise shell');
        assert.equal(result.text,expected);
        assert.equal(result.referenceTextApplied,true);assert.equal(result.retainedCaptionWordBoundaries,true);
        assert.equal(api.getSubtitleCorrectionDeletionMarkers(result).length,0);
        const tokens=api.buildSubtitlePracticeDualTokens(result.text,'en-US',null,result);
        assert.equal(tokens.map(token=>token.text || token.parts?.map(part=>part.text).join('') || '').join(''),expected);
        assert.equal(cues[0].text,rawFirst);assert.equal(grouped[0].end,30);
        const damaged='The careful researcher reviewed allofthe evidence, and signed the report—before returning home.';
        const caption='The careful researcher reviewed all of the evidence. And signed the report, before returning home.';
        assert.equal(api.applySubtitleReferencePreference(resolver(damaged).resolve({text:caption})).text,damaged.replace('allofthe','all of the'),'ebook joins do not become malformed answer words');
    });
    test('explicit clock meridiems align across dots, colons, spacing and name transcription: ' + file, () => {
        const first='It is 4:31 AM, very late.';
        const second='When I was your age, I wake up at 4AM every morning to cook breakfast for Ah Gong and Ah Ma.';
        const engine=resolver('Are you awake? '+first+' '+second+' Qi lai! Carpe diem! Kind regards, Mama.');
        const a=engine.resolveWithNeighbours({text:'It is 4.31 a.m., very late.'},null,{text:second});
        assert.equal(a.aligned,true,JSON.stringify(a));assert.equal(api.applySubtitleReferencePreference(a).text,first);
        const b=engine.resolveWithNeighbours({text:'When I was your age, I wake up at 4 a.m. every morning to cook breakfast for A Gong and A Ma.'},{text:first},null);
        assert.equal(b.aligned,true,JSON.stringify(b));
        assert.match(api.applySubtitleReferencePreference(b).text,/Ah Gong and Ah Ma/);
        for(const notation of ['4AM','4 AM','4 a.m.','four a.m.']) {
            const raw=second.replace('4AM',notation);
            assert.equal(resolver(second).resolve({text:raw}).aligned,true,notation);
        }
        for(const raw of [first.replace('4:31 AM','4:32 AM'),first.replace('AM','PM')]) {
            const result=resolver(first).resolve({text:raw});
            assert.ok(!result.trusted || result.reviewDifferences?.length,'different minute or meridiem is not silently equivalent');
        }
    });
    test('spoken handles align as a whole identifier across a timestamp and paragraph break: ' + file, () => {
        for(const [handle,spoken] of [['NotChloeBennet','at not Chloe Bennett'],['TravelWithMina','at Travel With Mina'],['RiverStone','at River Stone']]) {
            const heading='Sent yesterday at 7:45 p.m.:';
            const sentence='Tilly, I notice that this girl @'+handle+' has liked TWO of your videos on the TikTok!';
            const ref=heading+'\n\n'+sentence+' I think this means she likes you.';
            const raw='Sent yesterday at 7.45 p.m. Tilly, I notice that this girl, '+spoken+', has liked two of your videos on the TikTok.';
            const result=resolver(ref).resolve({text:raw});
            assert.equal(result.aligned,true,JSON.stringify(result));
            const display=api.applySubtitleReferencePreference(result);
            assert.match(display.text,new RegExp('@'+handle));
            assert.equal(display.text,heading+'\n\n'+sentence,'mapped words retain original punctuation and line breaks');
            for(const time of ['7.45 p.m.','7:45 PM','7.45 p . m .'])
                assert.equal(resolver(ref).resolve({text:raw.replace('7.45 p.m.',time)}).trusted,true,time);
            const wrong=raw.replace(spoken,'at completely different account');
            assert.equal(resolver(ref).resolve({text:wrong}).trusted,false,'unrelated handles are not guessed');
            const changedTime=raw.replace('7.45','7.46');
            const mismatch=resolver(ref).resolve({text:changedTime});
            assert.ok(!mismatch.trusted || mismatch.reviewDifferences?.length,'clock mismatch remains protected');
        }
    });
    test('a fused ASR opening retains the whole contracted reference phrase as one review: ' + file, () => {
        const tail='in such good spirits these days; he says that things are going swimmingly with his business.';
        for(const [opening,heard] of [["He’s been",'spin'],["She's been",'spin'],["He's been",'sbin']]) {
            const ref='He is truly favored by the gods. '+opening+' '+tail;
            const raw=heard+' '+tail.replace(';',',');
            const result=resolver(ref).resolve({text:raw});
            assert.equal(result.aligned,true,JSON.stringify(result));assert.equal(result.trusted,false);
            assert.equal(result.ranges[0].text,opening+' '+tail.slice(0,-1));
            assert.equal(result.reviewDifferences.length,1);
            assert.equal(result.reviewDifferences[0].edit.from,heard);
            assert.equal(result.reviewDifferences[0].edit.to,opening);
            const display=api.applySubtitleReferencePreference(result);
            assert.equal(display.text,opening+' '+tail.replace(';',','));
            assert.equal(api.getSubtitleCorrectionDeletionMarkers(display).length,0);
            const blanks=api.buildSubtitlePracticeDualTokens(display.text,'en-US',[],display);
            const phrase=blanks.find(token=>token.corrected);
            assert.deepEqual(Array.from(phrase.parts[0].accepted),[opening,heard]);
            const original=api.applySubtitleReferencePreference(result,null,new Set([result.reviewDifferences[0].signature]));
            assert.equal(original.text,raw,'choosing original retains the entire ASR phrase');
        }
        const exact='been '+tail;
        assert.equal(resolver("He's been "+tail).resolve({text:exact}).text,exact,'exact partial cues are not silently extended');
        const unrelated=resolver('He is truly favored by the gods. He’s been '+tail).resolve({text:'green '+tail});
        assert.equal(unrelated.alignmentMethod==='opening_phrase',false,'unrelated sounds cannot justify borrowing a pronoun');
    });
    test('whole-phrase review works mid-cue, at the end, and in both word-count directions: ' + file, () => {
        const left='The neighbors told us yesterday that ',right=' in such good spirits these days and everyone was pleased about the news.';
        for(const [corrected,heard] of [["he’s been",'spin'],['he has been','spin'],['ice cream','scream'],['spin',"he's been"],['spin','he has been']]) {
            for(const ending of [false,true]) {
                const ref=left+corrected+(ending?'.':right),raw=left+heard+(ending?'.':right);
                const base=resolver(ref).resolve({text:raw});
                assert.equal(base.aligned,true,JSON.stringify(base));
                assert.equal(base.trusted,false,corrected+' / '+heard);
                assert.equal(base.reviewDifferences.length,1,JSON.stringify({corrected,heard,ending,base}));
                assert.equal(base.reviewDifferences[0].edit.from,heard);
                assert.equal(base.reviewDifferences[0].edit.to,corrected);
                const display=api.applySubtitleReferencePreference(base);
                assert.equal(display.text,ref);
                assert.equal(api.getSubtitleCorrectionDeletionMarkers(display).length,0,'no half-phrase deletion markers');
                const words=api.buildSubtitlePracticeDualTokens(display.text,'en-US',[],display);
                const phrase=words.filter(word=>word.corrected);
                assert.equal(phrase.length,1);
                assert.deepEqual(Array.from(phrase[0].parts[0].accepted),[corrected,heard]);
            }
        }
        const ref=left+"he's been"+right;
        const twice=left+"he's been"+right+' Later the neighbors explained that he has been in such good spirits these days and everyone was pleased about the news.';
        assert.equal(resolver(twice).resolve({text:'spin'+right}).trusted,false,'different competing phrase locations stay uncertain');
        for(const word of ['not spin','300','never']) {
            const result=resolver(ref).resolve({text:left+word+right});
            assert.ok(!result.trusted || result.reviewDifferences?.length,'protected meanings cannot be silently rewritten');
        }
        assert.notEqual(resolver("He's been in such good spirits.").resolve({text:'spin'}).aligned,true,'no phrase inference from an isolated word');
    });
    test('a complete four-word sentence with one spelling difference becomes a reviewable match: ' + file, () => {
        const ref='“Mung beans and pandan. Boil for fifteen minutes, maybe twenty if you want it richer in flavor.”';
        const raw='Mung beans and pantan.';
        const result=resolver(ref).resolve({text:raw});
        assert.equal(result.aligned,true,JSON.stringify(result));assert.equal(result.trusted,false);
        assert.equal(result.text,raw,'the unconfirmed base never mutates the raw caption');
        assert.equal(result.reviewDifferences.length,1);assert.equal(result.reviewDifferences[0].edit.to,'pandan');
        const preferred=api.applySubtitleReferencePreference(result);
        assert.equal(preferred.text,'Mung beans and pandan.');
        assert.equal(preferred.reviewDifferences.length,1);
        const tokens=api.buildSubtitlePracticeDualTokens(preferred.text,'en-US',[],preferred);
        const blank=tokens.find(token=>token.corrected);
        assert.deepEqual(Array.from(blank.parts[0].accepted),['pandan','pantan']);
        for(const [reference,caption] of [['Green leaves and stalks.','Green leaves and stalkes.'],['Fresh fruit tastes wonderful.','Fresh fruit tastes wonderfull.']]) {
            const located=resolver(reference).resolve({text:caption});
            assert.equal(located.aligned,true,caption);assert.equal(located.trusted,false);
            assert.equal(api.applySubtitleReferencePreference(located).text,reference);
        }
        assert.equal(resolver(ref+'\n'+ref.replace('pandan','pantan')).resolve({text:raw}).changed,false);
        const duplicate=resolver(ref+'\n'+ref).resolve({text:raw});
        assert.notEqual(duplicate.aligned,true,'multiple equally good positions remain ambiguous');
        for(const [source,cue] of [
            ['Mung beans and pandan.','Mung beans and nonsense.'],
            ['We bought mung beans and pandan for our guests.','Mung beans and pantan.'],
            ['Mung beans cost 200.','Mung beans cost 300.'],
            ['We should never leave.','We should always leave.']
        ]) assert.notEqual(resolver(source).resolve({text:cue}).alignmentMethod,'short_sentence_review',cue);
    });
    test('Vera opening and clock phrase resolve without false ambiguity or missing-word reviews: ' + file, () => {
        const opening='Vera Wong Zhuzhu, age sixty, is a pig, but she really should have been born a rooster.';
        const raw='Vera Wang Zhu Zhu, age 60, is a pig, but she really should have been born a rooster.';
        const next='We are, of course, referring to Chinese horoscopes.';
        const clock='Every morning, at exactly four thirty, Vera’s eyelids snap open like roller shades shooting up.';
        const engine=resolver('ONE\nVERA\n'+opening+' '+next+' Vera Wong is a human woman, thank you very much, but roosters have nothing on her. '+clock);
        const first=engine.resolveWithNeighbours({text:raw},null,{text:next});
        assert.equal(first.aligned,true,JSON.stringify(first));
        assert.equal(first.candidates,undefined);
        assert.match(first.text,/Vera Wong Zhuzhu/);
        for(const notation of ['4.30','4:30','four thirty']) {
            const cue=clock.replace('four thirty',notation);
            const result=engine.resolveWithNeighbours({text:cue},null,null);
            assert.equal(result.aligned,true,JSON.stringify(result));
            assert.equal(result.reviewDifferences?.length||0,0,notation);
            assert.equal(result.text,cue,'equivalent time keeps original subtitle spelling');
        }
        const wrong=engine.resolve({text:clock.replace('four thirty','4.45')});
        assert.ok(!wrong.trusted || wrong.reviewDifferences?.length,'different times cannot silently match');
        const decimal='The measured value was 4.30 and the researchers carefully checked every result today.';
        assert.equal(resolver(decimal).resolve({text:decimal.replace('4.30','4.3')}).trusted,true);
        assert.equal(resolver(decimal).resolve({text:decimal.replace('4.30','four thirty')}).trusted,false);
    });
    test('complete reference sentences supply punctuation and word-by-word answers without mutating subtitle timing: ' + file, () => {
        const opening='Vera Wong Zhuzhu, age sixty, is a pig, but she really should have been born a rooster.';
        const raw='Vera Wang Zhu Zhu age 60 is a pig but she really should have been born a rooster!';
        const next='We are, of course, referring to Chinese horoscopes.';
        const cue={text:raw,start:30.4,end:37.5};
        const projection=api.applySubtitleReferencePreference(resolver('VERA\n'+opening+' '+next).resolveWithNeighbours(cue,null,{text:next}));
        assert.equal(projection.text,opening);
        assert.equal(projection.raw,raw);assert.equal(projection.referenceTextApplied,true);
        assert.equal(cue.text,raw);assert.equal(cue.start,30.4);assert.equal(cue.end,37.5);
        let restored=raw;
        for(const edit of [...projection.edits].sort((a,b)=>b.start-a.start))restored=restored.slice(0,edit.start)+edit.text+restored.slice(edit.end);
        assert.equal(restored,opening,'display correction offsets reconstruct exact original text');
        const clock='Every morning, at exactly four thirty, Vera’s eyelids snap open like roller shades shooting up.';
        for(const notation of ['4.30','4:30','four thirty']) {
            const rawClock=clock.replace('four thirty',notation).replace('morning,','morning').replace('Vera’s',"Vera's");
            const result=api.applySubtitleReferencePreference(resolver(clock).resolve({text:rawClock}));
            assert.equal(result.text,clock);assert.equal(result.referenceTextApplied,true);
            const tokens=api.buildSubtitlePracticeDualTokens(result.text,'en-US',null,result);
            const answers=tokens.filter(token=>token.kind==='word').map(token=>token.parts.map(part=>part.text).join(''));
            assert.ok(answers.includes('four'));assert.ok(answers.includes('thirty'));
            assert.ok(!answers.includes(notation) || notation==='four thirty');
            assert.equal(tokens.some(token=>token.corrected),false,'no sentence-wide or ASR alternate-answer blank');
        }
        const prior={text:'The delegates read the report before returning home.'};
        const shortRef='At exactly four thirty, she wakes.';
        const sequential=resolver(prior.text+' '+shortRef);
        sequential.resolve(prior);
        const short=sequential.resolveFollowing({text:'At exactly 4.30 she wakes!'},prior);
        assert.equal(short.alignmentMethod,'adjacent_cue');
        assert.equal(api.applySubtitleReferencePreference(short).text,shortRef);
        const quoted='“The delegates reviewed the report,” she said, “and signed the treaty.”';
        assert.equal(api.applySubtitleReferencePreference(resolver(quoted).resolve({text:'The delegates reviewed the report she said and signed the treaty!'})).text,quoted);
    });
    test('matched sentence tails retain parenthetical punctuation without borrowing the introduction: ' + file, () => {
        const introduction='After a quick wash, Vera dons her morning gear—a polo shirt with a Ralph Lauren logo so big that it covers her entire left breast ';
        const tail='(well, okay, thanks to the ravages of time and gravity, it covers the top half of her breast) and sweatpants.';
        const raw='Well, okay, thanks to the ravages of time and gravity, it covers the top half of her breast and sweatpants.';
        const cue={text:raw,start:100,end:110};
        const result=api.applySubtitleReferencePreference(resolver(introduction+tail+' Arm sleeves are yanked on and adjusted.').resolve(cue));
        assert.equal(result.text,tail);assert.equal(result.referenceTextApplied,true);
        assert.equal(result.raw,raw);assert.equal(cue.text,raw);assert.equal(cue.start,100);assert.equal(cue.end,110);
        const tokens=api.buildSubtitlePracticeDualTokens(result.text,'en-US',null,result);
        assert.equal(tokens.map(token=>token.text || token.parts?.map(part=>part.text).join('') || '').join(''),tail);
        for(const [ref,raw,expected] of [
            ['An introduction (she carefully reviewed (and signed) the final report) and returned home.','She carefully reviewed and signed the final report and returned home.','(she carefully reviewed (and signed) the final report) and returned home.'],
            ['An introduction (she carefully reviewed the final report).','She carefully reviewed the final report.','(she carefully reviewed the final report).'],
            ['An introduction, she carefully reviewed the final report; then returned home.','She carefully reviewed the final report then returned home.','she carefully reviewed the final report; then returned home.']
        ]) {
            const first=ref.indexOf('she'),last=ref.lastIndexOf(raw.endsWith('home.')?'home':'report')+(raw.endsWith('home.')?4:6);
            assert.equal(api.getSubtitleReferenceSentenceText([{sourceLine:1,start:first,end:last}],new Map([[1,ref]])),expected);
        }
        const incomplete=api.applySubtitleReferencePreference(resolver('An introduction (she carefully reviewed the final report and returned home).').resolve({text:'She carefully reviewed the final report.'}));
        assert.equal(incomplete.text,'(she carefully reviewed the final report','keep the mapped fragment without borrowing words or inventing its closing parenthesis');
    });
    test('cue ending before a parenthesis uses the original dash without adding a full stop: ' + file, () => {
        const first='After a quick wash, Vera dons her morning gear—a polo shirt with a Ralph Lauren logo so big that it covers her entire left breast';
        const tail='(well, okay, thanks to the ravages of time and gravity, it covers the top half of her breast) and sweatpants.';
        const raw=first.replace('gear—','gear, ')+'.';
        const engine=resolver(first+' '+tail);
        const result=api.applySubtitleReferencePreference(engine.resolve({text:raw,start:80,end:100}));
        assert.equal(result.aligned,true);assert.equal(result.referenceTextApplied,true);
        assert.equal(result.text,first);assert.equal(result.raw,raw);
        assert.equal(result.text.includes('well'),false,'no words from the next cue');
        const tokens=api.buildSubtitlePracticeDualTokens(result.text,'en-US',null,result);
        assert.equal(tokens.map(token=>token.text || token.parts?.map(part=>part.text).join('') || '').join(''),first);
        const next=api.applySubtitleReferencePreference(engine.resolve({text:tail.replace(/[()]/g,'')}));
        assert.equal(next.text,tail,'the following cue still retains both parentheses');
        const ref='Earlier words. The delegates reviewed the report—then signed it, before returning home.';
        const fragment='The delegates reviewed the report—then signed it,';
        const aligned=api.applySubtitleReferencePreference(resolver(ref).resolve({text:'The delegates reviewed the report then signed it.'}));
        assert.equal(aligned.text,fragment,'a cue ending at a comma also keeps internal punctuation');
    });
    test('uncertainty stays reviewable while reliable partial cues use only mapped text: ' + file, () => {
        const ref='The delegates carefully reviewed all the available evidence before signing the treaty yesterday.';
        const raw=ref.replace('carefully ','');
        const pending=api.applySubtitleReferencePreference(resolver(ref).resolve({text:raw}));
        assert.notEqual(pending.referenceTextApplied,true);assert.ok(pending.reviewDifferences?.length);
        const numeric=ref.replace('all the available evidence','300 confirmed reports');
        const mismatch=api.applySubtitleReferencePreference(resolver(numeric).resolve({text:numeric.replace('300','200')}));
        assert.notEqual(mismatch.referenceTextApplied,true);assert.ok(mismatch.reviewDifferences?.length);
        const ambiguous=api.applySubtitleReferencePreference(resolver(ref+'\n'+ref).resolve({text:ref}));
        assert.notEqual(ambiguous.referenceTextApplied,true);assert.equal(ambiguous.text,ref);assert.equal(ambiguous.reason,'ambiguous');
        const partial='carefully reviewed all the available evidence';
        assert.equal(api.applySubtitleReferencePreference(resolver(ref).resolve({text:partial})).text,partial);
    });
    test('real competing positions expose text and offsets; ordered neighbours choose the correct copy: ' + file, () => {
        const phrase='The delegates carefully reviewed every document before signing the treaty yesterday.';
        const next='The committee accepted their conclusions after a long discussion today.';
        const book=phrase+' An unrelated sentence separates the first occurrence. '+phrase+' '+next;
        const engine=resolver(book),cue={text:phrase};
        const ambiguous=engine.resolve(cue);
        assert.equal(ambiguous.candidateCount,2);
        assert.equal(ambiguous.candidates.length,2);
        assert.notEqual(ambiguous.candidates[0].ranges[0].start,ambiguous.candidates[1].ranges[0].start);
        for(const candidate of ambiguous.candidates)assert.equal(candidate.text,phrase.slice(0,-1));
        const located=engine.resolveWithNeighbours(cue,null,{text:next});
        assert.equal(located.ranges[0].start,book.lastIndexOf('The delegates'));
        const following=engine.resolveWithNeighbours({text:next},cue,null);
        assert.equal(following.aligned,true);
        assert.equal(following.ranges[0].start,book.indexOf(next));
    });
    test('damaged ebook contractions, joined words and attached footnotes cannot corrupt caption answers: ' + file, () => {
        const fixtures = [
            ["The researcher doesn t know why we don t see the visible7 universe clearly today.", "The researcher doesn't know why we don't see the visible universe clearly today."],
            ['The researchers examined thevisible universe and described all the evidence carefully today.', 'The researchers examined the visible universe and described all the evidence carefully today.'],
            ['The researchers examined the visible7 universe and described all the evidence carefully today.', 'The researchers examined the visible universe and described all the evidence carefully today.'],
            ["The researcher doesn t know why thevisible7 universe appears so distant to everyone today.", "The researcher doesn't know why the visible universe appears so distant to everyone today."]
        ];
        for (const [ref, raw] of fixtures) {
            const engine = resolver(ref);
            const cue = {text: raw, start: 12, end: 18};
            const result = engine.resolve(cue);
            assert.equal(result.aligned, true, ref);
            assert.equal(api.applySubtitleReferencePreference(result).text, raw, ref);
            assert.equal(cue.text, raw); assert.equal(cue.start, 12); assert.equal(cue.end, 18);
            assert.ok(api.findKnowledgePreciseSubtitleRanges(ref, raw).length, ref);
            for (const range of result.ranges) assert.equal(ref.slice(range.start, range.end), range.text);
        }
        // A quality defect must not disable a separate, reliable correction.
        const ref = 'The signatories don t know why thevisible7 universe appears so distant to everyone today.';
        const raw = "The sinatures don't know why the visible universe appears so distant to everyone today.";
        const result = resolver(ref).resolve({text: raw});
        assert.equal(api.applySubtitleReferencePreference(result).text, raw.replace('sinatures','signatories'));
        assert.equal(result.changed, true);
        const typo = "The researcher doesn't know why the visible univerze appears so distant to everyone today.";
        const damaged = 'The researcher doesn t know why the visible7 universe appears so distant to everyone today.';
        assert.equal(api.applySubtitleReferencePreference(resolver(damaged).resolve({text: typo})).text, typo.replace('univerze','universe'));
    });
    test('nearby dialogue maps names, sound-boundary errors and contractions without borrowing surrounding speech: ' + file, () => {
        const fixtures=[
            ['“We should start back,” Gared urged as the woods began to grow dark around them.','Garret urged as the woods began to grow darker on them.','Gared urged as the woods began to grow dark around them.'],
            ['Gared did not rise to the bait. He was an old man, past fifty.','Garret did not rise to the bait.','Gared did not rise to the bait.'],
            ['“Will saw them,” Gared said. “If he says they are dead, that’s proof enough for me.”',"We'll show them, Garret said. And if he says they're dead, that's proof enough for me.",null],
            ['He wished it had been later rather than sooner.',"He wished he'd been later rather than sooner.",'He wished it had been later rather than sooner.'],
            ['Will shared his unease. He had been four years on the Wall.',"He'd been four years on the wall.","He'd been four years on the wall."]
        ];
        for(const [ref,raw,expected] of fixtures){
            const result=resolver(ref).resolve({text:raw},{sourceLine:1,sequential:true});
            assert.equal(result.aligned,true,raw);
            if(expected)assert.equal(api.applySubtitleReferencePreference(result).text,expected);
            assert.equal(result.ranges[0].text.includes('We should start back'),false);
            assert.equal(result.ranges[0].text.includes('He was an old man'),false);
            assert.equal(result.ranges[0].text.includes('Will shared his unease'),false);
        }
        const frequent='urged woods began grow '.repeat(150);
        const book=resolver(frequent+'\n'+frequent+fixtures[0][0]);
        const located=book.resolve({text:fixtures[0][1]},{sourceLine:1,sequential:true});
        assert.equal(located.aligned,true,'nearby late-paragraph anchors survive global frequency and first-128 limits');
        assert.equal(api.applySubtitleReferencePreference(located).text,fixtures[0][2]);
        const short=resolver(fixtures[1][0]).resolve({text:fixtures[1][1]});
        assert.equal(short.changed,false,'short misspelled names still need a nearby reference anchor');
        const repeated=resolver(fixtures[1][0]+'\n'+fixtures[1][0]).resolve({text:fixtures[1][1]},{sourceLine:1,sequential:true});
        assert.equal(repeated.aligned,undefined,'identical nearby dialogue remains ambiguous');
        const contraction=resolver(fixtures[4][0]).resolve({text:fixtures[4][1]},{sourceLine:1,sequential:true});
        assert.equal(contraction.changed,false);assert.equal(contraction.reviewDifferences?.length||0,0);
    });
    test('unanchored whole-book lookup uses ordered phrases when every useful word exceeds the posting limit: ' + file, () => {
        const ref='“We should start back,” Gared urged as the woods began to grow dark around them.';
        const raw='Garret urged as the woods began to grow darker on them.';
        const frequent='urged quiet woods distant began slowly grow tall '.repeat(110);
        const padding=Array.from({length:520},(_,i)=>'Unrelated chapter heading '+i+'.').join('\n');
        const book=resolver(padding+'\n'+frequent+'\n'+ref+'\nUnspoken later narration.');
        const cue={text:raw,start:7.7,end:12.2}, before=JSON.stringify(cue);
        const projection=book.resolve(cue); // Deliberately no sourceLine hint.
        assert.equal(projection.aligned,true,'a first lookup must work without a supplied correct paragraph');
        assert.equal(api.applySubtitleReferencePreference(projection).text,'Gared urged as the woods began to grow dark around them.');
        assert.equal(projection.ranges[0].text,'Gared urged as the woods began to grow dark around them');
        assert.equal(JSON.stringify(cue),before,'reference lookup cannot alter media timing or raw subtitles');
        assert.ok(projection.reviewDifferences.some(item=>item.text==='darker on → dark around'),'phrase review describes the complete replacement');
        assert.equal(book.resolve(cue),projection,'repeat playback reuses the result');
        const duplicate=resolver(frequent+'\n'+ref+'\n'+ref).resolve({text:raw});
        assert.ok(!duplicate.aligned,'exact phrase anchors cannot choose between duplicate full-cue matches');
        const unrelated=resolver(frequent+'\nSomeone urged as the woods were quiet before a storm started elsewhere.').resolve({text:raw});
        assert.ok(!unrelated.aligned,'an anchor phrase alone cannot approve a different whole sentence');
    });
    test('unequal sound-alike phrases stay one dual-answer blank without deletion markers: ' + file, () => {
        const sentence='It is hurtful when you could instead directly say goodbye to the ghost dude, live and let live.';
        for(const [raw,ref,from,to] of [
            [sentence,sentence.replace('ghost dude','ghosted'),'ghost dude','ghosted'],
            [sentence.replace('ghost dude','ghosted'),sentence,'ghosted','ghost dude']
        ]) {
            const cue={text:raw,start:120,end:130};
            const result=resolver(ref).resolve(cue);
            assert.equal(result.aligned,true);
            assert.equal(result.reviewDifferences.length,1);
            assert.equal(result.reviewDifferences[0].edit.from,from);
            assert.equal(result.reviewDifferences[0].edit.to,to);
            const projected=api.applySubtitleReferencePreference(result);
            assert.equal(projected.text,ref);
            assert.equal(projected.edits.length,1);
            assert.ok(!projected.edits.some(edit=>edit.kind==='extra'));
            const changed=api.buildSubtitlePracticeDualTokens(projected.text,'en-US',null,projected).filter(token=>token.corrected);
            assert.equal(changed.length,1);
            assert.deepEqual(Array.from(changed[0].parts[0].accepted),[to,from]);
            assert.equal(cue.text,raw);assert.equal(cue.start,120);assert.equal(cue.end,130);
        }
        const isolated=resolver('ghosted').resolve({text:'ghost dude'});
        assert.ok(!isolated.aligned,'sound signatures without sentence anchors cannot locate a phrase');
    });
    test('anchored spelled initials and an independent ASR error locate the whole following cue: ' + file, () => {
        const previous='turned up St. Vitus’s Dance—found, as I expected, that I had that too';
        const original='began to get interested in my case, and determined to sift it to the bottom, and so started alphabetically—read up ague, and learnt that I was sickening for it, and that the acute stage would commence in about another fortnight.';
        const raw='Began to get interested in my case and determined to sift it to the bottom, and so started alphabetically, read up A. G. U., and learnt that I was sickling for it, and that the acute stage would commence in about another fortnight.';
        const next='Bright’s disease, I was relieved to find, I had only in a modified form.';
        const book=resolver(previous+'—'+original+' '+next),prior={text:previous},cue={text:raw,start:10,end:30};
        assert.equal(book.resolve(prior).aligned,true);
        const result=book.resolveFollowing(cue,prior,{sourceLine:1,sequential:true});
        assert.equal(result.aligned,true);
        assert.ok(result.reviewDifferences.some(item=>item.edit.from==='A. G. U.' && item.edit.to==='ague'));
        const projected=api.applySubtitleReferencePreference(result);
        assert.equal(projected.text,raw.replace('A. G. U.','ague').replace('sickling','sickening'));
        assert.equal(projected.text.includes('ague.,'),false,'remove abbreviation punctuation together with its letters');
        assert.equal(result.ranges[0].text,original.slice(0,-1),'neither preceding nor following sentences may be borrowed');
        const dual=api.buildSubtitlePracticeDualTokens(projected.text,'en-US',null,projected).find(token=>token.originalText==='A. G. U.');
        assert.deepEqual(Array.from(dual.parts[0].accepted),['ague','A. G. U.']);
        assert.equal(cue.text,raw);assert.equal(cue.start,10);assert.equal(cue.end,30);
        assert.ok(!resolver('ague').resolve({text:'A. G. U.'}).aligned,'isolated initials cannot choose a source word');
        assert.ok(!resolver(original).resolve({text:raw.replace('A. G. U.','A. G. V.')}).aligned,'context cannot manufacture a different spelling');
    });
    test('misheard contraction boundaries remain complete phrase alternatives, including the final word: ' + file, () => {
        const prefix='He is an old chum of mine, and feels my pulse, and looks at my tongue, and talks about the weather all for nothing when I fancy ';
        for(const [raw,ref,from,to,expected] of [
            [prefix+'I mill.',prefix+"I’m ill; so I thought I would do him a good turn.",'I mill','I’m ill',prefix+'I’m ill.'],
            [prefix+'I mill before the next meeting.',prefix+"I'm ill before the next meeting.",'I mill',"I'm ill",prefix+"I'm ill before the next meeting."],
            [prefix+"I'm ill.",prefix+'I mill; so I thought I would do him a good turn.',"I'm ill",'I mill',prefix+'I mill.']
        ]){
            const cue={text:raw,start:1,end:10},result=resolver(ref).resolve(cue);
            assert.equal(result.aligned,true);
            assert.equal(result.reviewDifferences.length,1);
            assert.equal(result.reviewDifferences[0].edit.from,from);
            assert.equal(result.reviewDifferences[0].edit.to,to);
            const projected=api.applySubtitleReferencePreference(result);
            assert.equal(projected.text,expected,'neither ill nor its consonant may be dropped');
            assert.equal(projected.edits.length,1);
            assert.ok(!projected.edits.some(edit=>edit.kind==='extra'));
            const dual=api.buildSubtitlePracticeDualTokens(projected.text,'en-US',null,projected).find(token=>token.corrected);
            assert.deepEqual(Array.from(dual.parts[0].accepted),[to,from]);
            assert.equal(cue.text,raw);assert.equal(cue.start,1);assert.equal(cue.end,10);
        }
        assert.ok(!resolver("I'm ill.").resolve({text:'I mill.'}).aligned,'two isolated words cannot choose a whole-book location');
    });
    test('hyphenated and joined compounds retain caption spelling and never create false deletion/replacement blanks: ' + file, () => {
        const raw='Will wanted nothing so much as to ride hell-bent for the safety of the wall, but that was not a feeling to share with your commander, especially not a commander like this one.';
        const ref=raw.replace('hell-bent','hellbent').replace(', especially','.\nEspecially');
        for(const form of ['hell-bent','hell‐bent','hell‑bent','hell bent','hellbent']) {
            const cue={text:raw.replace('hell-bent',form)};
            const projection=resolver(ref).resolve(cue);
            assert.equal(projection.aligned,true,form);
            assert.equal(projection.changed,false,form);
            assert.equal(projection.reviewDifferences?.length || 0,0,form);
            assert.equal(api.applySubtitleReferencePreference(projection).text,ref.replace('hellbent',form),form+' retains caption compound spelling while adopting reference punctuation');
            assert.equal(api.buildSubtitlePracticeDualTokens(cue.text,'en-US',[],projection).some(token=>token.corrected),false,form);
        }
        const reverse=resolver(raw).resolve({text:raw.replace('hell-bent','hellbent')});
        assert.equal(reverse.aligned,true);assert.equal(reverse.changed,false);assert.equal(reverse.reviewDifferences?.length || 0,0);
        const adjacent=resolver('The signatories wanted to ride hellbent for safety before the coming storm.').resolve({text:'The sinatures wanted to ride hell-bent for safety before the coming storm.'});
        assert.equal(adjacent.text,'The signatories wanted to ride hell-bent for safety before the coming storm.');
        assert.equal(adjacent.edits.length,1,'a reliable adjacent correction remains independent from compound typography');
    });
    test('a one-word cue follows only the exact endpoint of the actual preceding verified subtitle: ' + file, () => {
        const ref='At the edge of the room, he passed rows of lights. They held sapphires infused with Stormlight. Profane. How could they do that? Profane, but beautiful. That was profane.';
        const previous={text:'They held sapphires infused with stormlight.'};
        const cue={text:'Profane.',start:270.5,end:271.2};
        const book=resolver(ref);
        assert.ok(!book.resolve(cue,{sourceLine:1,sequential:true}).aligned,'a paragraph hint alone cannot pick a repeated word');
        assert.equal(book.resolve(previous,{sourceLine:1}).aligned,true);
        const projection=book.resolveFollowing(cue,previous,{sourceLine:1,sequential:true});
        assert.equal(projection.aligned,true);assert.equal(projection.text,'Profane.');assert.equal(projection.changed,false);
        assert.equal(projection.ranges[0].start,ref.indexOf('Profane.'));
        assert.equal(projection.ranges[0].text,'Profane','never borrow the next sentence');
        assert.equal(book.resolveFollowing(cue,previous,{sourceLine:1,sequential:true}),projection,'replay keeps the same bounded range');
        const next={text:'How could they do that?'};
        assert.equal(book.resolveFollowing(next,cue).aligned,true,'short consecutive cues retain sequence context');
        const third=book.resolveFollowing({text:'Profane, but beautiful.'},next);
        assert.equal(third.aligned,true);assert.equal(third.ranges[0].start,ref.indexOf('Profane, but'));
        assert.equal(cue.start,270.5);assert.equal(cue.end,271.2);
        assert.ok(!resolver(ref).resolveFollowing(cue,previous).aligned,'a new document cannot inherit another resolver’s endpoint');
        const wrongPrevious={text:'At the edge of the room, he passed rows of lights.'};
        assert.equal(book.resolve(wrongPrevious).aligned,true);
        assert.ok(!book.resolveFollowing(cue,wrongPrevious).aligned,'cannot skip intervening words to find a convenient answer');
        assert.ok(!book.resolveFollowing({text:'Profanity.'},previous).aligned,'single-word phonetic guesses remain forbidden');
    });
    test('a previous cue cannot impose forward-only limits on an explicit nonsequential lookup: ' + file, () => {
        const prior={text:'The earlier delegation discussed the regional peace treaty yesterday.'};
        const next={text:'The royal delegation completed its lengthy journey through the northern mountains before the evening meeting.'};
        const book=resolver(prior.text+'\n'+Array.from({length:70},(_,i)=>'Unrelated heading '+i+'.').join('\n')+'\n'+next.text);
        assert.equal(book.resolve(prior,{sourceLine:1}).aligned,true);
        assert.equal(book.resolveFollowing(next,prior,{sourceLine:1,sequential:false}).aligned,true,'manual navigation retains its requested search scope');
    });
    test('short adjacent cues compare vocatives, demonstratives and ASR names without a whole-book guess: ' + file, () => {
        for(const [ref,previous,raw,expected,review,seed] of [
            ['A mountain stream only three steps from the ice. We are his. Oh Stormfather … we are his. It is but a thousand days.','We are his.','O Stormfather, we are his.','O Stormfather, we are his.',0,'A mountain stream only three steps from the ice.'],
            ['They did not call themselves Parshendi; this was the Alethi name for them. It meant something else.','They did not call themselves Parshendi.','That was the Alethi name for them.','this was the Alethi name for them.',1],
            ['The tiny spirits took the form of spinning translucent ribbons. As Szeth passed the drummers, they noted him. They would withdraw soon.','The tiny spirits took the form of spinning translucent ribbons.','As Zeth passed the drummers, they noted him.','As Szeth passed the drummers, they noted him.',1]
        ]) {
            const book=resolver(ref),previousCue={text:previous};
            const seedCue=seed && {text:seed};
            if(seedCue)assert.equal(book.resolve(seedCue,{sourceLine:1}).aligned,true);
            const prior=seedCue?book.resolveFollowing(previousCue,seedCue,{sourceLine:1}):book.resolve(previousCue,{sourceLine:1});
            assert.equal(prior.aligned,true,previous);
            const projection=book.resolveFollowing({text:raw},previousCue,{sourceLine:1,sequential:true});
            assert.equal(projection.aligned,true,raw);
            assert.equal(api.applySubtitleReferencePreference(projection).text,expected);
            assert.equal(projection.reviewDifferences.length,review);
            assert.ok(!projection.ranges[0].text.includes('It meant'));
            assert.ok(!projection.ranges[0].text.includes('They would withdraw'));
        }
    });
    test('legacy ebook apostrophes are format equivalence, never two replacement answers: ' + file, () => {
        const raw="For the month or so that they are visible, all that distinguishes them from the other stars in the sky is that they occupy a point of space that wasn't filled before.";
        for (const damaged of ['wasn\u0092t','wasn\u0091t','wasnʼt','wasn＇t','wasn‘t','wasn`t','wasn´t','wasn\uFFFDt','wasn\u200Bt','wasn t','wasnt']) {
            const ref=raw.replace("wasn't",damaged);
            const result=resolver(ref).resolve({text:raw,start:20,end:25});
            assert.equal(result.aligned,true,JSON.stringify(damaged));
            assert.equal(result.text,raw,JSON.stringify(damaged));
            assert.equal(result.changed,false,JSON.stringify(damaged));
            assert.equal(result.reviewDifferences?.length || 0,0,JSON.stringify(damaged));
            assert.equal(result.boundaryOmissions?.length || 0,0,JSON.stringify(damaged));
            assert.equal(api.applySubtitleReferencePreference(result).text,raw);
            const tokens=api.buildSubtitlePracticeDualTokens(raw,'en-US',[],result);
            assert.equal(tokens.some(token=>token.corrected),false,'format noise cannot create red dual-answer blanks');
            assert.ok(tokens.some(token=>token.kind==='word'&&token.parts.map(part=>part.text).join('')==="wasn't"));
            assert.equal(ref.slice(result.ranges[0].start,result.ranges[0].end),result.ranges[0].text,'document offsets remain exact');
        }
        const damaged=raw.replace("wasn't",'wasn\u0092t').replace('distinguishes','distinguish');
        const result=resolver(damaged).resolve({text:raw});
        assert.equal(result.aligned,true);assert.ok(result.edits.length || result.reviewDifferences?.length,'a real neighbouring wording difference is still compared');
        assert.ok(!(api.applySubtitleReferencePreference(result).text.includes('wasn t')));
    });
    test('source quality rules retain genuine standalone numbers, percentages and model identifiers: ' + file, () => {
        for (const value of ['300', '7%', 'COVID19', 'B12', 'chapter7', 'phase2']) {
            const text = 'The researchers carefully examined ' + value + ' and described all the evidence in their final report.';
            const result = resolver(text).resolve({text});
            assert.equal(result.aligned, true, value); assert.equal(result.text, text);
        }
        const ref = 'The researchers carefully examined 300 samples and described all the evidence in their final report.';
        const raw = ref.replace('300', '200');
        const result = resolver(ref).resolve({text: raw});
        assert.ok(result.reviewDifferences.length); assert.equal(result.changed, false);
        assert.equal(api.applySubtitleReferencePreference(result).text, ref);
    });
    test('context corrects ASR spelling without changing timing, punctuation or the original subtitle: ' + file, () => {
        const cue = { id: 7, start: 10, end: 15, text: 'All the sinatures agreed to join the block tomorrow.' };
        const original = JSON.stringify(cue);
        const engine = resolver('All the signatories agreed to join the bloc tomorrow. Another unspoken sentence follows.');
        const result = engine.resolve(cue);
        assert.equal(result.text, 'All the signatories agreed to join the bloc tomorrow.');
        assert.equal(result.edits.length, 2); assert.equal(result.trusted, true);
        assert.equal(result.ranges[0].text, 'All the signatories agreed to join the bloc tomorrow');
        assert.equal(JSON.stringify(cue), original);
        for (let i = 0; i < 100; i++) assert.equal(engine.resolve(cue), result, 'media ticks and replay reuse the same projection');
    });
    test('word alignment corrects populace to populist across unreliable punctuation: ' + file, () => {
        const ref = "Marine Le Pen, the populist-right front-runner in next year’s presidential election, officially launched her campaign. Another unspoken sentence.";
        const text = "Marine Le Pen, the populace right front runner in next year's presidential election, officially launched her campaign.";
        const result = resolver(ref).resolve({ text });
        assert.equal(result.text, text.replace('populace', 'populist'));
        assert.equal(result.trusted, true); assert.equal(result.edits.length, 1);
        assert.equal(result.ranges[0].text, ref.slice(0, ref.indexOf('.')));
        for (const punctuation of [',', ';', '—', '…', '']) {
            const cue = text.replace(', the', punctuation + ' the').replace('right front runner', 'right—front-runner');
            assert.equal(resolver(ref).resolve({text:cue}).text, cue.replace('populace','populist'));
        }
        const partial = "Marine Le Pen, the populace right front runner in next year's presidential election";
        assert.equal(resolver(ref).resolve({text:partial}).text,partial.replace('populace','populist'));
        assert.ok(!resolver(ref).resolve({text:partial}).ranges[0].text.includes('officially'));
    });
    test('a speculative miss cannot poison the cue after its anchor or document context changes: ' + file, () => {
        const text = "Marine Le Pen, the populace right front runner in next year's presidential election, officially launched her campaign.";
        const ref = text.replace('populace','populist');
        for (const cue of [{text},text]) {
            const engine = resolver(ref);
            const speculative = engine.resolve(cue,{sourceLine:120,sequential:true});
            assert.equal(speculative.changed,false); assert.equal(speculative.trusted,false);
            const corrected = engine.resolve(cue,{sourceLine:1,sequential:true});
            assert.equal(corrected.text,ref); assert.equal(corrected.changed,true);
            assert.equal(engine.resolve(cue,{sourceLine:1,sequential:true}),corrected);
            assert.equal(engine.resolve(cue,{sourceLine:120,sequential:true}),speculative);
            assert.equal(engine.resolve(cue,{sourceLine:120,sequential:false}).text,ref);
            assert.equal(engine.resolve(cue).text,ref);
        }
        const repeated = resolver(ref+'\n'+ref);
        const cue = {text};
        assert.equal(repeated.resolve(cue).trusted,false);
        assert.equal(repeated.resolve(cue,{sourceLine:1}).trusted,false,'two equally local occurrences remain ambiguous');
        const separated = resolver(ref+'\n'+Array.from({length:10},()=> 'Unrelated text.').join('\n')+'\n'+ref);
        assert.equal(separated.resolve(cue).trusted,false);
        assert.equal(separated.resolve(cue,{sourceLine:1}).text,ref,'a later trusted anchor can resolve a cached ambiguity');
    });
    test('a new document rejects stale cursor coordinates before the deferred follower resets: ' + file, () => {
        const start = source.indexOf('    const currentSubtitleProjection = useMemo');
        const end = source.indexOf('    const currentSubtitlePresentation =',start);
        const cue = {text:"Marine Le Pen, the populace right front runner in next year's presidential election, officially launched her campaign."};
        const ref = cue.text.replace('populace','populist');
        const context = {useMemo:fn=>fn(), referenceSubtitleActive:true, subtitleReferenceResolver:resolver(ref), subtitles:[cue],currentIndex:0,
            embeddedKnowledgeText:ref,embeddedKnowledgePlaybackProgressRef:{current:{documentText:'previous document',maxSourceLine:120,anchorState:'anchored',subtitleIndex:0}}};
        const result = vm.runInNewContext(source.slice(start,end)+'\ncurrentSubtitleProjection',context);
        assert.equal(result.text,ref);assert.equal(result.changed,true);
    });
    test('internal missing articles and regular past tense align the supplied train and delegation examples: ' + file, () => {
        for (const [ref,raw,expected] of [
            ['One train was stationary, reportedly because of a computer-system failure.', 'One train was stationary, reportedly because of computer system failure.', 'One train was stationary, reportedly because of a computer system failure.'],
            ['Dozens of African delegations travelled to Moscow for a summit with Vladimir Putin.', 'Dozens of African delegations travel to Moscow for a summit with Vladimir Putin.', 'Dozens of African delegations travelled to Moscow for a summit with Vladimir Putin.']
        ]) {
            const result=resolver(ref).resolve({text:raw});
            assert.equal(result.text,expected);assert.equal(result.trusted,true);
            assert.equal(result.ranges[0].text,ref.slice(0,-1));
            assert.ok(api.findKnowledgePreciseSubtitleRanges(ref,raw).length);
        }
    });
    test('numeric words and digits align by exact value without forcing digits into dictation: ' + file, () => {
        const ref='According to the UN drone strikes killed over 300 people and injured hundreds more in the first three weeks of October.';
        const raw='According to the UN, drone strikes killed over three hundred people and injured hundreds more in the first three weeks of October.';
        const result=resolver(ref).resolve({text:raw});
        assert.equal(result.trusted,true);assert.equal(result.text,raw);assert.equal(result.changed,false);
        assert.equal(result.ranges[0].text,ref.slice(0,-1));assert.ok(api.findKnowledgePreciseSubtitleRanges(ref,raw).length);
        const ref2="At least 100 people were killed and dozens more injured in an army drone strike on a market in Nyala, in Sudan’s Darfur region, which is controlled by the rebel Rapid Support Forces.";
        const raw2="At least one hundred people were killed and dozens more injured in an army drone strike on a market in Niala in Sudan's Darfur region, which is controlled by the rebel rapid support forces.";
        const mapped=resolver(ref2).resolve({text:raw2});
        assert.equal(mapped.trusted,true);assert.equal(mapped.text,raw2.replace('Niala','Nyala'));
        for(const [digits,words] of [['1,400','one thousand four hundred'],['120','one hundred and twenty'],['53','fifty-three'],['90%','ninety percent'],['1000000','one million']]) {
            const a='The delegation counted '+digits+' confirmed votes in the latest election.';
            const b='The delegation counted '+words+' confirmed votes in the latest election.';
            assert.equal(resolver(a).resolve({text:b}).trusted,true,b);
            assert.equal(resolver(b).resolve({text:a}).trusted,true,a);
        }
    });
    test('common secondary anchors do not discard a rare numeric anchor: ' + file, () => {
        const ref=Array.from({length:40},(_,i)=>`The signatories from district ${i} agreed to join the bloc tomorrow.`).join('\n');
        const raw='The sinatures from district 0 agreed to join the block tomorrow.';
        assert.equal(resolver(ref).resolve({text:raw}).text,'The signatories from district 0 agreed to join the bloc tomorrow.');
    });
    test('different number values, percent units and signs can align but require explicit correction review: ' + file, () => {
        for(const [ref,raw] of [['300','one hundred'],['100','one two'],['90%','ninety'],['100','minus one hundred'],['100','-100'],['100','200']]) {
            const a='The delegation counted '+ref+' confirmed votes in the latest election.';
            const b='The delegation counted '+raw+' confirmed votes in the latest election.';
            assert.equal(resolver(a).resolve({text:b}).trusted,false,b);
            const located=resolver(a).resolve({text:b});
            assert.equal(located.changed,false,b);assert.equal(located.aligned,true,b);assert.ok(located.reviewDifferences.length,b);
            assert.ok(api.findKnowledgePreciseSubtitleRanges(a,b).length,b);
        }
    });
    test('boundary omissions are reviewable suggestions until explicitly confirmed: ' + file, () => {
        const ref="Officials from Pakistan, Saudi Arabia and Turkey, the three signatories to the new Mecca pact, travelled to Tehran to meet Iran’s security chief and president.";
        const raw="from Pakistan, Saudi Arabia and Turkey, the three signatures to the new Mecca pact, travelled to Tehran to meet Iran's security chief and president.";
        const result=resolver(ref).resolve({text:raw});
        assert.equal(result.text,raw.replace('signatures','signatories'));
        assert.equal(result.ranges[0].start,ref.indexOf('from'));
        const suggestion=result.boundaryOmissions.find(item=>item.side==='leading');
        assert.equal(suggestion.text,'Officials');
        const accepted=api.applySubtitleReferenceBoundaryAcceptance(result,new Set([suggestion.signature]));
        assert.equal(accepted.text,'Officials '+raw.replace('signatures','signatories'));
        assert.equal(accepted.ranges[0].start,0);assert.equal(accepted.ranges[0].text,ref.slice(0,-1));
        assert.equal(accepted.boundaryOmissions.length,0);assert.equal(accepted.acceptedBoundaryCount,1);
        assert.equal(api.applySubtitleReferenceBoundaryAcceptance(result,new Set()),result,'undo restores the unextended cue');
        const both=resolver('Earlier delegates agreed to sign the final regional trade treaty tomorrow.').resolve({text:'delegates agreed to sign the final regional trade treaty'});
        assert.equal(both.boundaryOmissions.length,2);
        const expanded=api.applySubtitleReferenceBoundaryAcceptance(both,new Set(both.boundaryOmissions.map(item=>item.signature)));
        assert.equal(expanded.text,'Earlier delegates agreed to sign the final regional trade treaty tomorrow');
        assert.equal(expanded.ranges[0].text,expanded.text);
    });
    test('source names override very different ASR spellings when surrounding words agree: ' + file, () => {
        for (const [ref,raw] of [
            ['Luiz Inácio Lula da Silva was re-elected as Brazil’s president in a run-off election, winning 52% of the vote.',"Luis Inasio Luleva Silva was re-elected as Brazil's president in a run-off election, winning 52% of the vote."],
            ['Maria Ana Julia Isabel Sofia de la Cruz Silva spoke to the delegates about regional security and future negotiations.','Mary Sivah spoke to the delegates about regional security and future negotiations.'],
            ['She made her first campaign speech in Orléans, a city closely associated with Joan of Arc.','She made her first campaign speech in Orgliant, a city closely associated with Joan of Arc.'],
            ['At its party congress the same weekend, her National Rally re-elected Jordan Bardella as its president.',"At its party congress the same weekend, her national rally re-elected Jean d 'Ambadelle as its president."],
            ['At its party congress the same weekend, her National Rally re-elected Jordan Bardella as its president.',"At its party congress the same weekend, her national rally re-elected Jean d'Ambadelle as its president."],
            ['The ceasefire was reportedly extended across the Kherson region.','The ceasefire was reportedly extended across the Haerson region.'],
            ['Kherson was reportedly the final location selected for the peace talks.','Haerson was reportedly the final location selected for the peace talks.'],
            ['The delegation held the regional security meeting in Kherson.','The delegation held the regional security meeting in Haerson.'],
            ['The delegates attended the regional peace talks in Orléans before returning home.','The delegates attended the regional peace talks in Or Glee Ant City before returning home.'],
            ['The delegates discussed regional security with Aleksandar Vucic before the evening meeting.','The delegates discussed regional security with Alexander Voo Chich before the evening meeting.']
        ]) {
            const cue={text:raw,start:10,end:15}; const before=JSON.stringify(cue);
            const result=resolver(ref).resolve(cue);
            assert.equal(result.trusted,true,raw); assert.equal(result.changed,true,raw);
            const names=result.edits.filter(edit=>edit.kind==='name');assert.ok(names.length,raw);
            assert.equal(JSON.stringify(cue),before);
            assert.equal(result.ranges[0].text,ref.slice(0,-1));
            assert.ok(api.findKnowledgePreciseSubtitleRanges(ref,raw).length);
        }
    });
    test('sequential name correction never consumes the spoken clause before Dicke: ' + file, () => {
        const previous = "Penzias and Wilson’s finding pushed our acquaintance with the visible7 universe to within half an inch of the lobby floor.";
        const ref = 'Still unaware of what caused the noise, Wilson and Penzias phoned Dicke at Princeton and described their problem to him in the hope that he might suggest a solution.';
        const raw = ref.replace('Penzias', 'Penzius').replace('Dicke', 'Dickie');
        const engine = resolver(previous + '\n' + ref);
        const cue = { start: 1455.05, end: 1465.9, text: raw };
        for (const context of [{}, {sourceLine: 1, sequential: true}, {sourceLine: 2, sequential: true}]) {
            const result = engine.resolve(cue, context);
            assert.equal(result.text, ref);
            assert.equal(result.ranges[0].text, ref.slice(0, -1));
            assert.ok(result.edits.every(edit => edit.from === 'Penzius' || edit.from === 'Dickie'));
            assert.equal(api.applySubtitleReferencePreference(result).text, ref);
        }
        assert.equal(cue.text, raw);
        assert.equal(cue.start, 1455.05); assert.equal(cue.end, 1465.9);
        for (const punctuation of [',', '', '—', '.']) {
            const variant = raw.replace('noise,', 'noise' + punctuation);
            const result = engine.resolve({text: variant}, {sourceLine: 2, sequential: true});
            assert.equal(result.text, variant.replace('Penzius', 'Penzias').replace('Dickie', 'Dicke'));
        }
        // Even when other ASR errors prevent a complete match, a shorter name
        // candidate cannot win by deleting the still-correct spoken prefix.
        const damaged = raw.replace('unaware', 'ignorant').replace('caused', 'produced').replace('noise', 'sound');
        const result = engine.resolve({text: damaged}, {sourceLine: 2, sequential: true});
        assert.ok(result.text.startsWith('Still ignorant of what produced the sound, Wilson and '));
    });
    test('name replacement keeps even a short matching clause before the actual name: ' + file, () => {
        for (const prefix of ['We called', 'Yesterday we called', 'The researchers called']) {
            const ref = prefix + ' Dicke at Princeton and described their problem to him in the hope that he might suggest a solution.';
            const raw = ref.replace('Dicke', 'Dickie');
            const result = resolver(ref).resolve({text: raw}, {sourceLine: 1, sequential: true});
            assert.equal(result.text, ref);
            assert.ok(result.edits.every(edit => edit.from === 'Dickie'));
        }
    });
    test('equivalent first-name and full-name candidates do not reject a long paragraph cue: ' + file, () => {
        const ref='Our heads spin from distraction politics, the body count increases, and our brains break, as contributor and previous guest editor Jia Tolentino puts it, from absorbing the unbelievable acts of cruelty that come across our transoms with no hope of abating.';
        const raw='Our heads spin from distraction politics, the body count increases, and our brains break, as contributor and previous guest editor, Gia Tolentino, puts it, from absorbing the unbelievable acts of cruelty that come across our transoms, with no hope of abating.';
        const prefix='No one can keep track of what happened in the previous month. ';
        const suffix=' The essays collected in this volume appeared in print or online.';
        const result=resolver(prefix+ref+suffix).resolve({text:raw});
        assert.equal(result.trusted,true);assert.equal(result.text,raw.replace('Gia Tolentino','Jia Tolentino'));
        assert.equal(result.edits.length,1);assert.equal(result.edits[0].to,'Jia Tolentino');
        assert.equal(result.ranges[0].start,prefix.length);assert.equal(result.ranges[0].text,ref.slice(0,-1));
        assert.ok(!result.ranges[0].text.includes('previous month'));assert.ok(!result.ranges[0].text.includes('essays collected'));
        const precise=api.findKnowledgePreciseSubtitleRanges(prefix+ref+suffix,raw);
        assert.deepEqual(Array.from(precise,range=>(prefix+ref+suffix).slice(range.start,range.end)),[ref.slice(0,-1)]);
        const spellingVariants=resolver('The delegates discussed the final agreement with Jordan Bardella after the meeting.');
        assert.equal(spellingVariants.resolve({text:'The delegates discussed the final agreement with Jorden Bardella after the meeting.'}).text,
            'The delegates discussed the final agreement with Jordan Bardella after the meeting.');
    });
    test('near-total cue agreement permits a bounded first-letter ASR error without expanding the paragraph: ' + file, () => {
        const ref='All these possibilities and yet our individual lives with their energetic complexities do not even register on the geological timeline as anything but the merest mark.';
        const raw=ref.replace('merest','nearest');
        const prefix='On other days, I yearn for a right-brain revolution. ';
        const suffix=' But from the start, our species has been making marks.';
        const result=resolver(prefix+ref+suffix).resolve({text:raw});
        assert.equal(result.trusted,true);assert.equal(result.text,ref);
        assert.equal(result.edits.length,1);assert.equal(result.edits[0].from,'nearest');assert.equal(result.edits[0].to,'merest');
        assert.equal(result.ranges[0].text,ref.slice(0,-1));assert.equal(result.ranges[0].start,prefix.length);
        assert.deepEqual(Array.from(api.findKnowledgePreciseSubtitleRanges(prefix+ref+suffix,raw),range=>(prefix+ref+suffix).slice(range.start,range.end)),[ref.slice(0,-1)]);
        assert.equal(resolver(ref+'\n'+ref.replace('merest','dearest')).resolve({text:raw}).changed,false,'different plausible wordings remain ambiguous');
        const weak='The nearest mark was visible.';
        assert.equal(resolver(weak.replace('nearest','merest')).resolve({text:weak}).changed,false,'short cues do not relax the spelling rule');
        const protectedRaw='The delegates have now signed the final agreement after the successful meeting yesterday.';
        assert.equal(resolver(protectedRaw.replace('now','not')).resolve({text:protectedRaw}).changed,false);
        const wrongContext=raw.replace('anything but the nearest','anything near the nearest');
        assert.equal(resolver(ref).resolve({text:wrongContext}).changed,false,'local context must be exact');
    });
    test('context locates and corrects a cue-final ASR error despite punctuation and hyphen differences: ' + file, () => {
        const ref='Sometimes it feels less dire—or, at least, more philosophical—to cling to other-than-living-in-hell notions.';
        const raw='Sometimes it feels less dire, or at least more philosophical, to cling to other -than-living-in-hell motions.';
        const prefix='Prior sentence. '; const suffix=' For example, perhaps we are a projection from consciousness.';
        const result=resolver(prefix+ref+suffix).resolve({text:raw});
        assert.equal(result.aligned,true);assert.equal(result.text,raw.replace('motions','notions'));assert.equal(result.trusted,true);
        assert.equal(result.alignmentMethod,'ordered_context');assert.equal(result.ranges[0].text,ref.slice(0,-1));
        assert.equal(result.boundaryOmissions.length,0,'a preceding complete sentence is not a missing boundary word');
        assert.equal(resolver(prefix+ref+suffix).resolve({text:raw.replace('motions','notions')}).trusted,true);
        assert.deepEqual(Array.from(api.findKnowledgePreciseSubtitleRanges(prefix+ref+suffix,raw),range=>(prefix+ref+suffix).slice(range.start,range.end)),[ref.slice(0,-1)]);
    });
    test('whole-cue context can correct a local word without a spelling-distance gate: ' + file, () => {
        const ref='The researchers carefully reviewed all the evidence before describing the event as an unprecedented catastrophe.';
        const raw=ref.replace('catastrophe','banana');
        const result=resolver(ref).resolve({text:raw});
        assert.equal(result.aligned,true);assert.equal(result.text,ref);assert.equal(result.trusted,true);
        const competing=ref+'\n'+ref.replace('catastrophe','maelstrom');
        assert.equal(resolver(competing).resolve({text:raw}).changed,false,'two equally supported reference wordings are not guessed');
        assert.equal(resolver(ref).resolve({text:'The people described a surprising banana.'}).aligned,undefined);
    });
    test('locating a numeric or internal omission difference does not silently rewrite it: ' + file, () => {
        const ref='The researchers reviewed all the evidence and counted 300 confirmed reports in the final study.';
        const raw=ref.replace('300','200');const engine=resolver(ref);const cue={text:raw,start:5,end:10};
        const result=engine.resolve(cue);
        assert.equal(result.aligned,true);assert.equal(result.trusted,false);assert.equal(result.changed,false);assert.equal(result.text,raw);
        const accepted=api.applySubtitleReferenceBoundaryAcceptance(result,new Set(result.reviewDifferences.map(item=>item.signature)));
        assert.equal(accepted.text,ref);assert.equal(accepted.trusted,true);assert.equal(accepted.acceptedReviewCount,1);
        assert.equal(api.applySubtitleReferenceBoundaryAcceptance(result,new Set()),result);assert.equal(cue.text,raw);
        const original='The delegates reviewed all the evidence and finally agreed to sign the regional treaty yesterday.';
        const missing=original.replace('finally ','');const omission=resolver(original).resolve({text:missing});
        assert.equal(omission.aligned,true);assert.equal(omission.changed,false);assert.ok(omission.reviewDifferences.length);
        const restored=api.applySubtitleReferenceBoundaryAcceptance(omission,new Set(omission.reviewDifferences.map(item=>item.signature)));
        assert.equal(restored.text,original);
    });
    test('reviewed multi-word omissions retain reference order and extra words are never auto-deleted: ' + file, () => {
        const ref='The delegates examined all the available evidence and then carefully reviewed the final document before signing the regional treaty yesterday.';
        const raw=ref.replace('carefully reviewed ','');
        const result=resolver(ref).resolve({text:raw});
        assert.equal(result.aligned,true);assert.equal(result.changed,false);
        assert.equal(api.applySubtitleReferenceBoundaryAcceptance(result,new Set(result.reviewDifferences.map(item=>item.signature))).text,ref);
        const extra=ref.replace('evidence and','evidence strangely maybe and');
        const withExtra=resolver(ref).resolve({text:extra});
        assert.equal(withExtra.aligned,true);assert.equal(withExtra.changed,false);
        assert.equal(api.applySubtitleReferenceBoundaryAcceptance(withExtra,new Set(withExtra.reviewDifferences.map(item=>item.signature))).text,ref);
    });
    test('first visit uses the next loaded cue to settle a repeated exact sentence without next/back navigation: ' + file, () => {
        const text='If I leave this house, it will be in handcuffs.';
        const next='I should have run for it while I had the chance.';
        // Both copies can even occur inside the same paragraph; a line hint
        // cannot distinguish them, but the exact next-cue boundary can.
        const book=text+' A different recollection interrupted the earlier conversation. '+text+' '+next;
        const engine=resolver(book),cue={text,start:25,end:30},following={text:next,start:30,end:36};
        assert.equal(engine.resolve(cue).reason,'ambiguous');
        const first=engine.resolveWithNeighbours(cue,null,following);
        assert.equal(first.aligned,true);assert.equal(first.trusted,true);assert.equal(first.changed,false);
        assert.equal(first.ranges[0].start,book.lastIndexOf('If I leave'));
        assert.equal(api.getSubtitleReferenceStatus({active:true,hasText:true,hasCue:true,enabled:true,projection:first,highlighted:true}).text,'已對到文本・無需校正');
        engine.resolveWithNeighbours(following,cue,null);
        const revisited=engine.resolveWithNeighbours(cue,null,following);
        assert.equal(JSON.stringify(revisited.ranges),JSON.stringify(first.ranges));
        assert.equal(cue.text,text);assert.equal(cue.start,25);assert.equal(cue.end,30);
    });
    test('a previously unvisited preceding cue supplies a real boundary for a one-word cue immediately: ' + file, () => {
        const previous={text:'They held sapphires infused with Stormlight.'},cue={text:'Profane.'};
        const engine=resolver(previous.text+' '+cue.text+' Another thought followed. Profane, but beautiful.');
        assert.equal(engine.resolve(cue).trusted,false);
        const first=engine.resolveWithNeighbours(cue,previous,null);
        assert.equal(first.aligned,true);assert.equal(first.ranges[0].start,previous.text.length+1);
        assert.equal(first.text,'Profane.');
    });
    test('unresolved duplicate neighbours report position uncertainty and unrelated or partial cues cannot certify a match: ' + file, () => {
        const text='If I leave this house, it will be in handcuffs.';
        const next='I should have run for it while I had the chance.';
        const duplicated=resolver((text+' '+next+'\n').repeat(2));
        const unresolved=duplicated.resolveWithNeighbours({text},null,{text:next});
        assert.equal(unresolved.aligned,undefined);assert.equal(unresolved.trusted,false);
        assert.equal(api.getSubtitleReferenceStatus({active:true,hasText:true,hasCue:true,enabled:true,projection:unresolved,highlighted:true}).text,'已反白文本・多處候選，位置待確認');
        const separated=resolver(text+' Unspoken words separate this from the next sentence. '+next+'\n'+text);
        assert.equal(separated.resolveWithNeighbours({text},null,{text:next}).trusted,false,'a nearby paragraph alone cannot certify adjacency');
        const engine=resolver(text+' '+next);
        const partial=engine.resolveWithNeighbours({text:text+' Nonsensical imaginary additional words.'},null,{text:next});
        assert.equal(partial.aligned,undefined,'the complete current cue must map, including its tail');
    });
    test('next-cue evidence keeps review decisions and is isolated from unbounded lookup caches and other documents: ' + file, () => {
        const ref='The researchers carefully reviewed the evidence and counted 300 confirmed reports in their final study.';
        const next='The committee accepted their conclusions after a long discussion yesterday.';
        const raw=ref.replace('300','200'),engine=resolver(ref+' Unrelated intervening prose. '+ref+' '+next);
        const cue={text:raw,start:2,end:8},following={text:next};
        assert.equal(engine.resolve(cue).trusted,false);
        const located=engine.resolveWithNeighbours(cue,null,following);
        assert.equal(located.aligned,true);assert.equal(located.trusted,false);assert.equal(located.text,raw);
        assert.ok(located.reviewDifferences.length);
        assert.equal(engine.resolve(cue).trusted,false,'a constrained success cannot contaminate an ambiguous unbounded cache');
        assert.equal(resolver('A different document contains none of the requested material.').resolveWithNeighbours(cue,null,following).trusted,false);
    });
    test('frequent short cues resolve from the known paragraph without a rare global anchor: ' + file, () => {
        const repeated=Array.from({length:130},()=>"She hadn't wanted to remember.").join('\n');
        const engine=resolver(repeated);const cue={text:"She hadn't wanted to remember."};
        assert.equal(engine.resolve(cue).trusted,false,'global duplicate occurrences remain ambiguous');
        // Choose an isolated current paragraph so only that occurrence lies in
        // the trusted local source-line disambiguation window.
        const book=Array.from({length:130},()=>"She hadn't wanted to remember.\n"+Array.from({length:10},()=> 'Common intervening prose.').join('\n')).join('\n');
        const local=resolver(book);
        const result=local.resolve(cue,{sourceLine:1,sequential:true});
        assert.equal(result.trusted,true);assert.equal(result.aligned,true);assert.equal(result.text,cue.text);
        assert.equal(local.hasHighlight([1],cue.text),true);
        assert.equal(local.hasHighlight([2],cue.text),false);
        const partial=resolver('A short known sentence. Another unrelated text.');
        const partialCue='A short known sentence. Xyzzy flob rub invent paragraphs.';
        const projection=partial.resolve({text:partialCue});
        assert.equal(projection.trusted,false);assert.equal(partial.hasHighlight([1],partialCue),true);
        assert.equal(api.getSubtitleReferenceStatus({active:true,hasText:true,hasCue:true,enabled:true,projection,highlighted:true}).text,'已反白文本・尚未完整對齊');
    });
    test('a repeated ASR name can be corrected from nearby reference evidence: ' + file, () => {
        const ref='Iris Marle was thinking about her sister, Rosemary.';
        const raw='Iris Marl Iris Marl was thinking about her sister, Rosemary.';
        const result=resolver(ref).resolve({text:raw},{sourceLine:1});
        assert.equal(result.aligned,true);assert.equal(result.text,ref);assert.equal(result.trusted,true);
        const book=Array.from({length:130},()=>ref+'\n'+Array.from({length:10},()=> 'Common intervening prose.').join('\n')).join('\n');
        const engine=resolver(book);const cue={text:raw};
        assert.equal(engine.resolve(cue).trusted,false);
        assert.equal(engine.resolve(cue,{sourceLine:1}).text,ref);
    });
    test('located review differences provisionally prefer reference text without confirming them: ' + file, () => {
        const ref='The researchers reviewed all the evidence and counted 300 confirmed reports in the final study.';
        const raw=ref.replace('300','200');const cue={text:raw};
        const base=resolver(ref).resolve(cue);const signature=base.reviewDifferences[0].signature;
        const preferred=api.applySubtitleReferencePreference(base);
        assert.equal(preferred.text,ref);assert.equal(preferred.provisionalReviewCount,1);
        assert.equal(preferred.reviewDifferences.length,1);assert.equal(preferred.trusted,false);
        assert.match(api.getSubtitleReferenceStatus({active:true,hasText:true,hasCue:true,enabled:true,projection:preferred}).text,/待確認/);
        const originals=new Set([signature]);
        const reverted=api.applySubtitleReferencePreference(base,null,originals);
        assert.equal(reverted.text,raw);assert.equal(reverted.provisionalReviewCount,0);assert.equal(reverted.originalReviewCount,1);
        assert.match(api.getSubtitleReferenceStatus({active:true,hasText:true,hasCue:true,enabled:true,projection:reverted}).text,/依原字幕/);
        assert.equal(api.applySubtitleReferencePreference(base,null,originals).text,raw,'the original choice survives another render/replay');
        const confirmed=api.applySubtitleReferencePreference(base,new Set([signature]),originals);
        assert.equal(confirmed.text,ref);assert.equal(confirmed.reviewDifferences.length,0);assert.equal(confirmed.trusted,true);
        const key=getReferenceDecisionCueKey('reference',{...cue,start:1,end:2});
        const change=getReferenceDecisionChangeKey(base.reviewDifferences[0]);
        for(const [choice,text] of [['original',raw],['text',ref]]) {
            const saved=JSON.parse(JSON.stringify([{cue:key,change,choice}]));
            const restored=getReferenceDecisionChoices(saved,key,base);
            const presentation=api.applySubtitleReferencePreference(base,restored.accepted,restored.originals);
            assert.equal(presentation.text,text);
            assert.equal(presentation.provisionalReviewCount || 0,0);
        }
        assert.equal(cue.text,raw);assert.equal(base.text,raw,'provisional preference never mutates raw cues or cached alignment');
        const original='The delegates examined all the evidence and then carefully reviewed the final document before signing the regional treaty yesterday.';
        const missing=original.replace('carefully reviewed ','');
        assert.equal(api.applySubtitleReferencePreference(resolver(original).resolve({text:missing})).text,original);
        const boundary=resolver('Officials from Pakistan and Turkey agreed to sign the regional treaty today.').resolve({text:'from Pakistan and Turkey agreed to sign the regional treaty today.'});
        assert.equal(api.applySubtitleReferencePreference(boundary).text,'from Pakistan and Turkey agreed to sign the regional treaty today.','possible boundary words are not silently added');
    });
    test('name correction rejects ambiguous references, weak context and numbers or ordinary words: ' + file, () => {
        const raw='The ceasefire was reportedly extended across the Haerson region.';
        const first='The ceasefire was reportedly extended across the Kherson region.';
        const second='The ceasefire was reportedly extended across the Donetsk region.';
        assert.equal(resolver(first+'\n'+second).resolve({text:raw}).trusted,false);
        for(const [ref,cue] of [
            ['We visited Orléans yesterday.','We visited Orgliant yesterday.'],
            [first,'The ceasefire was reportedly extended across the 300 region.'],
            [first,'The ceasefire was reportedly extended across the no region.'],
            ['The delegates discussed regional security with ordinary wording before the evening meeting.','The delegates discussed regional security with nonsense garble before the evening meeting.']
        ]) assert.equal(resolver(ref).resolve({text:cue}).changed,false,cue);
    });
    test('comma-separated ASR repetition is removable with strong context but real emphasis is retained: ' + file, () => {
        const ref='But 19 of those seats went to Arab parties, a historic high, and most of the Jewish opposition parties have refused to include them in a coalition.';
        const raw=ref.replace('historic high,','historic high, high,');
        const result=resolver(ref).resolve({text:raw});
        assert.equal(result.text,ref);assert.equal(result.trusted,true);assert.equal(result.edits[0].kind,'duplicate');
        const emphasis='They were very, very pleased with the outcome of the final election.';
        assert.equal(resolver(emphasis.replace('very, very','very')).resolve({text:emphasis}).changed,false);
        assert.equal(resolver(ref.replace('historic high,','historic high, high,')).resolve({text:raw}).changed,false);
    });
    test('a partial cue cannot borrow the rest of a sentence or fill internal missing words: ' + file, () => {
        const text = 'The member states agreed to join the bloc and strengthen their common policy.';
        const result = resolver(text).resolve({ text: 'The member states agreed to join the block' });
        assert.equal(result.text, 'The member states agreed to join the bloc');
        assert.equal(result.ranges[0].text, 'The member states agreed to join the bloc');
        const missing = 'The member states agreed to join the bloc.';
        const reject = resolver('The member states finally agreed to join the bloc.').resolve({ text: missing });
        assert.equal(reject.text, missing); assert.equal(reject.trusted, false);
        assert.equal(resolver(text).resolve({ text: 'the block' }).changed, false);
    });
    test('adjacent duplicate tokens can be removed, while actual repetition and punctuation are preserved: ' + file, () => {
        const text = 'The member states agreed to join the bloc.';
        const result = resolver(text).resolve({ text: 'The member member states agreed to join the bloc.' });
        assert.equal(result.text, text); assert.equal(result.edits[0].kind, 'duplicate');
        const repeated = 'They were very very pleased with the final result.';
        assert.equal(resolver(repeated).resolve({ text: repeated }).text, repeated);
        assert.equal(resolver('They were very pleased with the final result.').resolve({ text: repeated }).changed, false, 'emphasis cannot be disproven by a reference omitting it');
        const separated = 'The member, member states agreed to join the bloc.';
        assert.equal(resolver(text).resolve({ text: separated }).changed, false);
        const end = resolver('All the signatories reached agreement today.').resolve({ text: 'All the signatories reached agreement today today.' });
        assert.equal(end.text, 'All the signatories reached agreement today.');
    });
    test('uncertain wording, numbers, negation and distant sequential jumps retain the raw cue: ' + file, () => {
        const ambiguous = 'The member states agreed to join the blocc tomorrow.';
        const result = resolver('The member states agreed to join the bloc tomorrow.\nThe member states agreed to join the block tomorrow.').resolve({ text: ambiguous }, { sourceLine: 1 });
        assert.equal(result.changed, false); assert.equal(result.text, ambiguous);
        for (const [ref, raw] of [
            ['The member states paid 200 million dollars yesterday.', 'The member states paid 100 million dollars yesterday.'],
            ['The member states did not sign the treaty.', 'The member states did now sign the treaty.'],
            ['The member states increased trade in the region.', 'The member states decreased trade in the region.']
        ]) assert.equal(resolver(ref).resolve({ text: raw }).changed, false);
        const distant = resolver(Array.from({ length: 90 }, (_, i) => `Unrelated section ${i}.`).join('\n') + '\nThe member states agreed to join the bloc tomorrow.');
        const cue = { text: 'The member states agreed to join the block tomorrow.' };
        assert.equal(distant.resolve(cue, { sourceLine: 1, sequential: true }).changed, false);
        const examples = api.createSubtitleReferenceResolver(api.buildKnowledgeOriginalSearchIndex('=== Examples\nThe member states agreed to join the bloc tomorrow.'));
        assert.equal(examples.resolve(cue).changed, false, 'knowledge explanations are not original-text evidence');
    });
    test('accepted multi-line cues expose only the actual mapped part of each line: ' + file, () => {
        const result = resolver('Earlier context. The signatories agreed to join the bloc\nbefore negotiations begin on Monday. Unspoken ending.').resolve({ text: 'The sinatures agreed to join the block before negotiations begin on Monday.' });
        assert.equal(result.text, 'The signatories agreed to join the bloc before negotiations begin on Monday.');
        assert.equal(result.ranges.length, 2);
        assert.equal(result.ranges[0].text, 'The signatories agreed to join the bloc');
        assert.equal(result.ranges[1].text, 'before negotiations begin on Monday');
    });
    test('precise ranges do not expand partial cues to the rest of a source sentence: ' + file, () => {
        const text = 'Now the two Gulf powers are under siege. Another sentence follows.';
        const ranges = api.findKnowledgePreciseSubtitleRanges(text, 'the two Gulf powers');
        assert.deepEqual(Array.from(ranges, range => text.slice(range.start, range.end)), ['the two Gulf powers']);
        const duplicate = 'The member states agreed to join the bloc. The member states agreed to join the bloc.';
        assert.equal(api.findKnowledgePreciseSubtitleRanges(duplicate, 'The member states agreed to join the block.').length, 0);
    });
    const compiled = await build({ stdin: { contents: source + '\nexport { MarkdownView };', loader: 'jsx', resolveDir: root }, bundle: true,
        platform: 'node', format: 'cjs', external: ['react'], write: false, logLevel: 'silent' });
    const module = { exports: {} };
    vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require, console, setTimeout, clearTimeout });
    test('the actual renderer preserves verified offsets for a repeated one-word caption in one paragraph: ' + file, () => {
        const ref='They held sapphires infused with Stormlight. Profane. Later he said Profane, but beautiful.';
        const book=resolver(ref),previous={text:'They held sapphires infused with Stormlight.'};
        book.resolve(previous,{sourceLine:1});
        const projection=book.resolveFollowing({text:'Profane.'},previous);
        const markup=renderToStaticMarkup(React.createElement(module.exports.MarkdownView,{
            content:'[原文]\n'+ref,activeKnowledgeSourceLines:[1],activeKnowledgeSubtitleText:'Profane.',activeKnowledgeLineTexts:projection.ranges
        }));
        const marks=[...markup.matchAll(/<mark[^>]*>([\s\S]*?)<\/mark>/g)].map(match=>match[1].replace(/<[^>]*>/g,''));
        assert.deepEqual(marks,['Profane']);
        assert.ok(markup.indexOf('<mark')<markup.indexOf('Later he said'),'highlight the adjacent occurrence, not the later duplicate');
    });
    test('the actual document renderer uses per-line cue portions and never backfills unspoken sentences: ' + file, () => {
        const text = '[原文]\nThe member states agreed to join the bloc and strengthen their common policy.\nBefore negotiations begin on Monday. Unspoken ending.';
        const markup = renderToStaticMarkup(React.createElement(module.exports.MarkdownView, {
            content: text, activeKnowledgeSourceLines: [1, 2], activeKnowledgeSubtitleText: 'The member states agreed to join the block before negotiations begin on Monday.',
            activeKnowledgeLineTexts: [{ sourceLine: 1, text: 'The member states agreed to join the bloc' }, { sourceLine: 2, text: 'before negotiations begin on Monday' }]
        }));
        const marked = [...markup.matchAll(/<mark[^>]*>([\s\S]*?)<\/mark>/g)].map(match => match[1].replace(/<[^>]*>/g, ''));
        assert.deepEqual(marked, ['The member states agreed to join the bloc', 'Before negotiations begin on Monday']);
        assert.ok(!marked.join(' ').includes('strengthen')); assert.ok(!marked.join(' ').includes('Unspoken'));
    });
}
