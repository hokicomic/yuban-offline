import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'esbuild';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const render = async (start, before, after) => {
        const state = source.slice(source.indexOf('    const sentenceTimelineRef ='), source.indexOf('    const getBufferedRange ='));
        const view = source.slice(source.indexOf('    const renderSentenceTimeline ='), source.indexOf('    return (\n        <AudioCacheContext.Provider'));
        const compiled = await transform(state + view + '\nrenderSentenceTimeline();', { loader: 'jsx', format: 'cjs' });
        const c = { React, useRef: current => ({ current }), useState: initial => [initial, () => {}], useEffect() {},
            subtitles: [{ start, end: start + 15 }], currentIndex: 0, currentTrackIndex: 0,
            playbackMode: 'sentence', duration: 100, currentTime: start, isEchoMode: false,
            sentenceTimelineBuffers: { before, after } };
        return vm.runInNewContext(compiled.code, c);
    };
    const flatten = element => Array.isArray(element) ? element.flatMap(flatten)
        : element && typeof element === 'object' ? [element, ...flatten(element.props?.children)] : [];
    test('first sentence shows both complete buffers with unavailable audio identified: ' + file, async () => {
        const tree = await render(0, 3, 3);
        const nodes = flatten(tree);
        assert.equal(nodes.filter(n => n.props?.['data-sentence-buffer']).length, 2);
        const markerA = nodes.find(n => n.props?.['aria-label'] === '拖曳單句播放起點 A');
        assert.ok(parseFloat(markerA.props.style.left) > 0, 'A must have a visible front buffer even at media zero');
        assert.ok(nodes.some(n => n.props?.['aria-label'] === '超出音檔範圍，無可播放音訊'));
        const html = renderToStaticMarkup(tree);
        assert.match(html, /前可用 0\.0s/);
        assert.match(html, /斜線區無音訊/);
        if (file === 'yuban-original.jsx') {
            mkdirSync('/tmp/yuban-buffer-preview', { recursive: true });
            writeFileSync('/tmp/yuban-buffer-preview/default.html', '<!doctype html><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script><div style="margin-top:30px">'+html+'</div>');
        }
    });
    test('larger buffers occupy more draggable rail and have matching second ticks: ' + file, async () => {
        const small = flatten(await render(20, 3, 3));
        const largeTree = await render(20, 10, 10);
        const large = flatten(largeTree);
        for (const side of ['before', 'after']) {
            const width = nodes => parseFloat(nodes.find(n => n.props?.['data-sentence-buffer'] === side).props.style.width);
            assert.ok(width(large) > width(small));
        }
        assert.ok(!large.some(n => n.props?.['aria-label'] === '超出音檔範圍，無可播放音訊'));
        assert.match(renderToStaticMarkup(largeTree), /前可用 10\.0s/);
        assert.match(renderToStaticMarkup(largeTree), /後可用 10\.0s/);
        if (file === 'yuban-original.jsx') writeFileSync('/tmp/yuban-buffer-preview/larger.html', '<!doctype html><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script><div style="margin-top:30px">'+renderToStaticMarkup(largeTree)+'</div>');
    });
}
