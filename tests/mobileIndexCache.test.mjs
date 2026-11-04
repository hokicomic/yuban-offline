import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for(const file of ['yuban-original.jsx','語伴20260713.1-codex.js']){
    const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const code=source.slice(source.indexOf('const accessMp3IndexCache ='),source.indexOf('const saveMp3IndexBesideMedia ='));
    test('cache persists owned bytes that survive a mobile Blob backing-object loss: '+file,async()=>{
        const records=new Map();let closes=0;
        const indexedDB={open(){const request={};queueMicrotask(()=>{request.result={close(){closes++;},transaction(){const tx={};tx.objectStore=()=>({
            put(record){records.set(record.key,structuredClone(record));},delete(key){records.delete(key);},
            get(key){const read={};queueMicrotask(()=>{read.result=records.get(key);read.onsuccess();});return read;},
            getAll(){const read={};queueMicrotask(()=>{read.result=[...records.values()];read.onsuccess();queueMicrotask(()=>tx.oncomplete?.());});return read;}
        });return tx;}};request.onsuccess();});return request;}};
        const cache=vm.runInNewContext(code+';accessMp3IndexCache',{indexedDB,Blob,setTimeout,clearTimeout});
        let backingAvailable=true;const original={arrayBuffer:async()=>{if(!backingAvailable)throw Object.assign(new Error('The object can not be found here.'),{name:'NotFoundError'});return Uint8Array.of(89,85,66,65,78).buffer;}};
        assert.equal(await cache('book',original),true);
        assert.equal(records.get('book').blob,undefined);assert.equal(records.get('book').bytes.byteLength,5);
        backingAvailable=false;
        const restored=await cache('book');
        assert.deepEqual(Array.from(new Uint8Array(await restored.arrayBuffer())),[89,85,66,65,78]);
        assert.equal(closes,2);
        assert.equal(await cache('unreadable',original),false,'bad optional cache cannot stop playback');
    });
}
