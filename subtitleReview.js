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
        const latest=incoming.updatedAt>=old.updatedAt?incoming:old;
        const attempts=[...new Map([...old.attempts,...incoming.attempts].map(x=>[x.id,x])).values()].sort((x,y)=>x.at.localeCompare(y.at));
        const words=[...new Map([...old.words,...incoming.words].map(x=>[x.key,x])).values()];
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
                cache();report('已保存同目錄 JSON');
            }catch(error){report('JSON 寫入失敗（保留暫存）：'+error.message);}
        };
        writeQueue=writeQueue.then(work,work);return writeQueue;
    };
    session.record=attempt=>{session.document=recordReviewAttempt(session.document,attempt);notify(session);return session.save();};
    session.import=async value=>{
        await session.ready;
        session.document=mergeReviewDocuments(session.document,validateReviewDocument(value,initial));notify(session);
        // A malformed existing disk file remains protected even after import.
        await session.save();
    };
    session.mark=(id,mastered)=>{
        session.document={...session.document,entries:session.document.entries.map(e=>e.id===id?{...e,mastered,updatedAt:nextReviewTime(session.document)}:e)};
        notify(session);return session.save();
    };
    return session;
}
