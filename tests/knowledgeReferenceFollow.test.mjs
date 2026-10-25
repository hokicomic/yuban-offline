import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sourceFiles = ['yuban-original.jsx', '語伴20260713.1-codex.js'];
const vocabulary = [
    'orchard harvest apples baskets autumn farmer countryside',
    'volcano magma crater molten mountain eruption hillside',
    'violin orchestra concert strings conductor melody audience',
    'satellite orbit galaxy telescope astronaut distant planets',
    'bakery dough bread oven flour kneading breakfast',
    'submarine ocean coral divers whales underwater expedition',
    'library manuscripts librarian archives novels borrowed shelves',
    'hospital surgeon nurse patients medicine recovery emergency',
    'railway locomotive carriage station tickets platform departure',
    'desert camel dunes oasis caravan scorching travellers',
    'laboratory chemist molecules experiment beakers reaction analysis',
    'football goalkeeper stadium referee penalty striker championship',
    'rainforest parrots monkeys canopy jaguar humid wildlife',
    'glacier frozen arctic penguins icebergs polar expedition'
];
const makeFixture = api => {
    const subtitles = [];
    const files = [];
    let time = 0;
    vocabulary.forEach((words, part) => {
        const lines = [0, 1, 2, 3].map(i => `${words} ${['carefully examined yesterday', 'suddenly appeared beside them', 'remained remarkably interesting afterwards', 'eventually disappeared that evening'][i]}.`);
        const rawTxt = '[原文]\n' + lines.join('\n') + '\n@K_HEADER@\n@HEAD@ not spoken';
        const file = { name: `Book (${part + 1} of 14)知識點.txt`, size: rawTxt.length, lastModified: 1, rawTxt };
        files.push(file);
        lines.forEach(text => {
            const start = time;
            // Part 1 occupies MOST audio time. Equal-duration splitting is wrong.
            time += part === 0 ? 100 : 2;
            subtitles.push({ text, start, end: time });
        });
    });
    const entries = files.map((file, i) => ({ file, name: file.name, label: `${i + 1}/14`, order: i + 1, total: 14 }));
    const data = file => ({ rawTxt: file.rawTxt, index: api.buildKnowledgeOriginalSearchIndex(file.rawTxt) });
    return { files, entries, subtitles, data };
};

for (const filename of sourceFiles) {
    const source = readFileSync(new URL('../' + filename, import.meta.url), 'utf8');
    const marker = source.split('\n').find(line => line.startsWith('const KNOWLEDGE_ORIGINAL_MARKER_RE ='));
    const sentenceHelpers = source.slice(source.indexOf('const isAbbreviation ='), source.indexOf('const extractJsonObjectFromText ='));
    const helpers = source.slice(source.indexOf('const normalizeKnowledgeAlignmentText ='), source.indexOf('const MarkdownView ='));
    const context = vm.createContext({ setTimeout, console });
    const api = vm.runInContext(marker + '\n' + sentenceHelpers + helpers + '\n({ buildKnowledgeOriginalSearchIndex, createKnowledgeReferenceCache, getKnowledgeReferenceFileKey, buildKnowledgeReferenceCueLookup, getKnowledgeReferenceRange, rankKnowledgeReferenceFiles, getKnowledgeReferenceEvidence })', context);

    test('bounded cache serializes reads, pins active file, evicts, and rejects stale results: ' + filename, async () => {
        const cache = api.createKnowledgeReferenceCache(2);
        const { files, data } = makeFixture(api);
        let reads = 0, concurrent = 0, maximum = 0;
        const reader = async file => { reads++; maximum = Math.max(maximum, ++concurrent); await new Promise(r => setTimeout(r, 1)); concurrent--; return data(file); };
        await cache.load(files[0], reader);
        const keep = api.getKnowledgeReferenceFileKey(files[0]);
        await Promise.all(files.slice(1).map(file => cache.load(file, reader, () => true, keep)));
        assert.equal(maximum, 1);
        assert.equal(cache.size, 2);
        assert.ok(cache.get(keep));
        await cache.load(files[0], reader);
        assert.equal(reads, 14);
        let valid = true;
        const pending = cache.load(files[2], async file => {
            valid = false;
            return data(file);
        }, () => valid);
        assert.equal(await pending, null);
        assert.equal(cache.size, 2);
        const clearing = cache.load(files[3], async file => { cache.clear(); return data(file); });
        assert.equal(await clearing, null);
        assert.equal(cache.size, 0);
        await assert.rejects(cache.load(files[4], async () => { throw new Error('disk offline'); }), /offline/);
        assert.ok(await cache.load(files[4], reader)); // failures cannot poison queue
    });

    test('fourteen uneven parts, backward seeks, real time ranges and neighbouring boundaries: ' + filename, () => {
        const { files, entries, subtitles, data } = makeFixture(api);
        const lookup = api.buildKnowledgeReferenceCueLookup(subtitles);
        const ranges = new Map();
        for (let part = 0; part < 14; part++) {
            const range = api.getKnowledgeReferenceRange(data(files[part]), lookup);
            assert.equal(range.start, part * 4);
            assert.equal(range.end, part * 4 + 3);
            assert.equal(range.startTime, subtitles[part * 4].start);
            ranges.set(api.getKnowledgeReferenceFileKey(files[part]), range);
            for (const cue of [part * 4, part * 4 + 3]) {
                const ranked = api.rankKnowledgeReferenceFiles(entries, cue, subtitles, files[13].name, ranges);
                assert.equal(ranked[0].name, files[part].name);
                const evidence = api.getKnowledgeReferenceEvidence(data(files[part]), subtitles, cue);
                assert.ok(evidence, 'must align first/last cue with only one side of context');
                assert.equal(evidence.sourceLine, cue % 4 + 1);
            }
        }
        // Far backwards seek selects part 2, not previous active part 14.
        const ranked = api.rankKnowledgeReferenceFiles(entries, 5, subtitles, files[13].name, ranges);
        assert.equal(ranked[0].name, files[1].name);
        assert.equal(api.getKnowledgeReferenceEvidence(data(files[13]), subtitles, 5), null);
        assert.equal(api.getKnowledgeReferenceEvidence({ rawTxt: '@EX@ invented example', index: api.buildKnowledgeOriginalSearchIndex('@EX@ invented example') }, subtitles, 5), null);
    });

    test('repeated short reactions need contextual evidence, not a time guess: ' + filename, () => {
        const subtitles = [
            { text: 'The orchestra conductor welcomed every musician into the concert hall.' },
            { text: 'Exactly.' },
            { text: 'Our violin players rehearsed the difficult melody throughout yesterday afternoon.' }
        ];
        const make = rawTxt => ({ rawTxt, index: api.buildKnowledgeOriginalSearchIndex(rawTxt) });
        const wrong = make('[原文]\nExactly.\nThe spacecraft is travelling towards Mars.\n@K_HEADER@');
        const right = make('[原文]\n' + subtitles.map(cue => cue.text).join('\n') + '\n@K_HEADER@');
        assert.equal(api.getKnowledgeReferenceEvidence(wrong, subtitles, 1), null);
        assert.equal(api.getKnowledgeReferenceEvidence(right, subtitles, 1)?.sourceLine, 2);
        const noContext = [{ text: 'Exactly.' }, { text: 'Exactly.' }, { text: 'Exactly.' }];
        assert.equal(api.getKnowledgeReferenceEvidence(right, noContext, 1), null);
        assert.equal(api.getKnowledgeReferenceEvidence(wrong, [{ text: 'Unrelated spoken sentence without any matching words.' }], 0), null);
    });


    test('UI status rerenders keep reference loader identity stable: ' + filename, () => {
        const merge = source.slice(source.indexOf('    const mergeFilesIntoSelectedFolderMap ='), source.indexOf('    const stripTrailingSubtitleLanguageSuffix ='));
        const loaders = source.slice(source.indexOf('    const getEmbeddedKnowledgeTabSearchData ='), source.indexOf('    const handleManualKnowledgeTxtFileForEmbedded ='));
        const callbackSlots = [];
        let slot = 0;
        const useCallback = (callback, deps) => {
            const index = slot++;
            const old = callbackSlots[index];
            if (old && old.deps.length === deps.length && old.deps.every((value, i) => value === deps[i])) return old.callback;
            callbackSlots[index] = { callback, deps };
            return callback;
        };
        const render = vm.runInNewContext('(function render() {\n' + merge + loaders + '\nreturn { loadEmbeddedKnowledgeTxtFile, getEmbeddedKnowledgeTabSearchData, mergeFilesIntoSelectedFolderMap };\n})',
            { useCallback, currentTrackIndex: 0, trackLanguage: 'en-US', loadKnowledgeBankFromTxtFile: () => {} });
        slot = 0;
        const first = render();
        slot = 0;
        const second = render();
        assert.equal(first.mergeFilesIntoSelectedFolderMap, second.mergeFilesIntoSelectedFolderMap);
        assert.equal(first.getEmbeddedKnowledgeTabSearchData, second.getEmbeddedKnowledgeTabSearchData);
        assert.equal(first.loadEmbeddedKnowledgeTxtFile, second.loadEmbeddedKnowledgeTxtFile);
    });

    const effectStart = source.indexOf('    useEffect(() => {\n        if (!embeddedKnowledgeAutoFollow');
    const effectEnd = source.indexOf('    const renderTrackKnowledgeTabs =', effectStart);
    const effectSource = source.slice(effectStart, effectEnd);
    const runController = ({ fixture, index, active, read = null, enabled = true }) => {
        const cache = api.createKnowledgeReferenceCache(2);
        const state = { status: '', loaded: null, located: null, cleanup: null, reads: 0 };
        Object.assign(context, {
            embeddedKnowledgeAutoFollow: enabled, topPanelMode: 'document', isVideoMasked: false,
            currentTrackIndex: 0, currentIndex: index, subtitles: fixture.subtitles,
            trackKnowledgeTabEntries: fixture.entries, embeddedKnowledgeFileInfo: { filename: fixture.files[active].name },
            embeddedKnowledgeTabSearchRef: { current: '' }, embeddedKnowledgeCueLookupRef: { current: null },
            embeddedKnowledgeTabIndexCacheRef: { current: cache }, embeddedKnowledgeReferenceRangesRef: { current: new Map() },
            embeddedKnowledgeTabSequenceRef: { current: { subtitleIndex: -1 } },
            getKnowledgeTxtFileByName: name => fixture.files.find(file => file.name === name),
            getEmbeddedKnowledgeTabSearchData: (file, { isCurrent, keepFile }) => cache.load(file, async file => {
                state.reads++;
                if (read) await read(file);
                return fixture.data(file);
            }, isCurrent, api.getKnowledgeReferenceFileKey(keepFile)),
            loadEmbeddedKnowledgeTxtFile: async (file, { isCurrent }) => { if (isCurrent()) state.loaded = file.name; },
            setEmbeddedKnowledgeFollowStatus: value => { state.status = value; },
            setEmbeddedKnowledgeLocatedCue: value => { state.located = value; },
            useEffect: callback => { state.cleanup = callback(); }
        });
        vm.runInContext(effectSource, context);
        return state;
    };
    const waitUntil = async predicate => {
        for (let i = 0; i < 200; i++) {
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.fail('reference controller did not finish');
    };

    test('actual React controller lazily finds far part and accepts reverse seeking: ' + filename, async () => {
        const fixture = makeFixture(api);
        for (const [index, active, expected] of [[53, 0, 13], [5, 13, 1]]) {
            const state = runController({ fixture, index, active });
            await waitUntil(() => state.loaded);
            assert.equal(state.loaded, fixture.files[expected].name);
            assert.equal(state.located.subtitleIndex, index);
            assert.ok(state.reads <= 14);
            assert.ok(context.embeddedKnowledgeTabIndexCacheRef.current.size <= 2);
            state.cleanup();
        }
    });

    test('actual controller ignores cancelled seek and respects manual pin: ' + filename, async () => {
        const fixture = makeFixture(api);
        let release;
        const blocked = new Promise(resolve => { release = resolve; });
        const state = runController({ fixture, index: 53, active: 0, read: () => blocked });
        await new Promise(resolve => setTimeout(resolve, 5));
        state.cleanup();
        release();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(state.loaded, null);
        assert.equal(state.located, null);
        assert.equal(context.embeddedKnowledgeTabIndexCacheRef.current.size, 0);
        const pinned = runController({ fixture, index: 53, active: 0, enabled: false });
        assert.equal(pinned.reads, 0);
        assert.equal(pinned.loaded, null);
    });

    test('unreadable files retain current reference without invented matches: ' + filename, async () => {
        const fixture = makeFixture(api);
        const state = runController({ fixture, index: 53, active: 0, read: () => { throw new Error('permission denied'); } });
        await waitUntil(() => state.status.includes('讀取失敗'));
        assert.equal(state.loaded, null);
        assert.equal(state.located, null);
        assert.equal(context.embeddedKnowledgeTabIndexCacheRef.current.size, 0);
        state.cleanup();
    });
}

