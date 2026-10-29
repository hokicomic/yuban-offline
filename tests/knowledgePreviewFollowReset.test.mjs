import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const item = term => ({ id: term, category: 'vocab', front: term, back: term + ' explanation' });
const payload = (...terms) => ({ term: terms.length > 1 ? '本句知識點：' + terms.join(' · ') : terms[0], items: terms.map(item) });

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const start = source.indexOf('    // Scope manual knowledge selection');
    const handlers = source.slice(start >= 0 ? start : source.indexOf('    const handleKnowledgePreviewTermClick ='), source.indexOf('    const handleEmbeddedKnowledgeSourceLineConfirm ='));
    const setup = () => {
        let previousDeps;
        let layout;
        const c = {
            React: { useLayoutEffect(fn, deps) {
                if (!previousDeps || deps.some((value, index) => value !== previousDeps[index])) layout = fn;
                previousDeps = deps;
            } },
            useCallback: fn => fn, cleanQuizDisplayText: value => value,
            knowledgePreviewManualOverrideRef: { current: { documentKey: '', subtitleIndex: -1 } },
            currentIndex: 8, embeddedKnowledgeRenderIndex: 8, currentTrackIndex: 0, embeddedKnowledgeDocumentKey: 'document-A',
            knowledgePreviewTermPopup: null, knowledgePreviewPopupPosRef: { current: { x: 0, y: 0 } },
            setKnowledgePreviewTermPopup: value => { c.knowledgePreviewTermPopup = typeof value === 'function' ? value(c.knowledgePreviewTermPopup) : value; },
            setKnowledgePreviewPopupPos() {}, getKnowledgePreviewPopupDefaultPos: () => ({ x: 0, y: 0 }),
            clampKnowledgePreviewPopupPos: (x, y) => ({ x, y }), QUIZ_FOCUS_TYPE_LABELS: { vocab: '單字' }
        };
        const context = vm.createContext(c);
        const render = () => {
            c.embeddedKnowledgeRenderIndex = c.currentIndex;
            const api = vm.runInContext('(() => {' + handlers + '\nreturn { click: handleKnowledgePreviewTermClick, sync: syncOpenKnowledgePreviewToActiveTerm }; })()', context);
            // React flushes layout effects before the child's passive reporter.
            layout?.(); layout = null;
            return api;
        };
        return { c, render };
    };
    test('next cue then previous cue follows all highlighted terms without reviving an old selection: ' + file, () => {
        const { c, render } = setup();
        let api = render();
        api.click(payload('under siege'));
        api = render(); api.sync(payload('chokehold', 'commerce'));
        assert.equal(c.knowledgePreviewTermPopup.term, 'under siege', 'preserve a manual choice during the same cue');
        c.currentIndex = 9;
        api = render(); api.sync(payload('militia', 'missiles', 'disrupting', 'vital'));
        assert.equal(c.knowledgePreviewTermPopup.items.length, 4);
        c.currentIndex = 8;
        api = render(); api.sync(payload('chokehold', 'commerce'));
        assert.equal(c.knowledgePreviewTermPopup.term, '本句知識點：chokehold · commerce');
        assert.deepEqual(Array.from(c.knowledgePreviewTermPopup.items, value => value.front), ['chokehold', 'commerce']);
    });
    test('visiting a cue without knowledge links still expires the manual selection: ' + file, () => {
        const { c, render } = setup();
        render().click(payload('under siege'));
        c.currentIndex = 10; render(); // no child sync callback on this cue
        c.currentIndex = 8;
        render().sync(payload('chokehold', 'commerce'));
        assert.equal(c.knowledgePreviewTermPopup.items.length, 2);
        assert.equal(c.knowledgePreviewTermPopup.items[0].front, 'chokehold');
    });
    test('document and track changes release a manual selection even at the same subtitle index: ' + file, () => {
        for (const scope of ['embeddedKnowledgeDocumentKey', 'currentTrackIndex']) {
            const { c, render } = setup();
            render().click(payload('under siege'));
            c[scope] = scope === 'currentTrackIndex' ? 1 : 'document-B';
            render().sync(payload('commerce'));
            assert.equal(c.knowledgePreviewTermPopup.term, 'commerce');
        }
    });
    test('automatic following never opens a closed knowledge window: ' + file, () => {
        const { c, render } = setup();
        render().sync(payload('chokehold', 'commerce'));
        assert.equal(c.knowledgePreviewTermPopup, null);
        render().click(payload('under siege'));
        c.knowledgePreviewTermPopup = null;
        c.currentIndex = 9;
        render().sync(payload('militia'));
        assert.equal(c.knowledgePreviewTermPopup, null);
    });
}
