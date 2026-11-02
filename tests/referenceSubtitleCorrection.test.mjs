import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../', import.meta.url));
for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const marker = source.split('\n').find(line => line.startsWith('const KNOWLEDGE_ORIGINAL_MARKER_RE ='));
    const sentenceHelpers = source.slice(source.indexOf('const isAbbreviation ='), source.indexOf('const extractJsonObjectFromText ='));
    const helpers = source.slice(source.indexOf('const normalizeKnowledgeAlignmentText ='), source.indexOf('const MarkdownView ='));
    const api = vm.runInNewContext(marker + '\n' + sentenceHelpers + helpers + '\n({createSubtitleReferenceResolver, buildKnowledgeOriginalSearchIndex, findKnowledgePreciseSubtitleRanges, applySubtitleReferenceBoundaryAcceptance})');
    const resolver = text => api.createSubtitleReferenceResolver(api.buildKnowledgeOriginalSearchIndex('[原文]\n' + text));
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
