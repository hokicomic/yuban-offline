import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const start = source.indexOf('const KNOWN_KNOWLEDGE_TEXT_RE');
    const end = source.indexOf('const readManualDocumentText', start);
    const { decode, suspicious, read } = vm.runInNewContext(source.slice(start, end) +
        '\n({ decode: decodeArrayBufferBestEffort, suspicious: isSuspiciousBinaryKnowledgeText, read: readTextFileRobust })',
        { TextDecoder, Uint8Array, ArrayBuffer });
    test('UTF-8 documents retain English, punctuation and bookmark words: ' + file, async () => {
        const text = 'Copyright © 2019\nI’ve bookmarked a bookmarkable site.\nbookmark file:///reference\n中文與日本語。';
        const bytes = Buffer.from(text);
        assert.equal(decode(bytes), text);
        assert.equal(await read({ arrayBuffer: async () => bytes }), text);
        assert.equal(suspicious('I’ve bookmarked these bookmarkable sites.'), false);
        assert.equal(suspicious('bplist00 NSURLBookmark bookmarkdata'), true);
        await assert.rejects(read({ name: 'shortcut.txt', arrayBuffer: async () => Buffer.from('bplist00 NSURLBookmark') }, { purpose: 'knowledge' }), /非文字資料/);
    });
    test('BOMs, UTF-16 fallback and legacy Big5 remain supported: ' + file, () => {
        const text = 'Hello English\n中文';
        assert.equal(decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])), text);
        const le = Buffer.from(text, 'utf16le');
        const be = Buffer.from(le).swap16();
        assert.equal(decode(Buffer.concat([Buffer.from([0xff, 0xfe]), le])), text);
        assert.equal(decode(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), text);
        assert.equal(decode(le), text);
        assert.equal(decode(be), text);
        assert.equal(decode(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])), '中文');
        assert.equal(decode(new ArrayBuffer(0)), '');
    });
}
