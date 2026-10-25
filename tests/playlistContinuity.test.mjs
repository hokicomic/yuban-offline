import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../yuban-original.jsx', import.meta.url), 'utf8');
const standalone = fs.readFileSync(new URL('../語伴20260713.1-codex.js', import.meta.url), 'utf8');

test('media ended delegates to the autoplay-aware playlist transition', () => {
  const ended = source.match(/onEnded=\{\(\) => \{([\s\S]*?)\}\} \/>/)?.[1] || '';
  assert.match(ended, /handlePlaylistEnd\(\);/);
  assert.doesNotMatch(ended, /loadTrack\(/);

  const handler = source.match(/const handlePlaylistEnd = \(\) => \{([\s\S]*?)\n    \};/)?.[1] || '';
  assert.match(handler, /autoplayOnLoadRef\.current = true;/);
  assert.match(handler, /playlistLoopModeRef\.current/);
  assert.match(handler, /\(idx \+ 1\) % list\.length/);
});

test('track changes preserve the selected media/document panel state', () => {
  const effect = source.match(/\/\/ Track changes must not reset[\s\S]*?\}, \[currentTrackIndex\]\);/)?.[0] || '';
  assert.ok(effect, 'track-change continuity effect should exist');
  assert.doesNotMatch(effect, /setIsVideoMasked\(/);
  assert.doesNotMatch(effect, /setTopPanelMode\(/);
  assert.match(effect, /topPanelMode === 'document' && !isVideoMasked/);
  assert.match(effect, /loadEmbeddedKnowledgePanel\(\)/);
});

test('source and standalone release carry the same continuity fix and version', () => {
  for (const candidate of [source, standalone]) {
    assert.equal(candidate.match(/const APP_VERSION = "([^"]+)";/)?.[1], source.match(/const APP_VERSION = "([^"]+)";/)?.[1]);
    assert.match(candidate, /handlePlaylistEnd\(\);/);
    assert.match(candidate, /\/\/ Track changes must not reset/);
  }
});
