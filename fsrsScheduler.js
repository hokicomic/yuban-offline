import { createEmptyCard, fsrs, Rating, State } from 'ts-fsrs';

export const FSRS_SCHEMA_VERSION = 3;
export const DEFAULT_FSRS_CONFIG = Object.freeze({ requestRetention: 0.90, maximumInterval: 36500, legacyCalibrationPerDay: 20, newCardsPerDay: 20, remindersEnabled: false });
export const FSRS_RATINGS = Object.freeze({ Again: Rating.Again, Hard: Rating.Hard, Good: Rating.Good, Easy: Rating.Easy });

const ISO_FIELDS = new Set(['due', 'last_review', 'review']);
const dayMs = 86400000;

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function datesToIso(record) {
  return Object.fromEntries(Object.entries(record || {}).map(([key, value]) => [key, ISO_FIELDS.has(key) ? iso(value) : value]));
}

function asFsrsCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const due = iso(raw.due);
  if (!due || !Number.isFinite(Number(raw.stability)) || !Number.isFinite(Number(raw.difficulty))) return null;
  return {
    due,
    stability: Number(raw.stability),
    difficulty: Number(raw.difficulty),
    elapsed_days: Math.max(0, Number(raw.elapsed_days || 0)),
    scheduled_days: Math.max(0, Number(raw.scheduled_days || 0)),
    learning_steps: Math.max(0, Number(raw.learning_steps || 0)),
    reps: Math.max(0, Number(raw.reps || 0)),
    lapses: Math.max(0, Number(raw.lapses || 0)),
    state: Number(raw.state),
    ...(iso(raw.last_review) ? { last_review: iso(raw.last_review) } : {})
  };
}

export function normalizeFsrsConfig(raw) {
  const retention = Number(raw?.requestRetention ?? raw?.request_retention ?? DEFAULT_FSRS_CONFIG.requestRetention);
  const maximumInterval = Number(raw?.maximumInterval ?? raw?.maximum_interval ?? DEFAULT_FSRS_CONFIG.maximumInterval);
  return {
    requestRetention: Math.min(0.99, Math.max(0.80, Number.isFinite(retention) ? retention : DEFAULT_FSRS_CONFIG.requestRetention)),
    maximumInterval: Math.min(36500, Math.max(1, Math.round(Number.isFinite(maximumInterval) ? maximumInterval : DEFAULT_FSRS_CONFIG.maximumInterval))),
    legacyCalibrationPerDay: Math.min(100, Math.max(0, Math.round(Number(raw?.legacyCalibrationPerDay ?? DEFAULT_FSRS_CONFIG.legacyCalibrationPerDay) || 0))),
    newCardsPerDay: Math.min(100, Math.max(0, Math.round(Number(raw?.newCardsPerDay ?? DEFAULT_FSRS_CONFIG.newCardsPerDay) || 0))),
    remindersEnabled: Boolean(raw?.remindersEnabled)
  };
}

function scheduler(config) {
  const normalized = normalizeFsrsConfig(config);
  return fsrs({
    request_retention: normalized.requestRetention,
    maximum_interval: normalized.maximumInterval,
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: ['1m', '10m'],
    relearning_steps: ['10m']
  });
}

export function getFsrsCard(entry, now = new Date()) {
  return asFsrsCard(entry?.fsrs) || createEmptyCard(now);
}

export function isFsrsScheduled(entry) {
  return Boolean(asFsrsCard(entry?.fsrs));
}

export function getFsrsPreview(entry, config, now = new Date()) {
  const engine = scheduler(config);
  const preview = engine.repeat(getFsrsCard(entry, now), now);
  return Object.fromEntries(Object.entries(FSRS_RATINGS).map(([label, rating]) => {
    const result = preview[rating];
    return [label, { card: datesToIso(result.card), log: datesToIso(result.log) }];
  }));
}

export function applyFsrsRating(entry, ratingLabel, config, now = new Date()) {
  const rating = FSRS_RATINGS[ratingLabel];
  if (!rating) throw new Error(`Unsupported FSRS rating: ${ratingLabel}`);
  const result = scheduler(config).next(getFsrsCard(entry, now), now, rating);
  return { card: datesToIso(result.card), log: datesToIso(result.log) };
}

export function isDue(entry, now = new Date()) {
  const card = asFsrsCard(entry?.fsrs);
  return Boolean(card && new Date(card.due).getTime() <= now.getTime());
}

export function getFsrsStateLabel(entry) {
  const card = asFsrsCard(entry?.fsrs);
  if (!card) return 'Uninitialized';
  return ['New', 'Learning', 'Review', 'Relearning'][card.state] || 'Unknown';
}

export function getRetrievability(entry, config, now = new Date()) {
  const card = asFsrsCard(entry?.fsrs);
  if (!card || card.state === State.New) return null;
  return scheduler(config).get_retrievability(card, now, false);
}

export function dueInLabel(dueAt, now = new Date()) {
  const ms = new Date(dueAt).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return '現在';
  if (ms < 3600000) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (ms < dayMs) return `${Math.max(1, Math.round(ms / 3600000))}h`;
  return `${Math.max(1, Math.round(ms / dayMs))}d`;
}
