import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { transform } from 'esbuild';

for (const file of ['yuban-original.jsx', '語伴20260713.1-codex.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    test('embedded reference controls occupy one compact row: ' + file, async () => {
        const start = source.indexOf('    const renderTrackKnowledgeTabs =');
        const end = source.indexOf('    const handleToggleMediaPanel =', start);
        const compiled = await transform(source.slice(start, end) + '\nrenderTrackKnowledgeTabs;', { loader: 'jsx', format: 'cjs' });
        const entries = Array.from({ length: 14 }, (_, i) => ({ name: 'Book ' + (i + 1), label: (i + 1) + '/14' }));
        const render = vm.runInNewContext(compiled.code, {
            React, trackKnowledgeTabEntries: entries, activeTrackKnowledgeTabName: 'Book 9',
            embeddedKnowledgeAutoFollow: true, embeddedKnowledgeFollowStatus: '字幕已定位 9/14 · 文件快取 2/2',
            handleSelectTrackKnowledgeTab() {}
        });
        const toolbar = render('embedded');
        assert.ok(toolbar.props.className.includes('h-8'));
        assert.ok(!toolbar.props.className.includes('flex-wrap'));
        const [label, tabs, status] = toolbar.props.children;
        assert.equal(label.type, 'label');
        assert.ok(label.props.className.includes('shrink-0'));
        assert.equal(tabs.props['data-knowledge-tab-list'], 'embedded');
        assert.ok(tabs.props.className.includes('overflow-x-auto'));
        assert.ok(tabs.props.className.includes('min-w-0'));
        assert.equal(tabs.props.children.length, 14);
        assert.ok(tabs.props.children.every(button => button.props.className.includes('shrink-0')));
        assert.equal(status.props.role, 'status');
        assert.ok(status.props.className.includes('sr-only md:not-sr-only'));
        assert.match(status.props.title, /9\/14/);
        assert.ok(render('modal').props.className.includes('flex-wrap'), 'modal layout remains unchanged');
        assert.match(source, /px-3 py-0\.5 border-b border-gray-100 bg-white shrink-0 min-w-0/);
    });
}

