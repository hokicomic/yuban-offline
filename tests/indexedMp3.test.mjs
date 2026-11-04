import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const concat = (...parts) => Buffer.concat(parts.map(p => Buffer.from(p)));
const frame = (bitrate = 9, version = 3, mono = false) => {
    const rates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
    const rate = 44100 / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const bytes = Buffer.alloc(Math.floor((version === 3 ? 144000 : 72000) * rates[bitrate] / rate), bitrate);
    bytes.set([255, 224 | (version << 3) | 3, bitrate << 4, mono ? 192 : 0]);
    return bytes;
};
const findBox = (buffer, type) => {
    const offset = buffer.indexOf(Buffer.from(type));
    assert.ok(offset > 0, type + ' exists');
    const size = buffer.readUInt32BE(offset - 4);
    return buffer.subarray(offset + 4, offset - 4 + size);
};
for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url),'utf8');
    const code = source.slice(source.indexOf('const readMp3FrameHeader ='),source.indexOf('const probeIndexedMp3 ='));
    const { buildIndexedMp3, readMp3FrameHeader } = vm.runInNewContext(code + '\n({buildIndexedMp3,readMp3FrameHeader})', { Blob, Uint8Array, DataView, setTimeout });
    test('exact sample tables preserve VBR frames and gapless duration: ' + file, async () => {
        const info = frame(9); info.write('Xing',36); info.writeUInt32BE(15,40);
        info.writeUInt32BE(999999,44); // Deliberately unreliable legacy frame count/TOC.
        info.write('LAME3.100',156); info.set([0x24,0x03,0xc0],177); // 576 delay + 960 padding.
        const frames = [frame(4),frame(12),frame(8),frame(14),frame(9)];
        const id3 = Buffer.alloc(30); id3.write('ID3'); id3[3] = 4; id3[9] = 20;
        const fileBlob = new Blob([concat(id3,info,...frames,Buffer.from('TAG'),Buffer.alloc(125))]);
        const result = await buildIndexedMp3(fileBlob);
        assert.equal(result.frames,5);
        assert.equal(result.duration,(5*1152-1536)/44100);
        const mp4 = Buffer.from(await result.blob.arrayBuffer());
        assert.deepEqual(findBox(mp4,'mdat'),concat(...frames),'no encoding or payload modification');
        const sizes = findBox(mp4,'stsz'); assert.equal(sizes.readUInt32BE(8),5);
        frames.forEach((f,i) => assert.equal(sizes.readUInt32BE(12+i*4),f.length));
        const stts = findBox(mp4,'stts'); assert.equal(stts.readUInt32BE(8),5); assert.equal(stts.readUInt32BE(12),1152);
        const stco = findBox(mp4,'stco'); const offset = stco.readUInt32BE(8);
        assert.equal(offset,mp4.indexOf(Buffer.from('mdat'))+4);
        assert.deepEqual(mp4.subarray(offset),concat(...frames));
        const elst = findBox(mp4,'elst'); assert.equal(elst.readUInt32BE(12),1105,'include MP3 decoder priming');
        const mov=Buffer.from(await result.mov.arrayBuffer());
        assert.deepEqual(findBox(mov,'mdat'),concat(...frames));
        const entry=findBox(mov,'.mp3');assert.equal(entry.readUInt16BE(8),1);assert.equal(entry.readInt16BE(20),-2);assert.equal(entry.readUInt32BE(28),1152);
        const caf = Buffer.from(await result.caf.arrayBuffer());
        assert.equal(caf.toString('ascii',0,4),'caff');
        const pakt = caf.indexOf(Buffer.from('pakt')) + 12;
        assert.equal(Number(caf.readBigInt64BE(pakt)),5);
        assert.equal(Number(caf.readBigInt64BE(pakt+8)),5*1152-1536);
        assert.equal(caf.readUInt32BE(pakt+16),1105);
        assert.equal(caf.readUInt32BE(pakt+20),431);
        let at=pakt+24;
        for (const f of frames) { let size=0,byte; do { byte=caf[at++]; size=(size<<7)|(byte&127); } while(byte&128); assert.equal(size,f.length); }
        assert.deepEqual(caf.subarray(caf.indexOf(Buffer.from('data'))+16),concat(...frames));
    });
    test('native chunks remain bounded and every VBR sample maps to its original bytes: ' + file, async () => {
        const frames = Array.from({length: 263}, (_, i) => frame(i % 2 ? 14 : 4));
        const result = await buildIndexedMp3(new Blob(frames));
        assert.equal(result.chunkCount, 3);
        for (const blob of [result.blob, result.mov]) {
            const bytes = Buffer.from(await blob.arrayBuffer()), offsets = findBox(bytes, 'stco'), map = findBox(bytes, 'stsc');
            assert.equal(offsets.readUInt32BE(4), 3);
            assert.equal(map.readUInt32BE(4), 2);
            assert.deepEqual(Array.from({length:6}, (_, i) => map.readUInt32BE(8 + i*4)), [1,128,1,3,7,1]);
            let relative = bytes.indexOf(Buffer.from('mdat')) + 4;
            for (let chunk = 0; chunk < 3; chunk++) {
                assert.equal(offsets.readUInt32BE(8 + chunk*4), relative);
                const payload = concat(...frames.slice(chunk*128, (chunk+1)*128));
                assert.deepEqual(bytes.subarray(relative, relative+payload.length), payload);
                assert.ok(payload.length < 256*1024);
                relative += payload.length;
            }
            assert.equal(relative, bytes.length);
        }
    });
    test('nineteen-hour QuickTime duration stays within signed range with unchanged audio sample rate and exact frame timing: ' + file, async () => {
        const count = 2616659, header = {version:3,sampleRate:44100,samples:1152,channels:2};
        const sizes = Array(count).fill(417), audioStart = 351, audioEnd = audioStart + count*417;
        let slices = 0;
        const sparseFile = {size:audioEnd,slice:(a,b)=>{slices++;assert.equal(a,audioStart);assert.equal(b,audioEnd);return new Blob([]);}};
        const index = {header,sizes,audioStart,audioEnd,encoderDelay:576,endPadding:832,hasGapless:true};
        const result = await buildIndexedMp3(sparseFile, {index});
        assert.equal(slices, 3, 'reusing the portable frame index only builds native wrappers');
        assert.equal(result.duration, (count*1152-1408)/44100);
        for (const blob of [result.blob, result.mov]) {
            const bytes = Buffer.from(await blob.arrayBuffer());
            const mdhd = findBox(bytes,'mdhd'), stts = findBox(bytes,'stts'), elst = findBox(bytes,'elst');
            const scale = mdhd.readUInt32BE(12), duration = mdhd.readUInt32BE(16), packet = stts.readUInt32BE(12);
            assert.equal(scale,22050); assert.equal(packet,576); assert.ok(duration < 0x7fffffff);
            assert.equal(duration/scale, count*1152/44100);
            assert.equal(packet/scale, 1152/44100);
            assert.ok(Math.abs(elst.readUInt32BE(12)/scale - 1105/44100) <= 0.5/scale);
            assert.equal(findBox(bytes,'stco').readUInt32BE(4),Math.ceil(count/128));
        }
        const entry = findBox(Buffer.from(await result.mov.arrayBuffer()),'.mp3');
        assert.equal(entry.readUInt32BE(24),44100*65536,'codec sample rate stays unchanged');
        assert.equal(entry.readUInt32BE(28),1152,'decoded samples per packet stay unchanged');
    });
    test('MPEG-2/2.5 mono, ID3 footer and raw CBR receive real sample counts: ' + file, async () => {
        for (const version of [0,2,3]) {
            const samples = version === 3 ? 1152 : 576;
            const frames = [frame(7,version,true),frame(10,version,true),frame(8,version,true)];
            const tag=Buffer.alloc(20); tag.write('ID3');tag[3]=4;tag[5]=16; // zero-byte body plus footer
            const result=await buildIndexedMp3(new Blob([tag,...frames]));
            assert.equal(result.duration,3*samples/(44100/(version===3?1:version===2?2:4)));
            assert.equal(readMp3FrameHeader(frames[0]).channels,1);
        }
    });
    test('invalid/truncated/changing formats cannot silently discard audio: ' + file, async () => {
        for (const bytes of [Buffer.from('not audio'), concat(frame(),frame(),Buffer.from('bad bytes'),frame()), concat(frame(),frame(),frame(9,2)), concat(frame(),frame(),frame().subarray(0,100))]) {
            await assert.rejects(buildIndexedMp3(new Blob([bytes])));
        }
    });
    test('multi-megabyte files are scanned in bounded blocks without dropping a boundary frame: ' + file, async () => {
        const frames=Array.from({length:7000},(_,i)=>frame(i%2?14:4));
        const blob=new Blob(frames);const reads=[];
        const fileBlob={size:blob.size,slice:(start,end)=>{const piece=blob.slice(start,end);const read=piece.arrayBuffer.bind(piece);piece.arrayBuffer=()=>{reads.push(end-start);return read();};return piece;}};
        const result=await buildIndexedMp3(fileBlob);
        assert.equal(result.frames,frames.length);
        assert.ok(Math.max(...reads)<=2*1024*1024);
        assert.ok(reads.filter(size=>size===2*1024*1024).length>=2);
        assert.deepEqual(findBox(Buffer.from(await result.blob.arrayBuffer()),'mdat'),concat(...frames));
    });
    test('track switch cancels indexing before publishing a source: ' + file, async () => {
        let current=true;
        await assert.rejects(buildIndexedMp3(new Blob([frame(),frame(),frame()]),{isCurrent:()=>current,onProgress:()=>{current=false;}}),{name:'AbortError'});
    });
}

for (const file of ['yuban-original.jsx','語伴20260713.1-codex.js']) {
    const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const code=source.slice(source.indexOf('const prepareIndexedMp3 ='),source.indexOf('// Only reuse the light replay path'));
    test('choose Core Audio or MP4 by capability, probe failures fall back and stale work is cancelled: '+file, async()=>{
        for(const preferCaf of [true,false]) {
            let calls=[];let current=true;let rejectFirst=true;
            const c={fingerprintMp3File:async()=>null,validateMp3FrameIndex:async()=>({checkedFrames:1}),document:{createElement:()=>({canPlayType:()=>preferCaf?'maybe':''})},
                buildIndexedMp3:async()=>({blob:{type:'audio/mp4'},caf:{type:'audio/x-caf'}}),
                probeIndexedMp3:async(blob)=>{calls.push(blob.type);if(rejectFirst){rejectFirst=false;throw Error('unsupported');}}};
            const prepare=vm.runInNewContext(code+';prepareIndexedMp3',c);
            const result=await prepare({}, {isCurrent:()=>current});
            assert.deepEqual(calls,preferCaf?['audio/x-caf','audio/mp4']:['audio/mp4','audio/x-caf']);
            assert.equal(result.container,calls[1]);
            current=false;calls=[];
            await assert.rejects(prepare({}, {isCurrent:()=>current}),{name:'AbortError'});
            assert.deepEqual(calls,[]);
        }
    });
}

for(const file of ['yuban-original.jsx','語伴20260713.1-codex.js']){
    const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const buildCode=source.slice(source.indexOf('const readMp3FrameHeader ='),source.indexOf('const probeIndexedMp3 ='));
    const cacheCode=source.slice(source.indexOf('const mp3SourceFolderHandles ='),source.indexOf('const prepareIndexedMp3 ='));
    const api=vm.runInNewContext(buildCode+cacheCode+';({buildIndexedMp3,fingerprintMp3File,encodeMp3Index,decodeMp3Index,accessMp3IndexCache,saveMp3IndexBesideMedia,mp3SourceFolderHandles,findMp3IndexFile,validateMp3FrameIndex})', {Blob,Uint8Array,DataView,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout});
    test('portable index survives a copied/renamed file and bypasses full audio scanning: '+file,async()=>{
        const blob=new Blob([frame(4),frame(14),frame(9)]);
        const first=await api.buildIndexedMp3(blob);const fingerprint=await api.fingerprintMp3File(blob);
        const portable=api.encodeMp3Index(first.index,blob,fingerprint);
        const copied=new Blob([blob]);copied.name='different name.mp3';copied.lastModified=123;
        assert.equal(await api.fingerprintMp3File(copied),fingerprint);
        const index=await api.decodeMp3Index(portable,copied,fingerprint);
        let reads=0;
        const fileBlob={size:copied.size,slice:(a,b)=>{const piece=copied.slice(a,b);piece.arrayBuffer=()=>{reads++;throw Error('must not scan');};return piece;}};
        const reused=await api.buildIndexedMp3(fileBlob,{index});
        assert.equal(reused.duration,first.duration);assert.equal(reads,0);
        assert.deepEqual(Buffer.from(await reused.blob.arrayBuffer()),Buffer.from(await first.blob.arrayBuffer()));
    });
    test('changed files and damaged index tables are rejected rather than reused: '+file,async()=>{
        const blob=new Blob([frame(4),frame(14),frame(9)]);const result=await api.buildIndexedMp3(blob);const hash=await api.fingerprintMp3File(blob);
        const portable=api.encodeMp3Index(result.index,blob,hash);
        const changed=new Blob([frame(5),frame(14),frame(9)]);
        const newHash=await api.fingerprintMp3File(changed);
        assert.notEqual(newHash,hash);
        await assert.rejects(api.decodeMp3Index(portable,changed,newHash));
        const damaged=Buffer.from(await portable.arrayBuffer());damaged[damaged.length-1]^=128;
        await assert.rejects(api.decodeMp3Index(new Blob([damaged]),blob,hash));
        await assert.rejects(api.decodeMp3Index(new Blob([damaged.subarray(0,16)]),blob,hash));
    });
    test('validate a nineteen-hour index against original frame headers including the two-hour target: '+file,async()=>{
        const header={version:3,sampleRate:44100,samples:1152,channels:2};
        const count=Math.ceil(19*3600*44100/1152),packet=frame(9),sizes=Array(count).fill(packet.length);
        const size=count*packet.length;let invalid=false,reads=0;
        const audio={size,slice:(start,end)=>{assert.equal(end-start,4);assert.equal(start%packet.length,0);reads++;return new Blob([invalid?Buffer.from('BAD!'):packet.subarray(0,4)]);}};
        const index={header,sizes,audioStart:0,audioEnd:size,encoderDelay:0,endPadding:0,hasGapless:false};
        const result=await api.validateMp3FrameIndex(audio,index);
        assert.equal(result.frameCount,count);assert.ok(result.duration>=19*3600);
        assert.equal(reads,result.checkedFrames);assert.ok(reads>=16);
        const target=result.points.find(p=>p.target===7500);assert.ok(target.offset>0);assert.ok(Math.abs(target.time-7500)<1152/44100);
        invalid=true;await assert.rejects(api.validateMp3FrameIndex(audio,index),/原音框不符/);
    });
    test('cache unavailability never blocks playback; folder writes require existing grant: '+file,async()=>{
        assert.equal(await api.accessMp3IndexCache('test'),null);
        assert.equal(await api.accessMp3IndexCache('test',new Blob(['index'])),false);
        const media={name:'book.mp3'};let writes=0,requested=0,rootWrites=0;
        const folder={queryPermission:async()=> 'prompt',requestPermission:async()=>{requested++;return 'granted';},getFileHandle:async()=>{writes++;return {createWritable:async()=>({write:async()=>{},close:async()=>{}})};}};
        assert.equal(await api.saveMp3IndexBesideMedia(media,new Blob(['index']),folder,()=>true),false);
        assert.equal(writes,0);assert.equal(requested,0,'background persistence cannot show an unexpected permission prompt');
        folder.queryPermission=async()=> 'granted';api.mp3SourceFolderHandles.set(media,folder);
        assert.equal(await api.saveMp3IndexBesideMedia(media,new Blob(['index']),{getFileHandle:()=>rootWrites++},()=>true),true);
        assert.equal(writes,1);assert.equal(rootWrites,0,'nested media writes beside itself, not to parent folder');
        assert.equal(await api.saveMp3IndexBesideMedia(media,new Blob(['index']),folder,()=>false),false);
        const sidecar={name:'book.mp3.yuban-index'},other={name:'book.mp3.yuban-index'};
        api.mp3SourceFolderHandles.set(sidecar,folder);api.mp3SourceFolderHandles.set(other,{});
        assert.equal(api.findMp3IndexFile(media,[other,sidecar]),sidecar);
    });
}
