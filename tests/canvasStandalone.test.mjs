import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
import { applyFsrsRating } from '../fsrsScheduler.js';

const source = readFileSync(new URL('../語伴20260713.1-codex.js', import.meta.url), 'utf8');

test('Canvas JSX compiles without local modules or additional npm dependencies', async () => {
    const result = await build({
        stdin: { contents: source, loader: 'jsx' },
        bundle: true, write: false, format: 'esm',
        plugins: [{
            name: 'canvas-dependencies',
            setup(builder) {
                builder.onResolve({ filter: /.*/ }, ({ path }) => {
                    assert.ok(['react', 'lucide-react'].includes(path), 'Unexpected Canvas dependency: ' + path);
                    return { path, external: true };
                });
            }
        }]
    });
    assert.ok(result.outputFiles[0].text.length > 0);
});

test('embedded FSRS matches the GitHub scheduler for all ratings', () => {
    const start = source.indexOf('var YubanCanvasFsrs');
    const end = source.indexOf('\nconst { DEFAULT_FSRS_CONFIG', start);
    const api = vm.runInNewContext(source.slice(start, end) + '\nYubanCanvasFsrs', { Date });
    const now = new Date('2026-10-13T00:00:00Z');
    for (const rating of ['Again', 'Hard', 'Good', 'Easy']) {
        assert.equal(
            JSON.stringify(api.applyFsrsRating({}, rating, {}, now)),
            JSON.stringify(applyFsrsRating({}, rating, {}, now))
        );
    }
});

test('successful Canvas wake lock returns true without referencing rawTxt', async () => {
    const start = source.indexOf('    const requestFlashCardWakeLock =');
    const end = source.indexOf('    const releaseFlashCardWakeLock =', start);
    const context = {
        navigator: { wakeLock: { request: async () => ({ released: false, addEventListener() {} }) } },
        wakeLockRef: { current: null }, useCallback: fn => fn
    };
    const request = vm.runInNewContext(source.slice(start, end) + '\nrequestFlashCardWakeLock', context);
    assert.equal(await request(), true);
});
