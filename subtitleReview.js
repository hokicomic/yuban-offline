// Portable local-file review records. Playback and source captions stay immutable.
export const REVIEW_SCHEMA = 1;
export function reviewHash(value) {
    let a=2166136261,b=5381;
    for(const char of String(value)){const n=char.codePointAt(0);a=Math.imul(a^n,16777619);b=Math.imul(b,33)^n;}
    return `${(a>>>0).toString(16)}-${(b>>>0).toString(16)}-${String(value).length}`;
}
export function createReviewDocument(subtitleName,content,mediaName='') {
    return {schemaVersion:REVIEW_SCHEMA,source:{subtitleName,subtitleHash:reviewHash(String(content).replace(/\r\n?/g,'\n')),mediaName},entries:[]};
}
export function validateReviewDocument(value,expected) {
    if(!value || value.schemaVersion!==REVIEW_SCHEMA || !value.source || !Array.isArray(value.entries) || value.entries.length>10000)
        throw new Error('錯題 JSON 格式或版本不符');
    if(value.source.subtitleName!==expected.source.subtitleName || value.source.subtitleHash!==expected.source.subtitleHash || value.source.mediaName!==expected.source.mediaName)
        throw new Error('錯題紀錄與目前影音／字幕不符，未匯入或覆寫');
    const validWords=words=>Array.isArray(words)&&words.every(w=>w&&typeof w.key==='string'&&typeof w.text==='string'&&typeof w.typed==='string'&&
        ['unfinished','revealed-empty','revealed-after-attempt'].includes(w.reason)&&Array.isArray(w.accepted)&&w.accepted.every(x=>typeof x==='string'));
    for(const e of value.entries){
        if(!e || typeof e.id!=='string' || !Number.isFinite(e.start)||e.start<0||!Number.isFinite(e.end)||e.end<e.start||
            typeof e.originalText!=='string'||typeof e.displayText!=='string'||typeof e.updatedAt!=='string'||!Number.isFinite(Date.parse(e.updatedAt))||typeof e.mastered!=='boolean'||!validWords(e.words)||
            !Array.isArray(e.attempts)||e.attempts.length>10000||!e.attempts.every(a=>a&&typeof a.id==='string'&&typeof a.at==='string'&&Number.isFinite(Date.parse(a.at))&&validWords(a.words)))
            throw new Error('錯題 JSON 內含無效紀錄，未覆寫');
    }
    return value;
}
export function mergeReviewDocuments(a,b) {
    validateReviewDocument(b,a);
    const entries=new Map(a.entries.map(e=>[e.id,e]));
    for(const incoming of b.entries){
        const old=entries.get(incoming.id);
        if(!old){entries.set(incoming.id,incoming);continue;}
        // Device exports may contain older snapshots of the same attempt.
        // Resolve by event time, independently of file selection order.
        const latest=incoming.updatedAt>old.updatedAt?incoming:incoming.updatedAt<old.updatedAt?old:
            incoming.mastered!==old.mastered?(incoming.mastered?old:incoming):JSON.stringify(incoming)>JSON.stringify(old)?incoming:old;
        const byAttempt=new Map();
        for(const attempt of [...old.attempts,...incoming.attempts]){
            const previous=byAttempt.get(attempt.id);
            if(!previous || attempt.at>previous.at || (attempt.at===previous.at&&JSON.stringify(attempt)>JSON.stringify(previous)))byAttempt.set(attempt.id,attempt);
        }
        const attempts=[...byAttempt.values()].sort((x,y)=>x.at.localeCompare(y.at)||x.id.localeCompare(y.id));
        const earlier=latest===incoming?old:incoming;
        const words=[...new Map([...earlier.words,...latest.words].map(x=>[x.key,x])).values()].sort((x,y)=>x.key.localeCompare(y.key));
        entries.set(incoming.id,{...latest,attempts,words});
    }
    return {...a,entries:[...entries.values()].sort((x,y)=>x.start-y.start||x.id.localeCompare(y.id))};
}
const nextReviewTime=doc=>new Date(Math.max(Date.now(),...doc.entries.map(e=>Date.parse(e.updatedAt)+1))).toISOString();
export function recordReviewAttempt(doc,attempt,now=nextReviewTime(doc)) {
    const start=Number(attempt.start),end=Number(attempt.end);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start)return doc;
    const id=reviewHash(JSON.stringify([start,end,attempt.originalText]));
    const old=doc.entries.find(e=>e.id===id);
    const priorAttempt=old?.attempts.find(a=>a.id===attempt.attemptId);
    // Repeated pagehide/cleanup flushes must not undo an explicit mastery mark.
    if(priorAttempt && old.displayText===attempt.displayText && JSON.stringify(priorAttempt.words)===JSON.stringify(attempt.words))return doc;
    if(!attempt.words.length&&!old)return doc;
    if(!attempt.words.length&&!attempt.completedWithoutHints)return doc;
    const entry={id,start,end,originalText:attempt.originalText,displayText:attempt.displayText,
        words:attempt.words,attempts:[{id:attempt.attemptId,at:now,words:attempt.words}],
        mastered:Boolean(attempt.completedWithoutHints),updatedAt:now};
    return mergeReviewDocuments(doc,{...doc,entries:[entry]});
}
export function findReviewCue(subtitles,entry) {
    // Smart-merge settings can change: match actual original wording first,
    // otherwise use a containing time interval. Never substitute a distant cue.
    const exact=subtitles.findIndex(s=>s.text===entry.originalText&&Math.abs(s.start-entry.start)<.05);
    if(exact>=0)return exact;
    return subtitles.findIndex(s=>s.start<=entry.start+.05&&s.end>entry.start);
}
export function getReviewPlaybackIndices(subtitles,document) {
    return [...new Set((document?.entries || []).filter(entry=>!entry.mastered).map(entry=>findReviewCue(subtitles,entry)).filter(index=>index>=0))].sort((a,b)=>a-b);
}
export function stepReviewIndex(indices,current,direction=1) {
    if(!indices.length)return -1;
    const position=indices.indexOf(current);
    if(position>=0)return indices[(position+direction+indices.length)%indices.length];
    return direction<0?[...indices].reverse().find(index=>index<current)??indices.at(-1):indices.find(index=>index>current)??indices[0];
}
// Worker and native EOF share this gate; filtered continuous playback must
// never fall through to the ordinary adjacent-subtitle/playlist logic.
export function tickReviewPlayback(state,ended=false) {
    if(!state.enabled || state.echo)return false;
    const {player,indices,currentIndex}=state;
    if(!player)return true;
    if(!indices.length){state.stop();return true;}
    if(player.seeking || state.busy())return true;
    if(!state.playing&&!ended)return true;
    state.onTime(player.currentTime);
    if(state.pending!=null){
        if(currentIndex!==state.pending)return true;
        const range=state.range(currentIndex);
        if(player.currentTime>=range.end && !ended)return true;
        state.pending=null;
    }
    let target=-1;
    if(!indices.includes(currentIndex))target=stepReviewIndex(indices,currentIndex);
    else {
        const range=state.range(currentIndex);
        if(ended || player.currentTime>=range.end-.02)
            target=state.mode==='sentence'&&state.loop==='single'?currentIndex:stepReviewIndex(indices,currentIndex);
        else if(player.currentTime<range.start-.1)target=currentIndex;
    }
    if(target>=0){state.pending=target;state.jump(target);}
    return true;
}
let writeQueue=Promise.resolve();
export function openReviewSession({document:initial,folder=null,sidecar=null,storage=null,notify=()=>{}}) {
    const session={document:initial,filename:initial.source.subtitleName+'.review.json',folder,blocked:false,status:'載入錯題紀錄中'};
    const key='yuban-review-v1:'+JSON.stringify(initial.source);
    const report=message=>{session.status=message;notify(session);};
    const cache=()=>{try{if(!storage)throw new Error();storage.setItem(key,JSON.stringify(session.document));return true;}catch(_){return false;}};
    try{const saved=storage?.getItem(key);if(saved)session.document=mergeReviewDocuments(initial,validateReviewDocument(JSON.parse(saved),initial));}catch(_){report('本機暫存無法讀取；請匯入備份');}
    const readDisk=async()=>JSON.parse(await (await (await folder.getFileHandle(session.filename)).getFile()).text());
    session.ready=(async()=>{
        try {
            if(folder)session.document=mergeReviewDocuments(session.document,validateReviewDocument(await readDisk(),initial));
            else if(sidecar)session.document=mergeReviewDocuments(session.document,validateReviewDocument(JSON.parse(await sidecar.text()),initial));
        } catch(error){if(error.name!=='NotFoundError'){session.blocked=true;report('JSON 未讀入，為保護原檔已停止覆寫：'+error.message);return;}}
        const cached=cache();
        let writable=false;
        try{writable=folder && (typeof folder.queryPermission!=='function' || await folder.queryPermission({mode:'readwrite'})==='granted');}catch(_){}
        report(writable?'資料夾已授權讀寫；新增錯題將自動保存':cached?'已暫存此瀏覽器；可匯出 JSON':'僅本次記憶體；請匯出備份');
    })();
    session.save=()=>{
        const cached=cache();
        if(!folder){report(cached?'已暫存此瀏覽器；可匯出 JSON':'暫存失敗，僅本次記憶體；請匯出');return Promise.resolve();}
        const work=async()=>{
            await session.ready;
            if(session.blocked)return;
            try{
                if(typeof folder.queryPermission==='function'&&await folder.queryPermission({mode:'readwrite'})!=='granted'){
                    report(cached?'已暫存；資料夾僅可讀，請重新授權後按儲存':'寫入未授權且暫存失敗，請匯出');return;
                }
                try{session.document=mergeReviewDocuments(session.document,validateReviewDocument(await readDisk(),initial));}
                catch(error){if(error.name!=='NotFoundError'){session.blocked=true;throw error;}}
                const file=await folder.getFileHandle(session.filename,{create:true});
                const writable=await file.createWritable();
                try{await writable.write(JSON.stringify(session.document,null,2));await writable.close();}
                catch(error){try{await writable.abort();}catch(_){}throw error;}
                cache();report('已保存同目錄 JSON');return true;
            }catch(error){report('JSON 寫入失敗（保留暫存）：'+error.message);}
        };
        writeQueue=writeQueue.then(work,work);return writeQueue;
    };
    session.record=attempt=>{session.document=recordReviewAttempt(session.document,attempt);notify(session);return session.save();};
    session.importMany=async values=>{
        await session.ready;
        // Validate the whole selection before changing memory or disk.
        const documents=values.map(value=>validateReviewDocument(value,initial));
        session.document=documents.reduce((doc,value)=>mergeReviewDocuments(doc,value),session.document);notify(session);
        // A malformed existing disk file remains protected even after import.
        await session.save();
    };
    session.import=value=>session.importMany([value]);
    session.planCleanup=async files=>{
        if(!folder?.removeEntry)throw new Error('目前沒有目錄刪除權限，請在檔案管理器手動清理');
        if(await session.save()!==true)throw new Error('合併版尚未成功寫入，不能刪除舊檔');
        const canonical=await (await (await folder.getFileHandle(session.filename)).getFile()).text();
        const saved=validateReviewDocument(JSON.parse(canonical),initial),items=[],skipped=[];
        for(const file of files){
            if(file.name.toLowerCase()===session.filename.toLowerCase())continue;
            if(!/\.json$/i.test(file.name)||/[\\/]/u.test(file.name)){skipped.push(file.name);continue;}
            try{
                const text=await file.text(),value=validateReviewDocument(JSON.parse(text.replace(/^\uFEFF/u,'')),initial);
                if(JSON.stringify(mergeReviewDocuments(saved,value))!==JSON.stringify(saved))throw new Error('尚未完整合併');
                const actual=await (await (await folder.getFileHandle(file.name)).getFile()).text();
                if(actual!==text)throw new Error('內容已變更或不在本目錄');
                if(!items.some(item=>item.name===file.name))items.push({name:file.name,text});
            }catch(_){skipped.push(file.name);}
        }
        return {canonical,items,skipped};
    };
    session.cleanup=plan=>{
        const work=async()=>{
            let deleted=0;const skipped=[...plan.skipped];
            for(const item of plan.items){
                try{
                    if(item.name.toLowerCase()===session.filename.toLowerCase()||/[\\/]/u.test(item.name)||!/\.json$/i.test(item.name))throw new Error('保留');
                    if(typeof folder.queryPermission==='function'&&await folder.queryPermission({mode:'readwrite'})!=='granted')throw new Error('權限失效');
                    const canonical=await (await (await folder.getFileHandle(session.filename)).getFile()).text();
                    if(canonical!==plan.canonical)throw new Error('合併版已變更，請重新清理');
                    const actual=await (await (await folder.getFileHandle(item.name)).getFile()).text();
                    if(actual!==item.text)throw new Error('舊檔已變更');
                    await folder.removeEntry(item.name);deleted++;
                }catch(_){skipped.push(item.name);}
            }
            report(`已清理 ${deleted} 份舊 JSON；保留正式紀錄${skipped.length?`，${skipped.length} 份未刪除`:''}`);
            return {deleted,skipped};
        };
        const result=writeQueue.then(work,work);writeQueue=result.catch(()=>{});return result;
    };
    session.mark=(id,mastered)=>{
        session.document={...session.document,entries:session.document.entries.map(e=>e.id===id?{...e,mastered,updatedAt:nextReviewTime(session.document)}:e)};
        notify(session);return session.save();
    };
    return session;
}
