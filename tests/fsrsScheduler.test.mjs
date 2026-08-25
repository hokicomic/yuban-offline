import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFsrsRating, getFsrsPreview, isDue, isFsrsScheduled, normalizeFsrsConfig } from '../fsrsScheduler.js';

test('new card receives official FSRS state and future due after Good', () => {
  const now = new Date('2026-08-25T00:00:00.000Z');
  const result = applyFsrsRating({}, 'Good', { requestRetention: 0.9, maximumInterval: 36500 }, now);
  assert.ok(result.card.due > now.toISOString());
  assert.equal(result.card.reps, 1);
  assert.equal(result.log.rating, 3);
});

test('preview and applied FSRS result agree for a chosen rating', () => {
  const now = new Date('2026-08-25T00:00:00.000Z');
  const preview = getFsrsPreview({}, {}, now);
  const applied = applyFsrsRating({}, 'Easy', {}, now);
  assert.equal(applied.card.due, preview.Easy.card.due);
});

test('future scheduled card is not due and Again produces a real lapse transition', () => {
  const now = new Date('2026-08-25T00:00:00.000Z');
  const first = applyFsrsRating({}, 'Good', {}, now).card;
  assert.equal(isFsrsScheduled({ fsrs: first }), true);
  assert.equal(isDue({ fsrs: first }, now), false);
  const again = applyFsrsRating({ fsrs: { ...first, due: now.toISOString() } }, 'Again', {}, now);
  assert.equal(again.log.rating, 1);
});

test('configuration is constrained to supported retention and interval bounds', () => {
  assert.deepEqual(normalizeFsrsConfig({ requestRetention: 2, maximumInterval: 999999 }), { requestRetention: 0.99, maximumInterval: 36500 });
});
