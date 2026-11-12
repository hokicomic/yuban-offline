import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewDocument,validateReviewDocument,mergeReviewDocuments,recordReviewAttempt,findReviewCue,openReviewSession} from '../subtitleReview.js';
const base=()=>createReviewDocument('book.lrc','[00:01]Hello world.','book.mp3');
const word={key:'1:0',text:'ghosted',typed:'ghost',accepted:['ghosted','ghost dude'],reason:'revealed-after-attempt'};
const attempt=(id='one',words=[word])=>({attemptId:id,start:1,end:4,originalText:'Hello ghost dude.',displayText:'Hello ghosted.',words,completedWithoutHints:false});
const memory=()=>{const map=new Map();return {getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};};
function disk({text=null,permission='granted',fail=false}={}){
    const writes=[],events=[];let content=text;
    return {writes,events,queryPermission:async()=>permission,get content(){return content;},
        async getFileHandle(name,{create=false}={}){
            events.push([name,create]);if(content===null&&!create)throw Object.assign(new Error('missing'),{name:'NotFoundError'});
            return {getFile:async()=>({text:async()=>content}),createWritable:async()=>({
                async write(value){if(fail)throw new Error('disk full');this.value=value;},
                async close(){content=this.value;writes.push(content);},async abort(){events.push('abort');}})};
        }};
}
test('stable identity normalizes line endings, but changed subtitles or another media are rejected',()=>{
    const a=createReviewDocument('a.lrc','one\r\ntwo','a.mp3'),b=createReviewDocument('a.lrc','one\ntwo','a.mp3');
    assert.equal(a.source.subtitleHash,b.source.subtitleHash);
    for(const other of [createReviewDocument('a.lrc','different','a.mp3'),createReviewDocument('a.lrc','one\ntwo','b.mp3'),base()])
        assert.throws(()=>validateReviewDocument(other,a),/不符/);
    assert.throws(()=>validateReviewDocument({...base(),entries:[{}]},base()),/無效/);
});
test('recording deduplicates an attempt, accumulates different attempts and preserves both answers',()=>{
    const a=recordReviewAttempt(base(),attempt(),'2026-11-12T00:00:00Z');
    const b=recordReviewAttempt(a,attempt(),'2026-11-12T00:00:01Z');
    assert.equal(b.entries.length,1);assert.equal(b.entries[0].attempts.length,1);
    const c=recordReviewAttempt(b,attempt('two'),'2026-11-12T00:00:02Z');
    assert.equal(c.entries[0].attempts.length,2);assert.deepEqual(c.entries[0].words[0].accepted,['ghosted','ghost dude']);
    const mastered=recordReviewAttempt(c,{...attempt('three',[]),completedWithoutHints:true},'2026-11-12T00:00:03Z');
    assert.equal(mastered.entries[0].mastered,true);assert.equal(mastered.entries[0].words.length,1);
    assert.deepEqual(recordReviewAttempt(base(),attempt('empty',[])),base());
});
test('a merged display cue can still locate its original time, but never a distant sentence',()=>{
    const e=recordReviewAttempt(base(),attempt()).entries[0];
    assert.equal(findReviewCue([{start:0,end:5,text:'Merged words.'}],e),0);
    assert.equal(findReviewCue([{start:20,end:25,text:e.originalText}],e),-1);
});
test('mobile session survives reopening through cache and supports import without duplicate attempts',async()=>{
    const storage=memory(),s=openReviewSession({document:base(),storage});await s.ready;await s.record(attempt());
    assert.match(s.status,/暫存/);assert.equal(s.filename,'book.lrc.review.json');
    const reopened=openReviewSession({document:base(),storage});await reopened.ready;
    assert.equal(reopened.document.entries.length,1);await reopened.import(s.document);assert.equal(reopened.document.entries[0].attempts.length,1);
    await reopened.mark(reopened.document.entries[0].id,true);assert.equal(reopened.document.entries[0].mastered,true);
    await assert.rejects(reopened.import(createReviewDocument('wrong.lrc','wrong','book.mp3')),/不符/);
});
test('folder writes replace the same named sidecar and merge records already on disk',async()=>{
    const previous=recordReviewAttempt(base(),{...attempt('old'),start:8,end:10});
    const folder=disk({text:JSON.stringify(previous)}),s=openReviewSession({document:base(),folder,storage:memory()});
    await s.ready;await Promise.all([s.record(attempt('new')),s.record(attempt('newer'))]);
    assert.match(s.status,/已保存同目錄/);const stored=JSON.parse(folder.content);
    assert.equal(stored.entries.length,2);assert.equal(stored.entries[0].attempts.length,2);
    assert.ok(folder.events.filter(Array.isArray).every(([name])=>name==='book.lrc.review.json'));
});
test('read-only folders keep browser records without creating files or requesting permission in background',async()=>{
    const folder=disk({permission:'prompt'}),s=openReviewSession({document:base(),folder,storage:memory()});
    await s.ready;await s.record(attempt());assert.match(s.status,/僅可讀/);assert.equal(folder.writes.length,0);
    assert.ok(!folder.events.some(e=>Array.isArray(e)&&e[1]));
});
test('malformed or mismatched sidecars are protected from replacement, including after import',async()=>{
    for(const text of ['broken json',JSON.stringify(createReviewDocument('other.lrc','other','other.mp3'))]){
        const folder=disk({text}),s=openReviewSession({document:base(),folder,storage:memory()});await s.ready;
        assert.equal(s.blocked,true);await s.record(attempt());await s.import(recordReviewAttempt(base(),attempt('import')));
        assert.equal(folder.content,text);assert.equal(folder.writes.length,0);
    }
});
test('failed writes retain recoverable cached records and do not report a successful save',async()=>{
    const folder=disk({fail:true}),storage=memory(),s=openReviewSession({document:base(),folder,storage});
    await s.ready;await s.record(attempt());assert.match(s.status,/寫入失敗/);assert.equal(folder.writes.length,0);
    const copy=openReviewSession({document:base(),storage});await copy.ready;assert.equal(copy.document.entries.length,1);
});
test('separate file sessions do not mix records when delayed saves finish after a track switch',async()=>{
    const fa=disk(),fb=disk(),a=openReviewSession({document:base(),folder:fa,storage:memory()});
    const other=createReviewDocument('second.lrc','second','second.mp3'),b=openReviewSession({document:other,folder:fb,storage:memory()});
    await Promise.all([a.ready,b.ready]);await Promise.all([a.record(attempt('a')),b.record(attempt('b'))]);
    assert.equal(JSON.parse(fa.content).source.subtitleName,'book.lrc');assert.equal(JSON.parse(fb.content).source.subtitleName,'second.lrc');
    assert.equal(JSON.parse(fa.content).entries[0].attempts[0].id,'a');
});
test('storage quota errors are visible instead of claiming browser persistence',async()=>{
    const storage={getItem(){return null;},setItem(){throw new Error('quota');}},s=openReviewSession({document:base(),storage});
    await s.ready;await s.record(attempt());assert.match(s.status,/暫存失敗/);assert.equal(s.document.entries.length,1);
});
test('repeated cleanup flushes cannot undo mastery, but a new failed attempt reopens the item',async()=>{
    const folder=disk(),s=openReviewSession({document:base(),folder,storage:memory()});await s.ready;
    await s.record(attempt());await s.mark(s.document.entries[0].id,true);
    await s.record(attempt());assert.equal(s.document.entries[0].mastered,true);
    assert.equal(JSON.parse(folder.content).entries[0].mastered,true);
    await s.record(attempt('new-failure'));assert.equal(s.document.entries[0].mastered,false);
});
test('file selected through the mobile folder reader merges with browser progress automatically',async()=>{
    const previous=recordReviewAttempt(base(),attempt('portable'));
    const s=openReviewSession({document:base(),sidecar:{text:async()=>JSON.stringify(previous)},storage:memory()});
    await s.ready;assert.equal(s.document.entries.length,1);assert.equal(s.document.entries[0].attempts[0].id,'portable');
});
test('multi-device imports combine unique attempts and words regardless of file selection order',async()=>{
    const pc=recordReviewAttempt(base(),attempt('pc'),'2026-11-12T01:00:00Z');
    const phone=recordReviewAttempt(pc,attempt('iphone',[{...word,key:'2:0',wordIndex:2,text:'again',accepted:['again']}]),'2026-11-12T02:00:00Z');
    const tablet=recordReviewAttempt(pc,{...attempt('ipad',[]),completedWithoutHints:true},'2026-11-12T03:00:00Z');
    const outputs=[];
    for(const values of [[pc,phone,tablet],[tablet,pc,phone],[phone,tablet,pc]]){
        const s=openReviewSession({document:base(),storage:memory()});await s.ready;await s.importMany(values);
        assert.equal(s.document.entries[0].attempts.length,3);
        assert.equal(s.document.entries[0].words.length,2);
        assert.equal(s.document.entries[0].mastered,true,'most recent device status wins');
        await s.importMany(values);assert.equal(s.document.entries[0].attempts.length,3,'reimport cannot double count');
        outputs.push(s.document);
    }
    assert.deepEqual(outputs[0],outputs[1]);assert.deepEqual(outputs[1],outputs[2]);
});
test('an older export cannot replace the newer snapshot of the same attempt',()=>{
    const older=recordReviewAttempt(base(),attempt('same'),'2026-11-12T01:00:00Z');
    const newer=recordReviewAttempt(older,attempt('same',[{...word,typed:'ghost du'}]),'2026-11-12T02:00:00Z');
    assert.deepEqual(mergeReviewDocuments(older,newer),mergeReviewDocuments(newer,older));
    assert.equal(mergeReviewDocuments(newer,older).entries[0].attempts[0].words[0].typed,'ghost du');
});
test('a mismatched file in a batch leaves current records and the original disk untouched',async()=>{
    const folder=disk(),s=openReviewSession({document:base(),folder,storage:memory()});await s.ready;await s.record(attempt('original'));
    const before=JSON.stringify(s.document),diskBefore=folder.content;
    await assert.rejects(s.importMany([recordReviewAttempt(base(),attempt('new')),createReviewDocument('different.lrc','other','other.mp3')]),/不符/);
    assert.equal(JSON.stringify(s.document),before);assert.equal(folder.content,diskBefore);
});
function cleanupFolder(){
    const files=new Map(),removed=[];
    return {files,removed,queryPermission:async()=>'granted',
        async getFileHandle(name,{create=false}={}){
            if(!files.has(name)&&!create)throw Object.assign(new Error('missing'),{name:'NotFoundError'});
            return {getFile:async()=>({text:async()=>files.get(name)}),createWritable:async()=>({
                async write(text){this.text=text;},async close(){files.set(name,this.text);},async abort(){}})};
        },async removeEntry(name){removed.push(name);files.delete(name);}};
}
test('cleanup removes verified imported copies only after merged disk readback, keeping the canonical file',async()=>{
    const folder=cleanupFolder(),doc=recordReviewAttempt(base(),attempt('phone')),text=JSON.stringify(doc);
    folder.files.set('phone.json',text);folder.files.set('unrelated.json','{}');
    const session=openReviewSession({document:base(),folder,storage:memory()});await session.ready;await session.import(doc);
    const plan=await session.planCleanup([{name:'phone.json',text:async()=>text},{name:session.filename,text:async()=>text}]);
    assert.equal(plan.items.length,1);const result=await session.cleanup(plan);
    assert.equal(result.deleted,1);assert.deepEqual(folder.removed,['phone.json']);
    assert.ok(folder.files.has(session.filename));assert.ok(folder.files.has('unrelated.json'));
});
test('cleanup skips files outside the selected directory, modified copies, and records not yet merged',async()=>{
    const folder=cleanupFolder(),doc=recordReviewAttempt(base(),attempt('phone')),text=JSON.stringify(doc);
    folder.files.set('changed.json','changed externally');
    const session=openReviewSession({document:base(),folder,storage:memory()});await session.ready;await session.import(doc);
    const extra=recordReviewAttempt(base(),attempt('new'));
    const plan=await session.planCleanup([{name:'outside.json',text:async()=>text},{name:'changed.json',text:async()=>text},
        {name:'unmerged.json',text:async()=>JSON.stringify(extra)}]);
    assert.equal(plan.items.length,0);assert.equal(plan.skipped.length,3);assert.equal(folder.removed.length,0);
});
test('cleanup rechecks both the canonical and source contents after confirmation',async()=>{
    for(const changed of ['phone.json','book.lrc.review.json']){
        const folder=cleanupFolder(),doc=recordReviewAttempt(base(),attempt('phone')),text=JSON.stringify(doc);
        folder.files.set('phone.json',text);
        const session=openReviewSession({document:base(),folder,storage:memory()});await session.ready;await session.import(doc);
        const plan=await session.planCleanup([{name:'phone.json',text:async()=>text}]);folder.files.set(changed,'changed after confirmation');
        assert.equal((await session.cleanup(plan)).deleted,0);assert.equal(folder.removed.length,0);
    }
});
test('cleanup is unavailable without folder access or after an unsuccessful save',async()=>{
    const mobile=openReviewSession({document:base(),storage:memory()});await mobile.ready;
    await assert.rejects(mobile.planCleanup([]),/手動清理/);
    const folder=cleanupFolder();folder.queryPermission=async()=>'denied';
    const readOnly=openReviewSession({document:base(),folder,storage:memory()});await readOnly.ready;
    await assert.rejects(readOnly.planCleanup([]),/尚未成功寫入/);assert.equal(folder.removed.length,0);
});
