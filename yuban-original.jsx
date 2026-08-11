// VERSION: v5.144
// DATE: 2026-02-13
// AUTHOR: Maintenance Engineer
// BASE: v5.139
// CHANGES:
// 1. [Gamification] Added 'Survival Mode' (Ghost Word Challenge).
// 2. [Gamification] Added Progress Bar tracking per video.
// 3. [Gamification] Added Trophy button (unlocks at 100% progress).
// 4. [UI] Added Game Overlay.

import React, { useState, useRef, useEffect, useCallback, useContext, useMemo } from 'react';
import {
    Play, Pause, SkipBack, SkipForward,
    Mic, Settings, FolderOpen, ChevronLeft, ChevronUp, ChevronDown,
    CheckCircle, AlertCircle, MonitorPlay,
    Volume2, FastForward, X, Download,
    Type, Minus, Plus, Bug, Puzzle, Key, Sparkles, BookOpen, Volume1, Loader2,
    Eye, EyeOff, Repeat, Repeat1, ArrowRight, Send, Infinity as InfinityIcon,
    Hand, Languages, Search, Globe, MessageCircle, Phone, PhoneOff, MicOff, Maximize2, Minimize2, FilePlus, MoveRight,
    Gauge, Clock, Trophy, Activity, Zap, Wand2, Ear, Ban, Brain, StopCircle, Trash2, Copy
} from 'lucide-react';

// ============================================================================
// [CONFIG] API KEY
// ============================================================================
const apiKey = "";
const APP_VERSION = "v5.171 (Better Heuristic Examples)";
let bridgeRuntimeStats = { tx: 0, rx: 0, echo: 0, lastType: "", lastKeys: "" };
const AI_NOTES_CACHE_SCHEMA_VERSION = "20260305.6";
const EXPLAIN_ENABLE_SECOND_PASS = false; // default: keep single-pass for stable quality
const PRESERVE_GEMINI_MARKDOWN_LAYOUT = true; // default: keep Gemini original paragraph/bold layout
const FLASHCARD_MASTERY_FILE_NAME = "flashcard_mastery.json";
const FLASHCARD_MASTERY_SCHEMA_VERSION = 1;
const FLASHCARD_MASTERY_LOCAL_STORAGE_KEY = "flashcard_mastery";
const FLASHCARD_MASTERY_AUTOSAVE_DEBOUNCE_MS = 1500;
const FLASHCARD_MASTERY_FORCE_FLUSH_EVERY = 5;
// Flashcard review data is global by normalized front/head + back/explanation.
// MacBook Chrome can auto-sync flashcard_mastery.json after the user chooses a folder.
// iPhone/iPad Chrome may not support folder writes, so it falls back to localStorage + JSON import/export.

// ============================================================================
// [WORKER SCRIPT] - Inline Blob
// ============================================================================
const WORKER_SCRIPT = `
self.onmessage = function(e) {
  const { type, payload } = e.data;
  
  if (type === 'START_HEARTBEAT') {
    if (self.heartbeatId) clearInterval(self.heartbeatId);
    // Poll faster (100ms) to catch subtitle ends precisely, even in background
    self.heartbeatId = setInterval(() => {
      self.postMessage({ type: 'TICK' });
    }, 100);
  } 
  else if (type === 'STOP_HEARTBEAT') {
    if (self.heartbeatId) clearInterval(self.heartbeatId);
    self.heartbeatId = null;
  }
  else if (type === 'START_TIMER') {
    if (self.timerId) clearTimeout(self.timerId);
    const token = payload && typeof payload.token === 'number' ? payload.token : Date.now();
    self.timerToken = token;
    // Reliable background timer
    self.timerId = setTimeout(() => {
      self.postMessage({ type: 'TIMER_DONE', token });
    }, payload.delay);
  }
  else if (type === 'STOP_TIMER') {
    if (self.timerId) clearTimeout(self.timerId);
    self.timerId = null;
  }
};
`;

// ============================================================================
// [GLOBAL UTILS] - Shared Logic
// ============================================================================
const isPredominantlyChinese = (text) => {
    if (!text) return false;
    const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    return chineseCount > text.length * 0.5;
};

const isPhonetic = (text) => {
    const clean = text.trim();
    return /^(\/.*\/|\[.*\])$/.test(clean);
};

const looksLikePhoneticChunk = (chunk = "") => {
    const t = String(chunk || "").trim();
    if (!t) return false;
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(t)) return false;
    return /[ˈˌː]/u.test(t) || /[\u0250-\u02af]/u.test(t);
};

const stripTtsMarkupButKeepPatternBrackets = (text = "") => String(text || "")
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/###/g, '')
    .replace(/\[([^\]\n]{1,120})\]/gu, (m, inner) => looksLikePhoneticChunk(inner) ? '' : ` ${inner} `)
    .trim();

// Support dynamic language code in target tags, e.g. <T lang="ja-JP">...</T> or <T lang=ja-JP>...</T>
const TARGET_TAG_CAPTURE_ONE_REGEX = /<T\b[^>]*\blang\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>([\s\S]*?)<\/T>/i;
const TARGET_TAG_CAPTURE_ALL_REGEX = /<T\b[^>]*\blang\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>([\s\S]*?)<\/T>/gi;
const hasTargetLangTag = (text) => TARGET_TAG_CAPTURE_ONE_REGEX.test(String(text || ""));
const stripTargetLangTags = (text) => String(text || "").replace(TARGET_TAG_CAPTURE_ALL_REGEX, '$1');

// Remove partial/broken target-tag residues such as n-US">, US">, or lang="en-US">.
const stripBrokenTargetTagFragments = (text) => String(text || "")
    .replace(/\blang\s*=\s*(?:"[^"]*"|'[^']*')\s*>/gi, "")
    .replace(/\b[a-z]{1,3}-[A-Za-z]{2,4}["']>/g, "")
    .replace(/\b[A-Za-z]{2,4}["']>/g, "");

// [UPDATED] Tag-based extractor
const extractTargetText = (cellContent) => {
    if (!cellContent || typeof cellContent !== 'string') return "";

    // 1. Priority: Check for <T lang="...">...</T> wrapper
    const tagMatch = cellContent.match(TARGET_TAG_CAPTURE_ONE_REGEX);
    if (tagMatch && tagMatch[1]) {
        return tagMatch[1].replace(/\*\*(.*?)\*\*/g, '$1').replace(/<[^>]*>/g, '').trim();
    }

    // 2. Fallback: Check for {{ ... }} wrapper defined in Prompt
    const legacyMatch = cellContent.match(/\{\{(.*?)\}\}/);
    if (legacyMatch && legacyMatch[1]) {
        // Remove markdown bold for TTS, trim whitespace
        return legacyMatch[1].replace(/\*\*(.*?)\*\*/g, '$1').trim();
    }

    // 2. Fallback: Old logic (split by break)
    let text = cellContent.split(/<br\s*\/?>/i)[0];

    // Fallback cleanup
    const separators = ["===TRANSLATION===", "Translation:", "Translation in Chinese:", "中文:", "意思:", "Meaning:"];
    for (const sep of separators) {
        const idx = text.indexOf(sep);
        if (idx !== -1) text = text.substring(0, idx);
    }

    return text.replace(/<[^>]*>/g, '').replace(/\*\*(.*?)\*\*/g, '$1').trim();
};

// [NEW] Helper to clean display text (remove {{ }} but keep ** **)
const cleanTextForDisplay = (text) => {
    if (!text || typeof text !== 'string') return "";
    return stripBrokenTargetTagFragments(stripTargetLangTags(text)).replace(/\{\{(.*?)\}\}/g, '$1');
};

// [NEW] Target sentence rendering helpers (safe HTML + strikethrough)
const escapeHtml = (text) => {
    if (!text || typeof text !== 'string') return "";
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const decodeHtml = (text) => {
    if (!text || typeof text !== 'string') return "";
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
};

function normalizeFlashCardText(text) {
    let s = String(text || "");
    s = s.replace(/<[^>]*>/g, " ");
    s = s
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*\n]+)\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/_([^_\n]+)_/g, "$1")
        .replace(/`([^`]+)`/g, "$1");
    if (typeof decodeHtml === "function") s = decodeHtml(s);
    if (typeof s.normalize === "function") s = s.normalize("NFKC");
    s = s.trim().replace(/\s+/g, " ");
    s = stripFlashCardFrontPronunciationForMastery(s);
    return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function stripFlashCardFrontPronunciationForMastery(text) {
    let s = String(text || "").trim();
    if (!s) return "";
    s = s.replace(/\s*\/[^\/\n]{1,120}\/\s*$/u, "").trim();
    s = s.replace(/\s*\[[^\]\n]{1,120}\]\s*$/u, "").trim();
    const paren = s.match(/^(.*?)\s*[（(]([^()（）]{1,80})[)）]\s*$/u);
    if (paren) {
        const base = String(paren[1] || "").trim();
        const note = String(paren[2] || "").trim();
        const noteNoSpace = note.replace(/\s+/g, "");
        const baseNoSpace = base.replace(/\s+/g, "");
        const looksLikeReading =
            /^[\u3040-\u30ffー・]+$/u.test(noteNoSpace) ||
            /^[a-zA-Z\u0250-\u02af\u1d00-\u1d7f\u02b0-\u02ffˈˌ.·:ː'’\-\s]+$/u.test(note) ||
            (baseNoSpace && noteNoSpace && baseNoSpace.toLowerCase() === noteNoSpace.toLowerCase());
        if (base && looksLikeReading) {
            s = base;
        }
    }
    return s;
}

function simpleStableHash(input) {
    let hash = 0x811c9dc5;
    const s = String(input || "");
    for (let i = 0; i < s.length; i += 1) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function getFlashCardFrontText(card) {
    if (!card) return "";
    return card.front ?? card.head ?? card.question ?? card.term ?? card.title ?? "";
}

function getFlashCardBackText(card) {
    if (!card) return "";
    return card.back ?? card.explanation ?? card.answer ?? card.meaning ?? card.definition ?? "";
}

function buildFlashCardId(card) {
    const front = normalizeFlashCardText(getFlashCardFrontText(card));
    return "card_" + simpleStableHash(front);
}

function mergeFlashCardMasteryEntry(existing, incoming, options = {}) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const sumCounts = Boolean(options.sumCounts);
    const existingLast = String(existing.lastReviewedAt || "");
    const incomingLast = String(incoming.lastReviewedAt || "");
    const latest = incomingLast > existingLast ? incoming : existing;
    const countValue = (field) => {
        const a = Number(existing[field] || 0);
        const b = Number(incoming[field] || 0);
        return sumCounts ? Math.max(0, a) + Math.max(0, b) : Math.max(a, b);
    };
    return {
        cardId: incoming.cardId || existing.cardId || "",
        head: existing.head || incoming.head || "",
        headNormalized: existing.headNormalized || incoming.headNormalized || "",
        rememberedCount: countValue("rememberedCount"),
        forgotCount: countValue("forgotCount"),
        reviewCount: countValue("reviewCount"),
        lastResult: latest.lastResult || existing.lastResult || incoming.lastResult || "remembered",
        lastReviewedAt: latest.lastReviewedAt || existing.lastReviewedAt || incoming.lastReviewedAt || "",
        discardedAt: [existing.discardedAt, incoming.discardedAt].filter(Boolean).sort().slice(-1)[0] || ""
    };
}

function createEmptyFlashCardMasteryData() {
    return {
        schemaVersion: FLASHCARD_MASTERY_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        cards: {}
    };
}

function normalizeFlashCardMasteryEntry(rawEntry, fallbackKey, nowIso) {
    const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
    const head = String(entry.head || entry.front || (fallbackKey && !String(fallbackKey).startsWith("card_") ? fallbackKey : ""));
    const headNormalized = normalizeFlashCardText(entry.headNormalized || head);
    const cardId = headNormalized
        ? "card_" + simpleStableHash(headNormalized)
        : String(entry.cardId || fallbackKey || "").trim();
    if (!cardId) return null;
    const lastReview = entry.lastReviewedAt || entry.lastReview || entry.reviewedAt || "";
    const rememberedCount = Number.isFinite(Number(entry.rememberedCount))
        ? Math.max(0, Number(entry.rememberedCount))
        : Math.max(0, Number(entry.level || 0));
    const forgotCount = Number.isFinite(Number(entry.forgotCount))
        ? Math.max(0, Number(entry.forgotCount))
        : Math.max(0, Number(entry.wrongCount || 0));
    const reviewCount = Number.isFinite(Number(entry.reviewCount))
        ? Math.max(0, Number(entry.reviewCount))
        : rememberedCount + forgotCount;
    const lastResult = entry.lastResult === "forgot" || (!entry.lastResult && forgotCount > 0 && rememberedCount <= 0)
        ? "forgot"
        : "remembered";
    return {
        cardId,
        head,
        headNormalized,
        rememberedCount,
        forgotCount,
        reviewCount,
        lastResult,
        lastReviewedAt: lastReview ? String(lastReview) : "",
        discardedAt: entry.discardedAt ? String(entry.discardedAt) : ""
    };
}

function normalizeFlashCardMasteryData(raw) {
    try {
        if (!raw || typeof raw !== "object") return createEmptyFlashCardMasteryData();
        const nowIso = new Date().toISOString();
        const cardsSource = raw.schemaVersion === FLASHCARD_MASTERY_SCHEMA_VERSION && raw.cards && typeof raw.cards === "object"
            ? raw.cards
            : raw;
        const normalized = {
            schemaVersion: FLASHCARD_MASTERY_SCHEMA_VERSION,
            updatedAt: String(raw.updatedAt || nowIso),
            cards: {}
        };
        Object.entries(cardsSource || {}).forEach(([key, value]) => {
            if (key === "schemaVersion" || key === "updatedAt" || key === "cards") return;
            const entry = normalizeFlashCardMasteryEntry(value, key, nowIso);
            if (entry) {
                normalized.cards[entry.cardId] = mergeFlashCardMasteryEntry(
                    normalized.cards[entry.cardId],
                    entry,
                    { sumCounts: true }
                );
            }
        });
        return normalized;
    } catch (err) {
        console.warn("Failed to normalize flashcard mastery data", err);
        return createEmptyFlashCardMasteryData();
    }
}

function mergeFlashCardMasteryData(baseData, incomingData) {
    const base = normalizeFlashCardMasteryData(baseData);
    const incoming = normalizeFlashCardMasteryData(incomingData);
    const merged = {
        ...base,
        schemaVersion: FLASHCARD_MASTERY_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        cards: { ...base.cards }
    };
    Object.entries(incoming.cards || {}).forEach(([rawCardId, incomingEntry]) => {
        const cardId = String(incomingEntry?.cardId || rawCardId || "");
        const baseEntry = merged.cards[cardId];
        if (!baseEntry) {
            merged.cards[cardId] = { ...incomingEntry, cardId };
            return;
        }
        merged.cards[cardId] = mergeFlashCardMasteryEntry(baseEntry, incomingEntry, { sumCounts: false });
    });
    return merged;
}

function loadFlashCardMasteryFromLocalStorage() {
    if (typeof window === "undefined") return createEmptyFlashCardMasteryData();
    try {
        const data = window.localStorage.getItem(FLASHCARD_MASTERY_LOCAL_STORAGE_KEY);
        return normalizeFlashCardMasteryData(data ? JSON.parse(data) : null);
    } catch (err) {
        console.warn("Failed to load flashcard mastery data", err);
        return createEmptyFlashCardMasteryData();
    }
}

function saveFlashCardMasteryToLocalStorage(data) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(FLASHCARD_MASTERY_LOCAL_STORAGE_KEY, JSON.stringify(normalizeFlashCardMasteryData(data)));
    } catch (err) {
        console.warn("Failed to save flashcard mastery data", err);
    }
}

function buildFlashCardMasteryExportFileName() {
    const now = new Date();
    const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "_",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0")
    ].join("");
    return `flashcard_mastery_${stamp}.json`;
}

async function buildUniqueFileNameInDirectory(dirHandle, filename) {
    if (!dirHandle || typeof dirHandle.getFileHandle !== "function") return filename;
    const dotIndex = filename.lastIndexOf(".");
    const base = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
    const ext = dotIndex >= 0 ? filename.slice(dotIndex) : "";
    for (let index = 1; index < 1000; index += 1) {
        const candidate = index === 1 ? filename : `${base}-${index}${ext}`;
        try {
            await dirHandle.getFileHandle(candidate, { create: false });
        } catch (err) {
            if (err?.name === "NotFoundError") return candidate;
            throw err;
        }
    }
    return `${base}-${Date.now()}${ext}`;
}

function isFileSystemAccessSupported() {
    return typeof window !== "undefined" &&
        typeof window.showDirectoryPicker === "function";
}

const stripStrike = (text) => {
    if (!text || typeof text !== 'string') return "";
    return text.replace(/~~(.*?)~~/g, '$1');
};

const shrinkReadingParenthesesHtml = (inputHtml) => {
    let out = String(inputHtml || "");
    const style = "font-size:0.72em;opacity:0.78;letter-spacing:0;";
    out = out.replace(
        /([\u3400-\u9FFF\u3005\u3006\u30F5\u30F6])\uFF08([\u3041-\u3096\u30A1-\u30FA\u30FC\u3099\u309A\u30FB\uFF65]+)\uFF09/gu,
        `$1<span style="${style}">（$2）</span>`
    );
    out = out.replace(
        /([\u3400-\u9FFF\u3005\u3006\u30F5\u30F6])\(([\u3041-\u3096\u30A1-\u30FA\u30FC\u3099\u309A\u30FB\uFF65]+)\)/gu,
        `$1<span style="${style}">($2)</span>`
    );
    return out;
};


const normalizeTargetSentence = (text) => {
    if (!text || typeof text !== 'string') return "";
    return cleanTextForDisplay(text)
        .replace(/<small>[\s\S]*?<\/small>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const renderTargetSentenceHtml = (original, fixed) => {
    const source = (fixed && fixed.trim()) ? fixed : (original || "");
    const normalized = normalizeTargetSentence(source);
    const escaped = escapeHtml(normalized);
    const withReading = shrinkReadingParenthesesHtml(escaped);
    return withReading.replace(/~~(.*?)~~/g, '<del>$1</del>');
};

const shouldAcceptTargetFix = (original, fixed, confidence = "") => {
    if (!fixed || typeof fixed !== 'string') return false;
    if (confidence && confidence !== 'HIGH') return false;
    const o = normalizeTargetSentence(stripStrike(original));
    const f = normalizeTargetSentence(stripStrike(fixed));
    if (!o || !f) return false;
    const oTokens = o.toLowerCase().split(/\s+/).filter(Boolean);
    const fTokens = f.toLowerCase().split(/\s+/).filter(Boolean);
    if (oTokens.length === 0 || fTokens.length === 0) return false;
    const oSet = new Set(oTokens);
    const fSet = new Set(fTokens);
    const oHyphenTokens = oTokens.filter(t => t.includes('-'));
    if (oHyphenTokens.length > 0 && confidence !== 'HIGH') {
        const removedHyphen = oHyphenTokens.filter(t => !fSet.has(t));
        if (removedHyphen.length > 0) return false;
    }
    let overlap = 0;
    for (const t of fTokens) if (oSet.has(t)) overlap++;
    const overlapRatio = overlap / Math.max(oTokens.length, fTokens.length);
    const lenRatio = Math.min(oTokens.length, fTokens.length) / Math.max(oTokens.length, fTokens.length);
    return overlapRatio >= 0.55 && lenRatio >= 0.6;
};

const stripMarkdownInline = (text) => {
    if (!text || typeof text !== 'string') return "";
    return text
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(?!\*)([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
};

const cleanupExtractedSentence = (text) => {
    if (!text || typeof text !== 'string') return "";
    return text
        .replace(TARGET_TAG_CAPTURE_ALL_REGEX, '$1')
        .replace(/\{\{(.*?)\}\}/g, '$1')
        .replace(/^\s*[>\-*]\s*/g, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim();
};

const extractCorrectionSentenceFromContent = (content) => {
    if (!content || typeof content !== 'string') return "";
    const labels = [
        '校正後的字幕', '校正後字幕', '修正後的字幕', '修正後字幕', '更正後的字幕', '更正後字幕', '正確字幕',
        'Corrected subtitle', 'Corrected sentence', 'Corrected line'
    ];
    const labelPattern = new RegExp(`(?:${labels.join('|')})`, 'i');
    const labelRegex = new RegExp(`^(?:\\s*[-*]\\s*)?(?:${labels.join('|')})(?:\\s*[（(][^）)]*[）)])?\\s*[:：]?\\s*(.*)$`, 'i');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        let line = stripMarkdownInline(lines[i] || "");
        if (!line) continue;
        let tail = "";
        let matched = false;
        const m = line.match(labelRegex);
        if (m) {
            matched = true;
            tail = (m[1] || "").trim();
        } else if (labelPattern.test(line)) {
            matched = true;
            const parts = line.split(/[:：]/);
            if (parts.length > 1) tail = parts.slice(1).join(':').trim();
        }
        if (!matched) continue;
        if (!tail) {
            for (let j = i + 1; j < lines.length; j++) {
                const next = stripMarkdownInline(lines[j] || "");
                if (!next) continue;
                tail = next;
                break;
            }
        }
        const cleaned = cleanupExtractedSentence(tail);
        if (cleaned) return cleaned;
    }
    return "";
};

const formatTutorText = (text) => {
    if (!text || typeof text !== 'string') return text;
    if (text.includes('\n')) return text;
    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) {
        return text.replace(/([。！？])\s*/g, '$1\n');
    }
    return text.replace(/([.!?])\s+/g, '$1\n');
};

const stripTutorChineseHintLines = (text) => {
    const raw = String(text || '');
    if (!raw) return '';
    return raw
        .split(/\r?\n/)
        .filter(line => !/^\s*(?:中文提示|Chinese\s*Hint)\s*[:：]/i.test(String(line || '').trim()))
        .join('\n')
        .replace(/(?:^|\n)\s*中文提示\s*[:：][^\n]*/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

const normalizeVoiceLabel = (text) => {
    return String(text || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
};

const getTtsLangParts = (lang = "") => {
    const normalized = String(lang || "").replace(/_/g, "-").toLowerCase();
    const [family = "", region = ""] = normalized.split("-");
    return { normalized, family, region };
};

const ttsVoiceQualityScore = (voice, requestedLang = "") => {
    const rawName = String(voice?.name || "");
    const rawUri = String(voice?.voiceURI || "");
    const label = normalizeVoiceLabel(`${rawName} ${rawUri}`);
    const rawLabel = `${rawName} ${rawUri}`;
    const voiceLang = getTtsLangParts(voice?.lang || "");
    const requestLang = getTtsLangParts(requestedLang || voice?.lang || "");
    let score = 0;

    if (voiceLang.normalized && requestLang.normalized && voiceLang.normalized === requestLang.normalized) {
        score += 4000;
    } else if (voiceLang.family && requestLang.family && voiceLang.family === requestLang.family) {
        score += 1000;
    }

    if (requestLang.family === "zh") {
        if (requestLang.region === "tw" && /(?:zh[-_]tw|taiwan|traditional|繁體|台灣|臺灣|國語|mandarin\s*taiwan)/i.test(`${voice?.lang || ""} ${rawLabel}`)) score += 900;
        if (requestLang.region === "hk" && /(?:zh[-_]hk|hong\s*kong|cantonese|粵語|廣東話|香港)/i.test(`${voice?.lang || ""} ${rawLabel}`)) score += 900;
        if ((requestLang.region === "cn" || requestLang.region === "hans") && /(?:zh[-_]cn|china|simplified|普通话|普通話|简体|簡體)/i.test(`${voice?.lang || ""} ${rawLabel}`)) score += 900;

        if (/(?:mei[-\s]?jia|meijia|han[-\s]?han|hanhan|hsiao[-\s]?chen|hsiaochen|xiaoxiao|ting[-\s]?ting|tingting)/i.test(label)) score += 500;
        if (/(?:yun[-\s]?jhe|yunjhe|yunxi|yunjian|zhiwei|sin[-\s]?ji|sinji)/i.test(label)) score -= 350;
    }

    if (requestLang.family === "en") {
        if (requestLang.region === "us" && /(?:en[-_]us|us\s+english|united\s+states|american)/i.test(`${voice?.lang || ""} ${rawLabel}`)) score += 800;
        if (/(?:samantha|ava|nicky|allison|susan|jenny|aria|michelle|natasha|google\s+us\s+english)/i.test(label)) score += 350;
        if (/(?:david|mark|guy|brian|ryan|george|fred|ralph|daniel)/i.test(label)) score -= 250;
    }

    // Cross-language "enhanced quality" markers (highest priority).
    if (
        /(?:^|\b)(enhanced|high quality|high-quality|hq voice|hq)(?:\b|$)/.test(label) ||
        /增強音質|增强音质|高品質|高品质|高音質|プレミアム|고품질|프리미엄/.test(rawLabel)
    ) score += 1000;

    // High-tier engines, still below explicit enhanced labels.
    if (/(?:^|\b)(premium|neural2?|studio|wavenet|journey|pro)(?:\b|$)/.test(label)) score += 900;
    if (/(?:^|\b)(natural)(?:\b|$)/.test(label)) score += 750;

    // Provider preference as fallback only.
    if (/(?:^|\b)(google)(?:\b|$)/.test(label)) score += 600;
    if (/(?:^|\b)(microsoft)(?:\b|$)/.test(label)) score += 500;
    if (/(?:^|\b)(apple|siri|macos)(?:\b|$)/.test(label)) score += 400;

    if (voice?.default) score += 50;
    if (voice?.localService) score += 10;
    return score;
};

const chooseBestTtsVoice = (voices, langHint) => {
    if (!Array.isArray(voices) || voices.length === 0) return null;
    const requested = getTtsLangParts(langHint || "");
    const prefix = requested.family;
    const langVoices = voices.filter(v => String(v?.lang || "").toLowerCase().startsWith(prefix));
    if (langVoices.length === 0) return null;

    // User preference: on English tracks, prioritize Google US English when available.
    if (prefix === 'en' && (!requested.normalized || requested.normalized === 'en-us')) {
        const preferredGoogleUs = langVoices.find((v) => {
            const name = String(v?.name || '').toLowerCase();
            const uri = String(v?.voiceURI || '').toLowerCase();
            const lang = String(v?.lang || '').toLowerCase();
            return lang === 'en-us' && /google\s+us\s+english/.test(`${name} ${uri}`);
        });
        if (preferredGoogleUs) return preferredGoogleUs;

        const anyGoogleEnUs = langVoices.find((v) => {
            const name = String(v?.name || '').toLowerCase();
            const uri = String(v?.voiceURI || '').toLowerCase();
            const lang = String(v?.lang || '').toLowerCase();
            return lang === 'en-us' && /google/.test(`${name} ${uri}`);
        });
        if (anyGoogleEnUs) return anyGoogleEnUs;
    }

    return langVoices
        .slice()
        .sort((a, b) => ttsVoiceQualityScore(b, requested.normalized) - ttsVoiceQualityScore(a, requested.normalized))[0] || null;
};

const isTtsVoiceCompatibleWithLang = (voice, langHint = "") => {
    const voiceLang = getTtsLangParts(voice?.lang || "");
    const requested = getTtsLangParts(langHint || "");
    if (!voiceLang.family || !requested.family || voiceLang.family !== requested.family) return false;
    if (requested.family === "zh") {
        return voiceLang.normalized === requested.normalized;
    }
    return true;
};

const normalizeMarkdownHeadingKey = (line) => {
    return String(line || "")
        .replace(/^\s*#{1,6}\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
};

const splitMarkdownLevel3Sections = (text) => {
    const raw = String(text || "").replace(/\r/g, '');
    if (!raw.trim()) return { preface: "", sections: [] };

    const lines = raw.split('\n');
    const sections = [];
    const prefaceLines = [];
    let current = null;

    const flushCurrent = () => {
        if (!current) return;
        const sectionRaw = current.lines.join('\n').trim();
        if (sectionRaw) {
            sections.push({
                heading: current.heading,
                headingKey: current.headingKey,
                raw: sectionRaw
            });
        }
        current = null;
    };

    for (const line of lines) {
        if (/^\s*###\s+/.test(line)) {
            flushCurrent();
            current = {
                heading: line.trim(),
                headingKey: normalizeMarkdownHeadingKey(line),
                lines: [line]
            };
            continue;
        }
        if (current) current.lines.push(line);
        else prefaceLines.push(line);
    }
    flushCurrent();

    return {
        preface: prefaceLines.join('\n').trim(),
        sections
    };
};

const mergeStableExplainContent = (pinnedContent, fullContent) => {
    const pinned = String(pinnedContent || "").trim();
    const full = String(fullContent || "").trim();
    if (!pinned) return full;
    if (!full) return pinned;
    if (full === pinned) return pinned;
    if (full.startsWith(pinned)) return full;

    const pinnedParsed = splitMarkdownLevel3Sections(pinned);
    const fullParsed = splitMarkdownLevel3Sections(full);
    if (pinnedParsed.sections.length === 0 || fullParsed.sections.length === 0) return pinned;

    const pinnedKeys = new Set(
        pinnedParsed.sections
            .map(s => s.headingKey)
            .filter(Boolean)
    );
    const extraSections = fullParsed.sections.filter(s => s.raw && !pinnedKeys.has(s.headingKey));
    if (extraSections.length === 0) return pinned;

    const appendix = extraSections.map(s => s.raw).join('\n\n');
    return `${pinned}\n\n---\n\n${appendix}`.trim();
};

// [NEW] Extract Latin phrases but KEEP digits/currency/common connectors (e.g., $300, S&P, C++, C#) for TTS completeness
const extractLatinPhrasesForAudio = (text) => {
    if (!text || typeof text !== 'string') return "";
    const cleaned = text
        .replace(/<small>[\s\S]*?<\/small>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\{\{(.*?)\}\}/g, '$1')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        // Remove inline emphasis/scare quotes before phrase extraction;
        // otherwise a sentence like the “leverage” in this... gets split into
        // multiple phrases joined by " / ", which later becomes audible pauses.
        .replace(/[“”"]/g, ' ')
        .replace(/(^|[\s([{])['‘’]+([A-Za-z])/g, '$1$2')
        .replace(/([A-Za-z])['‘’]+(?=[\s)\]}.,;:!?]|$)/g, '$1');
    if (!/\p{Script=Latin}/u.test(cleaned)) return "";
    const matches = cleaned.match(/[\p{Script=Latin}0-9$€£¥&+#@][\p{Script=Latin}0-9$€£¥&+#@'’\-.,:%/]*(?:\s+[\p{Script=Latin}0-9$€£¥&+#@][\p{Script=Latin}0-9$€£¥&+#@'’\-.,:%/]*)*/gu);
    if (!matches) return "";
    const phrases = [];
    for (const m of matches) {
        const t = m.trim();
        if (!t) continue;
        if (phrases[phrases.length - 1] !== t) phrases.push(t);
    }
    return phrases.join(' / ');
};

// [NEW] Target-language tag helpers
const extractTaggedTargetText = (text) => {
    if (!text || typeof text !== 'string') return "";
    const regex = new RegExp(TARGET_TAG_CAPTURE_ALL_REGEX.source, 'gi');
    const parts = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        if (m[1]) parts.push(m[1]);
    }
    return parts.join(' ').replace(/<[^>]*>/g, '').trim();
};

const chooseTaggedSpeakerText = ({ taggedText = "", fallbackText = "", trackLanguage = "en-US" } = {}) => {
    const tagged = String(taggedText || "").replace(/\s+/g, ' ').trim();
    const fallback = String(fallbackText || "").replace(/\s+/g, ' ').trim();
    if (!tagged) return fallback;
    if (!fallback) return tagged;

    const taggedWords = tagged.split(/\s+/).filter(Boolean).length;
    const fallbackWords = fallback.split(/\s+/).filter(Boolean).length;
    const extraWords = Math.max(0, fallbackWords - taggedWords);
    const fallbackLower = fallback.toLowerCase();
    const taggedLower = tagged.toLowerCase();
    const fallbackHasCjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(fallback);
    const isCjkTrack = /^(ja|ko|zh)/i.test(String(trackLanguage || ""));
    const hasQuestionSignal = /[?？()（）]|which of the following|choose all that apply|fill in the blank|multiple choice/i.test(fallbackLower);
    const taggedInsideFallback = taggedLower && fallbackLower.includes(taggedLower);

    // If a tagged phrase appears inside a full question/sentence, prefer full sentence reading.
    if (
        taggedInsideFallback &&
        !fallbackHasCjk &&
        (hasQuestionSignal || extraWords >= 3)
    ) {
        return fallback;
    }

    // For CJK-heavy mixed lines, keep only tagged target-language phrase.
    if (isCjkTrack && fallbackHasCjk) return tagged;

    return tagged;
};

const stripTargetTagsForDisplay = (text) => {
    if (!text || typeof text !== 'string') return "";
    return stripBrokenTargetTagFragments(stripTargetLangTags(text));
};

const chunkArray = (arr, size) => {
    if (!Array.isArray(arr) || size <= 0) return [];
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
};

const extractFullVocabularyTerms = (text, trackLanguage = "en-US") => {
    if (!text || typeof text !== 'string') return [];
    const cleaned = cleanTextForDisplay(text)
        .replace(/<small>[\s\S]*?<\/small>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return [];

    const hasListSeparators = /[\n,;|/、，；]+/.test(text);
    let rawTerms = [];

    if (hasListSeparators) {
        rawTerms = text
            .split(/[\n,;|/、，；]+/)
            .map(s => cleanTextForDisplay(s || ""))
            .map(s => s.replace(/^\s*\d+[\.)]\s*/, '').replace(/^\s*[-*]\s*/, '').trim())
            .filter(Boolean);
    } else if (/[A-Za-z]/.test(cleaned)) {
        rawTerms = cleaned.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || [];
    } else {
        const isCjkTrack = /^(ja|ko|zh)/i.test(trackLanguage);
        if (isCjkTrack) {
            rawTerms = cleaned
                .split(/\s+/)
                .map(s => s.trim())
                .filter(Boolean);
        }
    }

    if (rawTerms.length === 0) {
        rawTerms = cleaned.split(/\s+/).map(s => s.trim()).filter(Boolean);
    }

    const seen = new Set();
    const deduped = [];
    for (const t of rawTerms) {
        const normalized = t
            .replace(/^[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+|[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+$/g, '')
            .trim();
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(normalized);
    }

    return deduped.slice(0, 180);
};

const extractBackExamplesForSpeech = (card = null) => {
    if (!card) return "";
    const preferredLang = String(card?.speakLang || card?.targetLanguage || "").trim();
    const direct = sanitizeSpeakerText(
        normalizeJapaneseRubyForSpeech(String(card.speakText || ""), preferredLang || undefined),
        preferredLang || undefined
    );

    const backText = String(card.back || "");
    if (!backText) return direct;
    const exMatch = backText.match(/例句\s*[:：]\s*([\s\S]*)/i);
    if (!exMatch) return direct;

    const rawExamples = String(exMatch[1] || "")
        .split(/\n(?:\s*Tags?\s*[:：]|\s*分類\s*[:：])/i)[0]
        .trim();
    if (!rawExamples) return direct;

    const parsed = splitExampleSegmentsPreservingParens(rawExamples)
        .flatMap(x => stripExampleZhTranslationForSpeech(x).split(/\n+/))
        .map(x => normalizeJapaneseRubyForSpeech(x, preferredLang || undefined))
        .map(x => cleanQuizDisplayText(x))
        .filter(Boolean)
        .join("\n");
    const countLines = (value) => String(value || "").split(/\n+/).map(x => x.trim()).filter(Boolean).length;
    if (parsed && countLines(parsed) > countLines(direct)) return parsed;
    return direct || parsed;
};

const extractBackExampleZhTranslations = (card = null) => {
    if (!card) return "";
    const backText = String(card.back || "");
    if (!backText) return "";
    const exMatch = backText.match(/例句\s*[:：]\s*([\s\S]*)/i);
    if (!exMatch) return "";
    const rawExamples = String(exMatch[1] || "")
        .split(/\n(?:\s*Tags?\s*[:：]|\s*分類\s*[:：])/i)[0]
        .trim();
    if (!rawExamples) return "";

    const out = [];
    const seen = new Set();
    const push = (value) => {
        const cleaned = cleanQuizDisplayText(String(value || ""))
            .replace(/^[\s:：]+/, "")
            .replace(/[\s）)]*$/, "")
            .trim();
        if (!cleaned) return;
        const key = cleaned.replace(/\s+/g, "");
        if (seen.has(key)) return;
        seen.add(key);
        out.push(cleaned);
    };

    // 中譯本身可以有括號，例如「罷免（踢走）了…」。先依最外層
    // 例句分段，再只移除最後的外層中譯括號，不能在第一個 ）截斷。
    for (const exampleSegment of splitExampleSegmentsPreservingParens(rawExamples)) {
        const marker = String(exampleSegment || "").match(/[（(]\s*中譯\s*[:：]\s*/i);
        if (!marker || marker.index == null) continue;
        const translation = String(exampleSegment || "")
            .slice(marker.index + marker[0].length)
            .replace(/[）)]\s*$/, "")
            .trim();
        push(translation);
    }
    if (out.length === 0) {
        rawExamples
            .split(/\r?\n|[\/／]\s*/g)
            .forEach((part) => {
                const lineMatch = String(part || "").match(/中譯\s*[:：]\s*(.+)$/i);
                if (lineMatch) push(lineMatch[1]);
            });
    }
    return out.join("\n");
};

// ============================================================================
// [PROMPT TEMPLATES]
// ============================================================================
const SYSTEM_PROMPT_CORE = (level) => `
[STRICT SYSTEM RULES]
1. OUTPUT LANGUAGE: MUST BE **Traditional Chinese (繁體中文)** for explanations.
2. ROLE: Expert Native Instructor.
3. LEARNER LEVEL: ${level}/10 (1=Beginner, 10=Native). 
4. **FORMATTING RESTRICTIONS (CRITICAL)**:
   - **STRICTLY NO LATEX**: NEVER use '$' signs, '\\text{}', or math symbols for text formatting. The user's browser CANNOT render them.
   - **FORMULA FORMAT**:
     * BAD: $\\text{[Cause]} + \\text{[Effect]}$
     * BAD: $ A \\to B $
     * GOOD: **[Cause]** + **[Effect]**
     * GOOD: A -> B
   - **NO PINYIN**: Do NOT provide Pinyin unless the Target Language is Chinese.
5. **PEDAGOGY**: 
   - Explanations must be STRICTLY tailored to the learner's level.
   - For key concepts, provide **multiple simple, easy-to-memorize example sentences**.
   - If the user provides input, gently correct their errors.
6. OUTPUT FORMAT PRIORITY: Always follow task-specific output requirements exactly.
   - If the task asks JSON/plain text, do NOT output markdown tables.
   - If the task asks markdown/table, follow that requested structure.
`;

const SYSTEM_PROMPT_LIVE_CALL = (level) => `
[SYSTEM ROLE: VOICE CALL MODE]
You are a friendly language tutor on a voice call.
CURRENT LEARNER LEVEL: ${level}/10.
INSTRUCTIONS:
1. **STYLE**: Spoken, conversational, warm. 
2. **CONTEXT**: User is watching a video. 
3. **LANGUAGE**: Speak primarily in the Target Language. Use Traditional Chinese only for difficult explanations.
4. **TEACHING DUTIES**:
   - Listen for user's errors (grammar, vocab, pronunciation).
   - Gently correct them in the target language (or Chinese if needed).
   - Suggest better expressions.
   - Keep your own sentence structure and vocabulary suitable for Level ${level}.
`;

const SYSTEM_PROMPT_TUTOR_TARGET = (level) => `
[SYSTEM ROLE: VOICE TUTOR TARGET MODE]
OUTPUT LANGUAGE: Target Language ONLY.
LEARNER LEVEL: ${level}/10.
STYLE: Spoken, warm, encouraging. Short sentences. Natural phrasing.
GUIDANCE:
- Prefer simple, high-frequency vocabulary.
- Use contractions if natural in the Target Language.
- Vary sentence length slightly to sound natural.
- Add natural pauses using commas or ellipses occasionally.
- Use mild emotion (encouraging, friendly) without being dramatic.
- Aim for 10-12 short sentences per response.
- Output one sentence per line (use line breaks).
- STRICT: Do NOT output Traditional Chinese or any Chinese hint line.
`;

const SYSTEM_PROMPT_PRONUNCIATION = `
[SYSTEM ROLE]
You are a strict linguistic expert specializing in phonetics and speech coaching.

[TASK]
Analyze the user's pronunciation audio against the provided Target Text.

[OUTPUT FORMAT]
Return ONLY a valid, raw JSON object (no markdown fences, no backticks) with this exact structure:
{
  "translation": "Traditional Chinese translation of the target sentence (string)",
  "overall_score": 0-100 (integer),
  "words": [
    {
      "word": "TargetWord (string)", 
      "score": 0-100 (integer), 
      "status": "perfect" | "warning" | "bad",
      "advice": "Specific correction advice in **Traditional Chinese** (繁體中文). Explain how to fix the mouth shape or tongue position. (e.g. '你的 /r/ 發音太弱，舌頭要捲起'). If status is perfect, return empty string."
    }
  ],
  "fluency_advice": "Advice on liaison/pauses in Traditional Chinese (string)",
  "intonation_advice": "Advice on pitch/tone in Traditional Chinese (string)",
  "general_comment": "Brief encouragement in Traditional Chinese (string)"
}

[SCORING RULES]
- Perfect (80-100): Green.
- Warning (50-79): Yellow. Minor accent or stress error.
- Bad (0-49): Red. Wrong phoneme or skipped word.
`;

// [UPDATED] Dynamic table format by target language (no hard-coded single-language behavior)
const buildPromptTableFormat = (targetLanguage = "en-US") => {
    const safeLang = String(targetLanguage || "target").trim() || "target";
    const isJapanese = /^ja(?:-|$)/i.test(safeLang);
    const japaneseKanjiRule = isJapanese ? `
[JP KANJI RULE - REQUIRED]
- For Japanese entries, if a common Kanji form exists, you MUST show Kanji + reading together in "Target Word/Phrase".
- Required format example: \`<T lang="${safeLang}">午前（ごぜん）</T>\`.
- Do NOT output kana-only when common Kanji exists.
- Typical required pairs: ごぜん→午前（ごぜん）, ごご→午後（ごご）, あさ→朝（あさ）, ひる→昼（ひる）, ばん→晩（ばん）.
` : "";
    return `
[TABLE REQUIREMENT]
Create a Markdown table with exactly these columns:
| Target Word/Phrase | Pronunciation/Reading (optional) | Part of Speech | Meaning (Chinese) | Collocations (with Chinese) | Example Sentence (Target Lang) |

[RULES]
0. Use headings with ### only. Avoid ####.
1. "Target Word/Phrase":
   - Content: The word/phrase in Target Language.
   - **FORMAT**: Wrap strictly with target-language tags, e.g., \`<T lang="${safeLang}">apple</T>\`.
   - Keep original script/spelling. Do NOT rewrite this into a different foreign language script for analysis.
2. "Pronunciation/Reading": IPA or reading help only when needed.
3. "Part of Speech": n., v., adj., etc.
4. "Meaning": Explanation in Traditional Chinese.
5. "Collocations (with Chinese)":
   - Content: Common collocations in Target Language.
   - **FORMAT**: \`<T lang="${safeLang}">collocation</T> (中文)\`.
   - **REQUIREMENT**: You MUST provide the Chinese translation for each collocation.
6. "Example Sentence": 
   - Content: Sentence in Target Language.
   - **FORMAT**: Wrap the ENTIRE sentence with target-language tags, e.g., \`<T lang="${safeLang}">This is a **book**.</T>\`.
   - **IMPORTANT**: You MUST use bold \`**...**\` to highlight the target word/phrase WITHIN the example sentence.
   - Add translation on the next line in **small** style: \`<small>中文翻譯</small>\`.
   - Do NOT replace the original target sentence with another non-Chinese language version.
   - Example: \`<T lang="${safeLang}">This is a **book**.</T><br><small>這是一本書。</small>\`.
${japaneseKanjiRule}
`;
};

// ============================================================================
// [MODULE 1]: CONTEXT & SERVICES
// ============================================================================

const AudioCacheContext = React.createContext({
    cache: {},
    addToCache: () => { },
    currentKey: "",
    trackLanguage: "en-US",
    preferredVoice: null,
    globalAudioRef: null
});


const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const KNOWN_KNOWLEDGE_TEXT_RE = /LRC\s*知識點整理|===\s*(?:單字|用語|文法|句型|閱讀|聽力)|@K_HEADER@|\[原文\]|中譯[:：]/i;
const SUSPICIOUS_BOOKMARK_TEXT_RE = /NSURLBookmark|NSURLError|bookmark(?:data)?|Macintosh\s*HD|file:\/\/\//i;

const scoreDecodedKnowledgeCandidate = (text = "") => {
    const s = String(text || "");
    if (!s) return -9999;
    let score = 0;
    if (KNOWN_KNOWLEDGE_TEXT_RE.test(s)) score += 90;
    if (SUSPICIOUS_BOOKMARK_TEXT_RE.test(s)) score -= 120;
    const replacement = (s.match(/\uFFFD/g) || []).length;
    const ctrl = (s.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
    score -= replacement * 3;
    score -= ctrl * 4;
    const printable = (s.match(/[^\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
    const ratio = s.length > 0 ? printable / s.length : 0;
    score += Math.round(ratio * 10);
    return score;
};

const decodeArrayBufferBestEffort = (buffer) => {
    const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
    if (!bytes.length) return "";

    const candidates = [];
    const tryDecode = (enc) => {
        try {
            const txt = new TextDecoder(enc, { fatal: false }).decode(bytes);
            if (txt) candidates.push({ enc, text: txt, score: scoreDecodedKnowledgeCandidate(txt) });
        } catch (_) { }
    };

    const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
    const hasUtf16LeBom = bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE;
    const hasUtf16BeBom = bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF;

    if (hasUtf8Bom) tryDecode("utf-8");
    if (hasUtf16LeBom) tryDecode("utf-16le");
    if (hasUtf16BeBom) tryDecode("utf-16be");

    tryDecode("utf-8");
    tryDecode("utf-16le");
    tryDecode("utf-16be");
    tryDecode("big5");

    if (!candidates.length) return "";
    candidates.sort((a, b) => b.score - a.score);
    return String(candidates[0].text || "");
};

const isSuspiciousBinaryKnowledgeText = (text = "") => {
    const s = String(text || "");
    if (!s.trim()) return false;
    if (/^bplist00/.test(s)) return true;
    if (SUSPICIOUS_BOOKMARK_TEXT_RE.test(s) && !KNOWN_KNOWLEDGE_TEXT_RE.test(s)) return true;
    const replacement = (s.match(/\uFFFD/g) || []).length;
    const ctrl = (s.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
    return replacement > 24 || ctrl > 16;
};

const readTextFileRobust = async (file, { purpose = "text" } = {}) => {
    if (!file) throw new Error("檔案不存在。");
    let text = "";
    if (typeof file.arrayBuffer === "function") {
        try {
            const buf = await file.arrayBuffer();
            text = decodeArrayBufferBestEffort(buf);
        } catch (_) { }
    }
    if (!text && typeof file.text === "function") {
        text = await file.text();
    }
    text = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (purpose === "knowledge" && isSuspiciousBinaryKnowledgeText(text)) {
        throw new Error(`知識點檔讀取到非文字資料（可能是 macOS 書籤/捷徑檔），請改選真正的 .txt 文字檔：${String(file?.name || "unknown")}`);
    }
    return text;
};

const isLikelyPlainTextDocumentFile = (file) => {
    const name = String(file?.name || "").toLowerCase();
    const type = String(file?.type || "").toLowerCase();
    return (
        type.startsWith("text/") ||
        /\.(txt|md|markdown|srt|vtt|lrc|csv|tsv|json|html?|xml)$/i.test(name)
    );
};

const readManualDocumentText = async (file) => {
    if (!file) throw new Error("檔案不存在。");
    const name = String(file?.name || "").trim() || "unknown";
    const lower = name.toLowerCase();
    if (lower.endsWith(".pdf") || String(file?.type || "").toLowerCase() === "application/pdf") {
        throw new Error(`目前不能直接讀取 PDF：${name}。請先用 OCR 轉成 .md/.txt 後再開啟。`);
    }
    if (lower.endsWith(".epub") || String(file?.type || "").toLowerCase().includes("epub")) {
        throw new Error(`目前不能直接讀取 EPUB：${name}。請先匯出或轉成 .md/.txt 後再開啟。`);
    }
    if (!isLikelyPlainTextDocumentFile(file)) {
        throw new Error(`目前只支援文字檔：${name}。可開啟 .txt、.md、.srt、.vtt、.lrc 等純文字檔。`);
    }
    const text = String(await readTextFileRobust(file, { purpose: "text" }) || "").trim();
    if (isSuspiciousBinaryKnowledgeText(text)) {
        throw new Error(`檔案不像純文字內容：${name}。請改選 .txt/.md，或先將 PDF/EPUB 轉成文字。`);
    }
    return text;
};

// --- AUDIO SEGMENT VERIFICATION UTILS ---
const blobToBase64 = (blob) => {
    return new Promise((resolve, reject) => {
        try {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = reader.result;
                const base64 = typeof result === 'string' ? result.split(',')[1] : "";
                resolve(base64 || "");
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        } catch (e) {
            reject(e);
        }
    });
};

const recordAudioSliceFromPlayer = async (playerEl, startSec, endSec, playbackRate = 1.0) => {
    if (!playerEl) return null;

    // IMPORTANT: Do NOT disturb the main player playback state.
    // Use a hidden, separate Audio element fed by the same src, and captureStream from it.
    const src = playerEl.currentSrc;
    if (!src) return null;

    const probeEl = new Audio();
    probeEl.src = src;
    probeEl.preload = 'auto';
    probeEl.muted = true;
    probeEl.volume = 0;
    probeEl.playbackRate = playbackRate;

    // Wait for metadata so we can seek
    await new Promise((resolve, reject) => {
        const onLoaded = () => {
            cleanup();
            resolve();
        };
        const onErr = () => {
            cleanup();
            reject(new Error('Probe audio failed to load metadata'));
        };
        const cleanup = () => {
            probeEl.removeEventListener('loadedmetadata', onLoaded);
            probeEl.removeEventListener('error', onErr);
        };
        probeEl.addEventListener('loadedmetadata', onLoaded);
        probeEl.addEventListener('error', onErr);
        // In case metadata is already available
        if (probeEl.readyState >= 1) {
            cleanup();
            resolve();
        }
    });

    const canCapture = typeof probeEl.captureStream === 'function' || typeof probeEl.mozCaptureStream === 'function';
    if (!canCapture) return null;

    const stream = (probeEl.captureStream?.() || probeEl.mozCaptureStream?.());
    if (!stream) return null;

    const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'video/webm;codecs=opus',
        'video/webm'
    ];
    const mimeType = mimeCandidates.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';

    let recorder;
    try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (e) {
        try {
            recorder = new MediaRecorder(stream);
        } catch (e2) {
            return null;
        }
    }

    const chunks = [];
    recorder.ondataavailable = (evt) => {
        if (evt.data && evt.data.size > 0) chunks.push(evt.data);
    };

    // Clamp and cap duration (keep it small and robust)
    const sliceStart = Math.max(0, startSec);
    const maxLenSec = 12;
    const sliceEnd = Math.min(endSec, sliceStart + maxLenSec);
    const waitMs = Math.max(150, (sliceEnd - sliceStart) * 1000 / Math.max(0.25, playbackRate));

    // Seek probe element
    probeEl.currentTime = sliceStart;

    // Ensure seek settles
    await new Promise((r) => {
        const onSeeked = () => { probeEl.removeEventListener('seeked', onSeeked); r(); };
        probeEl.addEventListener('seeked', onSeeked);
        setTimeout(() => { try { probeEl.removeEventListener('seeked', onSeeked); } catch (_) { } r(); }, 300);
    });

    return await new Promise((resolve) => {
        let resolved = false;
        const finalize = () => {
            if (resolved) return;
            resolved = true;
            try { recorder.stop(); } catch (_) { }
        };

        recorder.onstop = () => {
            try {
                probeEl.pause();
                probeEl.src = '';
            } catch (_) { }

            if (chunks.length === 0) return resolve(null);
            const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
            resolve(blob);
        };

        try {
            recorder.start();
        } catch (_) {
            try { probeEl.pause(); probeEl.src = ''; } catch (_) { }
            return resolve(null);
        }

        // Play the probe element (muted) to generate stream data.
        probeEl.play().catch(() => { });

        setTimeout(finalize, waitMs);
        setTimeout(finalize, waitMs + 1200);
    });
};

const handleApiError = async (response, type) => {
    if (!response.ok) {
        let errorText = "";
        try { errorText = await response.text(); } catch (e) { errorText = response.statusText; }
        throw new Error(`${type} API Error ${response.status}: ${errorText}`);
    }
    const text = await response.text();
    if (!text) throw new Error(`${type} API returned empty response.`);
    try { return JSON.parse(text); } catch (e) { throw new Error(`${type} Response is not valid JSON`); }
};

const getStoredApiKeySafe = () => {
    const pickKeyFromStorage = (storage) => {
        if (!storage) return "";
        const exact = String(storage.getItem('gemini_api_key') || '').trim();
        if (exact) return exact;
        const maybeNames = ['apiKey', 'apikey', 'geminiKey', 'googleApiKey', 'aiKey', 'llmKey'];
        for (let i = 0; i < storage.length; i++) {
            const k = String(storage.key(i) || "");
            const v = String(storage.getItem(k) || "");
            const lowerK = k.toLowerCase();
            if (/gemini|google|generative|api[_-]?key|ai[_-]?key|llm/i.test(lowerK)) {
                const exactHit = v.match(/AIza[0-9A-Za-z\-_]{20,}/);
                if (exactHit) return exactHit[0];
                try {
                    const obj = JSON.parse(v);
                    for (const n of maybeNames) {
                        const key = String(obj?.[n] || "").trim();
                        if (key) return key;
                    }
                } catch (_) { }
            }
            const regexHit = v.match(/AIza[0-9A-Za-z\-_]{20,}/);
            if (regexHit) return regexHit[0];
        }
        return "";
    };

    try {
        if (typeof window === 'undefined') return "";
        const localHit = pickKeyFromStorage(window.localStorage);
        if (localHit) return localHit;
        const sessionHit = pickKeyFromStorage(window.sessionStorage);
        if (sessionHit) return sessionHit;
        try {
            if (window.parent && window.parent !== window) {
                const parentLocal = pickKeyFromStorage(window.parent.localStorage);
                if (parentLocal) return parentLocal;
                const parentSession = pickKeyFromStorage(window.parent.sessionStorage);
                if (parentSession) return parentSession;
            }
        } catch (_) { }
        const search = String(window.location?.search || "");
        const queryHit = search.match(/(?:[?&](?:key|api_key|gemini_key|gkey)=)([^&]+)/i);
        if (queryHit && queryHit[1]) return decodeURIComponent(queryHit[1]);
    } catch (_) { }
    return "";
};

const getInjectedApiKeySafe = () => {
    try {
        if (typeof window === 'undefined') return "";
        const candidates = [
            window.__GEMINI_API_KEY__,
            window.GEMINI_API_KEY,
            window.__APP_GEMINI_API_KEY__,
            window.__APP_CONFIG__?.geminiApiKey,
            window.__APP_CONFIG__?.apiKey,
            window.__ENV__?.GEMINI_API_KEY,
            window.__NEXT_DATA__?.props?.pageProps?.geminiApiKey,
            window.__NEXT_DATA__?.props?.pageProps?.apiKey
        ];
        for (const c of candidates) {
            const key = String(c || '').trim();
            if (key) return key;
        }
        const scopes = [window.__APP_CONFIG__, window.__ENV__, window.__NEXT_DATA__, window.__NUXT__];
        for (const s of scopes) {
            if (!s || typeof s !== 'object') continue;
            const text = JSON.stringify(s);
            const hit = text.match(/AIza[0-9A-Za-z\-_]{20,}/);
            if (hit) return hit[0];
        }
    } catch (_) { }
    return "";
};

const resolveApiKey = (explicitKey) => {
    const byArg = String(explicitKey || '').trim();
    if (byArg) return byArg;
    const byStored = getStoredApiKeySafe();
    if (byStored) return byStored;
    const byInjected = getInjectedApiKeySafe();
    if (byInjected) return byInjected;
    return String(apiKey || '').trim();
};

const discoverWindowBridgeFns = () => {
    if (typeof window === 'undefined') return [];
    const out = [];
    const seen = new Set();

    const pushFn = (name, fn, owner = null) => {
        if (typeof fn !== 'function') return;
        const normalizedName = String(name || '').trim();
        if (!normalizedName) return;
        const lowerName = normalizedName.toLowerCase();
        if (lowerName === 'fetch' || lowerName.endsWith('.fetch')) return;
        if (seen.has(fn)) return;
        let src = "";
        try { src = Function.prototype.toString.call(fn); } catch (_) { src = ""; }
        if (/\[native code\]/.test(src)) {
            // Keep likely host bridge natives (some platforms inject native-bound bridge methods).
            const maybeBridgeNative = /gemini|googleai|genai|openai|llm|aibridge|ai[_-]?bridge|jsx|invoke|generate|chat|model/i.test(normalizedName);
            if (!maybeBridgeNative) return;
        }
        seen.add(fn);
        out.push({ name: normalizedName, fn, owner });
    };

    const fnNamePattern = /gemini|googleai|genai|openai|llm|langmodel|aibridge|ai[_-]?bridge|jsx|generate(text)?|chat(complete|reply)?|invoke(model|ai)|ask(ai|llm)|completion/i;
    const objectNamePattern = /^__|gemini|googleai|genai|openai|llm|langmodel|aibridge|ai[_-]?bridge|jsx|runtime|bridge|model|chat|sdk|host/i;
    const srcPattern = /generativelanguage\.googleapis\.com|generateContent|gemini-2\.5|googleapis\.com\/v1beta\/models|contents\s*:\s*\[\s*\{\s*parts|api[_-]?key/i;

    const scopes = [{ label: 'window', obj: window }];
    try {
        if (window.parent && window.parent !== window) scopes.push({ label: 'parent', obj: window.parent });
    } catch (_) { }
    try {
        if (window.top && window.top !== window && !scopes.some(s => s.obj === window.top)) {
            scopes.push({ label: 'top', obj: window.top });
        }
    } catch (_) { }

    for (const scope of scopes) {
        const scopeLabel = scope.label;
        const scopeObj = scope.obj;
        if (!scopeObj) continue;

        let propNames = [];
        try {
            propNames = Array.from(new Set([
                ...Object.keys(scopeObj),
                ...Object.getOwnPropertyNames(scopeObj)
            ]));
        } catch (_) {
            propNames = [];
        }

        for (const name of propNames) {
            let value;
            try { value = scopeObj[name]; } catch (_) { continue; }
            const fullName = scopeLabel === 'window' ? String(name) : `${scopeLabel}.${name}`;

            if (typeof value === 'function') {
                if (fnNamePattern.test(name)) {
                    pushFn(fullName, value, scopeObj);
                } else {
                    let src = "";
                    try { src = Function.prototype.toString.call(value); } catch (_) { src = ""; }
                    if (src && srcPattern.test(src)) {
                        pushFn(fullName, value, scopeObj);
                    }
                }
                continue;
            }
            if (!value || typeof value !== 'object') continue;
            if (!objectNamePattern.test(name)) continue;

            let nestedNames = [];
            try { nestedNames = Array.from(new Set([...Object.keys(value), ...Object.getOwnPropertyNames(value)])); } catch (_) { nestedNames = []; }
            for (const n of nestedNames) {
                let fn;
                try { fn = value[n]; } catch (_) { continue; }
                if (typeof fn !== 'function') continue;
                const fullNested = scopeLabel === 'window' ? `${name}.${n}` : `${scopeLabel}.${name}.${n}`;
                if (fnNamePattern.test(n)) {
                    pushFn(fullNested, fn, value);
                    continue;
                }
                let src = "";
                try { src = Function.prototype.toString.call(fn); } catch (_) { src = ""; }
                if (src && srcPattern.test(src)) {
                    pushFn(fullNested, fn, value);
                }
            }
        }
    }
    return out;
};

const getAccessibleFetchCandidates = () => {
    const out = [];
    const seen = new Set();
    const add = (name, owner, fn) => {
        if (typeof fn !== 'function') return;
        if (seen.has(fn)) return;
        seen.add(fn);
        out.push({ name, owner, fn });
    };
    if (typeof window === 'undefined') return out;
    try {
        if (window.parent && window.parent !== window) {
            add('parent.fetch', window.parent, window.parent.fetch);
        }
    } catch (_) { }
    try {
        if (window.top && window.top !== window) {
            add('top.fetch', window.top, window.top.fetch);
        }
    } catch (_) { }
    try { add('window.fetch', window, window.fetch); } catch (_) { }
    return out;
};

const getNativeBridgeCandidates = () => {
    const out = [];
    const add = (name, fn, owner = null, kind = "fn") => {
        if (typeof fn !== 'function') return;
        out.push({ name, fn, owner, kind });
    };
    if (typeof window === 'undefined') return out;
    try { add('chrome.webview.postMessage', window?.chrome?.webview?.postMessage, window?.chrome?.webview || null, 'webview2'); } catch (_) { }
    try { add('ReactNativeWebView.postMessage', window?.ReactNativeWebView?.postMessage, window?.ReactNativeWebView || null, 'rn'); } catch (_) { }
    try { add('external.notify', window?.external?.notify, window?.external || null, 'external'); } catch (_) { }
    try {
        const handlers = window?.webkit?.messageHandlers || {};
        const keys = Object.keys(handlers);
        for (const k of keys) {
            add(`webkit.messageHandlers.${k}.postMessage`, handlers[k]?.postMessage, handlers[k] || null, 'webkit');
        }
    } catch (_) { }
    return out;
};

const getAuthDebugSnapshot = (explicitKey = "") => {
    try {
        const byArg = !!String(explicitKey || '').trim();
        const byStored = !!getStoredApiKeySafe();
        const byInjected = !!getInjectedApiKeySafe();
        const byConst = !!String(apiKey || '').trim();
        const bridgeFns = discoverWindowBridgeFns();
        const bridgeFnCount = bridgeFns.length;
        const bridgeSample = bridgeFns.slice(0, 8).map(x => x.name).join(', ');
        const fetchCandidates = getAccessibleFetchCandidates();
        const fetchCount = fetchCandidates.length;
        const fetchSample = fetchCandidates.slice(0, 8).map(x => x.name).join(', ');
        const nativeBridges = getNativeBridgeCandidates();
        const nativeBridgeCount = nativeBridges.length;
        const nativeBridgeSample = nativeBridges.slice(0, 8).map(x => x.name).join(', ');
        const hasParent = typeof window !== 'undefined' && window.parent && window.parent !== window;
        return { byArg, byStored, byInjected, byConst, bridgeFnCount, bridgeSample, fetchCount, fetchSample, nativeBridgeCount, nativeBridgeSample, hasParent };
    } catch (_) {
        return { byArg: false, byStored: false, byInjected: false, byConst: false, bridgeFnCount: 0, bridgeSample: "", fetchCount: 0, fetchSample: "", nativeBridgeCount: 0, nativeBridgeSample: "", hasParent: false };
    }
};

const isLikelyPromptEcho = (prompt, text) => {
    const p = String(prompt || "").trim();
    const t = String(text || "").trim();
    if (!p || !t) return false;

    if (t === p) return true;
    if (t.length >= 80 && p.startsWith(t)) return true;
    if (p.length >= 80 && t.startsWith(p.slice(0, Math.min(220, p.length)))) return true;

    const head = t.slice(0, 240);
    if (head.length >= 80 && p.includes(head)) return true;

    const hasStrictBlock = /^\[STRICT SYSTEM RULES\]/i.test(t) && /\[STRICT SYSTEM RULES\]/i.test(p);
    const hasPromptSections = /\[(TASK|OUTPUT|STRICT RULES|CONSTRAINTS|LRC|LANG)\]/i.test(t) && /\[(TASK|OUTPUT|STRICT RULES|CONSTRAINTS|LRC|LANG)\]/i.test(p);
    if (hasStrictBlock && hasPromptSections) {
        const hasAnswerSignals = /===TRANSLATION===|###\s+|單字用語總覽|核心詞彙表|句型骨架|文法知識點|搭配用法|替代表達|介系詞重點對比|測驗|Q\d+\s*[（(]|正確答案[:：]|題後解析[:：]|\|.*\|/i.test(t);
        if (hasAnswerSignals) return false;
        const pNormLen = p.replace(/\s+/g, ' ').trim().length || 1;
        const tNormLen = t.replace(/\s+/g, ' ').trim().length;
        const ratio = tNormLen / pNormLen;
        if (ratio > 1.18) return false;
        return true;
    }

    return false;
};

const stripPromptEchoPrefix = (prompt, text) => {
    const p = String(prompt || "").trim();
    const t = String(text || "").trim();
    if (!p || !t) return t;
    if (t === p) return "";

    if (t.startsWith(p)) {
        const tail = t.slice(p.length).trim();
        return tail || "";
    }

    const pHead = p.slice(0, Math.min(240, p.length));
    if (pHead && t.startsWith(pHead)) {
        const markerRegexes = [
            /^\s*===/m,
            /^\s*###\s+/m,
            /^\s*LRC\s*知識點整理/m,
            /^\s*正確答案[:：]/m,
            /^\s*題後解析[:：]/m,
            /^\s*\d+\.\s+/m,
            /^<T\s+lang=/m
        ];
        let bestPos = -1;
        for (const re of markerRegexes) {
            const m = re.exec(t);
            if (m && Number.isFinite(m.index) && m.index > 0) {
                if (bestPos === -1 || m.index < bestPos) bestPos = m.index;
            }
        }
        if (bestPos > 0) {
            const tail = t.slice(bestPos).trim();
            if (tail && tail !== t) return tail;
        }
    }

    // [Fix] Aggressive tail stripping if head matches but no marker found
    const pTail = p.slice(-60).trim();
    if (pTail.length > 10) {
        const tailIdx = t.indexOf(pTail);
        if (tailIdx !== -1) {
            const candidate = t.slice(tailIdx + pTail.length).trim();
            if (candidate) return candidate;
        }
    }

    return t;
};

const rescuePromptEchoText = (prompt, text) => {
    const p = String(prompt || "").trim();
    const t = String(text || "").trim();
    if (!p || !t) return "";

    const stripped = stripPromptEchoPrefix(p, t);
    if (stripped && stripped !== t) return stripped;

    const markerRegexes = [
        /^\s*===TRANSLATION===/m,
        /^\s*###\s+/m,
        /^\s*單字用語總覽/m,
        /^\s*核心詞彙表/m,
        /^\s*句型骨架/m,
        /^\s*文法知識點/m,
        /^\s*搭配用法/m,
        /^\s*替代表達/m,
        /^\s*介系詞重點對比/m,
        /^\s*測驗/m,
        /^\s*Q\d+\s*[（(]/m,
        /^\s*正確答案[:：]/m,
        /^\s*題後解析[:：]/m,
        /^\s*\|.*\|/m,
        /^\s*<T\s+lang=/m
    ];
    let best = -1;
    for (const re of markerRegexes) {
        const m = re.exec(t);
        if (m && Number.isFinite(m.index) && m.index > 0) {
            if (best === -1 || m.index < best) best = m.index;
        }
    }
    if (best > 0) {
        const tail = t.slice(best).trim();
        if (tail) return tail;
    }

    // Fuzzy fallback: keep appended tail after longest common prefix.
    let i = 0;
    const max = Math.min(p.length, t.length);
    while (i < max && p.charCodeAt(i) === t.charCodeAt(i)) i += 1;
    if (i >= 100) {
        const tail = t.slice(i).trim();
        if (tail.length >= 32) return tail;
    }

    return "";
};

const isLikelyBridgeFailureText = (text) => {
    const raw = String(text || "").trim();
    if (!raw) return false;

    const hasStructuredOutput = /===TRANSLATION===|###\s|<T\s+lang=|正確答案[:：]|題後解析[:：]|\|.*\|/i.test(raw);
    if (hasStructuredOutput) return false;

    const normalized = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    const stripped = normalized.replace(/[.!?]+$/g, '').trim();

    const exactFail = new Set([
        "something went wrong",
        "an error occurred",
        "request failed",
        "failed to fetch",
        "network error",
        "internal server error",
        "service unavailable",
        "bad gateway",
        "gateway timeout",
        "temporarily unavailable",
        "please try again",
        "please try again later",
        "try again later",
        "unexpected error",
        "unknown error",
        "no response",
        "empty response"
    ]);
    if (exactFail.has(stripped)) return true;

    if (/^error\s*:/i.test(raw)) return true;

    if (
        /^(sorry[,.!\s]*)?(something went wrong|an error occurred|request failed|failed to fetch|network error|internal server error|service unavailable|bad gateway|gateway timeout|temporarily unavailable|please try again(?: later)?|try again later|unexpected error)\b/i.test(raw) &&
        raw.length <= 260
    ) {
        return true;
    }

    if (/<(?:!doctype|html|head|body)[\s>]/i.test(raw) && /\b(4\d\d|5\d\d|error|forbidden|unauthorized|not found|bad gateway|service unavailable)\b/i.test(raw)) {
        return true;
    }

    return false;
};

const isLikelyBridgeAckText = (text) => {
    const raw = String(text || "").trim();
    if (!raw) return true;
    const t = raw.toLowerCase();
    const normalized = t.replace(/\s+/g, ' ');
    if (/^LKB_[A-Z0-9_]+$/.test(raw)) return true;
    if (/^ai-winbridge-[a-z0-9_-]+$/i.test(raw)) return true;
    if (/^(blob|https?):/i.test(raw) && raw.length < 240) return true;

    // Common bridge ack/status payloads that are not model outputs.
    const exactAck = new Set([
        "ok", "okay", "ack", "acked", "acknowledged",
        "received", "request received", "accepted",
        "queued", "processing", "done", "success",
        "succeeded", "true", "1"
    ]);
    if (exactAck.has(normalized)) return true;

    if (/^(ok|okay|ack|done|success|true)\s*[.!]?$/i.test(raw) && raw.length <= 16) return true;
    if (/^\{?\s*"?ok"?\s*[:=]\s*"?true"?\s*\}?$/i.test(raw)) return true;
    if (/^\{?\s*"?status"?\s*[:=]\s*"?(ok|success|accepted|queued|processing)"?\s*\}?$/i.test(raw)) return true;

    return false;
};

const sanitizeBridgeText = (prompt, text) => {
    const t = String(text || "").trim();
    if (!t) return "";
    if (isLikelyBridgeAckText(t)) {
        try {
            bridgeRuntimeStats.echo = (bridgeRuntimeStats.echo || 0) + 1;
            bridgeRuntimeStats.lastType = "ack-filtered";
            bridgeRuntimeStats.lastKeys = `preview:${t.slice(0, 80).replace(/\s+/g, ' ')}`;
        } catch (_) { }
        return "";
    }
    if (isLikelyBridgeFailureText(t)) {
        try {
            bridgeRuntimeStats.echo = (bridgeRuntimeStats.echo || 0) + 1;
            bridgeRuntimeStats.lastType = "error-filtered";
            bridgeRuntimeStats.lastKeys = `preview:${t.slice(0, 80).replace(/\s+/g, ' ')}`;
        } catch (_) { }
        return "";
    }
    const strippedEcho = stripPromptEchoPrefix(prompt, t);
    if (strippedEcho && strippedEcho !== t) {
        return strippedEcho;
    }
    if (isLikelyPromptEcho(prompt, t)) {
        const rescued = rescuePromptEchoText(prompt, t);
        if (rescued && !isLikelyBridgeFailureText(rescued)) {
            try {
                bridgeRuntimeStats.lastType = "echo-rescued";
                bridgeRuntimeStats.lastKeys = `preview:${rescued.slice(0, 80).replace(/\s+/g, ' ')}`;
            } catch (_) { }
            return rescued;
        }
        console.warn("[Bridge] Echo filtered. Response starts with:", t.slice(0, 100));
        try {
            bridgeRuntimeStats.echo = (bridgeRuntimeStats.echo || 0) + 1;
            bridgeRuntimeStats.lastType = "echo-filtered";
            bridgeRuntimeStats.lastKeys = `preview:${t.slice(0, 80).replace(/\s+/g, ' ')}`;
        } catch (_) { }
        return "";
    }
    return t;
};

const pickUsableBridgeText = (prompt, ...nodes) => {
    let best = "";
    const seen = new Set();
    const pushCandidate = (raw) => {
        const t = String(raw || "").trim();
        if (!t) return;
        if (seen.has(t)) return;
        seen.add(t);
        const usable = sanitizeBridgeText(prompt, t);
        if (!usable) return;
        if (!best || usable.length > best.length) best = usable;
    };

    for (const node of nodes) {
        if (!node) continue;
        pushCandidate(extractBridgeText(node));
        try {
            if (typeof node === 'object') {
                pushCandidate(node.text);
                pushCandidate(node.content);
                pushCandidate(node.result);
                pushCandidate(node.output);
                pushCandidate(node.outputText);
                pushCandidate(node.output_text);
                pushCandidate(node.answer);
                pushCandidate(node.answerText);
                pushCandidate(node.final);
                pushCandidate(node.finalText);
                pushCandidate(node.delta);
                pushCandidate(node.chunk);
                pushCandidate(node.partial);
                if (node.response) pushCandidate(extractBridgeText(node.response));
                if (node.message) pushCandidate(extractBridgeText(node.message));
                if (node.data) pushCandidate(extractBridgeText(node.data));
                if (node.payload) pushCandidate(extractBridgeText(node.payload));
            }
        } catch (_) { }
    }
    return best;
};

const BRIDGE_STREAM_IDLE_MS = 2200;

const mergeBridgeTextChunk = (prevText, nextText) => {
    const prev = String(prevText || "");
    const next = String(nextText || "").trim();
    if (!next) return prev;
    if (!prev) return next;
    if (next === prev) return prev;
    if (next.startsWith(prev)) return next;
    if (prev.startsWith(next)) return prev;
    if (next.includes(prev)) return next;
    if (prev.includes(next)) return prev;
    const maxOverlap = Math.min(prev.length, next.length, 2400);
    for (let i = maxOverlap; i >= 18; i--) {
        if (prev.slice(-i) === next.slice(0, i)) {
            return (prev + next.slice(i)).trim();
        }
    }
    return (prev + "\n" + next).trim();
};

const hasBridgeFinalSignal = (...nodes) => {
    const queue = nodes.filter(Boolean);
    while (queue.length > 0) {
        const node = queue.shift();
        if (!node || typeof node !== 'object') continue;
        const doneFlag = node.done ?? node.isDone ?? node.final ?? node.isFinal ?? node.completed ?? node.complete ?? node.finished;
        if (doneFlag === true) return true;

        const finishReason = String(
            node.finishReason || node.finish_reason || node.stopReason || node.stop_reason ||
            node.status || node.state || node.event || node.type || ""
        ).toLowerCase();
        if (/(^|[^a-z])(done|final|finished|completed|stop|stopped|end|ended|eos)([^a-z]|$)/.test(finishReason)) {
            return true;
        }

        if (Array.isArray(node.candidates)) {
            for (const c of node.candidates) {
                if (!c || typeof c !== 'object') continue;
                const cReason = String(c.finishReason || c.finish_reason || c.stopReason || c.stop_reason || "").toLowerCase();
                if (/(^|[^a-z])(stop|stopped|end|ended|done|final|max_tokens)([^a-z]|$)/.test(cReason)) {
                    return true;
                }
            }
        }

        if (node.payload && typeof node.payload === 'object') queue.push(node.payload);
        if (node.data && typeof node.data === 'object') queue.push(node.data);
        if (node.response && typeof node.response === 'object') queue.push(node.response);
        if (node.message && typeof node.message === 'object') queue.push(node.message);
    }
    return false;
};

const isLikelyTruncatedBridgeText = (text) => {
    const t = String(text || "").trim();
    if (!t) return true;
    if (isLikelyBridgeAckText(t)) return true;
    if (isLikelyBridgeFailureText(t)) return true;
    const emptyOptionLines = (t.match(/(?:^|\n)\s*[A-Da-d][\)\.：:]\s*$/gm) || []).length;
    const emptyBulletLines = (t.match(/(?:^|\n)\s*[•\-*]\s*$/gm) || []).length;
    const emptyAnswerLines = (t.match(/(?:^|\n)\s*正確答案[:：]\s*$/gm) || []).length;
    const emptyAnalysisLines = (t.match(/(?:^|\n)\s*題後解析[:：]\s*$/gm) || []).length;
    const trailingMarker = /(?:^|\n)\s*(?:[A-Da-d][\)\.：:]|[•\-*])\s*$/.test(t);
    if (emptyOptionLines >= 2) return true;
    if (emptyBulletLines >= 3) return true;
    if (emptyAnswerLines >= 1) return true;
    if (emptyAnalysisLines >= 2) return true;
    if (trailingMarker && t.length > 120) return true;
    return false;
};

const pickBestBridgeText = (...texts) => {
    const list = texts
        .flat()
        .map(t => String(t || "").trim())
        .filter(Boolean)
        .filter(t => !isLikelyBridgeFailureText(t));
    if (list.length === 0) return "";
    const complete = list.filter(t => !isLikelyTruncatedBridgeText(t));
    const pool = complete.length > 0 ? complete : list;
    pool.sort((a, b) => b.length - a.length);
    return pool[0] || "";
};

const getBridgeWaitMs = (prompt) => {
    const len = String(prompt || "").length;
    // Longer wait is required for rich/structured answers to avoid stream truncation.
    // Keep bounded to avoid hanging forever when bridge is unavailable.
    return Math.min(45000, Math.max(12000, Math.floor(len * 2.2)));
};

const isRecoverableNoKeyAuthError = (errText) => {
    const t = String(errText || "").toLowerCase();
    if (!t) return false;
    return (
        /text gen api error 401|tts api error 401|status\s*401|unauthorized|forbidden|api key|no api key/.test(t) ||
        /runtime bridge unavailable|echo-filtered|bridge unavailable/.test(t)
    );
};

const isAuth401LikeError = (errText) => {
    const t = String(errText || "").toLowerCase();
    if (!t) return false;
    return (
        /text gen api error 401|tts api error 401|api error 401|status\s*401/.test(t) ||
        (/unauthorized|forbidden/.test(t) && /api|auth|key|token|gemini|text gen|tts/.test(t))
    );
};

const fetchWithCredentialFallback = async (url, init) => {
    const candidates = getAccessibleFetchCandidates();
    let first401 = null;
    let lastErr = null;

    for (const c of candidates) {
        try {
            const resp = await c.fn.call(c.owner || window, url, init);
            if (resp && resp.status === 401 && candidates.length > 1) {
                if (!first401) first401 = resp;
                continue;
            }
            return resp;
        } catch (err) {
            lastErr = err;
        }
    }

    if (first401) return first401;
    if (lastErr) throw lastErr;
    return await fetch(url, init);
};

const callParentMessageBridge = async (prompt) => {
    if (typeof window === 'undefined') return "";
    const reqId = `ai-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payloads = [
        { channel: 'jsx-ai', action: 'generateText', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { channel: 'jsx-ai', action: 'text', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { channel: 'jsx-bridge', action: 'generateText', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { channel: 'jsx-bridge', action: 'text', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { type: 'AI_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { type: 'GEMINI_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { type: 'JSX_BRIDGE_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { type: 'AI_REQUEST', id: reqId, requestId: reqId, reqId, action: 'generateText', prompt, data: { prompt }, payload: { prompt } },
        { type: 'JSX_AI_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { type: 'GENERATE_TEXT', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { type: 'TEXT_GEN_REQUEST', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { type: 'LLM_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { type: 'GENAI_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { type: 'GEMINI_GENERATE_TEXT', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { action: 'ai.text', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { action: 'gemini.text', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { action: 'textGen', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { cmd: 'gemini.text', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { cmd: 'generateText', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { cmd: 'textGen', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { event: 'ask-ai', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { event: 'jsx-ai-request', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { cmd: 'ai.text', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { id: reqId, requestId: reqId, reqId, message: prompt },
        { id: reqId, requestId: reqId, reqId, text: prompt },
        prompt
    ];

    const waitMs = getBridgeWaitMs(prompt);
    const waitAny = () => new Promise((resolve) => {
        let done = false;
        let mergedText = "";
        let idleTimer = null;
        const clearIdleTimer = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        const settleByIdle = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => finish(mergedText), BRIDGE_STREAM_IDLE_MS);
        };
        const finish = (text = "") => {
            if (done) return;
            done = true;
            clearIdleTimer();
            try { window.removeEventListener('message', onMessage); } catch (_) { }
            resolve(String(text || mergedText || "").trim());
        };
        const onMessage = (evt) => {
            const src = evt?.source;
            if (src && src !== window && src !== window.parent && src !== window.top) return;
            let data = evt?.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (_) { }
            }
            if (!data) return;
            const packet = data?.payload || data?.data || data;
            try {
                bridgeRuntimeStats.rx = (bridgeRuntimeStats.rx || 0) + 1;
                bridgeRuntimeStats.lastType = String(data?.type || data?.event || packet?.type || packet?.event || "");
                const keys = Object.keys((data && typeof data === 'object') ? data : {}).slice(0, 10).join(',');
                bridgeRuntimeStats.lastKeys = keys;
            } catch (_) { }
            const maybeEcho = (
                typeof packet === 'object' &&
                packet &&
                String(packet?.prompt || packet?.data?.prompt || packet?.payload?.prompt || "") === String(prompt || "") &&
                !packet?.text && !packet?.content && !packet?.result && !packet?.output && !packet?.outputText &&
                !packet?.output_text && !packet?.answer && !packet?.answerText && !packet?.final && !packet?.finalText &&
                !packet?.delta && !packet?.chunk && !packet?.partial &&
                !packet?.response && !packet?.message?.content && !packet?.message?.text &&
                !packet?.data?.text && !packet?.data?.content && !packet?.data?.result &&
                !packet?.data?.output && !packet?.data?.outputText && !packet?.data?.output_text &&
                !packet?.data?.answer && !packet?.data?.answerText && !packet?.data?.final && !packet?.data?.finalText &&
                !packet?.data?.delta && !packet?.data?.chunk && !packet?.data?.partial
            );
            if (maybeEcho) {
                try { bridgeRuntimeStats.echo = (bridgeRuntimeStats.echo || 0) + 1; } catch (_) { }
                return;
            }
            const hasAiPayloadFields = !!(
                packet?.text || packet?.content || packet?.result || packet?.output || packet?.outputText || packet?.output_text ||
                packet?.answer || packet?.answerText || packet?.final || packet?.finalText ||
                packet?.delta || packet?.chunk || packet?.partial ||
                packet?.response?.text || packet?.response?.content || packet?.response?.result ||
                packet?.message?.text || packet?.message?.content ||
                packet?.data?.text || packet?.data?.content || packet?.data?.result ||
                data?.text || data?.content || data?.result || data?.output || data?.outputText || data?.output_text ||
                data?.answer || data?.answerText || data?.final || data?.finalText ||
                data?.delta || data?.chunk || data?.partial ||
                data?.response?.text || data?.response?.content || data?.response?.result ||
                data?.message?.text || data?.message?.content ||
                Array.isArray(packet?.candidates) || Array.isArray(packet?.choices) ||
                Array.isArray(data?.candidates) || Array.isArray(data?.choices)
            );
            const usable = pickUsableBridgeText(
                prompt,
                packet,
                data,
                data?.response,
                data?.message,
                data?.data,
                data?.payload,
                packet?.response,
                packet?.message,
                packet?.data,
                packet?.payload
            );
            const eventId = String(
                data?.id || data?.requestId || data?.reqId ||
                packet?.id || packet?.requestId || packet?.reqId ||
                ""
            );
            if (eventId && eventId !== reqId && !hasAiPayloadFields && !usable) return;
            if (!usable) return;
            mergedText = mergeBridgeTextChunk(mergedText, usable);
            if (hasBridgeFinalSignal(data, packet)) {
                finish(mergedText);
                return;
            }
            settleByIdle();
        };
        try { window.addEventListener('message', onMessage); } catch (_) { return finish(""); }

        try {
            const targets = [];
            const pushTarget = (w) => {
                if (!w) return;
                if (targets.includes(w)) return;
                targets.push(w);
            };
            if (!window.parent || window.parent === window) {
                pushTarget(window);
            }
            if (window.parent && window.parent !== window) pushTarget(window.parent);
            if (window.top && window.top !== window) pushTarget(window.top);
            for (const payload of payloads) {
                for (const target of targets) {
                    try { bridgeRuntimeStats.tx = (bridgeRuntimeStats.tx || 0) + 1; } catch (_) { }
                    try { target.postMessage(payload, '*'); } catch (_) { }
                    try { target.postMessage(JSON.stringify(payload), '*'); } catch (_) { }
                    try { target.postMessage(payload, window.location.origin); } catch (_) { }
                }
            }
        } catch (_) { }

        setTimeout(() => finish(mergedText), waitMs);
    });

    return await waitAny();
};

const callChromeRuntimeBridge = async (prompt) => {
    if (typeof window === 'undefined') return "";
    const isExtensionPage = String(window.location?.protocol || "").toLowerCase() === "chrome-extension:";
    if (!isExtensionPage) return "";
    const rt = window?.chrome?.runtime;
    if (!rt || typeof rt.sendMessage !== 'function') return "";
    const waitMs = Math.min(12000, getBridgeWaitMs(prompt));

    const reqId = `ai-rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const messages = [
        { type: 'AI_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt },
        { type: 'GEMINI_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt },
        { type: 'JSX_BRIDGE_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt },
        { type: 'GENAI_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt },
        { action: 'ai.text', id: reqId, requestId: reqId, reqId, prompt },
        { action: 'gemini.text', id: reqId, requestId: reqId, reqId, prompt },
        { action: 'textGen', id: reqId, requestId: reqId, reqId, prompt },
        { cmd: 'ai.text', id: reqId, requestId: reqId, reqId, prompt },
        { cmd: 'gemini.text', id: reqId, requestId: reqId, reqId, prompt },
        { cmd: 'generateText', id: reqId, requestId: reqId, reqId, prompt },
        { cmd: 'textGen', id: reqId, requestId: reqId, reqId, prompt },
        { action: 'generateText', id: reqId, requestId: reqId, reqId, prompt }
    ];

    const sendOne = (msg) => new Promise((resolve) => {
        let done = false;
        const finish = (text = "") => {
            if (done) return;
            done = true;
            resolve(String(text || "").trim());
        };
        const timer = setTimeout(() => finish(""), waitMs);
        try {
            rt.sendMessage(msg, (resp) => {
                clearTimeout(timer);
                try {
                    const err = window?.chrome?.runtime?.lastError;
                    if (err) return finish("");
                } catch (_) { }
                const usable = pickUsableBridgeText(prompt, resp, resp?.response, resp?.message, resp?.data, resp?.payload);
                finish(usable);
            });
        } catch (_) {
            clearTimeout(timer);
            finish("");
        }
    });

    for (const msg of messages) {
        const out = await sendOne(msg);
        if (out) return out;
    }
    return "";
};

const callDomEventBridge = async (prompt) => {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return "";
    const reqId = `ai-dom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const waitMs = getBridgeWaitMs(prompt);
    const requestEvents = ['jsx-ai-request', 'ai-text-request', 'gemini-text-request', 'llm-text-request'];
    const responseEvents = ['jsx-ai-response', 'ai-text-response', 'gemini-text-response', 'llm-text-response'];
    return await new Promise((resolve) => {
        let done = false;
        let mergedText = "";
        let idleTimer = null;
        const clearIdleTimer = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        const settleByIdle = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => finish(mergedText), BRIDGE_STREAM_IDLE_MS);
        };
        const finish = (text = "") => {
            if (done) return;
            done = true;
            clearIdleTimer();
            try {
                for (const name of responseEvents) window.removeEventListener(name, onResponse);
            } catch (_) { }
            resolve(String(text || mergedText || "").trim());
        };
        const onResponse = (evt) => {
            const detail = evt?.detail || {};
            const rid = String(detail?.id || detail?.requestId || detail?.reqId || "");
            if (rid && rid !== reqId) return;
            const usable = pickUsableBridgeText(prompt, detail, detail?.payload, detail?.data, detail?.response, detail?.message);
            if (!usable) return;
            mergedText = mergeBridgeTextChunk(mergedText, usable);
            if (hasBridgeFinalSignal(detail)) {
                finish(mergedText);
                return;
            }
            settleByIdle();
        };
        try {
            for (const name of responseEvents) window.addEventListener(name, onResponse);
            for (const name of requestEvents) {
                try {
                    window.dispatchEvent(new CustomEvent(name, { detail: { id: reqId, requestId: reqId, reqId, prompt, text: prompt, message: prompt } }));
                } catch (_) { }
            }
        } catch (_) {
            return finish("");
        }
        setTimeout(() => finish(mergedText), waitMs);
    });
};

const callBridgeFnCandidates = async (entries, prompt) => {
    const invokeCandidates = async (entry) => {
        const fn = entry?.fn;
        const owner = entry?.owner || null;
        if (typeof fn !== 'function') return "";
        const calls = [
            () => fn.call(owner, prompt),
            () => fn.call(owner, { prompt }),
            () => fn.call(owner, { text: prompt }),
            () => fn.call(owner, { input: prompt }),
            () => fn.call(owner, [{ role: 'user', content: prompt }]),
            () => fn.call(owner, { messages: [{ role: 'user', content: prompt }] })
        ];
        for (const run of calls) {
            try {
                const res = await run();
                const text = pickUsableBridgeText(prompt, res, res?.response, res?.message, res?.data, res?.payload);
                if (text) return text;
            } catch (_) { }
        }
        return "";
    };

    for (const entry of entries || []) {
        const text = await invokeCandidates(entry);
        if (text) return text;
    }
    return "";
};

const getAuthDebugHint = (explicitKey = "") => {
    const dbg = getAuthDebugSnapshot(explicitKey);
    const bridgeSample = String(dbg.bridgeSample || "").replace(/\s+/g, ' ').slice(0, 180);
    const fetchSample = String(dbg.fetchSample || "").replace(/\s+/g, ' ').slice(0, 160);
    const nativeSample = String(dbg.nativeBridgeSample || "").replace(/\s+/g, ' ').slice(0, 160);
    const rxType = String(bridgeRuntimeStats?.lastType || "").slice(0, 80);
    const rxKeys = String(bridgeRuntimeStats?.lastKeys || "").slice(0, 120);
    return `arg:${dbg.byArg ? 1 : 0}, stored:${dbg.byStored ? 1 : 0}, injected:${dbg.byInjected ? 1 : 0}, const:${dbg.byConst ? 1 : 0}, bridgeFns:${dbg.bridgeFnCount}, nativeBridges:${dbg.nativeBridgeCount || 0}, fetchFns:${dbg.fetchCount}, parent:${dbg.hasParent ? 1 : 0}, bridgeTx:${bridgeRuntimeStats?.tx || 0}, bridgeRx:${bridgeRuntimeStats?.rx || 0}, bridgeEcho:${bridgeRuntimeStats?.echo || 0}${rxType ? `, bridgeRxType:${rxType}` : ''}${rxKeys ? `, bridgeRxKeys:[${rxKeys}]` : ''}${bridgeSample ? `, bridge:[${bridgeSample}]` : ''}${nativeSample ? `, native:[${nativeSample}]` : ''}${fetchSample ? `, fetch:[${fetchSample}]` : ''}`;
};

const extractBridgeText = (raw) => {
    if (raw == null) return "";
    if (typeof raw === 'string') return raw;
    if (typeof raw?.text === 'string') return raw.text;
    if (typeof raw?.content === 'string') return raw.content;
    if (typeof raw?.result === 'string') return raw.result;
    if (typeof raw?.output === 'string') return raw.output;
    if (typeof raw?.outputText === 'string') return raw.outputText;
    if (typeof raw?.output_text === 'string') return raw.output_text;
    if (typeof raw?.answer === 'string') return raw.answer;
    if (typeof raw?.answerText === 'string') return raw.answerText;
    if (typeof raw?.final === 'string') return raw.final;
    if (typeof raw?.finalText === 'string') return raw.finalText;
    if (typeof raw?.delta === 'string') return raw.delta;
    if (typeof raw?.chunk === 'string') return raw.chunk;
    if (typeof raw?.partial === 'string') return raw.partial;
    if (typeof raw?.response === 'string') return raw.response;
    if (typeof raw?.payload === 'string') return raw.payload;
    if (typeof raw?.message === 'string') return raw.message;
    if (typeof raw?.payload?.text === 'string') return raw.payload.text;
    if (typeof raw?.payload?.content === 'string') return raw.payload.content;
    if (typeof raw?.payload?.result === 'string') return raw.payload.result;
    if (typeof raw?.payload?.output === 'string') return raw.payload.output;
    if (typeof raw?.payload?.outputText === 'string') return raw.payload.outputText;
    if (typeof raw?.payload?.output_text === 'string') return raw.payload.output_text;
    if (typeof raw?.payload?.answer === 'string') return raw.payload.answer;
    if (typeof raw?.payload?.answerText === 'string') return raw.payload.answerText;
    if (typeof raw?.payload?.final === 'string') return raw.payload.final;
    if (typeof raw?.payload?.finalText === 'string') return raw.payload.finalText;
    if (typeof raw?.payload?.delta === 'string') return raw.payload.delta;
    if (typeof raw?.payload?.chunk === 'string') return raw.payload.chunk;
    if (typeof raw?.payload?.partial === 'string') return raw.payload.partial;
    if (typeof raw?.response?.text === 'string') return raw.response.text;
    if (typeof raw?.response?.content === 'string') return raw.response.content;
    if (typeof raw?.response?.result === 'string') return raw.response.result;
    if (typeof raw?.response?.output === 'string') return raw.response.output;
    if (typeof raw?.response?.outputText === 'string') return raw.response.outputText;
    if (typeof raw?.response?.output_text === 'string') return raw.response.output_text;
    if (typeof raw?.response?.answer === 'string') return raw.response.answer;
    if (typeof raw?.response?.answerText === 'string') return raw.response.answerText;
    if (typeof raw?.response?.final === 'string') return raw.response.final;
    if (typeof raw?.response?.finalText === 'string') return raw.response.finalText;
    if (typeof raw?.response?.delta === 'string') return raw.response.delta;
    if (typeof raw?.response?.chunk === 'string') return raw.response.chunk;
    if (typeof raw?.response?.partial === 'string') return raw.response.partial;
    if (typeof raw?.message?.content === 'string') return raw.message.content;
    if (typeof raw?.message?.text === 'string') return raw.message.text;
    if (typeof raw?.data?.delta === 'string') return raw.data.delta;
    if (typeof raw?.data?.chunk === 'string') return raw.data.chunk;
    if (typeof raw?.data?.partial === 'string') return raw.data.partial;
    if (typeof raw?.data?.final === 'string') return raw.data.final;
    if (typeof raw?.data?.finalText === 'string') return raw.data.finalText;
    if (typeof raw?.data?.answer === 'string') return raw.data.answer;
    if (typeof raw?.data?.answerText === 'string') return raw.data.answerText;
    const direct = String(
        raw?.candidates?.[0]?.content?.parts?.[0]?.text ||
        raw?.choices?.[0]?.message?.content ||
        raw?.message?.content ||
        raw?.output_text ||
        raw?.result ||
        raw?.payload?.candidates?.[0]?.content?.parts?.[0]?.text ||
        raw?.payload?.choices?.[0]?.message?.content ||
        raw?.payload?.message?.content ||
        raw?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
        raw?.response?.choices?.[0]?.message?.content ||
        raw?.response?.message?.content ||
        raw?.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
        raw?.data?.text ||
        raw?.data?.content ||
        raw?.data?.result ||
        raw?.data?.payload?.text ||
        raw?.data?.payload?.content ||
        raw?.data?.payload?.result ||
        raw?.data?.response?.text ||
        raw?.data?.response?.content ||
        raw?.data?.response?.result ||
        ""
    );
    if (direct.trim()) return direct;

    const walk = (node, depth = 0) => {
        if (depth > 5 || node == null) return "";
        if (typeof node === 'string') return node;
        if (Array.isArray(node)) {
            for (const item of node) {
                const hit = walk(item, depth + 1);
                if (hit) return hit;
            }
            return "";
        }
        if (typeof node !== 'object') return "";

        const priorityKeys = [
            'text', 'content', 'result', 'output', 'outputText', 'output_text',
            'answer', 'answerText', 'final', 'finalText', 'delta', 'chunk', 'partial',
            'message', 'response', 'data', 'payload', 'candidate', 'candidates', 'choices'
        ];
        for (const key of priorityKeys) {
            if (!(key in node)) continue;
            const hit = walk(node[key], depth + 1);
            if (typeof hit === 'string' && hit.trim()) return hit;
        }

        for (const key of Object.keys(node)) {
            const hit = walk(node[key], depth + 1);
            if (typeof hit === 'string' && hit.trim()) return hit;
        }
        return "";
    };

    return String(walk(raw, 0) || "");
};

const callSameOriginTextProxy = async (prompt) => {
    if (typeof window === 'undefined') return "";
    const waitMs = Math.min(22000, Math.max(8000, getBridgeWaitMs(prompt)));
    const endpoints = ['/api/gemini', '/api/ai', '/api/text-gen', '/api/textgen', '/api/llm'];
    const payloads = [
        { prompt },
        { text: prompt },
        { input: prompt },
        { message: prompt }
    ];
    const attempts = [];
    for (const ep of endpoints) {
        for (const bodyObj of payloads) {
            attempts.push((async () => {
                try {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), waitMs);
                    const resp = await fetchWithCredentialFallback(ep, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(bodyObj),
                        signal: controller.signal
                    });
                    clearTimeout(timer);
                    if (!resp.ok) return "";
                    const contentType = String(resp.headers.get('content-type') || '').toLowerCase();
                    if (contentType.includes('application/json')) {
                        const json = await resp.json();
                        return sanitizeBridgeText(prompt, extractBridgeText(json));
                    }
                    return sanitizeBridgeText(prompt, await resp.text());
                } catch (_) {
                    return "";
                }
            })());
        }
    }

    return await new Promise((resolve) => {
        let done = false;
        let pending = attempts.length;
        const finish = (text = "") => {
            if (done) return;
            done = true;
            resolve(String(text || "").trim());
        };
        for (const p of attempts) {
            p.then((text) => {
                const t = String(text || "").trim();
                if (t) return finish(t);
                pending -= 1;
                if (pending <= 0) finish("");
            }).catch(() => {
                pending -= 1;
                if (pending <= 0) finish("");
            });
        }
        setTimeout(() => finish(""), waitMs + 1000);
    });
};

const getReferrerOriginSafe = () => {
    try {
        const ref = String(document?.referrer || "").trim();
        if (!ref) return "";
        const u = new URL(ref);
        return `${u.protocol}//${u.host}`;
    } catch (_) {
        return "";
    }
};

const callReferrerOriginProxy = async (prompt) => {
    if (typeof window === 'undefined') return "";
    const waitMs = Math.min(26000, Math.max(9000, getBridgeWaitMs(prompt)));
    const origin = getReferrerOriginSafe();
    if (!origin) return "";

    const endpoints = [
        '/api/gemini',
        '/api/ai',
        '/api/text-gen',
        '/api/textgen',
        '/api/llm',
        '/api/generate-text',
        '/api/genai/text'
    ];
    const payloads = [
        { prompt },
        { text: prompt },
        { input: prompt },
        { message: prompt },
        { messages: [{ role: 'user', content: prompt }] }
    ];

    const attempts = [];
    for (const ep of endpoints) {
        const url = `${origin}${ep}`;
        for (const bodyObj of payloads) {
            attempts.push((async () => {
                try {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), waitMs);
                    const resp = await fetchWithCredentialFallback(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(bodyObj),
                        credentials: 'include',
                        mode: 'cors',
                        signal: controller.signal
                    });
                    clearTimeout(timer);
                    if (!resp || !resp.ok) return "";
                    const contentType = String(resp.headers.get('content-type') || '').toLowerCase();
                    if (contentType.includes('application/json')) {
                        const json = await resp.json();
                        return sanitizeBridgeText(prompt, extractBridgeText(json));
                    }
                    return sanitizeBridgeText(prompt, await resp.text());
                } catch (_) {
                    return "";
                }
            })());
        }
    }

    return await new Promise((resolve) => {
        let done = false;
        let pending = attempts.length;
        const finish = (text = "") => {
            if (done) return;
            done = true;
            resolve(String(text || "").trim());
        };
        for (const p of attempts) {
            p.then((text) => {
                const t = String(text || "").trim();
                if (t) return finish(t);
                pending -= 1;
                if (pending <= 0) finish("");
            }).catch(() => {
                pending -= 1;
                if (pending <= 0) finish("");
            });
        }
        setTimeout(() => finish(""), waitMs + 1000);
    });
};

const callNativeContainerBridge = async (prompt) => {
    if (typeof window === 'undefined') return "";
    const bridges = getNativeBridgeCandidates();
    if (!bridges.length) return "";
    const reqId = `ai-native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const waitMs = getBridgeWaitMs(prompt);
    const payloads = [
        { type: 'AI_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { type: 'GEMINI_TEXT_REQUEST', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { cmd: 'ai.text', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { cmd: 'gemini.text', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { action: 'generateText', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { action: 'textGen', id: reqId, requestId: reqId, reqId, prompt, data: { prompt }, payload: { prompt } },
        { prompt },
        { text: prompt },
        prompt
    ];

    return await new Promise((resolve) => {
        let done = false;
        let mergedText = "";
        let idleTimer = null;
        const clearIdleTimer = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        const settleByIdle = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => finish(mergedText), BRIDGE_STREAM_IDLE_MS);
        };
        const finish = (text = "") => {
            if (done) return;
            done = true;
            clearIdleTimer();
            try { window.removeEventListener('message', onWindowMessage); } catch (_) { }
            try { window?.chrome?.webview?.removeEventListener?.('message', onWebviewMessage); } catch (_) { }
            resolve(String(text || mergedText || "").trim());
        };

        const tryUse = (raw) => {
            const text = pickUsableBridgeText(
                prompt,
                raw,
                raw?.response,
                raw?.message,
                raw?.data,
                raw?.payload
            );
            if (!text) return;
            mergedText = mergeBridgeTextChunk(mergedText, text);
            if (hasBridgeFinalSignal(raw)) {
                finish(mergedText);
                return;
            }
            settleByIdle();
        };

        const onWindowMessage = (evt) => {
            const data = evt?.data;
            if (!data) return;
            tryUse(data?.payload || data?.data || data);
        };
        const onWebviewMessage = (evt) => {
            const data = evt?.data;
            if (!data) return;
            tryUse(data?.payload || data?.data || data);
        };

        try { window.addEventListener('message', onWindowMessage); } catch (_) { }
        try { window?.chrome?.webview?.addEventListener?.('message', onWebviewMessage); } catch (_) { }

        for (const b of bridges) {
            for (const p of payloads) {
                try {
                    if (b.kind === 'rn') {
                        b.fn.call(b.owner || null, typeof p === 'string' ? p : JSON.stringify(p));
                    } else {
                        b.fn.call(b.owner || null, p);
                    }
                    bridgeRuntimeStats.tx = (bridgeRuntimeStats.tx || 0) + 1;
                } catch (_) { }
            }
        }
        setTimeout(() => finish(mergedText), waitMs);
    });
};

const probeWindowGeminiBridgeReady = async (timeoutMs = 4500) => {
    if (typeof window === 'undefined' || typeof window.postMessage !== 'function') return false;
    const waitMs = Math.max(1000, Math.min(15000, Number(timeoutMs) || 4500));
    const reqId = `ai-winbridge-ping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return await new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { window.removeEventListener('message', onMessage); } catch (_) { }
            resolve(Boolean(ok));
        };

        const onMessage = (evt) => {
            const src = evt?.source;
            try {
                const p = window.parent && window.parent !== window ? window.parent : null;
                const t = window.top && window.top !== window ? window.top : null;
                if (src && src !== window && src !== p && src !== t) return;
            } catch (_) {
                if (src && src !== window) return;
            }
            let data = evt?.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (_) { }
            }
            if (!data || typeof data !== 'object') return;
            if (String(data.type || '') !== 'LKB_GEMINI_BRIDGE_PONG') return;
            const respReqId = String(data.requestId || data.reqId || '');
            if (respReqId !== reqId) return;
            finish(true);
        };

        try { window.addEventListener('message', onMessage); } catch (_) { return finish(false); }

        const payload = {
            type: 'LKB_GEMINI_BRIDGE_PING',
            requestId: reqId,
            reqId,
            ts: Date.now()
        };
        const targets = [];
        const pushTarget = (w) => {
            if (!w) return;
            if (targets.includes(w)) return;
            targets.push(w);
        };
        pushTarget(window);
        try { if (window.parent && window.parent !== window) pushTarget(window.parent); } catch (_) { }
        try { if (window.top && window.top !== window) pushTarget(window.top); } catch (_) { }

        const emit = () => {
            for (const target of targets) {
                try { target.postMessage(payload, '*'); } catch (_) { }
            }
        };

        emit();
        setTimeout(emit, 250);
        setTimeout(emit, 700);
        setTimeout(() => finish(false), waitMs);
    });
};

const callWindowGeminiBridge = async (prompt) => {
    if (typeof window === 'undefined' || typeof window.postMessage !== 'function') return "";
    const bridgeReady = await probeWindowGeminiBridgeReady(5000);
    if (!bridgeReady) {
        try { console.warn("[LKB-LEARN-BRIDGE] preflight.unready", { promptLen: String(prompt || "").length, continue: true }); } catch (_) { }
        // Do not early-return. Some pages race with injection; request may still be handled moments later.
    }

    const reqId = `ai-winbridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Keep this close to extension background sync timeout (180s) for Pro/long prompts.
    const waitMs = Math.min(300000, Math.max(180000, getBridgeWaitMs(prompt) * 6));
    try { console.log("[LKB-LEARN-BRIDGE] request", { reqId, promptLen: String(prompt || "").length, waitMs }); } catch (_) { }

    return await new Promise((resolve) => {
        let done = false;
        let mergedText = "";
        let pendingError = "";
        let idleTimer = null;
        let hardTimer = null;
        const clearIdleTimer = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        const clearHardTimer = () => {
            if (hardTimer) {
                clearTimeout(hardTimer);
                hardTimer = null;
            }
        };
        const settleByIdle = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => finish(mergedText), BRIDGE_STREAM_IDLE_MS);
        };
        const finish = (text = "") => {
            if (done) return;
            done = true;
            clearIdleTimer();
            clearHardTimer();
            try { window.removeEventListener('message', onMessage); } catch (_) { }
            resolve(String(text || mergedText || "").trim());
        };
        const onMessage = (evt) => {
            const src = evt?.source;
            try {
                const p = window.parent && window.parent !== window ? window.parent : null;
                const t = window.top && window.top !== window ? window.top : null;
                if (src && src !== window && src !== p && src !== t) return;
            } catch (_) {
                if (src && src !== window) return;
            }
            let data = evt?.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (_) { }
            }
            if (!data || typeof data !== 'object') return;
            if (String(data.type || "") !== "LKB_GEMINI_BRIDGE_RESPONSE") return;
            if (String(data.requestId || data.reqId || "") !== reqId) return;
            const isOk = data.ok !== false;
            const usable = pickUsableBridgeText(prompt, data, data?.payload, data?.data, data?.response, data?.message);
            if (usable) {
                mergedText = mergeBridgeTextChunk(mergedText, usable);
            }
            const isDone = data.done === true || data.final === true || data.isFinal === true || data.complete === true || data.completed === true;
            if (!isOk) {
                const errText = String(data.error || "").trim();
                if (errText) pendingError = errText;
            }
            if (isDone) {
                if (mergedText) {
                    try { console.log("[LKB-LEARN-BRIDGE] response.done", { reqId, textLen: mergedText.length }); } catch (_) { }
                    finish(mergedText);
                    return;
                }
                if (!isOk) {
                    // Some stale/invalidated listeners may fail first, while a healthy listener succeeds shortly after.
                    // Keep waiting instead of finalizing the bridge as failed immediately.
                    settleByIdle();
                    return;
                }
                if (pendingError) {
                    try { console.warn("[LKB-LEARN-BRIDGE] response.error", { reqId, error: pendingError }); } catch (_) { }
                    finish(`Error: ${pendingError}`);
                    return;
                }
                // Ignore empty-done packets (can come from stale listeners); wait for real text until idle/hard timeout.
                settleByIdle();
                return;
            }
            settleByIdle();
        };

        try { window.addEventListener('message', onMessage); } catch (_) { return finish(""); }
        try {
            bridgeRuntimeStats.tx = (bridgeRuntimeStats.tx || 0) + 1;
            const payload = {
                type: "LKB_GEMINI_BRIDGE_REQUEST",
                requestId: reqId,
                reqId,
                prompt: String(prompt || ""),
                meta: { source: "learning-app", ts: Date.now() }
            };
            const targets = [];
            const pushTarget = (w) => {
                if (!w) return;
                if (targets.includes(w)) return;
                targets.push(w);
            };
            pushTarget(window);
            try { if (window.parent && window.parent !== window) pushTarget(window.parent); } catch (_) { }
            try { if (window.top && window.top !== window) pushTarget(window.top); } catch (_) { }
            for (const target of targets) {
                try { target.postMessage(payload, "*"); } catch (_) { }
            }
        } catch (_) {
            return finish("");
        }
        hardTimer = setTimeout(() => {
            try { console.log("[LKB-LEARN-BRIDGE] timeout", { reqId, textLen: mergedText.length, waitMs }); } catch (_) { }
            if (!mergedText && pendingError) {
                finish(`Error: ${pendingError}`);
                return;
            }
            finish(mergedText);
        }, waitMs);
    });
};

const callRuntimeTextBridge = async (prompt, opts = {}) => {
    if (typeof window === 'undefined') return "";
    const windowBridgeOnly = Boolean(opts && opts.windowBridgeOnly);
    const returnRawWindow = Boolean(opts && opts.rawWindow);
    const settleText = (p) => Promise.resolve(p).then(x => sanitizeBridgeText(prompt, x)).catch(() => "");

    if (windowBridgeOnly) {
        const rawWindow = String(await callWindowGeminiBridge(prompt) || "").trim();
        if (!rawWindow) return "";
        // Preserve explicit bridge errors (timeout, sync failure, etc.) for user-visible diagnostics.
        if (/^Error:/i.test(rawWindow)) return rawWindow;
        if (returnRawWindow) return rawWindow;
        return String(sanitizeBridgeText(prompt, rawWindow) || "").trim();
    }

    const entryList = [];
    const addEntry = (name, fn, owner = null) => {
        if (typeof fn !== 'function') return;
        entryList.push({ name, fn, owner });
    };
    addEntry('__callGeminiTextWithoutKey', window.__callGeminiTextWithoutKey);
    addEntry('__callGeminiTextNoKey', window.__callGeminiTextNoKey);
    addEntry('__callGeminiText', window.__callGeminiText);
    addEntry('callGeminiTextWithoutKey', window.callGeminiTextWithoutKey);
    addEntry('callGeminiTextNoKey', window.callGeminiTextNoKey);
    addEntry('__AI_BRIDGE__.generateText', window.__AI_BRIDGE__?.generateText, window.__AI_BRIDGE__ || null);
    addEntry('__AI_BRIDGE__.geminiText', window.__AI_BRIDGE__?.geminiText, window.__AI_BRIDGE__ || null);
    addEntry('__AI_BRIDGE__.text', window.__AI_BRIDGE__?.text, window.__AI_BRIDGE__ || null);
    addEntry('__JSX_BRIDGE__.generateText', window.__JSX_BRIDGE__?.generateText, window.__JSX_BRIDGE__ || null);
    addEntry('__JSX_BRIDGE__.geminiText', window.__JSX_BRIDGE__?.geminiText, window.__JSX_BRIDGE__ || null);
    addEntry('__JSX_BRIDGE__.text', window.__JSX_BRIDGE__?.text, window.__JSX_BRIDGE__ || null);
    addEntry('aiBridge.generateText', window.aiBridge?.generateText, window.aiBridge || null);
    addEntry('aiBridge.geminiText', window.aiBridge?.geminiText, window.aiBridge || null);
    addEntry('aiBridge.text', window.aiBridge?.text, window.aiBridge || null);
    addEntry('jsxBridge.generateText', window.jsxBridge?.generateText, window.jsxBridge || null);
    addEntry('jsxBridge.geminiText', window.jsxBridge?.geminiText, window.jsxBridge || null);
    addEntry('jsxBridge.text', window.jsxBridge?.text, window.jsxBridge || null);

    try {
        if (window.parent && window.parent !== window) {
            addEntry('parent.__callGeminiTextWithoutKey', window.parent.__callGeminiTextWithoutKey, window.parent);
            addEntry('parent.__callGeminiTextNoKey', window.parent.__callGeminiTextNoKey, window.parent);
            addEntry('parent.__callGeminiText', window.parent.__callGeminiText, window.parent);
            addEntry('parent.callGeminiTextWithoutKey', window.parent.callGeminiTextWithoutKey, window.parent);
            addEntry('parent.callGeminiTextNoKey', window.parent.callGeminiTextNoKey, window.parent);
            addEntry('parent.__AI_BRIDGE__.generateText', window.parent.__AI_BRIDGE__?.generateText, window.parent.__AI_BRIDGE__ || window.parent);
            addEntry('parent.__AI_BRIDGE__.geminiText', window.parent.__AI_BRIDGE__?.geminiText, window.parent.__AI_BRIDGE__ || window.parent);
            addEntry('parent.__JSX_BRIDGE__.generateText', window.parent.__JSX_BRIDGE__?.generateText, window.parent.__JSX_BRIDGE__ || window.parent);
            addEntry('parent.__JSX_BRIDGE__.geminiText', window.parent.__JSX_BRIDGE__?.geminiText, window.parent.__JSX_BRIDGE__ || window.parent);
            addEntry('parent.__JSX_BRIDGE__.text', window.parent.__JSX_BRIDGE__?.text, window.parent.__JSX_BRIDGE__ || window.parent);
            addEntry('parent.aiBridge.generateText', window.parent.aiBridge?.generateText, window.parent.aiBridge || window.parent);
            addEntry('parent.aiBridge.geminiText', window.parent.aiBridge?.geminiText, window.parent.aiBridge || window.parent);
            addEntry('parent.aiBridge.text', window.parent.aiBridge?.text, window.parent.aiBridge || window.parent);
            addEntry('parent.jsxBridge.generateText', window.parent.jsxBridge?.generateText, window.parent.jsxBridge || window.parent);
            addEntry('parent.jsxBridge.geminiText', window.parent.jsxBridge?.geminiText, window.parent.jsxBridge || window.parent);
            addEntry('parent.jsxBridge.text', window.parent.jsxBridge?.text, window.parent.jsxBridge || window.parent);
        }
    } catch (_) { }

    const waitMs = getBridgeWaitMs(prompt);
    const fromKnown = await callBridgeFnCandidates(entryList, prompt);
    if (fromKnown && !isLikelyTruncatedBridgeText(fromKnown)) return fromKnown;
    const parentPromise = settleText(callParentMessageBridge(prompt));
    const chromePromise = settleText(callChromeRuntimeBridge(prompt));
    const domPromise = settleText(callDomEventBridge(prompt));
    const proxyPromise = settleText(callSameOriginTextProxy(prompt));
    const refProxyPromise = settleText(callReferrerOriginProxy(prompt));
    const nativePromise = settleText(callNativeContainerBridge(prompt));
    const windowBridgePromise = settleText(callWindowGeminiBridge(prompt));

    const raced = await Promise.race([
        parentPromise.then(v => (v ? { text: v } : null)),
        chromePromise.then(v => (v ? { text: v } : null)),
        domPromise.then(v => (v ? { text: v } : null)),
        proxyPromise.then(v => (v ? { text: v } : null)),
        refProxyPromise.then(v => (v ? { text: v } : null)),
        nativePromise.then(v => (v ? { text: v } : null)),
        windowBridgePromise.then(v => (v ? { text: v } : null)),
        new Promise((resolve) => setTimeout(() => resolve(null), waitMs))
    ]);
    if (raced?.text && !isLikelyTruncatedBridgeText(raced.text)) return raced.text;

    const [fromParent, fromChrome, fromDom, proxyText, refProxyText, nativeText, windowBridgeText] =
        await Promise.all([parentPromise, chromePromise, domPromise, proxyPromise, refProxyPromise, nativePromise, windowBridgePromise]);
    return pickBestBridgeText(fromKnown, raced?.text || "", fromParent, fromChrome, fromDom, proxyText, refProxyText, nativeText, windowBridgeText);
};

const buildUrl = (baseUrl, key) => {
    const url = new URL(baseUrl);
    const k = String(key || '').trim();
    if (k.length > 0) {
        url.searchParams.append('key', k);
    }
    return url.toString();
};

const callGeminiText = async (prompt, key) => {
    const validKey = resolveApiKey(key);
    const requestViaApi = async (resolvedKey = validKey) => {
        const url = buildUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent', resolvedKey);
        const response = await fetchWithCredentialFallback(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await handleApiError(response, "Text Gen");
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response";
    };

    if (!validKey) {
        let noKeyApiError = "";

        // Keep original no-key direct path first: some JSX/runtime environments inject auth automatically.
        try {
            const noKeyApiText = await requestViaApi("");
            if (noKeyApiText && !isLikelyBridgeFailureText(noKeyApiText)) {
                return noKeyApiText;
            }
        } catch (err) {
            noKeyApiError = String(err?.message || err || "").trim();
            try { console.warn("[LKB-LEARN-BRIDGE] no-key-api.fail", { err: noKeyApiError.slice(0, 200) }); } catch (_) { }
        }
        const forceBridgeOnAuth = isRecoverableNoKeyAuthError(noKeyApiError) || isAuth401LikeError(noKeyApiError);
        const bridgeText = await callRuntimeTextBridge(prompt, { windowBridgeOnly: true });
        if (bridgeText && !isLikelyBridgeFailureText(bridgeText) && !isLikelyTruncatedBridgeText(bridgeText)) {
            return bridgeText;
        }

        if (forceBridgeOnAuth || isAuth401LikeError(noKeyApiError)) {
            return `Error: Gemini bridge unavailable (${getAuthDebugHint(key)})`;
        }
        if (noKeyApiError) {
            return `Error: ${noKeyApiError} (${getAuthDebugHint(key)})`;
        }
        return `Error: No API key and runtime bridge unavailable (${getAuthDebugHint(key)})`;
    }

    // Key path: direct API first for performance, then bridge fallback.
    try {
        const apiText = await requestViaApi(validKey);
        if (apiText && !isLikelyBridgeFailureText(apiText)) return apiText;
    } catch (_) { }

    const bridgeCandidates = [];
    const maxBridgeAttempts = 1;
    for (let attempt = 0; attempt < maxBridgeAttempts; attempt++) {
        const candidate = await callRuntimeTextBridge(prompt);
        if (!candidate) continue;
        bridgeCandidates.push(candidate);
        if (!isLikelyTruncatedBridgeText(candidate)) {
            return candidate;
        }
    }

    const bridgeText = pickBestBridgeText(bridgeCandidates);
    try {
        const apiText = await requestViaApi(validKey);
        if (apiText && !isLikelyBridgeFailureText(apiText)) return apiText;
        if (bridgeText && !isLikelyBridgeFailureText(bridgeText)) return bridgeText;
        return `Error: ${apiText || "Unknown error"}`;
    } catch (err) {
        if (bridgeText && !isLikelyBridgeFailureText(bridgeText)) return bridgeText;
        const raw = String(err?.message || "Unknown error");
        if (isAuth401LikeError(raw)) {
            const forcedBridge = await callRuntimeTextBridge(prompt, { windowBridgeOnly: true });
            if (forcedBridge && !isLikelyBridgeFailureText(forcedBridge) && !isLikelyTruncatedBridgeText(forcedBridge)) {
                return forcedBridge;
            }
            const forcedRescueRaw = await callRuntimeTextBridge(prompt, { windowBridgeOnly: true, rawWindow: true });
            const forcedRescue = rescuePromptEchoText(prompt, forcedRescueRaw);
            if (forcedRescue && !isLikelyBridgeFailureText(forcedRescue)) {
                return forcedRescue;
            }
            return `Error: Gemini bridge unavailable (${getAuthDebugHint(key)})`;
        }
        return `Error: ${raw}`;
    }
};


const callGeminiMultimodal = async (prompt, audioBase64, key) => {
    const validKey = resolveApiKey(key);
    try {
        const payload = {
            contents: [{
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: "audio/webm", data: audioBase64 } }
                ]
            }]
        };
        const url = buildUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent', validKey);
        const response = await fetchWithCredentialFallback(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await handleApiError(response, "Multimodal");
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response";
    } catch (err) {
        const raw = String(err?.message || "Unknown error");
        if (!validKey && /401|unauth|api\s*key|credential/i.test(raw)) {
            return `Error: ${raw} (${getAuthDebugHint(key)})`;
        }
        return `Error: ${raw}`;
    }
};

// --- AUDIO UTILS ---
const base64ToBytes = (base64) => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
};

const createWavBlob = (pcmData, sampleRate = 24000) => {
    const numChannels = 1;
    const byteRate = sampleRate * numChannels * 2;
    const blockAlign = numChannels * 2;
    const dataSize = pcmData.byteLength;
    const headerSize = 44;

    const headerBuffer = new ArrayBuffer(headerSize);
    const view = new DataView(headerBuffer);
    const writeString = (view, offset, string) => { for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); };

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    return new Blob([headerBuffer, pcmData], { type: 'audio/wav' });
};

const TTS_MODEL_CANDIDATES = [
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-flash-tts',
    'gemini-2.5-flash-preview-09-2025'
];

const extractTtsInlineAudioBase64 = (data) => {
    try {
        const p = data?.candidates?.[0]?.content?.parts || [];
        for (const part of p) {
            const b64 = part?.inlineData?.data || part?.inline_data?.data;
            if (b64) return b64;
        }
    } catch (_) { }
    return '';
};

const requestGeminiTtsBase64 = async (text, key, voiceName = 'Aoede') => {
    const validKey = resolveApiKey(key);
    let lastErr = null;
    for (const model of TTS_MODEL_CANDIDATES) {
        try {
            const url = buildUrl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, validKey);
            const response = await fetchWithCredentialFallback(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text }] }],
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
                    }
                })
            });
            const data = await handleApiError(response, "TTS");
            const b64 = extractTtsInlineAudioBase64(data);
            if (b64) return b64;
        } catch (err) {
            lastErr = err;
        }
    }
    if (lastErr) {
        try { console.warn('[LKB-TTS] all-models-failed', String(lastErr?.message || lastErr)); } catch (_) { }
    }
    return '';
};

const callGeminiTTS_Single = async (text, key, voiceName = "Aoede") => {
    const cleanText = stripTtsMarkupButKeepPatternBrackets(text);
    if (!cleanText) return null;
    try {
        const b64 = await requestGeminiTtsBase64(cleanText, key, voiceName);
        if (b64) return createWavBlob(base64ToBytes(b64).buffer, 24000);
    } catch (e) {
        console.error("TTS Single Chunk Error", e);
    }
    return null;
};

const callGeminiTTS_Chunked = async (text, key, voiceName = "Aoede") => {
    const MAX_CHUNK_LENGTH = 280;
    const cleanText = stripTtsMarkupButKeepPatternBrackets(text);
    if (!cleanText) return null;

    let parts = cleanText.split(/\n+/);
    let chunks = [];
    let currentChunk = "";

    for (let part of parts) {
        if ((currentChunk + " " + part).length < MAX_CHUNK_LENGTH) {
            currentChunk += (currentChunk ? "\n" : "") + part;
        } else {
            if (currentChunk) chunks.push(currentChunk);
            if (part.length > MAX_CHUNK_LENGTH) {
                const sentences = part.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [part];
                let subChunk = "";
                for (let sent of sentences) {
                    if ((subChunk + sent).length < MAX_CHUNK_LENGTH) { subChunk += sent; } else {
                        if (subChunk) chunks.push(subChunk);
                        subChunk = sent;
                    }
                }
                if (subChunk) currentChunk = subChunk; else currentChunk = "";
            } else { currentChunk = part; }
        }
    }
    if (currentChunk) chunks.push(currentChunk);
    if (chunks.length === 0) return null;

    try {
        const chunkPromises = chunks.map(async (chunk) => {
            if (!chunk.trim()) return null;
            let attempts = 0;
            while (attempts < 3) {
                try {
                    const b64 = await requestGeminiTtsBase64(chunk, key, voiceName);
                    if (b64) return base64ToBytes(b64);
                    return null;
                } catch (e) { attempts++; await sleep(1000); }
            }
            return null;
        });

        const results = await Promise.all(chunkPromises);
        const validPcmArrays = results.filter(r => r !== null);
        if (validPcmArrays.length === 0) return null;

        let totalLen = validPcmArrays.reduce((acc, curr) => acc + curr.length, 0);
        const mergedBuffer = new Uint8Array(totalLen);
        let offset = 0;
        for (const arr of validPcmArrays) {
            mergedBuffer.set(arr, offset);
            offset += arr.length;
        }
        return createWavBlob(mergedBuffer.buffer, 24000);
    } catch (err) { console.error("TTS Pipeline Error:", err); return null; }
};

// 3. Parsing Utils
const timeToSeconds = (timeStr) => {
    if (typeof timeStr !== 'string') return 0;
    const parts = timeStr.trim().split(':');
    let h = 0, m = 0, s = 0;
    if (parts.length === 3) {
        h = parseInt(parts[0]); m = parseInt(parts[1]); s = parseFloat(parts[2].replace(',', '.'));
    } else {
        m = parseInt(parts[0]); s = parseFloat(parts[1].replace(',', '.'));
    }
    return h * 3600 + m * 60 + s;
};

const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const clampSubtitles = (subs) => {
    for (let i = 0; i < subs.length - 1; i++) {
        if (subs[i].end > subs[i + 1].start) {
            subs[i].end = subs[i + 1].start - 0.01;
        }
    }
    return subs;
};

const parseSRT = (data) => {
    const subtitles = [];
    const regex = /(\d+)\r?\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\r?\n([\s\S]*?)(?=\r?\n\r?\n|$)/g;
    let match;
    while ((match = regex.exec(data)) !== null) {
        subtitles.push({
            id: match[1],
            start: timeToSeconds(match[2]),
            end: timeToSeconds(match[3]),
            text: match[4].replace(/\r?\n/g, ' ').replace(/<[^>]*>/g, '')
        });
    }
    return clampSubtitles(subtitles);
};

const parseLRC = (data) => {
    const lines = data.split(/\r?\n/);
    const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;
    let entries = [];
    lines.forEach(line => {
        let match;
        const matches = [];
        timeRegex.lastIndex = 0;
        while ((match = timeRegex.exec(line)) !== null) {
            matches.push({
                time: parseInt(match[1]) * 60 + parseInt(match[2]) + (match[3] ? parseFloat('0.' + match[3]) : 0),
                length: match[0].length,
                index: match.index
            });
        }
        if (matches.length > 0) {
            const lastMatch = matches[matches.length - 1];
            const text = line.substring(lastMatch.index + lastMatch.length).trim();
            if (text) matches.forEach(m => entries.push({ start: m.time, text: text }));
        }
    });
    entries.sort((a, b) => a.start - b.start);
    const subs = entries.map((entry, index) => ({
        id: index + 1,
        start: entry.start,
        end: entries[index + 1] ? entries[index + 1].start : (entry.start + 5),
        text: entry.text
    }));
    return clampSubtitles(subs);
};

const isAbbreviation = (text) => {
    if (/(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Vs|etc|e\.g|i\.e|No|Fig|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.$/i.test(text)) return true;
    if (/(?:^|\s)[a-zA-Z]\.$/.test(text)) return true;
    if (/(?:[a-zA-Z]\.){2,}$/.test(text)) return true;
    return false;
};

const isTitleLike = (text) => {
    if (!text) return false;
    if (/^(?:Chapter|Episode|Season|Part|Section|Lesson|Unit|Vol|Volume)\s+\d+/i.test(text)) return true;
    if (text === text.toUpperCase() && text.length > 3 && text.length < 40 && /[A-Z]/.test(text)) return true;
    // Do NOT treat all numbered lines as titles (e.g. vocabulary lists "1. ことば").
    // Only treat as title when the numbered line itself is a heading keyword.
    if (/^\d+\.\s*(?:Chapter|Episode|Season|Part|Section|Lesson|Unit|Vol|Volume)\b/i.test(text)) return true;
    return false;
};

// --- SMART TIMELINE ESTIMATION (syllable/units-weighted) ---
const countVowelGroups = (word) => {
    if (!word) return 0;
    const m = String(word).toLowerCase().match(/[aeiouy]+/g);
    return m ? m.length : 0;
};

const countSpokenUnits = (text) => {
    if (!text || typeof text !== 'string') return 0;
    let units = 0;

    // Count CJK characters as 1 unit each
    const cjkMatches = text.match(/[\u4e00-\u9fff]/g);
    if (cjkMatches) units += cjkMatches.length;

    // Count Latin words by approximate syllables (vowel groups)
    const latinWords = text.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) || [];
    for (const w of latinWords) {
        const vg = countVowelGroups(w);
        units += Math.max(1, vg);
    }

    // Count numbers as 1 unit each token
    const nums = text.match(/\b\d+(?:[.,:]\d+)?\b/g) || [];
    units += nums.length;

    return units;
};

const countTimelineUnits = (text) => {
    const source = String(text || "");
    let units = countSpokenUnits(source);
    const commaPauses = source.match(/[,，、;；:：]/g) || [];
    const sentencePauses = source.match(/[.?!。！？]+["'”’）)]?/g) || [];
    const dashPauses = source.match(/\s[—–-]\s/g) || [];
    units += commaPauses.length * 0.35;
    units += sentencePauses.length * 1.25;
    units += dashPauses.length * 0.45;
    return Math.max(0.001, units);
};

const estimateSubtitleTailPadding = (text, durationSec) => {
    const duration = Math.max(0, Number(durationSec || 0));
    const units = countSpokenUnits(String(text || ""));
    const unitsPerSec = duration > 0 ? units / duration : 0;
    let pad = 0.14;

    if (duration <= 0.9) pad = 0.46;
    else if (duration <= 1.4) pad = 0.38;
    else if (duration <= 2.2) pad = 0.30;
    else if (duration <= 3.5) pad = 0.22;
    else if (duration <= 6.0) pad = 0.16;
    else pad = 0.10;

    if (unitsPerSec >= 7.5) pad += 0.10;
    else if (unitsPerSec >= 5.8) pad += 0.06;

    if (!/[.?!。！？]["'”’）)]?\s*$/u.test(String(text || "").trim())) {
        pad += 0.04;
    }

    return Math.max(0.08, Math.min(0.55, pad));
};

const generateSmartSubtitles = (rawSubtitles, bufferTime = 0.2, minDuration = 3.0, maxMergeCount = 3, trackLanguage = "en-US") => {
    if (!rawSubtitles || rawSubtitles.length === 0) return [];
    const punctuationRegex = /([.?!。！？]["']?)(?=\s|$)/g;
    const sentenceEndRegex = /[.?!。！？]["']?\s*$/;
    const isCJKLine = (text) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(String(text || ""));
    const getPeriodForText = (text) => {
        const isCJKTrack = /^(ja|ko|zh)/i.test(trackLanguage);
        return (isCJKLine(text) || isCJKTrack) ? "。" : ".";
    };
    const ensureSentenceTerminal = (text) => {
        const trimmed = String(text || "").trim();
        if (!trimmed) return trimmed;
        if (sentenceEndRegex.test(trimmed)) return trimmed;
        return trimmed + getPeriodForText(trimmed);
    };
    const stripLeadingListMarker = (text) => String(text || "")
        .replace(/^\s*(?:[0-9０-９]+|[A-Za-z])\s*[.)．、]\s*/, '')
        .trim();
    const contentLines = rawSubtitles
        .map(sub => {
            const raw = (sub?.text || "").trim();
            const cleaned = stripLeadingListMarker(raw);
            return cleaned || raw;
        })
        .filter(text => text && !isTitleLike(text));
    // Auto-append punctuation only when file head has 40 consecutive space-delimited tokens
    // (half-width or full-width spaces) without full-stop marks.
    // Important: only full stop is considered here ('.' / '。'), not other punctuation.
    const HEAD_TOKEN_LIMIT = 40;
    const hasFullStop = (token) => /[.。]/.test(String(token || ""));
    let headTokenCount = 0;
    let sawFullStopBeforeLimit = false;
    for (const line of contentLines) {
        const tokens = String(line || "").split(/[ \u3000]+/).filter(Boolean);
        for (const token of tokens) {
            if (hasFullStop(token)) {
                sawFullStopBeforeLimit = true;
                break;
            }
            headTokenCount++;
            if (headTokenCount >= HEAD_TOKEN_LIMIT) break;
        }
        if (sawFullStopBeforeLimit || headTokenCount >= HEAD_TOKEN_LIMIT) break;
    }
    const hasHead40TokenRunWithoutFullStop = headTokenCount >= HEAD_TOKEN_LIMIT && !sawFullStopBeforeLimit;
    const shouldAutoAddPunctuation = contentLines.length > 0 && hasHead40TokenRunWithoutFullStop;

    const sentences = [];
    // When a sentence ends exactly at an original segment boundary, the next sentence MUST start at the next segment's start.
    let pendingBoundaryStart = false;
    let currentSentence = {
        start: null,
        end: null,
        text: ""
    };

    let sentenceCount = 0; // [NEW] Count to control no-punctuation sentence merging

    rawSubtitles.forEach((sub, index) => {
        let text = sub.text.trim();
        if (!text) return;
        const punctCheckText = stripLeadingListMarker(text) || text;

        if (isTitleLike(text)) {
            if (currentSentence.text) {
                sentences.push(currentSentence);
            }
            sentences.push({
                start: sub.start,
                end: sub.end,
                text: text
            });
            currentSentence = { start: null, end: null, text: "" };
            sentenceCount = 0;
            return;
        }

        if (currentSentence.start === null) {
            // Requirement: if a new sentence begins at an original segment start, use that start exactly (no +/-).
            // Also, if the previous sentence ended exactly at a segment boundary, we must start at THIS segment's start.
            currentSentence.start = sub.start;
            if (pendingBoundaryStart) pendingBoundaryStart = false;
        }

        // [NEW] Logic for segments without punctuation
        // Check for Latin (.?!) or CJK (。！？) punctuation
        const hasPunctuation = sentenceEndRegex.test(punctCheckText);
        if (shouldAutoAddPunctuation && !hasPunctuation) {
            // Determine period type based on content (CJK vs Latin) OR Track Language
            const isCJK = isCJKLine(punctCheckText) || /^(ja|ko|zh)/i.test(trackLanguage);
            const period = isCJK ? "。" : ".";
            const space = isCJK ? "　" : " "; // Full-width space for CJK
            const textForAppend = punctCheckText || text;

            // Add space if appending to existing text
            const prefix = currentSentence.text ? space : "";

            currentSentence.text += prefix + textForAppend + period;
            currentSentence.end = sub.end;
            sentenceCount++;

            const currentDuration = currentSentence.end - currentSentence.start;
            // Respect both constraints: flush when count hits cap OR duration reaches minimum target.
            if (sentenceCount >= Math.max(1, maxMergeCount) || currentDuration >= minDuration) {
                sentences.push(currentSentence);
                pendingBoundaryStart = true;
                currentSentence = { start: null, end: null, text: "" };
                sentenceCount = 0;
            }
            return;
        }
        sentenceCount = 0;

        const regex = punctuationRegex;
        let match;
        let lastIndex = 0;

        while ((match = regex.exec(text)) !== null) {
            const punct = match[1];
            const endIdx = match.index + punct.length;

            const textToCheck = text.substring(lastIndex, endIdx).trim();
            if (isAbbreviation(textToCheck)) {
                continue;
            }

            const part = text.substring(lastIndex, endIdx).trim();
            currentSentence.text += (currentSentence.text ? " " : "") + part;

            const lineDuration = sub.end - sub.start;
            const lineLength = text.length;
            const splitPos = endIdx;

            // Weighted estimation by spoken units plus punctuation pauses.
            // LRC lines often contain "previous sentence. Next sentence"; if the period
            // pause is not counted, the first sentence end is estimated too early.
            const totalUnits = countTimelineUnits(text);
            const beforeUnits = countTimelineUnits(text.substring(0, splitPos));
            const ratio = (totalUnits > 0) ? (beforeUnits / totalUnits) : (splitPos / Math.max(1, lineLength));

            // Requirement #1: if the sentence ends exactly at the original segment end, use sub.end exactly
            const estimatedEnd = (splitPos >= lineLength) ? sub.end : (sub.start + (lineDuration * ratio));

            // [NEW] Merge short sentences (< minDuration) to avoid iOS playback skipping/sync issues.
            // If the sentence is too short, we skip this split point and let it merge with the next part.
            const currentDuration = estimatedEnd - currentSentence.start;
            if (currentDuration < minDuration) {
                lastIndex = endIdx;
                continue;
            }

            // [UPDATED] Dynamic TRIM
            // Requirement #1: exact boundary -> no +/- time
            if (splitPos >= lineLength) {
                // Requirement #1: exact boundary -> end must equal the original segment end (no +/-)
                currentSentence.end = sub.end;
                sentences.push(currentSentence);

                // IMPORTANT: The next sentence MUST start at the NEXT original segment's start (not sub.end),
                // otherwise we can hear a tiny carryover tail at playback.
                pendingBoundaryStart = true;
                currentSentence = {
                    start: null,
                    end: null,
                    text: ""
                };

                lastIndex = endIdx;
                continue;
            }

            const segDuration = estimatedEnd - currentSentence.start;
            let buffer = Math.min(bufferTime, 0.12);
            if (segDuration < 1.6) buffer = 0;
            else if (segDuration < 2.8) buffer = Math.min(bufferTime, 0.05);

            const trimmedEnd = Math.max(currentSentence.start + 0.2, estimatedEnd - buffer);

            currentSentence.end = trimmedEnd;
            sentences.push(currentSentence);

            currentSentence = {
                start: estimatedEnd,
                end: null,
                text: ""
            };

            lastIndex = endIdx;
        }

        const remaining = text.substring(lastIndex).trim();
        if (remaining) {
            currentSentence.text += (currentSentence.text ? " " : "") + remaining;
            currentSentence.end = sub.end;
        }
    });

    if (currentSentence.text) {
        sentences.push(currentSentence);
    }

    return sentences.map((s, i) => ({
        id: `smart-${i}`,
        ...s,
        text: shouldAutoAddPunctuation ? ensureSentenceTerminal(s.text) : s.text.trim()
    }));
};

const extractJsonObjectFromText = (rawText, opts = {}) => {
    const arrayField = String(opts?.arrayField || "").trim();
    if (!rawText || typeof rawText !== 'string') throw new Error('Empty AI response');
    let cleaned = rawText.trim()
        .replace(/^\uFEFF/, '')
        .replace(/```json/gi, '')
        .replace(/```JSON/gi, '')
        .replace(/```js/gi, '')
        .replace(/```/g, '')
        .trim();

    const candidates = [];
    const pushCandidate = (text) => {
        if (text && typeof text === 'string' && text.trim().length > 0) {
            candidates.push(text.trim());
        }
    };

    // Extract first balanced object/array block.
    const extractBalanced = (text, openChar, closeChar) => {
        const s = text.indexOf(openChar);
        if (s === -1) return "";
        let depth = 0;
        let inString = false;
        let escapeNext = false;
        for (let i = s; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (escapeNext) {
                    escapeNext = false;
                } else if (ch === '\\') {
                    escapeNext = true;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === openChar) depth++;
            if (ch === closeChar) {
                depth--;
                if (depth === 0) return text.slice(s, i + 1);
            }
        }
        return "";
    };

    pushCandidate(cleaned);
    const objStart = cleaned.indexOf('{');
    const objEnd = cleaned.lastIndexOf('}');
    if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
        pushCandidate(cleaned.slice(objStart, objEnd + 1));
    }
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
        pushCandidate(cleaned.slice(arrStart, arrEnd + 1));
    }
    pushCandidate(extractBalanced(cleaned, '{', '}'));
    pushCandidate(extractBalanced(cleaned, '[', ']'));

    const parseTry = (text) => {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed) && arrayField) return { [arrayField]: parsed };
            return parsed;
        } catch (_) {
            return null;
        }
    };

    for (const c of candidates) {
        const parsed = parseTry(c);
        if (parsed) return parsed;
    }

    // Heuristic repairs for common model JSON mistakes.
    const repairJsonLike = (text) => {
        let t = String(text || "");
        t = t
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/\u00A0/g, ' ')
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            // Remove trailing commas before object/array end.
            .replace(/,\s*([}\]])/g, '$1')
            // Add missing comma between adjacent objects in arrays.
            .replace(/}\s*{/g, '},{')
            .replace(/"\s*\n\s*{/g, '",{')
            .replace(/}\s*\n\s*"/g, '},"')
            // Add missing comma between adjacent quoted items (commonly in options arrays).
            .replace(/"\s*\n\s*"/g, '","')
            .trim();

        // Escape raw line breaks inside strings.
        let escaped = "";
        let inString = false;
        let escapeNext = false;
        for (let i = 0; i < t.length; i++) {
            const ch = t[i];
            if (inString) {
                if (escapeNext) {
                    escaped += ch;
                    escapeNext = false;
                    continue;
                }
                if (ch === '\\') {
                    escaped += ch;
                    escapeNext = true;
                    continue;
                }
                if (ch === '"') {
                    escaped += ch;
                    inString = false;
                    continue;
                }
                if (ch === '\n') {
                    escaped += '\\n';
                    continue;
                }
                if (ch === '\r') continue;
                escaped += ch;
                continue;
            }
            if (ch === '"') inString = true;
            escaped += ch;
        }
        return escaped;
    };

    for (const c of candidates) {
        const repaired = repairJsonLike(c);
        const parsed = parseTry(repaired);
        if (parsed) return parsed;
    }

    // Final fallback for array-root JSON when caller provides a target field.
    if (arrayField) {
        const arr = extractBalanced(cleaned, '[', ']');
        if (arr) {
            const parsed = parseTry(repairJsonLike(arr));
            if (parsed) return parsed;
        }
    }

    throw new Error('AI response is not valid JSON object');
};

const shuffleArray = (arr) => {
    const out = Array.isArray(arr) ? [...arr] : [];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

const detectCurriculumStyleContent = (text) => {
    if (!text || typeof text !== 'string') return false;
    const sample = text.toLowerCase();
    const markers = [
        'lesson', 'unit', 'chapter', 'grammar', 'vocabulary', 'exercise', 'worksheet',
        '課文', '課次', '單元', '章節', '文法', '語法', '詞彙', '單字', '練習', '教材', '講義'
    ];
    let hit = 0;
    for (const m of markers) {
        if (sample.includes(m)) hit++;
    }
    return hit >= 2;
};

const QUIZ_FOCUS_TYPE_LABELS = {
    vocab: "單字",
    usage: "用語",
    grammar: "文法",
    pattern: "句型",
    reading: "閱讀",
    listening: "聽力",
    sentence: "句子"
};

const QUIZ_FOCUS_TYPE_ORDER = ['vocab', 'usage', 'grammar', 'pattern', 'reading', 'listening'];
const FLASH_CARD_CATEGORY_ORDER = [...QUIZ_FOCUS_TYPE_ORDER, 'sentence'];

const getKnowledgeLinkStyleMeta = (items = []) => {
    const categories = new Set(
        (Array.isArray(items) ? items : [])
            .map((item) => String(item?.category || "").trim())
            .filter(Boolean)
    );
    const hasLexical = categories.has('vocab') || categories.has('usage');
    const hasStructure = categories.has('grammar') || categories.has('pattern');

    if (hasLexical && hasStructure) {
        return {
            className: "text-amber-900 underline decoration-2 underline-offset-2 decoration-amber-600 bg-amber-100 rounded-sm px-0.5 hover:bg-amber-200 hover:decoration-amber-700",
            title: "查看相關知識點：單字/用語 + 文法/句型"
        };
    }
    if (hasStructure) {
        return {
            className: "text-violet-800 underline decoration-2 underline-offset-2 decoration-violet-500 hover:text-violet-900 hover:decoration-violet-700",
            title: "查看相關知識點：文法/句型"
        };
    }
    if (hasLexical) {
        return {
            className: "text-cyan-800 underline decoration-2 underline-offset-2 decoration-cyan-400 hover:text-cyan-900 hover:decoration-cyan-600",
            title: "查看相關知識點：單字/用語"
        };
    }
    return {
        className: "text-slate-700 underline decoration-2 underline-offset-2 decoration-slate-400 hover:text-slate-900 hover:decoration-slate-600",
        title: "查看相關知識點"
    };
};

const normalizeQuizKnowledgeCategory = (raw) => {
    const t = String(raw || "").toLowerCase();
    if (/vocab|word|lexic|單字|詞彙|字彙/.test(t)) return 'vocab';
    if (/usage|phrase|collocation|idiom|expression|preposition|用語|片語|搭配|介詞|慣用/.test(t)) return 'usage';
    if (/grammar|syntax|tense|voice|mood|文法|語法|時態|語態/.test(t)) return 'grammar';
    if (/pattern|sentence|rewrite|dialogue|句型|改寫|對話|造句/.test(t)) return 'pattern';
    if (/reading|context|inference|comprehension|閱讀|語境|推論|理解/.test(t)) return 'reading';
    if (/listening|pronunciation|phonetic|stress|intonation|reduction|聽力|發音|連音|重音|語調/.test(t)) return 'listening';
    return 'vocab';
};

const getQuizBucket = (item) => {
    const typeText = String(item?.type || '').toLowerCase();
    const questionText = String(item?.stem || item?.question || '').toLowerCase();
    const kpText = String(item?.knowledgePoint || '').toLowerCase();
    const catText = String(item?.knowledgeCategory || item?.knowledgePointCategory || '').toLowerCase();
    const combined = `${typeText} ${questionText} ${kpText} ${catText}`;
    const normalizedCategory = normalizeQuizKnowledgeCategory(catText || kpText || typeText);

    if (normalizedCategory === 'vocab' || normalizedCategory === 'usage') return 'vocab';
    if (normalizedCategory === 'grammar' || normalizedCategory === 'pattern') return 'grammar';
    if (normalizedCategory === 'reading' || normalizedCategory === 'listening') return 'reading';

    if (/vocab|word|lexic|collocation|單字|詞彙|搭配|片語/.test(combined)) return 'vocab';
    if (/grammar|tense|syntax|rewrite|error|pattern|文法|語法|時態|改寫|句型|糾錯|訂正/.test(combined)) return 'grammar';
    if (/reading|context|inference|comprehension|listening|閱讀|語境|推論|理解|聽力/.test(combined)) return 'reading';
    return 'other';
};

const evaluateQuizBalance = (questions, textbookMode = false) => {
    const counts = { vocab: 0, grammar: 0, reading: 0, other: 0 };
    for (const q of questions || []) {
        const bucket = getQuizBucket(q);
        counts[bucket] = (counts[bucket] || 0) + 1;
    }
    const minVocab = textbookMode ? 4 : 3;
    const minGrammar = textbookMode ? 3 : 2;
    const maxReading = textbookMode ? 2 : 4;
    const minLearningCore = textbookMode ? 8 : 6; // vocab + grammar
    const learningCore = counts.vocab + counts.grammar;

    return {
        counts,
        minVocab,
        minGrammar,
        maxReading,
        minLearningCore,
        ok:
            counts.vocab >= minVocab &&
            counts.grammar >= minGrammar &&
            counts.reading <= maxReading &&
            learningCore >= minLearningCore
    };
};

const cleanQuizDisplayText = (text) => {
    if (!text || typeof text !== 'string') return "";
    return stripTargetTagsForDisplay(text)
        .replace(/\{\{(.*?)\}\}/g, '$1')
        .replace(/<[^>]*>/g, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^\s*(?:\d+\s*[.)、．]\s*)+/g, '')
        .replace(/^\s*(?:[-*•]\s*)+/g, '')
        .replace(/^\s*第\s*\d+\s*[課课篇章節节]\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
};

const KNOWLEDGE_META_LINE_RE = /^(LRC\s*知識點整理|檔名[:：]|語言[:：]|生成時間[:：]|總知識點[:：]|===)/i;
const KNOWLEDGE_SECTION_LINE_RE = /^(單字|詞彙|字彙|用語|片語|搭配|文法|語法|句型|閱讀|聽力|vocab(?:ulary)?|usage|grammar|pattern|reading|listening)\s*(?:\(\s*\d+\s*\))?$/i;
const KNOWLEDGE_ORIGINAL_MARKER_RE = /^(\[\s*原文\s*\]|\[\s*original\s*\]|原文\s*[:：]?|original\s*[:：]?)/i;

const isKnowledgeMetaLine = (line) => {
    const t = String(line || "").trim();
    if (!t) return false;
    return KNOWLEDGE_META_LINE_RE.test(t);
};

const isKnowledgeOriginalMarkerLine = (line) => {
    const t = String(line || "").trim();
    if (!t) return false;
    return KNOWLEDGE_ORIGINAL_MARKER_RE.test(t);
};

const isKnowledgeBodyStartLine = (line) => {
    const t = String(line || "").trim();
    if (!t) return false;
    if (isKnowledgeMetaLine(t)) return true;
    if (/^===\s*(.*?)\s*(?:\(\s*\d+\s*\))?\s*===$/.test(t)) return true;
    if (KNOWLEDGE_SECTION_LINE_RE.test(t)) return true;
    if (/^(?:#{1,6}\s*)?(?:\*\*)?\s*[【\[]?\s*(單字|詞彙|字彙|用語|片語|搭配|文法|語法|句型|閱讀|聽力|vocab(?:ulary)?|usage|grammar|pattern|reading|listening)\s*[】\]]?\s*(?:\(\s*\d+\s*\))?\s*(?:[:：])?\s*(?:\*\*)?$/i.test(t)) return true;
    return false;
};

const extractKnowledgeBodyText = (txt) => {
    const raw = String(txt || "").replace(/\r/g, "");
    if (!raw.trim()) return "";
    const lines = raw.split("\n");
    const sliceBeforeOriginalBlock = (startIdx = 0) => {
        const safeStart = Math.max(0, Number(startIdx || 0));
        const relativeOriginalIdx = lines.slice(safeStart).findIndex((line) => isKnowledgeOriginalMarkerLine(line));
        const endIdx = relativeOriginalIdx >= 0 ? (safeStart + relativeOriginalIdx) : lines.length;
        return lines.slice(safeStart, endIdx).join("\n").trim();
    };
    const lrcHeaderIdx = lines.findIndex((line) => /^LRC\s*知識點整理\s*$/i.test(String(line || "").trim()));
    if (lrcHeaderIdx >= 0) {
        return sliceBeforeOriginalBlock(lrcHeaderIdx);
    }
    const startIdx = lines.findIndex((line) => isKnowledgeBodyStartLine(line));
    if (startIdx > 0) {
        return sliceBeforeOriginalBlock(startIdx);
    }
    if (startIdx === -1) {
        const hasOriginalMarker = lines.some((line) => isKnowledgeOriginalMarkerLine(line));
        if (hasOriginalMarker) {
            return "";
        }
    }
    return raw.trim();
};

const looksLikeKnowledgeFallbackPointLine = (line) => {
    const t = cleanQuizDisplayText(String(line || ""));
    if (!t) return false;
    if (t.length > 64) return false;
    if (/^\d{1,2}[:：]\d{2}(?:\s*[AP]M)?$/i.test(t)) return false;
    if (/^(?:\d{1,2}[/-]){2,3}\d{1,4}$/.test(t)) return false;
    if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t)) return false;
    if (/[,.;!?。！？]/.test(t)) return false;
    if (/\b(?:am|pm)\b/i.test(t)) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 8) return false;
    return true;
};

const normalizeKnowledgePointLabel = (text, fallbackType = "綜合") => {
    const cleaned = cleanQuizDisplayText(text);
    if (!cleaned) return fallbackType;
    const firstCut = cleaned.split(/[:：|｜\-—]/)[0].trim();
    if (firstCut) return firstCut;
    return fallbackType;
};

const evaluateQuizQuestionLanguage = (questions, trackLanguage = "en-US") => {
    const isCjkTrack = /^(zh|ja|ko)/i.test(trackLanguage || "");
    if (isCjkTrack) return { ok: true, cjkRatio: 0, cjkCount: 0, totalChars: 0 };
    let cjkCount = 0;
    let totalChars = 0;
    for (const q of questions || []) {
        const text = `${q?.stem || ""} ${(q?.options || []).join(" ")}`.trim();
        if (!text) continue;
        const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
        cjkCount += cjk;
        totalChars += text.length;
    }
    const cjkRatio = totalChars > 0 ? cjkCount / totalChars : 0;
    const ok = cjkCount <= 6 && cjkRatio <= 0.03;
    return { ok, cjkRatio, cjkCount, totalChars };
};

const normalizeOptionRationales = (raw, optionCount = 4) => {
    const out = Array(Math.max(0, optionCount)).fill("");
    if (!raw) return out;

    if (Array.isArray(raw)) {
        for (let i = 0; i < Math.min(raw.length, out.length); i++) {
            out[i] = cleanQuizDisplayText(String(raw[i] || ""));
        }
        return out;
    }

    if (typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
            let idx = -1;
            const key = String(k || "").trim();
            if (/^[A-D]$/i.test(key)) idx = key.toUpperCase().charCodeAt(0) - 65;
            else if (/^\d+$/.test(key)) {
                const n = parseInt(key, 10);
                if (n >= 0 && n < out.length) idx = n;
                else if (n >= 1 && n <= out.length) idx = n - 1;
            }
            if (idx >= 0 && idx < out.length) {
                out[idx] = cleanQuizDisplayText(String(v || ""));
            }
        }
    }
    return out;
};

const sanitizeSingleAnswerReason = (text) => {
    let t = cleanQuizDisplayText(text);
    if (!t) return "";
    t = t
        .replace(/(根據|依據|按照|參照|基於)\s*LRC[^，。；]*[，。；]?/gi, '')
        .replace(/(在|於)\s*LRC[^，。；]*[，。；]?/gi, '')
        .replace(/according to the lrc[^,.!?;]*/gi, '')
        .replace(/based on the lrc[^,.!?;]*/gi, '')
        .replace(/\b(in this lrc(?: context)?)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return t;
};

const tokenizeLatinForLangDetect = (sample = "") => {
    const normalized = String(sample || "")
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    return normalized.split(/[^a-z]+/).filter(Boolean);
};

const scoreWords = (tokens = [], words = []) => {
    if (!Array.isArray(tokens) || tokens.length === 0 || !Array.isArray(words) || words.length === 0) {
        return { hits: 0, unique: 0 };
    }
    const dict = new Set(words);
    let hits = 0;
    const seen = new Set();
    for (const t of tokens) {
        if (dict.has(t)) {
            hits += 1;
            seen.add(t);
        }
    }
    return { hits, unique: seen.size };
};

const scoreSpanishLanguageHints = (sample = "") => {
    const text = String(sample || "");
    if (!text) return 0;
    let score = 0;
    if (/[¿¡]/.test(text)) score += 4;
    const accentHits = (text.match(/[ñáéíóúü]/gi) || []).length;
    if (accentHits > 0) score += Math.min(4, accentHits);
    const tokens = tokenizeLatinForLangDetect(text);
    const { hits, unique } = scoreWords(tokens, [
        "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "y", "o", "que", "en", "por", "para", "con", "sin", "pero", "porque", "como", "mas", "muy", "tambien", "sobre", "entre", "cuando", "donde", "quien", "que", "como", "cual", "cuales", "esta", "estan", "ser", "estar", "fue", "eran", "hay"
    ]);
    if (hits >= 4 && unique >= 3) score += 2;
    if (hits >= 7 && unique >= 5) score += 2;
    return score;
};

const scoreFrenchLanguageHints = (sample = "") => {
    const text = String(sample || "");
    if (!text) return 0;
    let score = 0;
    if (/[çœæ]/i.test(text)) score += 3;
    const accentHits = (text.match(/[àâéèêëîïôùûüÿ]/gi) || []).length;
    if (accentHits > 0) score += Math.min(3, accentHits);
    if (/\b(?:c|j|l|d|n|s|t|qu)['’]/i.test(text)) score += 2;
    const tokens = tokenizeLatinForLangDetect(text);
    const { hits, unique } = scoreWords(tokens, [
        "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "que", "qui", "en", "dans", "pour", "avec", "pas", "ne", "plus", "sur", "au", "aux", "est", "sont", "etre", "avoir", "ce", "cette", "ces"
    ]);
    if (hits >= 4 && unique >= 3) score += 2;
    if (hits >= 7 && unique >= 5) score += 2;
    return score;
};

const scoreItalianLanguageHints = (sample = "") => {
    const text = String(sample || "");
    if (!text) return 0;
    let score = 0;
    const accentHits = (text.match(/[àèéìòù]/gi) || []).length;
    if (accentHits > 0) score += Math.min(3, accentHits);
    const tokens = tokenizeLatinForLangDetect(text);
    const { hits, unique } = scoreWords(tokens, [
        "il", "lo", "la", "gli", "le", "un", "uno", "una", "di", "del", "della", "che", "e", "non", "per", "con", "ma", "come", "piu", "sono", "essere", "avere", "questo", "questa", "quello", "quella"
    ]);
    if (hits >= 4 && unique >= 3) score += 2;
    if (hits >= 7 && unique >= 5) score += 2;
    return score;
};

const scorePortugueseLanguageHints = (sample = "") => {
    const text = String(sample || "");
    if (!text) return 0;
    let score = 0;
    if (/[ãõç]/i.test(text)) score += 3;
    const accentHits = (text.match(/[áâàéêíóôú]/gi) || []).length;
    if (accentHits > 0) score += Math.min(3, accentHits);
    const tokens = tokenizeLatinForLangDetect(text);
    const { hits, unique } = scoreWords(tokens, [
        "o", "a", "os", "as", "um", "uma", "de", "do", "da", "dos", "das", "e", "que", "em", "para", "com", "nao", "por", "mais", "como", "esta", "estao", "foi", "eram", "ser", "estar"
    ]);
    if (hits >= 4 && unique >= 3) score += 2;
    if (hits >= 7 && unique >= 5) score += 2;
    return score;
};

const scoreGermanLanguageHints = (sample = "") => {
    const text = String(sample || "");
    if (!text) return 0;
    let score = 0;
    if (/[äöüß]/i.test(text)) score += 4;
    const tokens = tokenizeLatinForLangDetect(text);
    const { hits, unique } = scoreWords(tokens, [
        "der", "die", "das", "ein", "eine", "und", "ist", "sind", "nicht", "ich", "wir", "sie", "mit", "von", "zu", "auf", "fur", "aber", "als", "dem", "den", "des", "im", "am"
    ]);
    if (hits >= 4 && unique >= 3) score += 2;
    if (hits >= 7 && unique >= 5) score += 2;
    return score;
};

const scoreEnglishLanguageHints = (sample = "") => {
    const text = String(sample || "");
    if (!text) return 0;
    let score = 0;
    const tokens = tokenizeLatinForLangDetect(text);
    const { hits, unique } = scoreWords(tokens, [
        "the", "a", "an", "and", "or", "to", "of", "in", "on", "at", "for", "with", "from", "by", "as", "is", "are", "was", "were",
        "be", "been", "being", "have", "has", "had", "do", "does", "did", "not", "this", "that", "these", "those", "it", "its",
        "i", "you", "we", "they", "he", "she", "them", "their", "our", "your", "my", "me", "him", "her", "what", "which", "who",
        "when", "where", "why", "how", "if", "then", "than", "there", "here", "can", "could", "would", "should", "will"
    ]);
    if (hits >= 3 && unique >= 2) score += 2;
    if (hits >= 5 && unique >= 4) score += 2;
    if (hits >= 8 && unique >= 6) score += 2;
    if (/\b(?:it's|i'm|you're|we're|they're|don't|doesn't|didn't|can't|won't|isn't|aren't|wasn't|weren't|that's|there's|what's)\b/i.test(text)) {
        score += 2;
    }
    return score;
};

const inferLatinScriptLanguage = (sample = "", fallbackLanguage = "en-US") => {
    const text = String(sample || "");
    const fallback = String(fallbackLanguage || "").trim() || "en-US";
    if (!text.trim()) return fallback;

    const englishScore = scoreEnglishLanguageHints(text);

    const scores = {
        "es-ES": scoreSpanishLanguageHints(text),
        "fr-FR": scoreFrenchLanguageHints(text),
        "it-IT": scoreItalianLanguageHints(text),
        "pt-PT": scorePortugueseLanguageHints(text),
        "de-DE": scoreGermanLanguageHints(text)
    };
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const best = ranked[0];
    const second = ranked[1];
    const bestScore = best?.[1] || 0;
    const secondScore = second?.[1] || 0;
    if (englishScore >= 4 && englishScore >= bestScore) {
        return "en-US";
    }
    if (
        /^en(?:-|$)/i.test(fallback) &&
        englishScore >= 2 &&
        bestScore < 5
    ) {
        return "en-US";
    }
    if (best && (bestScore >= 5 || (bestScore >= 4 && bestScore >= secondScore + 2))) {
        return best[0];
    }
    if (englishScore >= 2 && bestScore <= englishScore + 1) {
        return "en-US";
    }

    if (/^(es|fr|de|it|pt|nl|sv|da|no|fi|pl|ro|cs|hu|tr|vi|id|ms|tl|ru|uk)(?:-|$)/i.test(fallback)) {
        if (englishScore >= 3) return "en-US";
        if (/^es/i.test(fallback)) return "es-ES";
        if (/^fr/i.test(fallback)) return "fr-FR";
        if (/^de/i.test(fallback)) return "de-DE";
        if (/^it/i.test(fallback)) return "it-IT";
        if (/^pt/i.test(fallback)) return "pt-PT";
        return fallback;
    }
    return "en-US";
};

const inferQuizTargetLanguage = (sourceText = "", fallbackLanguage = "en-US") => {
    const sample = String(sourceText || "");
    if (!sample.trim()) return fallbackLanguage || "en-US";
    if (/[\u3040-\u30ff]/.test(sample)) return "ja-JP";
    if (/[\uac00-\ud7af]/.test(sample)) return "ko-KR";

    const cjkCount = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
    const latinCount = (sample.match(/[A-Za-z]/g) || []).length;

    // For bilingual subtitles, prefer Latin-script target if it is substantial.
    if (latinCount >= 20 && latinCount >= cjkCount * 0.8) {
        return inferLatinScriptLanguage(sample, fallbackLanguage || "en-US");
    }
    return fallbackLanguage || "en-US";
};

const normalizeDeclaredLanguage = (rawValue = "", fallbackLanguage = "en-US") => {
    const raw = String(rawValue || "").trim();
    if (!raw) return fallbackLanguage || "en-US";
    const lower = raw.toLowerCase();
    if (/^ja(?:-|$)|japanese|日本語|日文|日語/.test(lower) || /日本語|日文|日語/.test(raw)) return "ja-JP";
    if (/^ko(?:-|$)|korean|한국어|韓文|韓語/.test(lower) || /한국어|韓文|韓語/.test(raw)) return "ko-KR";
    if (/^zh(?:-|$)|chinese|中文|華語|國語|繁體|简体|簡體/.test(lower) || /中文|華語|國語|繁體|简体|簡體/.test(raw)) return "zh-TW";
    if (/^es(?:-|$)|spanish|español|espanol|西班牙文|西語|西班牙語/.test(lower) || /西班牙文|西語|西班牙語|español|espanol/i.test(raw)) return "es-ES";
    if (/^fr(?:-|$)|french|français|francais|法文|法語/.test(lower) || /法文|法語|français|francais/i.test(raw)) return "fr-FR";
    if (/^it(?:-|$)|italian|italiano|義大利文|義大利語/.test(lower) || /義大利文|義大利語|italiano/i.test(raw)) return "it-IT";
    if (/^pt(?:-|$)|portuguese|português|portugues|葡萄牙文|葡語/.test(lower) || /葡萄牙文|葡語|português|portugues/i.test(raw)) return "pt-PT";
    if (/^de(?:-|$)|german|deutsch|德文|德語/.test(lower) || /德文|德語|deutsch/i.test(raw)) return "de-DE";
    if (/^en(?:-|$)|english|英文|英語/.test(lower) || /英文|英語/.test(raw)) return "en-US";
    if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(raw)) return raw;
    return fallbackLanguage || "en-US";
};

const extractKnowledgeTxtDeclaredLanguage = (txt = "", fallbackLanguage = "en-US") => {
    const content = String(txt || "").replace(/\r/g, "");
    if (!content.trim()) return fallbackLanguage || "en-US";

    // Accept plain headers and markdown-style bullets anywhere in the document.
    const direct = content.match(/(?:^|\n)\s*(?:[-*+]\s*)?(?:語言|语言|language|lang)\s*[:：=－-]\s*([^\n]+)/i);
    if (direct && direct[1]) {
        const v = String(direct[1]).split(/[，,;；|]/)[0].trim();
        return normalizeDeclaredLanguage(v, fallbackLanguage);
    }

    const lines = content.split('\n');
    for (const rawLine of lines) {
        const line = String(rawLine || "")
            .replace(/^\s*[>#\-\*\+\d.)\]]+\s*/, '')
            .trim();
        if (!line) continue;
        const m = line.match(/^(?:語言|语言|language|lang)\s*[:：=－-]\s*(.+)$/i);
        if (!m || !m[1]) continue;
        const v = String(m[1]).split(/[，,;；|]/)[0].trim();
        return normalizeDeclaredLanguage(v, fallbackLanguage);
    }

    return fallbackLanguage || "en-US";
};

const detectTtsLanguageFromText = (rawText = "", fallbackLanguage = "en-US") => {
    const text = String(rawText || "").trim();
    if (!text) return fallbackLanguage || "en-US";
    const fallback = String(fallbackLanguage || "").trim() || "en-US";
    const isJaFallback = /^ja/i.test(fallback);
    const isKoFallback = /^ko/i.test(fallback);
    const isZhFallback = /^zh/i.test(fallback);
    if (/[\u3040-\u30ff]/.test(text)) return "ja-JP";
    if (/[\uac00-\ud7af]/.test(text)) return "ko-KR";
    const hanCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const latinCount = (text.match(/[A-Za-z]/g) || []).length;
    // Mixed-script cards may contain short English labels (e.g. JLPT N5).
    // If fallback already declares a CJK language, keep that preference.
    if (hanCount > 0 && latinCount > 0) {
        if (isJaFallback) return "ja-JP";
        if (isKoFallback) return "ko-KR";
        if (isZhFallback) return "zh-TW";
        if (latinCount > hanCount * 1.2) return "en-US";
        return "zh-TW";
    }
    if (hanCount > 0 && latinCount === 0) {
        if (isJaFallback) return "ja-JP";
        if (isKoFallback) return "ko-KR";
        return "zh-TW";
    }
    if (latinCount > 0) return inferLatinScriptLanguage(text, fallback);
    return fallback;
};

const stripExampleZhTranslationForSpeech = (rawText = "") => {
    let text = String(rawText || "");
    if (!text) return "";
    return text
        .replace(/[（(]\s*中[譯译]\s*[:：][^）)]*[）)]/gu, "\n")
        .replace(/\s*中[譯译]\s*[:：][^\n\/／]+/giu, "\n")
        .split(/\n+/)
        .map(x => cleanQuizDisplayText(x))
        .filter(Boolean)
        .join("\n")
        .trim();
};

const splitExampleSegmentsPreservingParens = (rawText = "") => {
    const text = String(rawText || "");
    if (!text) return [];
    const out = [];
    let buf = "";
    let depth = 0;
    let hasTranslation = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '（' || ch === '(') {
            if (/^[（(]\s*中[譯译]\s*[:：]\s*/iu.test(text.slice(i))) hasTranslation = true;
            depth += 1;
            buf += ch;
            continue;
        }
        if (ch === '）' || ch === ')') {
            depth = Math.max(0, depth - 1);
            buf += ch;
            // Gemini 有時會把兩個例句直接以空白相接，而非使用「/」。
            // 中譯的外層括號結束後若緊接新的英文句，這裡才是例句邊界。
            if (depth === 0 && hasTranslation) {
                const nextSentence = text.slice(i + 1).match(/^\s+([A-ZÀ-ÖØ-Þ"“‘])/u);
                if (nextSentence) {
                    const part = cleanQuizDisplayText(buf);
                    if (part) out.push(part);
                    buf = "";
                    hasTranslation = false;
                    i += nextSentence[0].length - 1;
                }
            }
            continue;
        }
        if ((ch === '/' || ch === '／') && depth === 0) {
            const part = cleanQuizDisplayText(buf);
            if (part) out.push(part);
            buf = "";
            continue;
        }
        buf += ch;
    }
    const tail = cleanQuizDisplayText(buf);
    if (tail) out.push(tail);
    return out;
};

const extractBilingualSentencePairs = (examples = []) => {
    const list = Array.isArray(examples) ? examples : [examples];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        const segments = splitExampleSegmentsPreservingParens(String(raw || ""));
        for (const seg of segments) {
            const s = cleanQuizDisplayText(seg);
            if (!s) continue;
            const marker = s.match(/[（(]\s*中[譯译]\s*[:：]\s*/);
            let target = "";
            let zh = "";
            if (marker && marker.index != null) {
                const idx = marker.index;
                target = cleanQuizDisplayText(s.slice(0, idx));
                zh = cleanQuizDisplayText(s.slice(idx + marker[0].length));
                zh = zh.replace(/[）)]\s*$/g, '').trim();
            } else {
                const plainParen = s.match(/^(.*?)[（(]\s*([^()（）]+?)\s*[）)]\s*$/);
                if (!plainParen) continue;
                const maybeTarget = cleanQuizDisplayText(plainParen[1]);
                const maybeZh = cleanQuizDisplayText(plainParen[2]);
                if (!maybeTarget || !maybeZh) continue;
                // Accept plain parenthetical translation only when the paren content
                // looks like actual Chinese translation, not Japanese reading/kana.
                if (!/[\u4e00-\u9fff]/.test(maybeZh)) continue;
                if (/[\u3040-\u30ff]/.test(maybeZh) && !/[，。！？；：「」『』【】]/.test(maybeZh)) continue;
                target = maybeTarget;
                zh = maybeZh;
            }
            if (!target || !zh) continue;
            const key = `${zh.toLowerCase()}::${target.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ frontZh: zh, backTarget: target });
        }
    }
    return out;
};

const extractBilingualSentencePairsFromOriginalBlock = (rawText = "") => {
    const text = String(rawText || "").replace(/\r/g, "");
    if (!text.trim()) return [];
    const lines = text.split('\n');
    const startIdx = lines.findIndex(line => /^\s*(?:\[\s*原文\s*\]|\[\s*original\s*\]|原文\s*[:：]?|original\s*[:：]?)\s*$/i.test(String(line || "").trim()));
    if (startIdx < 0) return [];

    const out = [];
    const seen = new Set();
    const pushPair = (targetRaw, zhRaw) => {
        const backTarget = cleanQuizDisplayText(String(targetRaw || ""));
        let frontZh = cleanQuizDisplayText(String(zhRaw || ""));
        frontZh = frontZh.replace(/^\s*(?:中[譯译]|中文翻[譯译])\s*[:：]\s*/i, "").trim();
        if (!frontZh || !backTarget) return;
        const key = `${frontZh.toLowerCase()}::${backTarget.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ frontZh, backTarget });
    };

    const isEndMarker = (line) => /^\s*(?:LRC\s*知識點整理|@K_HEADER@|@FN@|@LG@|@TS@|@TT@|@SEC@|@ITEM@|@HEAD@|@DESC@|@EX@|@TAG@|===\s*(?:單字|用語|文法|句型|閱讀|聽力)\b)/i.test(String(line || "").trim());
    const isZhLine = (line) => /^\s*(?:中[譯译]|中文翻[譯译])\s*[:：]/i.test(String(line || "").trim());

    let pendingTarget = "";
    for (let i = startIdx + 1; i < lines.length; i += 1) {
        const raw = String(lines[i] || "").trim();
        if (!raw) continue;
        if (isEndMarker(raw)) break;

        const inlinePairs = extractBilingualSentencePairs([raw]);
        if (inlinePairs.length > 0) {
            for (const pair of inlinePairs) {
                pushPair(pair.backTarget, pair.frontZh);
            }
            pendingTarget = "";
            continue;
        }

        if (isZhLine(raw)) {
            if (pendingTarget) {
                pushPair(pendingTarget, raw);
                pendingTarget = "";
            }
            continue;
        }

        // If two consecutive target lines appear, keep the newer one.
        pendingTarget = raw;
    }
    return out;
};

const extractBilingualSentencePairsFromWholeText = (rawText = "") => {
    const text = String(rawText || "").replace(/\r/g, "");
    if (!text.trim()) return [];
    const lines = text.split('\n');
    const out = [];
    const seen = new Set();

    const pushPair = (frontZhRaw, backTargetRaw) => {
        const frontZh = cleanQuizDisplayText(String(frontZhRaw || ""))
            .replace(/^\s*(?:中[譯译]|中文翻[譯译])\s*[:：]\s*/i, "")
            .trim();
        const backTarget = cleanQuizDisplayText(String(backTargetRaw || ""));
        if (!frontZh || !backTarget) return;
        const key = `${frontZh.toLowerCase()}::${backTarget.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ frontZh, backTarget });
    };

    let pendingTarget = "";
    for (let i = 0; i < lines.length; i += 1) {
        const raw = String(lines[i] || "").trim();
        if (!raw) continue;
        if (isKnowledgeMetaLine(raw) || isKnowledgeOriginalMarkerLine(raw) || /^(@K_HEADER@|@FN@|@LG@|@TS@|@TT@|@SEC@|@ITEM@|@HEAD@|@DESC@|@EX@|@TAG@)/i.test(raw)) {
            pendingTarget = "";
            continue;
        }
        if (/^(?:Tags?|Tag|說明|解釋|解释|備註|註解|Note)\s*[:：]/i.test(raw)) {
            pendingTarget = "";
            continue;
        }

        const inlinePairs = extractBilingualSentencePairs([raw]);
        if (inlinePairs.length > 0) {
            for (const pair of inlinePairs) {
                pushPair(pair.frontZh, pair.backTarget);
            }
            pendingTarget = "";
            continue;
        }

        if (/^\s*(?:中[譯译]|中文翻[譯译])\s*[:：]/i.test(raw) && pendingTarget) {
            pushPair(raw, pendingTarget);
            pendingTarget = "";
            continue;
        }
        pendingTarget = raw;
    }
    return out;
};

const normalizeCurrencyForSpeech = (rawText = "", langHint = "") => {
    let s = String(rawText || "");
    if (!s) return "";
    const lang = String(langHint || "").trim().toLowerCase();
    const currencyWord = /^zh/i.test(lang)
        ? "美元"
        : /^ja/i.test(lang)
            ? "dollars"
            : /^ko/i.test(lang)
                ? "dollars"
                : "dollars";
    const scaleWord = (rawScale = "") => {
        const key = String(rawScale || "").trim().toLowerCase();
        if (!key) return "";
        if (key === "k") return /^zh/i.test(lang) ? "千" : "thousand";
        if (key === "m" || key === "mn") return /^zh/i.test(lang) ? "百萬" : "million";
        if (key === "b" || key === "bn") return /^zh/i.test(lang) ? "十億" : "billion";
        if (key === "t" || key === "tn") return /^zh/i.test(lang) ? "兆" : "trillion";
        return "";
    };
    const currencyPattern = /(?:\bUS\$|\$)\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)(?:\s*(k|m|mn|b|bn|t|tn))?(?=\b|[^0-9a-z])/gi;
    s = s.replace(currencyPattern, (_m, amount, scale) => {
        const unit = scaleWord(scale);
        return unit
            ? `${amount} ${unit} ${currencyWord}`
            : `${amount} ${currencyWord}`;
    });
    return s;
};

const normalizeAmpersandForSpeech = (rawText = "", langHint = "") => {
    let s = String(rawText || "");
    if (!s) return "";
    const lang = String(langHint || "").trim().toLowerCase();
    const andWord = /^zh/i.test(lang)
        ? "和"
        : /^ja/i.test(lang)
            ? "and"
            : /^ko/i.test(lang)
                ? "and"
                : "and";
    return s.replace(/([A-Za-z0-9])\s*&\s*([A-Za-z0-9])/g, `$1 ${andWord} $2`);
};

const normalizeCommonSymbolWordsForSpeech = (rawText = "", langHint = "") => {
    let s = String(rawText || "");
    if (!s) return "";
    const lang = String(langHint || "").trim().toLowerCase();
    const plusWord = /^zh/i.test(lang) ? "加" : "plus";
    const sharpWord = /^zh/i.test(lang) ? "sharp" : "sharp";

    // C++, C+ and Disney+ style names.
    s = s.replace(/\b([A-Za-z])\s*\+\+\b/g, `$1 ${plusWord} ${plusWord}`);
    s = s.replace(/\b([A-Za-z0-9]+)\s*\+\b/g, `$1 ${plusWord}`);
    s = s.replace(/\b([A-Za-z0-9]+)\s*\+\s*([A-Za-z0-9]+)\b/g, `$1 ${plusWord} $2`);

    // Common programming language / brand forms like C# and F#.
    s = s.replace(/\b([A-Za-z])\s*#\b/g, `$1 ${sharpWord}`);

    return s;
};

const normalizeTildeForSpeech = (rawText = "", langHint = "") => {
    let s = String(rawText || "");
    if (!s) return "";
    const lang = String(langHint || "").trim().toLowerCase();
    const rangeWord = /^zh/i.test(lang)
        ? "到"
        : /^ja/i.test(lang)
            ? "から"
            : "to";
    const placeholderWord = /^ja/i.test(lang)
        ? "なになに"
        : /^zh/i.test(lang)
            ? "某某"
            : "blank";
    // Only read as a range when both sides look numeric/time-like, e.g. 1～3 or 9:00～10:00.
    s = s.replace(/(\d[\d:：.,\/-]*)\s*[~～〜]\s*(\d[\d:：.,\/-]*)/gu, `$1 ${rangeWord} $2`);
    return s.replace(/[~～〜]+/gu, ` ${placeholderWord} `);
};

const normalizeInlineQuotesForSpeech = (rawText = "") => {
    let s = String(rawText || "");
    if (!s) return "";
    // Strip short inline scare quotes / emphasis quotes to avoid artificial pauses in TTS.
    // Keep longer quoted passages or sentence-like dialogue untouched.
    return s.replace(/([(\s]|^)[“"']([^"'“”‘’\n]{1,48}?)[”"'](?=[$\s,.;:!?，。；：)）\]])/g, (m, lead, inner) => {
        const t = String(inner || "").trim();
        if (!t) return m;
        const wordCount = t.split(/\s+/).filter(Boolean).length;
        if (wordCount > 6) return m;
        if (/[.!?。！？]/.test(t)) return m;
        return `${lead}${t}`;
    });
};

const normalizeVisualAngleBracketsForSpeech = (rawText = "") => {
    let s = String(rawText || "");
    if (!s) return "";
    // Generated explanations sometimes use <...> as visual emphasis/category
    // markers, not HTML. Strip the brackets so native TTS does not read
    // "open angle bracket / close angle bracket" aloud.
    return s
        .replace(/[〈《＜<]\s*([^<>{}〈〉《》＜＞\n]{1,80}?)\s*[〉》＞>]/gu, (m, inner) => {
            return /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(inner)
                ? ` ${inner} `
                : m;
        })
        .replace(/[〈〉《》＜＞]/gu, " ");
};

const normalizeChineseEllipsisForSpeech = (rawText = "", langHint = "") => {
    const s = String(rawText || "");
    if (!s) return "";
    if (!/^zh(?:-|$)/i.test(String(langHint || "").trim())) return s;
    return s.replace(/(?:\.{3,}|…+|⋯+|．{3,})/gu, "點點點");
};

const stripLeadingStructuralNumberForSpeech = (rawText = "") => {
    let s = String(rawText || "").trim();
    if (!s) return "";
    // Remove numbering used as a title/list marker, but keep numbers that are
    // part of the sentence itself: "2024 was...", "3 people...", "1.5 times...".
    const markerPatterns = [
        /^(?:\(\s*\d{1,3}\s*\)|\d{1,3}\s*[.)．、])\s+(?=\S)/u,
        /^(?:[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*(?=\S)/u,
        /^(?:[一二三四五六七八九十]{1,4}\s*[、.．)]|第\s*\d{1,3}\s*[課章节章])\s*(?=\S)/u
    ];
    for (const re of markerPatterns) {
        const next = s.replace(re, "").trim();
        if (next !== s) return next;
    }
    return s;
};

const stripDecorativeSymbolsForSpeech = (rawText = "") => {
    let s = String(rawText || "");
    if (!s) return "";
    return s
        // Arrows and pointer symbols are usually visual structure, not spoken content.
        .replace(/[←↑→↓↔↕↖↗↘↙↚-↟↠-↯⇐-⇿⟰-⟿⤀-⥿➔-➯➱-➾➜➝➞➟➠➡➢➣➤➥➦➧➨➩➪➫➬➭➮➯➲➳➵➸➺➻➼➽➾]/gu, " ")
        .replace(/(?:^|[\s\n])(?:-{1,2}>|={1,2}>|<{1,2}-|<{1,2}=)(?=$|[\s\n])/g, " ")
        // Common decorative bullets / reference marks that TTS engines may read aloud.
        .replace(/[•‣◦▪▫■□◆◇○●◎★☆※＊☑☐✓✔✕✖✗✘]/gu, " ")
        .replace(/[ \t\f\v]+/g, " ");
};

const addJapaneseSpeechBreaks = (rawText = "") => {
    let s = String(rawText || "");
    if (!s) return "";
    const nameToken = "[A-Za-z\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff々〆ヵヶー]{1,16}(?:さん|先生|くん|ちゃん)?";
    const nameBeforeTopicRe = new RegExp(`(ですか|です|ますか|ます|でしたか|でした|ません|ました)(?=(${nameToken})(?:は|が|も|[:：]))`, "gu");
    return s
        .replace(/\s*([。！？!?])\s*/gu, "$1\n")
        .replace(/\s*([:：])\s*/gu, "$1\n")
        .replace(nameBeforeTopicRe, "$1\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
};

const sanitizeSpeakerText = (rawText = "", langHint = "") => {
    let s = String(rawText || "").trim();
    if (!s) return "";
    const lang = String(langHint || "").trim().toLowerCase();
    const preferNonChinese = /^en|^ja|^ko|^de|^fr|^es|^it|^pt|^ru/i.test(lang);
    const likelyJapanese = /^ja/i.test(lang) || /[\u3040-\u30ff]/.test(s);
    s = normalizeChineseEllipsisForSpeech(s, langHint);
    s = stripLeadingStructuralNumberForSpeech(s);
    s = stripDecorativeSymbolsForSpeech(s);
    if (likelyJapanese) s = addJapaneseSpeechBreaks(s);
    // Remove IPA/phonetic snippets, not only at tail (e.g. "submarine /ˈsʌbməriːn/, ...").
    const looksLikeIpa = (chunk = "") => {
        return looksLikePhoneticChunk(chunk);
    };
    // Hard cut: if line is "head / IPA...", keep only head so speaker never reads IPA.
    const slashCut = s.match(/^\s*([^\n\/]{1,200}?)\s+[\/／]\s*([^\n]{1,200})$/u);
    if (slashCut) {
        const head = String(slashCut[1] || "").trim();
        const tail = String(slashCut[2] || "").trim();
        const tailProbe = tail.slice(0, 96);
        if (head && (/[ˈˌː]/u.test(tailProbe) || /[\u0250-\u02af]/u.test(tailProbe))) {
            return head;
        }
    }
    // Fast path: whole line is "word /ipa/" (or "phrase /ipa/"), keep only head term.
    const headIpaOnly = s.match(/^\s*([A-Za-z][A-Za-z0-9'’._\- ]{0,100}?)\s*[\/／]\s*([^\/／\n]{1,120})\s*[\/／]\s*$/u);
    if (headIpaOnly && looksLikeIpa(headIpaOnly[2])) {
        return String(headIpaOnly[1] || "").replace(/\s+/g, " ").trim();
    }
    // Remove explicit leading labels occasionally kept in knowledge lines.
    s = s.replace(/^(?:發音|音標|phonetic|ipa)\s*[:：]?\s*/i, "").trim();
    s = s.replace(/(?:\s*[,，;；:：]?\s*)[\/／]([^\/／\n]{1,120})[\/／](?=$|[\s,，;；:：)）】\]])(?:\s*[,，;；:：]?\s*)/gu, (m, inner) => looksLikeIpa(inner) ? " " : m);
    s = s.replace(/(?:\s*[,，;；:：]?\s*)\[([^\]\n]{1,120})\](?=$|[\s,，;；:：)）】\]])(?:\s*[,，;；:：]?\s*)/gu, (m, inner) => looksLikeIpa(inner) ? " " : ` ${inner} `);
    // Remove standalone IPA tokens that may appear without slash/brackets.
    s = s.replace(/(^|[\s(（\[])([ˈˌ]?[A-Za-z\u0250-\u02afːˑʰʲʷʼ˞̃.\-]{2,})(?=$|[\s,，;；:：)）】\]])/gu, (m, lead, token) => {
        if (/[ˈˌː]/u.test(token) || /[\u0250-\u02af]/u.test(token)) return `${lead} `;
        return m;
    });
    if (preferNonChinese) {
        s = s
            .replace(/[（(]\s*中[譯译]\s*[:：][^）)]*[）)]/gu, " ")
            .replace(/\b中[譯译]\s*[:：]\s*[^\n]+$/gu, " ")
            .replace(/^\s*中[譯译]\s*[:：]\s*/gu, "")
            .trim();
    }
    s = normalizeCurrencyForSpeech(s, langHint);
    s = normalizeAmpersandForSpeech(s, langHint);
    s = normalizeCommonSymbolWordsForSpeech(s, langHint);
    s = normalizeTildeForSpeech(s, langHint);
    s = normalizeInlineQuotesForSpeech(s);
    s = normalizeVisualAngleBracketsForSpeech(s);
    return s
        .replace(/\s*[,，;；:：]\s*$/u, "")
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim();
};

const extractFrontTermForSpeech = (rawFront = "") => {
    let s = cleanQuizDisplayText(String(rawFront || ""));
    if (!s) return "";

    // English front format may append IPA at tail: "abandon /əˈbændən/".
    s = s.replace(/\s*\/[^\/\n]{1,80}\/\s*$/u, "").trim();
    s = s.replace(/\s*\[([^\]\n]{1,80})\]\s*$/u, (m, inner) => looksLikePhoneticChunk(inner) ? "" : ` ${inner}`).trim();
    s = s.replace(/\[([^\]\n]{1,80})\]/gu, (m, inner) => looksLikePhoneticChunk(inner) ? "" : ` ${inner} `).trim();

    // Japanese front format may be "漢字（かな）" or "漢字(かな)".
    // Prefer reading for Japanese to avoid incorrect kanji pronunciation by engines.
    const readingMatch = s.match(/^(.*?)\s*[（(]([^)）]{1,80})[)）]\s*$/u);
    if (readingMatch) {
        const base = cleanQuizDisplayText(readingMatch[1] || "");
        const reading = String(readingMatch[2] || "").trim();
        const baseHasKanji = /[\u4e00-\u9fff]/.test(base);
        const readingLooksPhonetic = /[\u3040-\u30ff]/.test(reading) || /^[A-Za-zÀ-ÿ0-9 .,'_-]+$/.test(reading);
        if (base && baseHasKanji && readingLooksPhonetic) {
            s = reading;
        }
    }

    return s.replace(/\s+/g, " ").trim();
};

const normalizeJapaneseRubyForSpeech = (rawText = "", langHint = "") => {
    const src = cleanQuizDisplayText(String(rawText || ""));
    if (!src) return "";
    const likelyJa = /^ja/i.test(String(langHint || "").trim()) || /[\u3040-\u30ff]/.test(src);
    if (!likelyJa) return src;
    const pastedRubyPairs = [
        ["神戸病院", "こうべびょういん"], ["さくら大学", "さくらだいがく"], ["桜大学", "さくらだいがく"],
        ["富士大学", "ふじだいがく"], ["会社員", "かいしゃいん"], ["銀行員", "ぎんこういん"],
        ["研究者", "けんきゅうしゃ"], ["中国人", "ちゅうごくじん"], ["アメリカ人", "アメリカじん"],
        ["イギリス人", "イギリスじん"], ["ドイツ人", "ドイツじん"], ["ブラジル人", "ブラジルじん"],
        ["学生", "がくせい"], ["医者", "いしゃ"], ["大学", "だいがく"], ["先生", "せんせい"],
        ["何歳", "なんさい"], ["社員", "しゃいん"], ["教師", "きょうし"], ["中国", "ちゅうごく"],
        ["韓国", "かんこく"], ["神戸", "こうべ"], ["病院", "びょういん"], ["電気", "でんき"],
        ["名前", "なまえ"], ["失礼", "しつれい"], ["文型", "ぶんけい"], ["例文", "れいぶん"],
        ["会話", "かいわ"], ["単語", "たんご"], ["文法", "ぶんぽう"], ["練習", "れんしゅう"],
        ["問題", "もんだい"], ["初", "はじめ"], ["来", "き"], ["方", "かた"], ["歳", "さい"],
        ["人", "じん"], ["課", "か"], ["第", "だい"], ["例", "れい"], ["私", "わたし"],
        ["貴方", "あなた"], ["誰", "だれ"], ["佐藤", "さとう"], ["山田", "やまだ"],
        ["鈴木", "すずき"], ["田中", "たなか"]
    ];
    const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const normalizePastedRuby = (text) => pastedRubyPairs
        .slice()
        .sort((a, b) => String(b[0]).length - String(a[0]).length)
        .reduce((acc, [base, reading]) => {
            if (!base || !reading) return acc;
            return acc.replace(new RegExp(escapeRegExp(base) + "\\s*" + escapeRegExp(reading), "gu"), reading);
        }, text);
    return normalizePastedRuby(src)
        .replace(/[\u4e00-\u9fff々〆ヵヶ]+\s*[（(]\s*([\u3040-\u309f\u30a0-\u30ffー]{1,32})\s*[）)]/gu, '$1')
        .replace(/[「」『』]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

// ============================================================================
// [MODULE 2]: SUB-COMPONENTS
// ============================================================================

const QuickSpeakBtn = ({ text, size = 16, className = "", rate = 1.0, mode = 'native', forceNativeLang = "", pauseBetweenLinesMs = 0, autoPlaySignal = "", onPlaybackDone = null }) => {
    const { cache, addToCache, currentKey, trackLanguage, preferredVoice, globalAudioRef } = useContext(AudioCacheContext);
    const [isLoading, setIsLoading] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const wasManualRef = useRef(false);
    const nativeQueueTimerRef = useRef(null);
    const nativeSpeakTokenRef = useRef(0);
    const lastAutoPlaySignalRef = useRef("");
    const playbackWatchdogRef = useRef(null);
    const ttsDbg = (...args) => console.log("[TTS-DBG]", ...args);
    const effectiveSpeakLangHint = forceNativeLang || trackLanguage || "en-US";

    const normalizedCacheKey = sanitizeSpeakerText(
        normalizeJapaneseRubyForSpeech(text, effectiveSpeakLangHint),
        effectiveSpeakLangHint
    );
    const isCached = !!cache[normalizedCacheKey];

    useEffect(() => {
        return () => {
            if (nativeQueueTimerRef.current) {
                clearTimeout(nativeQueueTimerRef.current);
                nativeQueueTimerRef.current = null;
            }
            if (playbackWatchdogRef.current) {
                clearTimeout(playbackWatchdogRef.current);
                playbackWatchdogRef.current = null;
            }
            nativeSpeakTokenRef.current += 1;
        };
    }, []);

    useEffect(() => {
        const signal = String(autoPlaySignal || "").trim();
        if (!signal || !text) return;
        if (signal === lastAutoPlaySignalRef.current) return;
        lastAutoPlaySignalRef.current = signal;
        ttsDbg("autoplay.trigger", { mode, signal, textLen: String(text || "").length });
        handlePlay();
    }, [autoPlaySignal]);

    const clearPlaybackWatchdog = () => {
        if (playbackWatchdogRef.current) {
            clearTimeout(playbackWatchdogRef.current);
            playbackWatchdogRef.current = null;
        }
    };

    const startPlaybackWatchdog = (ms = 18000) => {
        clearPlaybackWatchdog();
        playbackWatchdogRef.current = setTimeout(() => {
            ttsDbg("watchdog.timeout", { mode, ms });
            setIsSpeaking(false);
            if ('speechSynthesis' in window) {
                try { window.speechSynthesis.cancel(); } catch (_) { }
            }
            emitPlaybackDone();
        }, Math.max(1000, ms));
    };

    const stopAllAudio = () => {
        // Stop Global AI Audio
        if (globalAudioRef.current) {
            globalAudioRef.current.pause();
            globalAudioRef.current.currentTime = 0;
            globalAudioRef.current = null;
        }
        // Stop Native TTS
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
        if (nativeQueueTimerRef.current) {
            clearTimeout(nativeQueueTimerRef.current);
            nativeQueueTimerRef.current = null;
        }
        clearPlaybackWatchdog();
        nativeSpeakTokenRef.current += 1;
        setIsSpeaking(false);
    };

    const emitPlaybackDone = () => {
        if (typeof onPlaybackDone === 'function') {
            try { onPlaybackDone({ manual: wasManualRef.current }); } catch (_) { }
        }
    };

    const detectNativeTtsLang = (rawText, fallbackLang) => {
        const text = String(rawText || "").trim();
        if (!text) return fallbackLang || "en-US";
        if (/[\uac00-\ud7af]/.test(text)) return "ko-KR";
        if (/[\u3040-\u30ff]/.test(text)) return "ja-JP";

        const hanCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const latinCount = (text.match(/[A-Za-z]/g) || []).length;
        const hasChinesePunct = /[，。！？；：「」『』（）]/.test(text);
        const hasChineseCue = /(?:這|這個|這裡|這種|這樣|意思|說明|中文|中譯|翻譯|解釋|例句|用法|常見|錯誤|比較|注意|表示|相當於|不是|可以|通常|後面|前面)/u.test(text);

        if (hanCount > 0 && latinCount === 0) {
            const isJaFallback = /^ja/i.test(fallbackLang || "");
            if (hasChineseCue || hasChinesePunct) return "zh-TW";
            if (isJaFallback && hanCount <= 4 && !hasChinesePunct) return "ja-JP";
            return "zh-TW";
        }

        if (latinCount > 0) return inferLatinScriptLanguage(text, fallbackLang || "en-US");
        return fallbackLang || "en-US";
    };

    const splitNativeSpeakSegments = (rawText, forcedLang = "") => {
        const isIpaOnlySegment = (seg = "") => {
            const t = String(seg || "").trim();
            if (!t) return false;
            if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(t)) return false;
            if (/[0-9]/.test(t)) return false;
            return /[ˈˌː]/u.test(t) || /[\u0250-\u02af]/u.test(t);
        };
        // Chrome/Safari 的 speechSynthesis 對過長單一 utterance 可能無聲中斷。
        // 優先在句末或子句標點切開；只有沒有安全標點時才在單字邊界切開。
        const chunkForNativeUtterance = (value, maxLength = 180) => {
            const text = String(value || "").trim();
            if (text.length <= maxLength) return text ? [text] : [];
            const clauses = text.match(/[^.!?;:。！？；：]+[.!?;:。！？；：]*\s*/gu) || [text];
            const chunks = [];
            let current = "";
            const flush = () => {
                const part = current.trim();
                if (part) chunks.push(part);
                current = "";
            };
            for (const clause of clauses) {
                const trimmed = clause.trim();
                if (!trimmed) continue;
                if (trimmed.length > maxLength) {
                    flush();
                    const words = trimmed.split(/\s+/u);
                    for (const word of words) {
                        if (current && `${current} ${word}`.length > maxLength) flush();
                        current = current ? `${current} ${word}` : word;
                    }
                    flush();
                } else if (current && `${current} ${trimmed}`.length > maxLength) {
                    flush();
                    current = trimmed;
                } else {
                    current = current ? `${current} ${trimmed}` : trimmed;
                }
            }
            flush();
            return chunks;
        };
        let s = String(rawText || "")
            .replace(/\r/g, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/\[\[Learn:.*?\]\]/g, '')
            .replace(/\*\*/g, '')
            .replace(/###/g, '')
            .replace(/\|/g, ' ')
            .trim();
        if (!s) return [];

        // Start a new segment at explicit example markers.
        s = s.replace(/\s*(例句?|例如|example|examples?)\s*[:：]\s*/gi, '\n');
        // Slash in generated examples is an inline alternative separator, not a sentence boundary.
        // Keep it as comma-length pause instead of creating a new native TTS segment.
        s = s.replace(/\s*[\/／]\s*/g, ', ');

        const langPrefix = String(forcedLang || trackLanguage || "").split('-')[0].toLowerCase();
        const preferNonChinese = langPrefix === 'en' || langPrefix === 'ja' || langPrefix === 'ko';

        const rows = s
            .split(/\n+/)
            .map(x => x.trim())
            .filter(Boolean)
            .map((part) => {
                let p = part
                    .replace(/^\s*[•\-*]\s*/, '')
                    .replace(/^(例句?|例如|example|examples?)\s*[:：]\s*/i, '')
                    .trim();
                // If it's "EN phrase：中文解釋", keep the target-language phrase only.
                p = p.replace(/^([A-Za-z][^:：]{1,140})\s*[:：]\s*[\u4e00-\u9fff][\s\S]*$/u, '$1');
                // Remove trailing Chinese translation in parentheses for non-Chinese target voices.
                if (preferNonChinese) {
                    p = p
                        .replace(/[（(]\s*中[譯译]\s*[:：][^）)]*[）)]\s*/gu, ' ')
                        .replace(/^\s*中[譯译]\s*[:：]\s*/u, '')
                        .replace(/[（(][\u4e00-\u9fff][^）)]*[）)]\s*$/u, '')
                        .trim();
                }
                return p;
            })
            .filter(Boolean);

        const expanded = [];
        for (const row of rows) {
            const normalizedRow = sanitizeSpeakerText(
                normalizeJapaneseRubyForSpeech(row, forcedLang || trackLanguage),
                forcedLang || trackLanguage
            );
            if (!normalizedRow) continue;
            if (isIpaOnlySegment(normalizedRow)) continue;
            expanded.push(...chunkForNativeUtterance(normalizedRow));
        }

        return expanded;
    };

    const splitMixedLanguageNativeSegments = (segments = [], fallbackLang = "") => {
        const hasJapanese = (text = "") => /[\u3040-\u30ff]/u.test(String(text || ""));
        const hasHangul = (text = "") => /[\uac00-\ud7af]/u.test(String(text || ""));
        const hasHan = (text = "") => /[\u4e00-\u9fff]/u.test(String(text || ""));
        const pushPart = (out, text, lang) => {
            const cleaned = String(text || "")
                .replace(/^[\s,，;；:：。！？!?]+/u, "")
                .replace(/[\s,，;；:：]+$/u, "")
                .trim();
            if (!cleaned) return;
            const prev = out[out.length - 1];
            if (prev && prev.lang === lang) {
                prev.text = `${prev.text} ${cleaned}`.replace(/\s+/g, " ").trim();
            } else {
                out.push({ text: cleaned, lang });
            }
        };
        const splitOne = (segment = "") => {
            const text = String(segment || "").trim();
            if (!text) return [];
            const textHasJapanese = hasJapanese(text);
            const fallbackIsJapanese = /^ja/i.test(String(fallbackLang || trackLanguage || ""));
            const textHasChineseCue = /(?:這|這個|這裡|這種|這樣|意思|說明|中文|中譯|翻譯|解釋|例句|用法|常見|錯誤|比較|注意|表示|相當於|不是|可以|通常|後面|前面)/u.test(text);
            if (!textHasJapanese && !hasHangul(text) && !(hasHan(text) && /[A-Za-z]/u.test(text))) {
                return [{ text, lang: detectNativeTtsLang(text, fallbackLang || trackLanguage) }];
            }
            const out = [];
            let buf = "";
            let currentKind = "";
            const kindOf = (ch, prevCh = "") => {
                if (/[\u3040-\u30ff]/u.test(ch)) return "ja";
                if (/[\uac00-\ud7af]/u.test(ch)) return "ko";
                if (/[\u4e00-\u9fff]/u.test(ch)) {
                    if (fallbackIsJapanese && textHasJapanese && !textHasChineseCue) return "ja";
                    if (currentKind === "ja" && !/[\s「」『』"“”'‘’()（）[\]【】.,，;；:：。！？!?-]/u.test(prevCh || "")) return "ja";
                    return "zh";
                }
                if (/[A-Za-z0-9]/u.test(ch)) return currentKind === "zh" ? "latin" : currentKind || "latin";
                return currentKind || "punct";
            };
            const chars = Array.from(text);
            for (let i = 0; i < chars.length; i += 1) {
                const ch = chars[i];
                const kind = kindOf(ch, chars[i - 1] || "");
                const effectiveKind = kind === "punct" ? currentKind : kind;
                if (currentKind && effectiveKind && effectiveKind !== currentKind && !/^[\s「」『』"“”'‘’()（）[\]【】.,，;；:：。！？!?-]$/u.test(ch)) {
                    const lang = currentKind === "ja" ? "ja-JP" : currentKind === "ko" ? "ko-KR" : currentKind === "zh" ? "zh-TW" : detectNativeTtsLang(buf, fallbackLang || trackLanguage);
                    pushPart(out, buf, lang);
                    buf = ch;
                    currentKind = effectiveKind;
                } else {
                    buf += ch;
                    if (effectiveKind && effectiveKind !== "punct") currentKind = effectiveKind;
                }
            }
            if (buf.trim()) {
                const lang = currentKind === "ja" ? "ja-JP" : currentKind === "ko" ? "ko-KR" : currentKind === "zh" ? "zh-TW" : detectNativeTtsLang(buf, fallbackLang || trackLanguage);
                pushPart(out, buf, lang);
            }
            return out.length > 0 ? out : [{ text, lang: detectNativeTtsLang(text, fallbackLang || trackLanguage) }];
        };
        return segments.flatMap(splitOne);
    };

    const playNativeSpeech = (rawTtsText = "") => {
        if (!('speechSynthesis' in window)) {
            ttsDbg("native.unsupported");
            emitPlaybackDone();
            return;
        }
        const synthesis = window.speechSynthesis;
        const cleanText = String(rawTtsText || "").replace(/\[\[Learn:.*?\]\]/g, '').replace(/\*\*/g, '').replace(/###/g, '').replace(/\|/g, '').trim();
        if (!cleanText) {
            emitPlaybackDone();
            return;
        }
        const detectedLang = forceNativeLang || detectNativeTtsLang(cleanText, trackLanguage);
        const langPrefix = String(detectedLang || "").split('-')[0].toLowerCase();
        const voices = synthesis.getVoices();

        let chosenVoice = null;
        const preferredByUri = (preferredVoice && preferredVoice.voiceURI)
            ? voices.find(v => String(v.voiceURI || "") === String(preferredVoice.voiceURI || ""))
            : null;
        if (preferredByUri && isTtsVoiceCompatibleWithLang(preferredByUri, detectedLang || trackLanguage || "en-US")) {
            chosenVoice = preferredByUri;
        } else if (Array.isArray(voices) && voices.length > 0) {
            chosenVoice = chooseBestTtsVoice(voices, detectedLang || trackLanguage || "en-US");
        }
        ttsDbg("native.prepare", {
            detectedLang,
            voiceCount: Array.isArray(voices) ? voices.length : 0,
            chosenVoice: chosenVoice?.name || "",
            chosenVoiceLang: chosenVoice?.lang || "",
            langPrefix,
            synthPaused: !!synthesis.paused,
            synthSpeaking: !!synthesis.speaking,
            synthPending: !!synthesis.pending
        });
        try { synthesis.resume(); } catch (_) { }

        const token = nativeSpeakTokenRef.current + 1;
        nativeSpeakTokenRef.current = token;

        const splitSegments = splitNativeSpeakSegments(cleanText, detectedLang);
        const textSegments = splitSegments.length > 0 ? splitSegments : [cleanText];
        const segments = splitMixedLanguageNativeSegments(textSegments, detectedLang);
        const segmentGapMs = segments.length > 1
            ? Math.max(0, Number(pauseBetweenLinesMs) || 0)
            : 0;

        if (segments.length === 0) {
            emitPlaybackDone();
            return;
        }
        setIsSpeaking(true);
        const safeRate = Math.max(0.5, Number(rate) || 1);
        startPlaybackWatchdog(Math.min(120000, Math.max(12000, Math.round((segments.map(s => s.text).join(' ').length * 260) / safeRate))));

        const speakAt = (idx) => {
            if (nativeSpeakTokenRef.current !== token) return;
            if (idx >= segments.length) {
                clearPlaybackWatchdog();
                setIsSpeaking(false);
                emitPlaybackDone();
                return;
            }
            const currentSegment = segments[idx];
            const segmentLang = currentSegment.lang || detectedLang || trackLanguage || "en-US";
            const preferredSegmentVoice = preferredByUri && isTtsVoiceCompatibleWithLang(preferredByUri, segmentLang)
                ? preferredByUri
                : null;
            const segmentVoice = preferredSegmentVoice || (Array.isArray(voices) && voices.length > 0
                ? chooseBestTtsVoice(voices, segmentLang)
                : null);
            const utterance = new SpeechSynthesisUtterance(currentSegment.text);
            if (segmentVoice) utterance.voice = segmentVoice;
            else if (chosenVoice && isTtsVoiceCompatibleWithLang(chosenVoice, segmentLang)) utterance.voice = chosenVoice;
            utterance.lang = segmentLang;
            utterance.rate = rate;
            utterance.pitch = 1;
            utterance.volume = 1;
            let settled = false;
            const finalizeCurrent = (toNext) => {
                if (settled) return;
                settled = true;
                if (!toNext) {
                    clearPlaybackWatchdog();
                    setIsSpeaking(false);
                    emitPlaybackDone();
                    return;
                }
                nativeQueueTimerRef.current = setTimeout(() => {
                    speakAt(idx + 1);
                }, segmentGapMs);
            };
            ttsDbg("native.speak", { idx, total: segments.length, lang: utterance.lang, voice: utterance.voice?.name || "", textPreview: currentSegment.text.slice(0, 80) });
            utterance.onstart = () => {
                ttsDbg("native.start", { idx, total: segments.length });
            };
            utterance.onend = () => {
                if (nativeSpeakTokenRef.current !== token) return;
                finalizeCurrent(idx < segments.length - 1);
            };
            utterance.onerror = () => {
                if (nativeSpeakTokenRef.current !== token) return;
                ttsDbg("native.error", { idx, total: segments.length });
                finalizeCurrent(idx < segments.length - 1);
            };
            try { synthesis.resume(); } catch (_) { }
            synthesis.speak(utterance);
        };

        setTimeout(() => {
            if (nativeSpeakTokenRef.current !== token) return;
            try { synthesis.cancel(); } catch (_) { }
            try { synthesis.resume(); } catch (_) { }
            speakAt(0);
        }, 80);
    };

    const handlePlay = async (e = null) => {
        wasManualRef.current = !!e;
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        const ttsText = sanitizeSpeakerText(
            normalizeJapaneseRubyForSpeech(text, effectiveSpeakLangHint),
            effectiveSpeakLangHint
        );
        if (!ttsText) return;
        ttsDbg("handlePlay.start", {
            mode,
            textLen: String(ttsText || "").length,
            textPreview: String(ttsText || "").slice(0, 120),
            isLoading,
            isSpeaking,
            hasCache: !!cache[ttsText]
        });

        stopAllAudio();

        if (cache[ttsText]) {
            const audio = new Audio(cache[ttsText]);
            audio.playbackRate = rate;
            globalAudioRef.current = audio;
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                clearPlaybackWatchdog();
                setIsSpeaking(false);
                globalAudioRef.current = null;
                emitPlaybackDone();
            };
            audio.onplay = () => setIsSpeaking(true);
            audio.onended = finish;
            audio.onerror = finish;
            ttsDbg("ai.cache.play", { rate });
            startPlaybackWatchdog(18000);
            audio.play().catch(err => { console.error("Play error:", err); finish(); });
            return;
        }

        const hasApiKey = !!String(currentKey || "").trim();
        if (mode === 'ai' && !hasApiKey) {
            ttsDbg("ai.skip.noApiKey", { fallback: "native" });
            playNativeSpeech(ttsText);
            return;
        }

        if (mode === 'ai') {
            if (isLoading) return;
            setIsLoading(true);
            try {
                ttsDbg("ai.fetch.start", { hasApiKey: true });
                const blob = await callGeminiTTS_Single(ttsText, currentKey);
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    if (addToCache) addToCache(ttsText, url);
                    const audio = new Audio(url);
                    audio.playbackRate = rate;
                    globalAudioRef.current = audio;
                    let finished = false;
                    const finish = () => {
                        if (finished) return;
                        finished = true;
                        clearPlaybackWatchdog();
                        setIsSpeaking(false);
                        globalAudioRef.current = null;
                        emitPlaybackDone();
                    };
                    audio.onplay = () => setIsSpeaking(true);
                    audio.onended = finish;
                    audio.onerror = finish;
                    ttsDbg("ai.fetch.play", { rate });
                    startPlaybackWatchdog(22000);
                    audio.play().catch(() => finish());
                    return;
                }
                ttsDbg("ai.fetch.emptyBlob", { fallback: "native" });
            } catch (error) {
                console.error(error);
                ttsDbg("ai.fetch.error", { message: String(error?.message || error), fallback: "native" });
            } finally {
                setIsLoading(false);
            }
            playNativeSpeech(ttsText);
            return;
        }

        playNativeSpeech(ttsText);
    };

    const btnClass = isSpeaking
        ? "text-blue-500 animate-pulse"
        : isCached
            ? "text-blue-600 font-bold"
            : "text-gray-400 hover:text-blue-600";

    return (
        <button onClick={handlePlay} disabled={isLoading} className={`inline-flex items-center justify-center p-1 rounded-full hover:bg-gray-100 transition-colors ${className}`}>
            {isLoading ? <Loader2 size={size} className="animate-spin text-gray-400" /> : <Volume2 size={size} className={btnClass} />}
        </button>
    );
};

const normalizeKnowledgeAlignmentText = (value = "") => String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\{\{(.*?)\}\}/g, "$1")
    .replace(/\*+/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u3400-\u9fff]+/gu, " ")
    .trim();

const getKnowledgeAlignmentWordScore = (needle = "", haystack = "") => {
    const targetWords = normalizeKnowledgeAlignmentText(needle).match(/[\p{L}\p{N}]+/gu) || [];
    const sourceWords = normalizeKnowledgeAlignmentText(haystack).match(/[\p{L}\p{N}]+/gu) || [];
    if (targetWords.length === 0 || sourceWords.length === 0) return 0;
    const closeEnough = (target, source) => {
        if (target === source) return true;
        if (target.length < 5 || source.length < 5) return false;
        if (target[0] !== source[0] || Math.abs(target.length - source.length) > 1) return false;
        let mismatches = 0;
        for (let i = 0; i < Math.min(target.length, source.length); i += 1) {
            if (target[i] !== source[i]) mismatches += 1;
            if (mismatches > 1) return false;
        }
        return true;
    };
    let matched = 0;
    for (const word of targetWords) {
        if (word.length < 2) continue;
        if (sourceWords.some(candidate => closeEnough(word, candidate))) matched += 1;
    }
    return matched / Math.max(1, targetWords.filter(word => word.length >= 2).length);
};

const findKnowledgeSubtitleMatch = (content = "", subtitleText = "") => {
    const target = normalizeKnowledgeAlignmentText(subtitleText);
    if (!target || target.length < 6) return null;
    const lines = String(content || "").replace(/\r/g, "").split("\n");
    let inOriginal = false;
    let best = null;
    for (let sourceLine = 0; sourceLine < lines.length; sourceLine += 1) {
        const raw = String(lines[sourceLine] || "");
        const trimmed = raw.trim();
        if (KNOWLEDGE_ORIGINAL_MARKER_RE.test(trimmed) || /^\[\s*(?:原文|original)(?:\s*\/\s*(?:原文|original))?\s*\]$/i.test(trimmed) || /^@ORIG@\s*$/i.test(trimmed)) { inOriginal = true; continue; }
        if (inOriginal && /^(?:LRC\s*知識點整理|@K_HEADER@|@FN@|@LG@|@TS@|@TT@|@SEC@|@ITEM@|@HEAD@|@DESC@|@EX@|@TAG@|===)/i.test(trimmed)) inOriginal = false;
        // 僅能以使用者提供的原文 scaffold 對位；不能把 LRC 猜測配到 AI 例句或說明。
        if (!inOriginal || !trimmed) continue;
        const candidate = normalizeKnowledgeAlignmentText(raw);
        if (candidate.length < 6) continue;
        const exact = candidate.includes(target) || target.includes(candidate);
        const wordScore = getKnowledgeAlignmentWordScore(target, candidate);
        const score = exact ? 1 : wordScore;
        const targetWords = target.match(/[\p{L}\p{N}]+/gu) || [];
        const minimum = targetWords.length >= 5 ? 0.55 : 0.8;
        if (score < minimum) continue;
        if (!best || score > best.score) best = { sourceLine, score };
    }
    return best;
};

const getKnowledgeOriginalLinesForSync = (content = "") => {
    let inOriginal = false;
    return String(content || "").replace(/\r/g, "").split("\n").flatMap((raw, sourceLine) => {
        const line = String(raw || "").trim();
        if (KNOWLEDGE_ORIGINAL_MARKER_RE.test(line) || /^@ORIG@\s*$/i.test(line)) { inOriginal = true; return []; }
        if (inOriginal && /^(?:LRC\s*知識點整理|@K_HEADER@|@FN@|@LG@|@TS@|@TT@|@SEC@|@ITEM@|@HEAD@|@DESC@|@EX@|@TAG@|===)/i.test(line)) inOriginal = false;
        if (!inOriginal || !line || /^#{1,6}\s|^(?:chapter|part|book)\b/i.test(line)) return [];
        const words = normalizeKnowledgeAlignmentText(line).match(/[\p{L}\p{N}]+/gu) || [];
        return words.length >= 4 ? [{ text: line, sourceLine }] : [];
    });
};

const findLrcStartForKnowledgeText = (content = "", subtitles = []) => {
    const candidates = getKnowledgeOriginalLinesForSync(content).slice(0, 8);
    for (const candidate of candidates) {
        let best = { index: -1, score: 0 };
        for (let index = 0; index < subtitles.length; index += 1) {
            const subtitleText = String(subtitles[index]?.text || "");
            const match = findKnowledgeSubtitleMatch(`[原文]\n${candidate.text}\n@K_HEADER@`, subtitleText);
            const score = match?.score || 0;
            if (score > best.score) best = { index, score };
        }
        if (best.index >= 0 && best.score >= 0.72) return best.index;
    }
    return -1;
};

const MarkdownView = ({
    content,
    fontSize = 16,
    trackLanguage = "en-US",
    speakerLanguage = "",
    enableKnowledgeTermLinks = false,
    knowledgeTermEntries = [],
    onKnowledgeTermClick = null,
    activeKnowledgeSourceLine = -1
}) => {
    if (!content || typeof content !== 'string') return null;
    const isCjkTrack = /^(ja|ko|zh)/i.test(trackLanguage);
    const preferredSpeakerLanguage = String(speakerLanguage || "").trim();
    const tableHeaderFontSize = Math.max(10, Math.round(fontSize * 0.8));
    const tableCellFontSize = Math.max(12, Math.round(fontSize * 0.92));

    const hasCjkScript = (text) => /[぀-ヿ㐀-䶿一-鿿가-힯]/.test(text);
    const hasKanaScript = (text) => /[぀-ヿ]/.test(text);
    const hasHangulScript = (text) => /[가-힯]/.test(text);

    const sectionLeadNames = [
        "搭配用法", "替代表達", "片語與俚語", "介系詞重點對比", "測驗", "可能誤聽/錯字",
        "單字用語總覽", "核心詞彙表", "句型骨架", "文法知識點", "變化與替換", "實用場景"
    ];
    const escapeRegex = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripInlineSectionLabel = (line) => {
        let out = String(line || "");
        out = out.replace(/<<[^>]+>>/gi, '').trimStart();
        for (const name of sectionLeadNames) {
            const re = new RegExp(`^(?:\\*\\*\\s*)?${escapeRegex(name)}(?:\\s*[:：-])?(?:\\s*\\*\\*)?\\s*`, 'i');
            out = out.replace(re, '');
        }
        return out;
    };

    const stripMarkdownStrong = (text) => String(text || "").replace(/\*\*(.*?)\*\*/g, "$1");

    const extractPrimaryRowTarget = (cell) => {
        let t = stripTargetTagsForDisplay(String(cell || ""))
            .replace(/\{\{(.*?)\}\}/g, "$1")
            .replace(/<[^>]*>/g, "")
            .replace(/\*\*(.*?)\*\*/g, "$1")
            .trim();
        if (!t) return "";
        t = t.split(/\s*[|｜]\s*/)[0].trim();
        t = t.replace(/\s*\/[^\/\n]+\/\s*$/g, "").trim();
        t = t.replace(/\s*[（(][^)）]{1,24}[）)]\s*$/g, "").trim();
        t = t.replace(/\s{2,}/g, " ");
        return t;
    };

    const highlightTargetTermInHtml = (html, targetTerm) => {
        const baseHtml = String(html || "");
        const term = String(targetTerm || "").trim();
        if (!baseHtml || !term) return baseHtml;
        const isLatin = /^[A-Za-z][A-Za-z0-9' -]*$/.test(term);
        if (isLatin) {
            const lettersOnly = term.replace(/[^A-Za-z]/g, "");
            if (lettersOnly.length < 2) return baseHtml;
        }
        const escaped = escapeRegex(term);
        if (!escaped) return baseHtml;
        const re = isLatin
            ? new RegExp(`(^|[^A-Za-z])(${escaped})(?=[^A-Za-z]|$)`, "gi")
            : new RegExp(`(${escaped})`, "g");
        return baseHtml
            .split(/(<[^>]+>)/g)
            .map((part) => {
                if (!part || part.startsWith("<")) return part;
                if (isLatin) return part.replace(re, `$1<strong class="text-blue-600">$2</strong>`);
                return part.replace(re, '<strong class="text-blue-600">$1</strong>');
            })
            .join("");
    };

    const isKnowledgeLatinWordChar = (ch = "") => /[A-Za-zÀ-ÖØ-öø-ÿ0-9'’\-]/u.test(ch);
    const isKnowledgeLatinBoundaryChar = (ch = "") => !/[A-Za-zÀ-ÖØ-öø-ÿ0-9'’]/u.test(ch);
    const normalizeLatinWordForMatch = (w = "") => String(w || "").toLowerCase().replace(/’/g, "'");
    const getLatinSpellingVariants = (word = "") => {
        const base = normalizeLatinWordForMatch(word).replace(/^[^a-z]+|[^a-z]+$/g, "");
        if (!base) return [];
        const variants = new Set([base]);
        const swaps = [
            [/our/g, "or"],
            [/or/g, "our"],
            [/ise/g, "ize"],
            [/ize/g, "ise"],
            [/isation/g, "ization"],
            [/ization/g, "isation"],
            [/re$/g, "er"],
            [/er$/g, "re"],
            [/ogue$/g, "og"],
            [/og$/g, "ogue"]
        ];
        for (const [from, to] of swaps) {
            const next = base.replace(from, to);
            if (next && next !== base) variants.add(next);
        }
        return Array.from(variants);
    };
    const getLatinInflectedForms = (word = "") => {
        const forms = new Set();
        for (const base of getLatinSpellingVariants(word)) {
            forms.add(base);
            if (/[sxz]$/.test(base) || /(?:sh|ch|o)$/.test(base)) forms.add(`${base}es`);
            else forms.add(`${base}s`);

            if (/[^aeiou]y$/.test(base)) {
                forms.add(`${base.slice(0, -1)}ied`);
                forms.add(`${base.slice(0, -1)}ies`);
                forms.add(`${base}ing`);
            } else if (/e$/.test(base)) {
                forms.add(`${base}d`);
                forms.add(`${base.slice(0, -1)}ing`);
                forms.add(`${base.slice(0, -1)}ely`);
            } else {
                forms.add(`${base}ed`);
                forms.add(`${base}ing`);
            }

            const cvc = base.match(/^(.+?[aeiou])([^aeiouyw])$/);
            if (cvc && base.length >= 3) {
                forms.add(`${base}${base.slice(-1)}ed`);
                forms.add(`${base}${base.slice(-1)}ing`);
            }
            if (/ic$/.test(base)) forms.add(`${base}ally`);
            if (/al$/.test(base)) forms.add(`${base}ly`);
            else forms.add(`${base}ly`);
        }
        return forms;
    };
    const isInflectedLatinMatch = (baseWord = "", candidateWord = "") => {
        const candidate = normalizeLatinWordForMatch(candidateWord).replace(/^[^a-z]+|[^a-z]+$/g, "");
        if (!candidate) return false;
        return getLatinInflectedForms(baseWord).has(candidate);
    };
    const readLatinTokenAt = (source, at) => {
        const m = String(source || "").slice(at).match(/^([A-Za-zÀ-ÖØ-öø-ÿ'’\-]+)/u);
        return m ? String(m[1] || "") : "";
    };
    const readNextLatinToken = (source, at) => {
        const full = String(source || "");
        const sep = full.slice(at).match(/^[\s"'“”‘’`.,;:!?()[\]{}\-—–]+/u);
        const tokenStart = at + (sep ? sep[0].length : 0);
        const token = readLatinTokenAt(full, tokenStart);
        return token ? { token, start: tokenStart, end: tokenStart + token.length } : null;
    };
    const getLatinPhraseMatchLengthAt = (source, at, term) => {
        const full = String(source || "");
        const phrase = String(term || "").trim();
        if (!full || !phrase) return 0;
        const words = phrase.split(/\s+/).filter(Boolean);
        if (words.length < 2) return 0;

        const prev = at > 0 ? full[at - 1] : "";
        if (!isKnowledgeLatinBoundaryChar(prev)) return 0;

        let cursor = at;
        const firstWord = readLatinTokenAt(full, cursor);
        if (!firstWord) return 0;
        if (!isInflectedLatinMatch(words[0], firstWord)) return 0;
        cursor += firstWord.length;

        for (let i = 1; i < words.length; i += 1) {
            let next = readNextLatinToken(full, cursor);
            if (!next) return 0;
            let gapWords = 0;
            while (next && !isInflectedLatinMatch(words[i], next.token) && gapWords < 3) {
                cursor = next.end;
                gapWords += 1;
                next = readNextLatinToken(full, cursor);
            }
            if (!next || !isInflectedLatinMatch(words[i], next.token)) return 0;
            cursor = next.end;
        }

        const next = cursor < full.length ? full[cursor] : "";
        if (!isKnowledgeLatinBoundaryChar(next)) return 0;
        return Math.max(0, cursor - at);
    };
    const getLatinSingleWordMatchLengthAt = (source, at, term) => {
        const full = String(source || "");
        const baseTerm = String(term || "").trim();
        if (!full || !baseTerm) return 0;
        if (/\s/.test(baseTerm)) return 0;

        const prev = at > 0 ? full[at - 1] : "";
        if (!isKnowledgeLatinBoundaryChar(prev)) return 0;

        const slice = full.slice(at);
        const m = slice.match(/^([A-Za-zÀ-ÖØ-öø-ÿ'’\-]+)/u);
        if (!m) return 0;
        const candidateWord = String(m[1] || "");
        if (!isInflectedLatinMatch(baseTerm, candidateWord)) return 0;

        const next = (at + candidateWord.length) < full.length ? full[at + candidateWord.length] : "";
        if (!isKnowledgeLatinBoundaryChar(next)) return 0;
        return candidateWord.length;
    };
    const getKnowledgeTermMatchLengthAt = (text, at, entry) => {
        const source = String(text || "");
        const term = String(entry?.term || "");
        if (!source || !term) return 0;
        if (at < 0 || at >= source.length) return 0;

        if (entry?.latinOnly) {
            if ((at + term.length) <= source.length) {
                const slice = source.slice(at, at + term.length);
                if (slice.toLowerCase() === term.toLowerCase()) {
                    const prev = at > 0 ? source[at - 1] : "";
                    const next = (at + term.length) < source.length ? source[at + term.length] : "";
                    if (isKnowledgeLatinBoundaryChar(prev) && isKnowledgeLatinBoundaryChar(next)) return term.length;
                }
            }
            const phraseLen = getLatinPhraseMatchLengthAt(source, at, term);
            if (phraseLen > 0) return phraseLen;
            const singleWordLen = getLatinSingleWordMatchLengthAt(source, at, term);
            if (singleWordLen > 0) return singleWordLen;
            return 0;
        }

        if (source.startsWith(term, at)) return term.length;
        return 0;
    };

    const matchKnowledgeTermAt = (text, at, entry) => {
        const source = String(text || "");
        const matchedLength = getKnowledgeTermMatchLengthAt(text, at, entry);
        if (!matchedLength) return false;
        if (entry?.latinOnly) {
            const prev = at > 0 ? source[at - 1] : "";
            const next = (at + matchedLength) < source.length ? source[at + matchedLength] : "";
            return isKnowledgeLatinBoundaryChar(prev) && isKnowledgeLatinBoundaryChar(next);
        }
        return true;
    };

    const getKnowledgePopupItemKey = (item = {}) => {
        return `${item?.category || ""}::${item?.id || ""}::${item?.front || ""}::${item?.back || ""}`;
    };

    const isMultiPartKnowledgeTerm = (term = "") => {
        const value = String(term || "").trim();
        if (!value) return false;
        if (value.split(/\s+/).filter(Boolean).length > 1) return true;
        const cjkChars = value.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu) || [];
        return cjkChars.length > 1;
    };

    const hasMultiWordUsageEvidence = (sourceText = "", term = "") => {
        const sourceTokens = String(sourceText || "").match(/[A-Za-zÀ-ÖØ-öø-ÿ'’\-]+/gu) || [];
        const termTokens = String(term || "").match(/[A-Za-zÀ-ÖØ-öø-ÿ'’\-]+/gu) || [];
        if (sourceTokens.length < 2 || termTokens.length < 2) return false;

        for (let termStart = 0; termStart < termTokens.length - 1; termStart += 1) {
            for (let sourceStart = 0; sourceStart < sourceTokens.length; sourceStart += 1) {
                if (!isInflectedLatinMatch(termTokens[termStart], sourceTokens[sourceStart])) continue;
                let matchedCount = 1;
                let sourceCursor = sourceStart + 1;
                for (let termIdx = termStart + 1; termIdx < termTokens.length && sourceCursor < sourceTokens.length; termIdx += 1) {
                    let foundIdx = -1;
                    const scanEnd = Math.min(sourceTokens.length, sourceCursor + 8);
                    for (let i = sourceCursor; i < scanEnd; i += 1) {
                        if (isInflectedLatinMatch(termTokens[termIdx], sourceTokens[i])) {
                            foundIdx = i;
                            break;
                        }
                    }
                    if (foundIdx < 0) continue;
                    matchedCount += 1;
                    if (matchedCount >= 2) return true;
                    sourceCursor = foundIdx + 1;
                }
            }
        }
        return false;
    };

    const findMatchedMultiUsageItemKeys = (sourceText = "") => {
        const source = String(sourceText || "");
        const matched = new Set();
        if (!source) return matched;
        const evidenceSegments = source
            .replace(/\r/g, "\n")
            .split(/\n+|(?<=[.!?。！？；;])\s+/u)
            .map((segment) => String(segment || "").trim())
            .filter(Boolean);

        for (const entry of knowledgeTermEntries) {
            if (!isMultiPartKnowledgeTerm(entry?.term || "")) continue;
            const usageItems = (Array.isArray(entry?.items) ? entry.items : [])
                .filter((item) => String(item?.category || "").trim() === "usage");
            if (usageItems.length === 0) continue;

            let found = false;
            for (const segment of evidenceSegments) {
                for (let pos = 0; pos < segment.length; pos += 1) {
                    if (getKnowledgeTermMatchLengthAt(segment, pos, entry) > 0) {
                        found = true;
                        break;
                    }
                }
                if (found) break;
            }
            if (!found && entry?.latinOnly) {
                found = evidenceSegments.some((segment) => hasMultiWordUsageEvidence(segment, entry?.term || ""));
            }
            if (!found) continue;
            for (const item of usageItems) {
                matched.add(getKnowledgePopupItemKey(item));
            }
        }
        return matched;
    };

    const extractOriginalPreviewText = (rawContent = "") => {
        const lines = String(rawContent || "").replace(/\r/g, "\n").split("\n");
        const out = [];
        let inOriginalBlock = false;
        for (const rawLine of lines) {
            const line = String(rawLine || "");
            const trimmed = line.trim();
            if (/^\[\s*原文\s*\]$/i.test(trimmed)) {
                inOriginalBlock = true;
                continue;
            }
            if (
                inOriginalBlock &&
                /^(?:LRC\s*知識點整理|@K_HEADER@|@FN@|@LG@|@TS@|@TT@|@SEC@|@ITEM@|@HEAD@|@DESC@|@EX@|@TAG@|===\s*(?:單字|用語|文法|句型|閱讀|聽力)\b)/i.test(trimmed)
            ) {
                break;
            }
            if (inOriginalBlock) out.push(line);
        }
        return out.join("\n").trim();
    };

    const matchedMultiUsageItemKeysForPreview = findMatchedMultiUsageItemKeys(extractOriginalPreviewText(content));

    const buildKnowledgeLinkedNodes = (text, keyPrefix = "mdk") => {
        const source = String(text || "");
        if (!source) return source;
        if (!enableKnowledgeTermLinks) return source;
        if (!Array.isArray(knowledgeTermEntries) || knowledgeTermEntries.length === 0) return source;
        if (typeof onKnowledgeTermClick !== "function") return source;

        const nodes = [];
        let cursor = 0;
        let tokenIdx = 0;
        while (cursor < source.length) {
            let hitPos = -1;
            let hitMatches = [];

            for (let pos = cursor; pos < source.length; pos += 1) {
                const matches = [];
                for (const entry of knowledgeTermEntries) {
                    const matchLen = getKnowledgeTermMatchLengthAt(source, pos, entry);
                    if (matchLen > 0) {
                        const entryIsMultiPart = isMultiPartKnowledgeTerm(entry?.term || "");
                        const visibleItems = (Array.isArray(entry?.items) ? entry.items : [])
                            .filter((item) => {
                                if (entryIsMultiPart) return true;
                                if (String(item?.category || "").trim() !== "usage") return true;
                                return !matchedMultiUsageItemKeysForPreview.has(getKnowledgePopupItemKey(item));
                            });
                        if (visibleItems.length > 0) {
                            matches.push({ entry: { ...entry, items: visibleItems }, matchLen });
                        }
                    }
                }
                if (matches.length > 0) {
                    hitPos = pos;
                    hitMatches = matches.sort((a, b) => {
                        if (Number(b?.matchLen || 0) !== Number(a?.matchLen || 0)) {
                            return Number(b?.matchLen || 0) - Number(a?.matchLen || 0);
                        }
                        return String(b?.entry?.term || "").length - String(a?.entry?.term || "").length;
                    });
                    break;
                }
            }

            if (hitPos < 0 || hitMatches.length === 0) {
                if (cursor < source.length) {
                    nodes.push(<React.Fragment key={`${keyPrefix}-text-${tokenIdx++}`}>{source.slice(cursor)}</React.Fragment>);
                }
                break;
            }

            if (hitPos > cursor) {
                nodes.push(<React.Fragment key={`${keyPrefix}-text-${tokenIdx++}`}>{source.slice(cursor, hitPos)}</React.Fragment>);
            }

            const longest = hitMatches[0];
            const longestEntry = longest?.entry || null;
            const longestLen = Number(longest?.matchLen || 0);
            if (!longestLen) {
                cursor = hitPos + 1;
                continue;
            }
            const matchedText = source.slice(hitPos, hitPos + longestLen);

            const popupItems = [];
            const seen = new Set();
            for (const hit of hitMatches) {
                const entry = hit?.entry || null;
                const items = Array.isArray(entry?.items) ? entry.items : [];
                for (const item of items) {
                    const key = `${item?.category || ""}::${item?.front || ""}::${item?.back || ""}`;
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    popupItems.push(item);
                }
            }
            const linkStyle = getKnowledgeLinkStyleMeta(popupItems);

            nodes.push(
                <button
                    key={`${keyPrefix}-term-${tokenIdx++}`}
                    type="button"
                    className={`inline p-0 m-0 border-0 font-semibold ${linkStyle.className}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!popupItems.length) return;
                        onKnowledgeTermClick({
                            term: cleanQuizDisplayText(matchedText || longestEntry?.term || ""),
                            items: popupItems
                        });
                    }}
                    title={linkStyle.title}
                >
                    {matchedText}
                </button>
            );

            cursor = hitPos + longestLen;
        }
        return nodes.length > 0 ? nodes : source;
    };

    const getSpeakMode = (text) => {
        const clean = text.trim();
        if (/(?:\n|<br\s*\/?>|例句?|例如|example|examples?)\s*[:：]/i.test(clean) || /\s+[\/／]\s+/.test(clean)) {
            return 'native';
        }
        const hasHangul = /[가-힯]/.test(clean);
        if (hasHangul) {
            const wordCount = clean.split(/\s+/).filter(w => w.length > 0).length;
            return wordCount >= 4 ? 'ai' : 'native';
        }
        const hasOtherCJK = /[぀-ヿ㐀-䶿一-鿿]/.test(clean);
        if (hasOtherCJK) {
            return clean.length >= 12 ? 'ai' : 'native';
        }
        const wordCount = clean.split(/\s+/).filter(w => w.length > 0).length;
        return wordCount >= 4 ? 'ai' : 'native';
    };

    const lines = content.split('\n');
    const segments = [];
    let currentTable = [];
    let inOriginalBlock = false;
    const originalStartRe = /^\[\s*原文\s*\]$/i;
    const originalEndRe = /^(?:LRC\s*知識點整理|@K_HEADER@|@FN@|@LG@|@TS@|@TT@|@SEC@|@ITEM@|@HEAD@|@DESC@|@EX@|@TAG@|===\s*(?:單字|用語|文法|句型|閱讀|聽力)\b)/i;

    for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
        const trimmed = String(line || "").trim();
        const isOriginalStart = originalStartRe.test(trimmed);
        const isOriginalEnd = !isOriginalStart && originalEndRe.test(trimmed);
        if (isOriginalStart) inOriginalBlock = true;
        if (isOriginalEnd) inOriginalBlock = false;
        const lineInOriginal = inOriginalBlock && !isOriginalStart && !isOriginalEnd;
        const isTableRow = trimmed.startsWith('|') && trimmed.endsWith('|');
        if (isTableRow) {
            currentTable.push(trimmed);
            continue;
        }

        if (!trimmed) {
            if (currentTable.length > 0) {
                let j = idx + 1;
                while (j < lines.length && !String(lines[j] || '').trim()) j += 1;
                const nextTrim = j < lines.length ? String(lines[j] || '').trim() : '';
                const nextIsTableRow = nextTrim.startsWith('|') && nextTrim.endsWith('|');
                if (!nextIsTableRow) {
                    segments.push({ type: 'table', lines: currentTable });
                    currentTable = [];
                }
            }
            segments.push({ type: 'blank' });
            continue;
        }

        if (currentTable.length > 0) {
            segments.push({ type: 'table', lines: currentTable });
            currentTable = [];
        }
        segments.push({ type: 'text', content: line, inOriginal: lineInOriginal, sourceLine: idx });
    }
    if (currentTable.length > 0) segments.push({ type: 'table', lines: currentTable });

    return (
        <div style={{ fontSize: `${fontSize}px` }} className="space-y-3 leading-relaxed text-gray-800">
            {(() => {
                let lastTextType = null;
                return segments.map((seg, i) => {
                    if (seg.type === 'blank') {
                        lastTextType = null;
                        return <div key={i} className="h-2" />;
                    }
                    if (seg.type === 'text') {
                        const lineForRender = stripInlineSectionLabel(seg.content);
                        const trimmedRaw = lineForRender.trim();
                        if (!trimmedRaw) return null;
                        if (/^<div\b/i.test(trimmedRaw) && /question-box|User Question/i.test(trimmedRaw)) {
                            const questionAttrMatch = trimmedRaw.match(/\sdata-question="([\s\S]*?)"/i);
                            const questionTextMatch = trimmedRaw.match(/<div class="question-text">([\s\S]*?)<\/div>/i);
                            const questionText = decodeHtml(
                                String(
                                    (questionAttrMatch && questionAttrMatch[1]) ||
                                    (questionTextMatch && questionTextMatch[1]) ||
                                    ""
                                )
                            ).trim();
                            return (
                                <div key={i} className="question-box">
                                    <div className="question-label">User Question</div>
                                    <div className="question-text whitespace-pre-wrap">{questionText}</div>
                                </div>
                            );
                        }

                        const isHeadingLine = /^\s*#{2,6}\s+/.test(trimmedRaw);
                        const isNumberedLine = /^\d+\.\s+/.test(trimmedRaw);
                        const isSubheadLine = /^\s*[*-]\s*(概念|用法|常見錯誤|例句)\b/.test(trimmedRaw) || /^(概念|用法|常見錯誤|例句)\b/.test(trimmedRaw);
                        const lineType = isHeadingLine ? 'heading' : isNumberedLine ? 'kp' : isSubheadLine ? 'subhead' : 'paragraph';

                        const hasTargetTag = hasTargetLangTag(lineForRender) || /\{\{.*?\}\}/.test(lineForRender);
                        const targetForAudio = hasTargetTag ? extractTaggedTargetText(lineForRender) : "";
                        const audioSource = cleanTextForDisplay(lineForRender)
                            .replace(/<small>[\s\S]*?<\/small>/gi, '')
                            .split(/<br\s*\/?>/i)[0];
                        const sourceHasCjk = hasCjkScript(audioSource);
                        const latinPhrases = (isCjkTrack || sourceHasCjk) ? "" : extractLatinPhrasesForAudio(audioSource);
                        const fallbackText = (latinPhrases || audioSource)
                            .replace(/<[^>]*>/g, '')
                            .replace(/`([^`]+)`/g, '$1')
                            .replace(/\*\*(.*?)\*\*/g, '$1')
                            .replace(/\*(?!\*)([^*<>]+)\*/g, '$1')
                            .replace(/^\s*[-*]\s+/, '')
                            .trim();
                        const hasLatin = /[A-Za-z]/.test(fallbackText);
                        const hasKana = hasKanaScript(fallbackText);
                        const hasHangul = hasHangulScript(fallbackText);
                        const allowNonLatin = (isCjkTrack || hasKana || hasHangul || hasCjkScript(fallbackText)) && fallbackText.length > 0;
                        const passesChineseGuard = (isCjkTrack || hasKana || hasHangul) ? true : !isPredominantlyChinese(fallbackText);
                        const speakerTextRaw = hasTargetTag
                            ? chooseTaggedSpeakerText({ taggedText: targetForAudio, fallbackText, trackLanguage })
                            : fallbackText;
                        const speakerText = sanitizeSpeakerText(speakerTextRaw, preferredSpeakerLanguage || trackLanguage);
                        const shouldShowSpeaker = hasTargetTag
                            ? speakerText.length > 0
                            : (!isHeadingLine && !isPhonetic(fallbackText) && passesChineseGuard && (hasLatin || allowNonLatin));
                        let html = stripTargetTagsForDisplay(lineForRender)
                            .replace(/\{\{(.*?)\}\}/g, '$1')
                            .replace(/^(\s*)[-*]\s+/, (_m, sp) => `${'&nbsp;'.repeat(Math.min(16, (sp || '').length * 2))}• `)
                            .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
                            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                            .replace(/\*(?!\*)([^*<>]+)\*/g, '<em>$1</em>')
                            .replace(/^(\d+)\.\s+(.+)/, '$1. $2')
                            .replace(/^\s*[*-]\s*(概念|用法|常見錯誤|例句)(.*)/, '<div class="ai-subhead">$1$2</div>')
                            .replace(/^(概念|用法|常見錯誤|例句)(.*)/, '<div class="ai-subhead">$1$2</div>')
                            .replace(/^##### (.*)/, '<div class="ai-h4">$1</div>')
                            .replace(/^#### (.*)/, '<div class="ai-h4">$1</div>')
                            .replace(/^### (.*)/, '<div class="ai-h3">$1</div>')
                            .replace(/^## (.*)/, '<div class="ai-h2">$1</div>');
                        html = shrinkReadingParenthesesHtml(html);

                        const wrapClass = lineType === 'paragraph' && lastTextType === 'subhead' ? 'ai-subtext' : '';
                        lastTextType = lineType;
                        const shouldLinkKnowledgeTerms = Boolean(
                            enableKnowledgeTermLinks &&
                            seg.inOriginal &&
                            Array.isArray(knowledgeTermEntries) &&
                            knowledgeTermEntries.length > 0 &&
                            typeof onKnowledgeTermClick === 'function'
                        );
                        const plainTextForLink = stripTargetTagsForDisplay(lineForRender)
                            .replace(/\{\{(.*?)\}\}/g, '$1')
                            .replace(/^(\s*)[-*]\s+/, (_m, sp) => `${' '.repeat(Math.min(8, (sp || '').length))}• `)
                            .replace(/`([^`]+)`/g, '$1')
                            .replace(/\*\*(.*?)\*\*/g, '$1')
                            .replace(/\*(?!\*)([^*<>]+)\*/g, '$1')
                            .replace(/^#{2,6}\s+/, '');

                        return (
                            <div
                                key={i}
                                data-knowledge-source-line={seg.sourceLine}
                                className={`flex items-start gap-1 ${wrapClass} ${seg.sourceLine === activeKnowledgeSourceLine ? 'rounded-md bg-amber-100 ring-1 ring-amber-300 px-1 -mx-1' : ''}`}
                            >
                                {shouldLinkKnowledgeTerms ? (
                                    <div className="whitespace-pre-wrap leading-relaxed">
                                        {buildKnowledgeLinkedNodes(plainTextForLink, `mdk-${i}`)}
                                    </div>
                                ) : (
                                    <div dangerouslySetInnerHTML={{ __html: html }} />
                                )}
                                {shouldShowSpeaker && speakerText && (
                                    <QuickSpeakBtn text={speakerText} mode={getSpeakMode(speakerText)} forceNativeLang={preferredSpeakerLanguage} pauseBetweenLinesMs={1000} size={14} className="mt-0.5 shrink-0" />
                                )}
                            </div>
                        );
                    } else {
                        lastTextType = null;
                        const rows = seg.lines;
                        if (rows.length < 2) return null;
                        const headers = rows[0].split('|').slice(1, -1).map(s => stripTargetTagsForDisplay(s).replace(/<[^>]*>/g, '').trim());
                        const hasSeparator = rows.length > 1 && /^\|\s*[-:| ]+\|\s*$/.test(rows[1]);
                        const bodyRows = rows
                            .slice(hasSeparator ? 2 : 1)
                            .map(r => r.split('|').slice(1, -1).map(s => s.trim()))
                            .filter(r => r.some(c => String(c || '').trim()));
                        if (bodyRows.length === 0) return null;

                        return (
                            <div key={i} className="overflow-x-auto my-4 rounded-lg border border-gray-200 shadow-sm w-full">
                                <table className="min-w-full divide-y divide-gray-200 table-auto">
                                    <thead className="bg-gray-50">
                                        <tr>
                                            {headers.map((h, hi) => (
                                                <th key={hi} className="px-4 py-2 text-left font-semibold text-gray-500 uppercase tracking-wider whitespace-normal bg-gray-50" style={{ fontSize: `${tableHeaderFontSize}px` }}>
                                                    {h}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-gray-200">
                                        {bodyRows.map((row, ri) => {
                                            const rowTargetWord = extractPrimaryRowTarget(row[0] || "");
                                            return (
                                                <tr key={ri} className="hover:bg-gray-50 transition-colors">
                                                    {row.map((cell, ci) => {
                                                        const displayText = shrinkReadingParenthesesHtml(cleanTextForDisplay(cell));

                                                        const hasExplicitTag = hasTargetLangTag(cell) || /\{\{.*?\}\}/.test(cell);
                                                        let targetForAudio = "";
                                                        if (hasExplicitTag) {
                                                            targetForAudio = extractTaggedTargetText(cell) || extractTargetText(cell);
                                                        }

                                                        const headerText = headers[ci] || "";
                                                        const isTargetColumn = /target|word|phrase|example|sentence|collocation|原文|例句|目標|單字|詞語|片語|句子|搭配|英文內容|英文片段|原文片段|日文內容|日文片段|韓文內容|韓文片段|西文內容|西文片段|德文內容|德文片段|外語內容|外語片段|日文|日本語|日語|韓文|韓語|德文|德語|西文|西語|法文|法語|範例/i.test(headerText);
                                                        const normalizedHeader = String(headerText || "").toLowerCase().replace(/\s+/g, " ").trim();
                                                        const isPrimaryVocabColumn = ci === 0 || /^(?:target\s*word\s*\/\s*phrase|target\s*word|target\s*phrase|word\s*\/\s*phrase|目標詞|目標字詞|單字|詞語|片語)$/.test(normalizedHeader);
                                                        const isCollocationOrExampleColumn = /collocation|搭配|example|例句|範例|sentence|句子/i.test(headerText);
                                                        const isExcludedColumn = !/collocation|搭配|example|例句|範例/i.test(headerText) && /meaning|chinese|explanation|pos|part of speech|phonetic|reading|中文|翻譯|解釋|詞性|發音|音標|讀音|意思/i.test(headerText);
                                                        const audioSource = cleanTextForDisplay(cell)
                                                            .replace(/<small>[\s\S]*?<\/small>/gi, '')
                                                            .split(/<br\s*\/?>/i)[0];
                                                        const sourceHasCjk = hasCjkScript(audioSource);
                                                        const latinPhrases = (isCjkTrack || sourceHasCjk) ? "" : extractLatinPhrasesForAudio(audioSource);
                                                        const fallbackText = (latinPhrases || audioSource).replace(/<[^>]*>/g, '').trim();
                                                        const fallbackHasLatin = /[A-Za-z]/.test(fallbackText);
                                                        const hasKana = hasKanaScript(fallbackText);
                                                        const hasHangul = hasHangulScript(fallbackText);
                                                        const allowNonLatin = (isCjkTrack || hasKana || hasHangul || hasCjkScript(fallbackText)) && fallbackText.length > 0;
                                                        const passesChineseGuard = (isCjkTrack || hasKana || hasHangul) ? true : !isPredominantlyChinese(fallbackText);
                                                        const speakerTextRaw = hasExplicitTag
                                                            ? chooseTaggedSpeakerText({ taggedText: targetForAudio, fallbackText, trackLanguage })
                                                            : fallbackText;
                                                        const speakerText = sanitizeSpeakerText(speakerTextRaw, preferredSpeakerLanguage || trackLanguage);
                                                        const shouldShowSpeaker = hasExplicitTag
                                                            ? speakerText.length > 0
                                                            : (isTargetColumn && !isExcludedColumn && !isPhonetic(fallbackText) && passesChineseGuard && (fallbackHasLatin || allowNonLatin));
                                                        if (shouldShowSpeaker) targetForAudio = speakerText;
                                                        const speakMode = getSpeakMode(targetForAudio);

                                                        let renderedHtml = displayText;
                                                        if (isPrimaryVocabColumn) {
                                                            renderedHtml = stripMarkdownStrong(renderedHtml).trim();
                                                            if (renderedHtml) renderedHtml = `<strong class="text-blue-600">${renderedHtml}</strong>`;
                                                        } else if (isCollocationOrExampleColumn) {
                                                            renderedHtml = stripMarkdownStrong(renderedHtml);
                                                            renderedHtml = highlightTargetTermInHtml(renderedHtml, rowTargetWord);
                                                        } else {
                                                            renderedHtml = stripMarkdownStrong(renderedHtml);
                                                        }

                                                        return (
                                                            <td key={ci} className="px-4 py-2 text-gray-700 align-top whitespace-normal break-words" style={{ fontSize: `${tableCellFontSize}px` }}>
                                                                <div className="flex items-start gap-1">
                                                                    <span dangerouslySetInnerHTML={{ __html: renderedHtml }} />
                                                                    {shouldShowSpeaker && (
                                                                        <QuickSpeakBtn text={targetForAudio} mode={speakMode} forceNativeLang={preferredSpeakerLanguage} pauseBetweenLinesMs={1000} size={14} className="mt-0.5 shrink-0" />
                                                                    )}
                                                                </div>
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        );
                    }
                });
            })()}
        </div>
    );
};


// ============================================================================
// [MODULE 3]: MAIN APP COMPONENT
// ============================================================================

export default function GeminiPlayer() {
    const [currentApiKey, setCurrentApiKey] = useState(apiKey);
    const [showSettings, setShowSettings] = useState(false);

    // Global Audio Ref for managing singleton playback
    const globalAudioRef = useRef(null);
    const modalScrollRef = useRef(null); // [NEW] Ref for Modal Scroll
    const settingsPanelRef = useRef(null);
    const settingsButtonRef = useRef(null);

    useEffect(() => {
        const storedKey = localStorage.getItem("gemini_api_key");
        if (storedKey) setCurrentApiKey(storedKey);
        else setCurrentApiKey(apiKey);
    }, []);

    useEffect(() => {
        // Keep top/bottom control areas visible by default on all screen sizes.
        setIsHeaderVisible(true);
        setIsToolbarVisible(true);
    }, []);

    useEffect(() => {
        if (!showSettings || typeof window === 'undefined') return;
        const onPointerDown = (event) => {
            const target = event?.target;
            if (settingsPanelRef.current && settingsPanelRef.current.contains(target)) return;
            if (settingsButtonRef.current && settingsButtonRef.current.contains(target)) return;
            setShowSettings(false);
        };
        const onKeyDown = (event) => {
            if (event?.key === 'Escape') setShowSettings(false);
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [showSettings]);

    const saveApiKey = (key) => {
        setCurrentApiKey(key);
        localStorage.setItem("gemini_api_key", key);
        setShowSettings(false);
    };

    const [playlist, setPlaylist] = useState([]);
    const [currentTrackIndex, setCurrentTrackIndex] = useState(-1);
    const [rawSubtitles, setRawSubtitles] = useState([]);
    const [subtitles, setSubtitles] = useState([]);
    const [isSmartMode, setIsSmartMode] = useState(true);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [mediaSrc, setMediaSrc] = useState(null);
    const [mediaError, setMediaError] = useState("");
    const [loopMode, setLoopMode] = useState('single');
    const [playlistLoopMode, setPlaylistLoopMode] = useState('all');
    const [isPlaying, setIsPlaying] = useState(false);
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [playbackRate, setPlaybackRate] = useState(1.0);

    // [NEW] Customizable Timing
    const [timePadding, setTimePadding] = useState(0.2);
    const [timeBuffer, setTimeBuffer] = useState(0.2);
    const [minDuration, setMinDuration] = useState(3.0);
    const [maxMergeCount, setMaxMergeCount] = useState(3);

    // [NEW] Subtitle Font Size (Independent of Modal)
    const [subtitleFontSize, setSubtitleFontSize] = useState(24);

    // UI States
    const [isVideoMasked, setIsVideoMasked] = useState(true);
    const [topPanelMode, setTopPanelMode] = useState('media'); // 'media' | 'document'
    const [embeddedKnowledgeText, setEmbeddedKnowledgeText] = useState("");
    const [embeddedKnowledgeFileInfo, setEmbeddedKnowledgeFileInfo] = useState(null);
    const [embeddedKnowledgeLoading, setEmbeddedKnowledgeLoading] = useState(false);
    const [embeddedKnowledgeError, setEmbeddedKnowledgeError] = useState("");
    const [embeddedKnowledgePanelHeight, setEmbeddedKnowledgePanelHeight] = useState(60);
    const [embeddedKnowledgeFontSize, setEmbeddedKnowledgeFontSize] = useState(20);
    const [isHeaderExpanded, setIsHeaderExpanded] = useState(true);
    const [isSubtitleHidden, setIsSubtitleHidden] = useState(true);
    const [isHeaderVisible, setIsHeaderVisible] = useState(true);
    const [isToolbarVisible, setIsToolbarVisible] = useState(true);
    const [mockMode, setMockMode] = useState(false);
    const [learnerLevel, setLearnerLevel] = useState(5);

    const [isShadowing, setIsShadowing] = useState(false);
    const [shadowGapAdjustment, setShadowGapAdjustment] = useState(0.0);
    const [shadowGapInput, setShadowGapInput] = useState("0");
    const [shadowRepeatCount, setShadowRepeatCount] = useState(3);
    const [shadowRepeatInput, setShadowRepeatInput] = useState("3");
    const [isShadowInfinite, setIsShadowInfinite] = useState(false);
    const [isWaitingShadow, setIsWaitingShadow] = useState(false);

    // [FIX] REF for Logic, State for UI.
    const isWaitingShadowRef = useRef(false);

    const isGapPausing = useRef(false); // Used as a Mutex during transitions

    const [isShadowGapOriginal, setIsShadowGapOriginal] = useState(true);
    const [shadowCountdown, setShadowCountdown] = useState(0);

    const [showModal, setShowModal] = useState(false);
    const [modalContent, setModalContent] = useState("");
    const [modalTitle, setModalTitle] = useState("");
    const [isLoadingAI, setIsLoadingAI] = useState(false);
    const [aiMode, setAiMode] = useState('text');
    const [smartTargetDisplay, setSmartTargetDisplay] = useState("");
    const [targetTranslation, setTargetTranslation] = useState("");
    const [chatHistory, setChatHistory] = useState([]);
    const [showRecorder, setShowRecorder] = useState(false);
    const [globalFontSize, setGlobalFontSize] = useState(16);
    const [trackLanguage, setTrackLanguage] = useState("en-US");
    const [chatInput, setChatInput] = useState("");
    const [tutorLang, setTutorLang] = useState('target');
    const [deepDiveInput, setDeepDiveInput] = useState("");
    const [isFullVocabLoading, setIsFullVocabLoading] = useState(false);
    const [fullVocabProgress, setFullVocabProgress] = useState({ done: 0, total: 0 });
    const [quizQuestions, setQuizQuestions] = useState([]);
    const [quizCurrentIndex, setQuizCurrentIndex] = useState(0);
    const [quizSelectedOption, setQuizSelectedOption] = useState(null);
    const [quizAnswerState, setQuizAnswerState] = useState(null); // 'correct' | 'wrong' | null
    const [quizGenerationStage, setQuizGenerationStage] = useState("");
    const [quizScore, setQuizScore] = useState(0);
    const [quizStreak, setQuizStreak] = useState(0);
    const [quizBatchNo, setQuizBatchNo] = useState(0);
    const [quizSessionStats, setQuizSessionStats] = useState({ correct: 0, wrong: 0 });
    const [quizWrongKnowledge, setQuizWrongKnowledge] = useState([]);
    const [quizIsGenerating, setQuizIsGenerating] = useState(false);
    const [quizError, setQuizError] = useState("");
    const [quizKnowledgeBankMap, setQuizKnowledgeBankMap] = useState({});
    const [quizKnowledgeUsageMap, setQuizKnowledgeUsageMap] = useState({});
    const [quizKnowledgePointsPool, setQuizKnowledgePointsPool] = useState([]);
    const [quizSelectedKnowledgeBatch, setQuizSelectedKnowledgeBatch] = useState([]);
    const [quizKnowledgeFileInfo, setQuizKnowledgeFileInfo] = useState(null);
    const [flashCards, setFlashCards] = useState([]);
    const [flashCardCategories, setFlashCardCategories] = useState(["all"]);
    const [flashCardToolbarExpanded, setFlashCardToolbarExpanded] = useState(true);
    const [flashCardIndex, setFlashCardIndex] = useState(0);
    const [flashCardFlipped, setFlashCardFlipped] = useState(false);
    const [flashCardReverseSides, setFlashCardReverseSides] = useState(false);
    const [flashCardAutoSpeakFront, setFlashCardAutoSpeakFront] = useState(false);
    const [flashCardAutoSpeakBack, setFlashCardAutoSpeakBack] = useState(false);
    const [flashCardAutoSpeakBackIncludeZh, setFlashCardAutoSpeakBackIncludeZh] = useState(false);
    const [flashCardAutoRun, setFlashCardAutoRun] = useState(false);
    const [flashCardAutoPaused, setFlashCardAutoPaused] = useState(false);
    const [flashCardAutoRunAllKnowledgeTxt, setFlashCardAutoRunAllKnowledgeTxt] = useState(false);
    const [flashCardWakeLockEnabled, setFlashCardWakeLockEnabled] = useState(false);
    const [flashCardTouchLockEnabled, setFlashCardTouchLockEnabled] = useState(false);
    const [flashCardPocketModeEnabled, setFlashCardPocketModeEnabled] = useState(false);
    const [flashCardPocketUnlockHolding, setFlashCardPocketUnlockHolding] = useState(false);
    const [flashCardFrontPauseSec, setFlashCardFrontPauseSec] = useState(2);
    const [flashCardBackPauseSec, setFlashCardBackPauseSec] = useState(1);
    const [flashCardFrontPauseInput, setFlashCardFrontPauseInput] = useState("2");
    const [flashCardBackPauseInput, setFlashCardBackPauseInput] = useState("1");
    const [flashCardSpeakSignalNonce, setFlashCardSpeakSignalNonce] = useState(0);
    const [flashCardBackExampleSpeakSignalNonce, setFlashCardBackExampleSpeakSignalNonce] = useState(0);
    const [flashCardBackZhSpeakSignalNonce, setFlashCardBackZhSpeakSignalNonce] = useState(0);
    const [flashCardSourceName, setFlashCardSourceName] = useState("");
    const [flashCardError, setFlashCardError] = useState("");
    const [flashCardNotice, setFlashCardNotice] = useState("");
    const [flashCardTermPopup, setFlashCardTermPopup] = useState(null);
    const [knowledgePreviewTermPopup, setKnowledgePreviewTermPopup] = useState(null);
    const [knowledgePreviewPopupPos, setKnowledgePreviewPopupPos] = useState({ x: 24, y: 112 });
    const [knowledgePreviewPopupFontSize, setKnowledgePreviewPopupFontSize] = useState(16);
    const [knowledgePreviewPopupMode, setKnowledgePreviewPopupMode] = useState('floating'); // 'floating' | 'split'
    const [knowledgePreviewSplitWidth, setKnowledgePreviewSplitWidth] = useState(360);
    const [isFlashCardLoading, setIsFlashCardLoading] = useState(false);
    const [knowledgeTxtOptions, setKnowledgeTxtOptions] = useState([]);
    const [selectedKnowledgeTxtName, setSelectedKnowledgeTxtName] = useState("");
    const [activeTrackKnowledgeTabName, setActiveTrackKnowledgeTabName] = useState("");
    const [showKnowledgeTxtPicker, setShowKnowledgeTxtPicker] = useState(false);
    const [knowledgeTxtPickerError, setKnowledgeTxtPickerError] = useState("");
    const [knowledgeTxtPickerSortKey, setKnowledgeTxtPickerSortKey] = useState("modified");
    const [knowledgeTxtPickerSortDir, setKnowledgeTxtPickerSortDir] = useState("desc");
    const [knowledgePreviewReturnState, setKnowledgePreviewReturnState] = useState(null);
    const [flashCardMasteryData, setFlashCardMasteryData] = useState(() => loadFlashCardMasteryFromLocalStorage());
    const [flashCardMasteryDirHandle, setFlashCardMasteryDirHandle] = useState(null);
    const [flashCardMasterySyncStatus, setFlashCardMasterySyncStatus] = useState("local_only");
    const [flashCardMasteryLastSaveError, setFlashCardMasteryLastSaveError] = useState("");
    const [flashCardFilterMode, setFlashCardFilterMode] = useState('all');
    const [flashCardRememberedMinInput, setFlashCardRememberedMinInput] = useState("");
    const [flashCardForgotMinInput, setFlashCardForgotMinInput] = useState("");
    const [flashCardReviewMinInput, setFlashCardReviewMinInput] = useState("");
    const [flashCardFilterMenuOpen, setFlashCardFilterMenuOpen] = useState(false);
    const [flashCardReviewMenuOpen, setFlashCardReviewMenuOpen] = useState(false);
    const [flashCardPlaybackMenuOpen, setFlashCardPlaybackMenuOpen] = useState(false);
    const [flashCardWaitingFeedback, setFlashCardWaitingFeedback] = useState(false);

    useEffect(() => {
        saveFlashCardMasteryToLocalStorage(flashCardMasteryData);
    }, [flashCardMasteryData]);
    const [quizFocusTypes, setQuizFocusTypes] = useState({
        vocab: true,
        usage: true,
        grammar: true,
        pattern: true,
        reading: true,
        listening: true
    });
    const [quizReviewInsertions, setQuizReviewInsertions] = useState(0);
    const [quizDeepDiveInput, setQuizDeepDiveInput] = useState("");
    const [quizDeepDiveHistory, setQuizDeepDiveHistory] = useState([]);
    const [isQuizDeepDiveLoading, setIsQuizDeepDiveLoading] = useState(false);

    const buildMediaPlaybackErrorMessage = useCallback((file, mediaErrorObj = null) => {
        const fileName = String(file?.name || "此媒體檔").trim() || "此媒體檔";
        const lower = fileName.toLowerCase();
        const extMatch = lower.match(/\.([a-z0-9]+)$/i);
        const ext = String(extMatch?.[1] || "").toLowerCase();
        const errCode = Number(mediaErrorObj?.code || 0);
        const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || "") : "";
        const isAppleMobile = /iPad|iPhone|iPod/i.test(ua);

        let reason = "瀏覽器無法載入或解碼這個媒體檔。";
        if (errCode === 4) {
            reason = "瀏覽器不支援這個媒體檔目前使用的格式或內部編碼。";
        } else if (errCode === 3) {
            reason = "媒體在解碼時失敗。這通常是檔案本身的 codec 與裝置支援不相容。";
        } else if (errCode === 2) {
            reason = "媒體下載或讀取中斷。";
        } else if (errCode === 1) {
            reason = "媒體載入被中止。";
        }

        if (isAppleMobile && ext === "mp4") {
            return `${fileName} 無法在這台 iPad/iPhone 的 Chrome 中播放。${reason} iOS 上的 Chrome 使用 WebKit，\`.mp4\` 只是容器，若裡面不是 Apple 裝置可解的編碼，就會失敗。請優先改成 H.264 + AAC-LC；若其實是純音訊，也建議改成 \`.m4a\` 或 \`.mp3\`。`;
        }

        if (ext === "mp4") {
            return `${fileName} 無法播放。${reason} 注意：\`.mp4\` 只是容器，問題常出在裡面的視訊/音訊 codec，不是副檔名本身。`;
        }

        return `${fileName} 無法播放。${reason}`;
    }, []);

    const [aiCache, setAiCache] = useState({});
    // Global Translation Cache
    const [translationCache, setTranslationCache] = useState({});
    // Global Target Sentence Fix Cache (with ~~strikethrough~~)
    const [targetFixCache, setTargetFixCache] = useState({});

    const [modalHistory, setModalHistory] = useState([]);
    const [audioCache, setAudioCache] = useState({});

    // Pronunciation State
    const [pronunciationState, setPronunciationState] = useState('idle');
    const [pronunciationResult, setPronunciationResult] = useState(null);
    const [userAudioUrl, setUserAudioUrl] = useState(null);
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);
    const streamRef = useRef(null);
    // Track recording mime type
    const recordingMimeTypeRef = useRef("");

    // TTS STATE
    const [availableVoices, setAvailableVoices] = useState([]);
    const [selectedVoiceURI, setSelectedVoiceURI] = useState("");
    const [preferredVoice, setPreferredVoice] = useState(null);

    // GAMIFICATION STATE
    const [watchedSegments, setWatchedSegments] = useState(new Set());
    const [isSurvivalMode, setIsSurvivalMode] = useState(false);
    const [survivalLives, setSurvivalLives] = useState(3);
    const [survivalScore, setSurvivalScore] = useState(0);
    const [survivalCorrectCount, setSurvivalCorrectCount] = useState(0);
    const [survivalQuestion, setSurvivalQuestion] = useState(null); // { text, answer, options, subIndex, maskedText, sourceSub }
    const [survivalFeedback, setSurvivalFeedback] = useState(null); // 'correct', 'wrong', null
    const SURVIVAL_PASS_TARGET = 10;

    // [NEW] Loop Mode Ref to prevent stale state in loop
    const loopModeRef = useRef(loopMode);
    useEffect(() => { loopModeRef.current = loopMode; }, [loopMode]);

    const playlistLoopModeRef = useRef(playlistLoopMode);
    useEffect(() => { playlistLoopModeRef.current = playlistLoopMode; }, [playlistLoopMode]);

    const currentTrackIndexRef = useRef(currentTrackIndex);
    useEffect(() => { currentTrackIndexRef.current = currentTrackIndex; }, [currentTrackIndex]);

    const playlistRef = useRef(playlist);
    useEffect(() => { playlistRef.current = playlist; }, [playlist]);

    const currentIndexRef = useRef(currentIndex);
    useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);

    const subtitlesRef = useRef(subtitles);
    useEffect(() => { subtitlesRef.current = subtitles; }, [subtitles]);

    const aiCacheRef = useRef(aiCache);
    useEffect(() => { aiCacheRef.current = aiCache; }, [aiCache]);

    const translationCacheRef = useRef(translationCache);
    useEffect(() => { translationCacheRef.current = translationCache; }, [translationCache]);

    const targetFixCacheRef = useRef(targetFixCache);
    useEffect(() => { targetFixCacheRef.current = targetFixCache; }, [targetFixCache]);

    const audioCacheRef = useRef(audioCache);
    useEffect(() => { audioCacheRef.current = audioCache; }, [audioCache]);

    const quizKnowledgeUsageMapRef = useRef(quizKnowledgeUsageMap);
    useEffect(() => { quizKnowledgeUsageMapRef.current = quizKnowledgeUsageMap; }, [quizKnowledgeUsageMap]);

    const chatHistoryRef = useRef(chatHistory);
    useEffect(() => { chatHistoryRef.current = chatHistory; }, [chatHistory]);
    const chatHistorySentenceKeyRef = useRef(null);

    const trackLanguageRef = useRef(trackLanguage);
    useEffect(() => { trackLanguageRef.current = trackLanguage; }, [trackLanguage]);

    const preferredVoiceRef = useRef(preferredVoice);
    useEffect(() => { preferredVoiceRef.current = preferredVoice; }, [preferredVoice]);

    const learnerLevelRef = useRef(learnerLevel);
    useEffect(() => { learnerLevelRef.current = learnerLevel; }, [learnerLevel]);

    const tutorLangRef = useRef(tutorLang);
    useEffect(() => { tutorLangRef.current = tutorLang; }, [tutorLang]);

    const autoplayOnLoadRef = useRef(false);
    const wakeLockRef = useRef(null);
    const pocketUnlockTimerRef = useRef(null);
    const audioCacheIndexRef = useRef({});
    const lastSentenceRef = useRef(null);
    const knowledgeTxtPickerPanelRef = useRef(null);
    const manualKnowledgeTxtInputRef = useRef(null);
    const embeddedKnowledgeTxtInputRef = useRef(null);
    const embeddedKnowledgeContentRef = useRef(null);
    const embeddedKnowledgeHeightMigrationRef = useRef(false);
    const embeddedKnowledgeTabSearchRef = useRef("");
    const knowledgePreviewPopupPanelRef = useRef(null);
    const knowledgePreviewPopupDragRef = useRef(null);
    const knowledgePreviewSplitDragRef = useRef(null);
    const knowledgePreviewPopupPosRef = useRef({ x: 24, y: 112 });

    // Batch Gen State - REMOVED

    // --- GLOBAL CHAT STATE ---
    const [showGlobalChat, setShowGlobalChat] = useState(false);
    const [globalChatHistory, setGlobalChatHistory] = useState([{ role: 'ai', text: "你好！我是你的專屬外語教練。有什麼我可以幫你的嗎？" }]);
    const [globalChatInput, setGlobalChatInput] = useState("");

    // --- GEMINI LIVE STATE ---
    const [showLiveCall, setShowLiveCall] = useState(false);
    const [liveCallStatus, setLiveCallStatus] = useState("idle");
    const isLiveActiveRef = useRef(false);
    const isGeneratingRef = useRef(false);
    const isPlayingQueueRef = useRef(false);
    const liveAudioRef = useRef(null);

    // Request Animation Frame Ref
    const requestRef = useRef();
    const flashCardAutoTimerRef = useRef(null);
    const flashCardAutoSpeakWatchdogRef = useRef(null);
    const flashCardAutoSessionRef = useRef(0);
    const flashCardAutoPendingSpeakRef = useRef(null);
    const flashCardAutoFileQueueRef = useRef([]);
    const flashCardAutoFileCursorRef = useRef(-1);
    const flashCardAutoFileLoadingRef = useRef(false);
    const flashCardPreserveAutoRunOnDataChangeRef = useRef(false);
    const flashCardAutoRunStateRef = useRef(false);
    const flashCardMasteryDataRef = useRef(flashCardMasteryData);
    const flashCardMasteryDirHandleRef = useRef(null);
    const flashCardMasterySaveTimerRef = useRef(null);
    const flashCardMasteryDirtyRef = useRef(false);
    const flashCardMasteryFeedbackCountSinceFlushRef = useRef(0);

    useEffect(() => { flashCardMasteryDataRef.current = flashCardMasteryData; }, [flashCardMasteryData]);
    useEffect(() => { flashCardMasteryDirHandleRef.current = flashCardMasteryDirHandle; }, [flashCardMasteryDirHandle]);

    const readFlashCardMasteryJsonFromFolder = useCallback(async (dirHandle) => {
        try {
            const fileHandle = await dirHandle.getFileHandle(FLASHCARD_MASTERY_FILE_NAME);
            const file = await fileHandle.getFile();
            const text = await file.text();
            return normalizeFlashCardMasteryData(JSON.parse(text));
        } catch (err) {
            if (err?.name === "NotFoundError") return createEmptyFlashCardMasteryData();
            throw err;
        }
    }, []);

    const writeFlashCardMasteryJsonToFolder = useCallback(async (dirHandle, data) => {
        const fileHandle = await dirHandle.getFileHandle(FLASHCARD_MASTERY_FILE_NAME, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(normalizeFlashCardMasteryData(data), null, 2));
        await writable.close();
    }, []);

    const flushFlashCardMasteryToFolder = useCallback(async (dataOverride) => {
        const dirHandle = flashCardMasteryDirHandleRef.current;
        if (!dirHandle) return;
        if (!dataOverride && !flashCardMasteryDirtyRef.current) return;
        try {
            setFlashCardMasterySyncStatus("saving");
            setFlashCardMasteryLastSaveError("");
            await writeFlashCardMasteryJsonToFolder(dirHandle, dataOverride || flashCardMasteryDataRef.current);
            flashCardMasteryDirtyRef.current = false;
            setFlashCardMasterySyncStatus("saved");
        } catch (err) {
            console.warn("Failed to save flashcard mastery folder JSON", err);
            setFlashCardMasteryLastSaveError(String(err?.message || err || ""));
            setFlashCardMasterySyncStatus("save_failed");
        }
    }, [writeFlashCardMasteryJsonToFolder]);

    const scheduleFlashCardMasteryAutoSave = useCallback((nextData) => {
        saveFlashCardMasteryToLocalStorage(nextData);
        flashCardMasteryDirtyRef.current = true;
        if (flashCardMasterySaveTimerRef.current) {
            clearTimeout(flashCardMasterySaveTimerRef.current);
            flashCardMasterySaveTimerRef.current = null;
        }
        if (!flashCardMasteryDirHandleRef.current) {
            setFlashCardMasterySyncStatus(isFileSystemAccessSupported() ? "local_only" : "local_only");
            return;
        }
        flashCardMasterySaveTimerRef.current = setTimeout(() => {
            flushFlashCardMasteryToFolder(nextData);
        }, FLASHCARD_MASTERY_AUTOSAVE_DEBOUNCE_MS);
    }, [flushFlashCardMasteryToFolder]);

    const connectFlashCardMasteryFolder = useCallback(async (dirHandle) => {
        if (!dirHandle) return;
        setFlashCardMasteryDirHandle(dirHandle);
        flashCardMasteryDirHandleRef.current = dirHandle;
        const folderData = await readFlashCardMasteryJsonFromFolder(dirHandle);
        const merged = mergeFlashCardMasteryData(flashCardMasteryDataRef.current, folderData);
        flashCardMasteryDataRef.current = merged;
        setFlashCardMasteryData(merged);
        saveFlashCardMasteryToLocalStorage(merged);
        flashCardMasteryDirtyRef.current = true;
        await flushFlashCardMasteryToFolder(merged);
        setFlashCardMasterySyncStatus("folder_sync_active");
    }, [flushFlashCardMasteryToFolder, readFlashCardMasteryJsonFromFolder]);

    const chooseFlashCardMasteryFolder = useCallback(async () => {
        if (!isFileSystemAccessSupported()) {
            const msg = "目前這個瀏覽器/開啟方式不支援直接選資料夾寫入 JSON。請用桌面 Chrome，並用 http://localhost 或 https 開啟；iPhone/iPad 請改用 Import/Export JSON。";
            setFlashCardMasterySyncStatus("unsupported");
            setFlashCardMasteryLastSaveError(msg);
            alert(msg);
            return;
        }
        try {
            setFlashCardMasterySyncStatus("loading");
            setFlashCardMasteryLastSaveError("");
            const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
            await connectFlashCardMasteryFolder(dirHandle);
        } catch (err) {
            if (err?.name === "AbortError") {
                setFlashCardMasterySyncStatus(flashCardMasteryDirHandleRef.current ? "folder_sync_active" : "local_only");
                return;
            }
            if (err?.name === "SecurityError") {
                const msg = "瀏覽器拒絕開啟資料夾選擇器。請確認這是由按鈕點擊觸發，並用桌面 Chrome 的 http://localhost 或 https 頁面開啟。";
                setFlashCardMasteryLastSaveError(msg);
                setFlashCardMasterySyncStatus("unsupported");
                alert(msg);
                return;
            }
            console.warn("Failed to choose flashcard mastery folder", err);
            setFlashCardMasteryLastSaveError(String(err?.message || err || ""));
            setFlashCardMasterySyncStatus("save_failed");
            alert(`授權 JSON 資料夾失敗：${String(err?.message || err || "")}`);
        }
    }, [connectFlashCardMasteryFolder]);

    const exportFlashCardMasteryJson = useCallback(async () => {
        try {
            const data = normalizeFlashCardMasteryData(flashCardMasteryDataRef.current);
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const baseFileName = buildFlashCardMasteryExportFileName();
            const dirHandle = flashCardMasteryDirHandleRef.current;
            if (dirHandle && typeof dirHandle.getFileHandle === "function") {
                const filename = await buildUniqueFileNameInDirectory(dirHandle, baseFileName);
                const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                setFlashCardMasteryLastSaveError("");
                setFlashCardMasterySyncStatus("synced");
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = baseFileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.warn("Failed to export flashcard mastery JSON", err);
        }
    }, []);

    const importFlashCardMasteryJsonFiles = useCallback(async (filesInput) => {
        const files = Array.from(filesInput || []).filter(Boolean);
        if (files.length === 0) return;
        try {
            setFlashCardMasterySyncStatus("loading");
            setFlashCardMasteryLastSaveError("");
            let merged = normalizeFlashCardMasteryData(flashCardMasteryDataRef.current);
            for (const file of files) {
                const text = await file.text();
                const incoming = normalizeFlashCardMasteryData(JSON.parse(text));
                merged = mergeFlashCardMasteryData(merged, incoming);
            }
            flashCardMasteryDataRef.current = merged;
            setFlashCardMasteryData(merged);
            scheduleFlashCardMasteryAutoSave(merged);
            if (flashCardMasteryDirHandleRef.current) {
                await flushFlashCardMasteryToFolder(merged);
            } else {
                setFlashCardMasterySyncStatus("local_only");
            }
        } catch (err) {
            console.warn("Failed to import flashcard mastery JSON", err);
            setFlashCardMasteryLastSaveError(String(err?.message || err || ""));
            setFlashCardMasterySyncStatus("save_failed");
        }
    }, [flushFlashCardMasteryToFolder, scheduleFlashCardMasteryAutoSave]);

    const importFlashCardMasteryJson = useCallback(async (file) => {
        await importFlashCardMasteryJsonFiles(file ? [file] : []);
    }, [importFlashCardMasteryJsonFiles]);

    const openFlashCardMasteryImportPicker = useCallback(() => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.multiple = true;
        input.style.display = "none";
        input.onchange = () => {
            importFlashCardMasteryJsonFiles(input.files);
            input.remove();
        };
        document.body.appendChild(input);
        input.click();
    }, [importFlashCardMasteryJsonFiles]);

    useEffect(() => {
        const onBeforeUnload = () => {
            saveFlashCardMasteryToLocalStorage(flashCardMasteryDataRef.current);
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => {
            window.removeEventListener("beforeunload", onBeforeUnload);
            if (flashCardMasterySaveTimerRef.current) clearTimeout(flashCardMasterySaveTimerRef.current);
        };
    }, []);

    useEffect(() => {
        if (!showModal || aiMode !== "flashcards") {
            flushFlashCardMasteryToFolder();
        }
    }, [aiMode, flushFlashCardMasteryToFolder, showModal]);

    // --- TTS ENGINE LOGIC ---
    useEffect(() => {
        const loadVoices = () => {
            const voices = window.speechSynthesis.getVoices();
            if (voices.length > 0) {
                setAvailableVoices(voices);

                const langPrefix = String(trackLanguage || "").split('-')[0].toLowerCase();

                // English preference rule: always prioritize Google US English on desktop/browsers where it's available.
                if (langPrefix === 'en') {
                    const googleUs = voices.find((v) => {
                        const name = String(v?.name || '').toLowerCase();
                        const uri = String(v?.voiceURI || '').toLowerCase();
                        const lang = String(v?.lang || '').toLowerCase();
                        return lang === 'en-us' && /google\s+us\s+english/.test(`${name} ${uri}`);
                    }) || voices.find((v) => {
                        const name = String(v?.name || '').toLowerCase();
                        const uri = String(v?.voiceURI || '').toLowerCase();
                        const lang = String(v?.lang || '').toLowerCase();
                        return lang === 'en-us' && /google/.test(`${name} ${uri}`);
                    });

                    if (googleUs) {
                        if (String(selectedVoiceURI || '') !== String(googleUs.voiceURI || '')) {
                            setSelectedVoiceURI(googleUs.voiceURI || '');
                        }
                        setPreferredVoice(prev => (
                            prev && prev.voiceURI === googleUs.voiceURI ? prev : googleUs
                        ));
                        return;
                    }
                }

                const selected = selectedVoiceURI
                    ? voices.find(v => String(v.voiceURI || "") === String(selectedVoiceURI || ""))
                    : null;
                if (selected) {
                    setPreferredVoice(prev => (
                        prev && prev.voiceURI === selected.voiceURI ? prev : selected
                    ));
                    return;
                }

                const bestVoice = chooseBestTtsVoice(voices, trackLanguage || langPrefix || "en-US");
                if (bestVoice) {
                    setSelectedVoiceURI(bestVoice.voiceURI);
                    setPreferredVoice(prev => (
                        prev && prev.voiceURI === bestVoice.voiceURI ? prev : bestVoice
                    ));
                }
            }
        };
        loadVoices();
        window.speechSynthesis.onvoiceschanged = loadVoices;
    }, [trackLanguage, selectedVoiceURI]);

    useEffect(() => {
        if (selectedVoiceURI && availableVoices.length > 0) {
            const voice = availableVoices.find(v => v.voiceURI === selectedVoiceURI);
            if (voice) setPreferredVoice(voice);
        }
    }, [selectedVoiceURI, availableVoices]);

    useEffect(() => {
        if (playerRef.current) {
            playerRef.current.playbackRate = playbackRate;
        }
    }, [playbackRate]);

    // [NEW] Re-generate subtitles when timeBuffer changes (if in smart mode)
    useEffect(() => {
        if (isSmartMode && rawSubtitles.length > 0) {
            setSubtitles(generateSmartSubtitles(rawSubtitles, timeBuffer, minDuration, maxMergeCount, trackLanguage));
        }
    }, [timeBuffer, minDuration, maxMergeCount, trackLanguage]);

    useEffect(() => {
        setShadowRepeatInput(String(shadowRepeatCount));
    }, [shadowRepeatCount]);

    useEffect(() => {
        setShadowGapInput(String(shadowGapAdjustment));
    }, [shadowGapAdjustment]);

    const clearFlashCardAutoTimer = useCallback(() => {
        if (flashCardAutoTimerRef.current) {
            clearTimeout(flashCardAutoTimerRef.current);
            flashCardAutoTimerRef.current = null;
        }
    }, []);

    const clearFlashCardAutoSpeakWatchdog = useCallback(() => {
        if (flashCardAutoSpeakWatchdogRef.current) {
            clearTimeout(flashCardAutoSpeakWatchdogRef.current);
            flashCardAutoSpeakWatchdogRef.current = null;
        }
    }, []);

    const resetFlashCardAutoFileQueue = useCallback(() => {
        flashCardAutoFileQueueRef.current = [];
        flashCardAutoFileCursorRef.current = -1;
        flashCardAutoFileLoadingRef.current = false;
    }, []);

    const stopFlashCardAutoRun = useCallback(() => {
        clearFlashCardAutoTimer();
        clearFlashCardAutoSpeakWatchdog();
        flashCardAutoPendingSpeakRef.current = null;
        flashCardAutoSessionRef.current += 1;
        resetFlashCardAutoFileQueue();
        setFlashCardAutoPaused(false);
        setFlashCardAutoRun(false);
    }, [clearFlashCardAutoSpeakWatchdog, clearFlashCardAutoTimer, resetFlashCardAutoFileQueue]);

    const clearPocketUnlockTimer = useCallback(() => {
        if (pocketUnlockTimerRef.current) {
            clearTimeout(pocketUnlockTimerRef.current);
            pocketUnlockTimerRef.current = null;
        }
    }, []);

    const requestFlashCardWakeLock = useCallback(async () => {
        if (typeof navigator === 'undefined' || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
            return false;
        }
        try {
            if (!wakeLockRef.current || wakeLockRef.current.released) {
                const lock = await navigator.wakeLock.request('screen');
                wakeLockRef.current = lock;
                if (lock && typeof lock.addEventListener === 'function') {
                    lock.addEventListener('release', () => {
                        if (wakeLockRef.current === lock) wakeLockRef.current = null;
                    });
                }
            }
            return { rawTxt };
        } catch (e) {
            console.warn('[FlashCard] WakeLock request failed:', e);
            return false;
        }
    }, []);

    const releaseFlashCardWakeLock = useCallback(async () => {
        const lock = wakeLockRef.current;
        wakeLockRef.current = null;
        if (!lock || lock.released) return;
        try {
            await lock.release();
        } catch (_) { }
    }, []);

    const handlePocketUnlockPressStart = useCallback(() => {
        if (!flashCardPocketModeEnabled) return;
        clearPocketUnlockTimer();
        setFlashCardPocketUnlockHolding(true);
        pocketUnlockTimerRef.current = setTimeout(() => {
            setFlashCardPocketModeEnabled(false);
            setFlashCardPocketUnlockHolding(false);
            pocketUnlockTimerRef.current = null;
        }, 1200);
    }, [clearPocketUnlockTimer, flashCardPocketModeEnabled]);

    const handlePocketUnlockPressEnd = useCallback(() => {
        clearPocketUnlockTimer();
        setFlashCardPocketUnlockHolding(false);
    }, [clearPocketUnlockTimer]);

    useEffect(() => {
        knowledgePreviewPopupPosRef.current = knowledgePreviewPopupPos;
    }, [knowledgePreviewPopupPos]);

    // [Progress] Always reset progress when switching files/tracks.
    useEffect(() => {
        setWatchedSegments(new Set());
    }, [currentTrackIndex]);

    useEffect(() => {
        setQuizSelectedKnowledgeBatch([]);
        setQuizKnowledgePointsPool([]);
        setQuizKnowledgeFileInfo(null);
        setFlashCards([]);
        setFlashCardCategories(["all"]);
        setFlashCardIndex(0);
        setFlashCardFlipped(false);
        setFlashCardAutoSpeakBack(false);
        setFlashCardAutoSpeakBackIncludeZh(false);
        setFlashCardAutoRun(false);
        setFlashCardWakeLockEnabled(false);
        setFlashCardTouchLockEnabled(false);
        setFlashCardPocketModeEnabled(false);
        setFlashCardPocketUnlockHolding(false);
        setFlashCardFrontPauseSec(2);
        setFlashCardBackPauseSec(1);
        setFlashCardSpeakSignalNonce(0);
        setFlashCardBackExampleSpeakSignalNonce(0);
        setFlashCardBackZhSpeakSignalNonce(0);
        clearFlashCardAutoTimer();
        clearPocketUnlockTimer();
        resetFlashCardAutoFileQueue();
        flashCardAutoPendingSpeakRef.current = null;
        flashCardAutoSessionRef.current += 1;
        setFlashCardSourceName("");
        setFlashCardError("");
        setFlashCardNotice("");
        setFlashCardTermPopup(null);
        setIsFlashCardLoading(false);
    }, [currentTrackIndex, clearFlashCardAutoTimer, clearPocketUnlockTimer, resetFlashCardAutoFileQueue]);

    useEffect(() => {
        if (flashCardPreserveAutoRunOnDataChangeRef.current) {
            flashCardPreserveAutoRunOnDataChangeRef.current = false;
            setFlashCardIndex(0);
            setFlashCardFlipped(false);
            return;
        }
        if (flashCardAutoRunStateRef.current) {
            stopFlashCardAutoRun();
        }
        setFlashCardIndex(0);
        setFlashCardFlipped(false);
    }, [flashCardCategories, flashCards.length, stopFlashCardAutoRun]);

    useEffect(() => {
        setFlashCardSpeakSignalNonce(v => v + 1);
        if (!flashCardAutoRun) {
            flashCardAutoPendingSpeakRef.current = null;
        }
    }, [flashCardAutoRun, flashCardFlipped, flashCardIndex, flashCardCategories, flashCards.length]);

    useEffect(() => {
        setFlashCardFrontPauseInput(String(flashCardFrontPauseSec));
    }, [flashCardFrontPauseSec]);

    useEffect(() => {
        setFlashCardBackPauseInput(String(flashCardBackPauseSec));
    }, [flashCardBackPauseSec]);

    useEffect(() => {
        if (!flashCardPocketModeEnabled) return;
        if (flashCardWakeLockEnabled) return;
        setFlashCardWakeLockEnabled(true);
    }, [flashCardPocketModeEnabled, flashCardWakeLockEnabled]);

    useEffect(() => {
        flashCardAutoRunStateRef.current = flashCardAutoRun;
    }, [flashCardAutoRun]);

    useEffect(() => {
        if (!showModal || aiMode !== 'flashcards') return;
        // 收合工具列時，自動啟用 Wake Lock（方便口袋連播）；展開時解除。
        if (!flashCardToolbarExpanded) {
            if (flashCardPocketModeEnabled) setFlashCardPocketModeEnabled(false);
            if (flashCardPocketUnlockHolding) setFlashCardPocketUnlockHolding(false);
            clearPocketUnlockTimer();
            if (!flashCardWakeLockEnabled) {
                setFlashCardWakeLockEnabled(true);
            }
            return;
        }
        if (flashCardTouchLockEnabled) setFlashCardTouchLockEnabled(false);
        if (flashCardWakeLockEnabled) setFlashCardWakeLockEnabled(false);
        releaseFlashCardWakeLock();
    }, [
        aiMode,
        clearPocketUnlockTimer,
        flashCardPocketModeEnabled,
        flashCardPocketUnlockHolding,
        flashCardTouchLockEnabled,
        flashCardToolbarExpanded,
        flashCardWakeLockEnabled,
        releaseFlashCardWakeLock,
        showModal
    ]);

    const touchStartRef = useRef(null);
    const lastUserSeekValueRef = useRef(0);

    const addToAudioCache = useCallback((text, url) => {
        setAudioCache(prev => ({ ...prev, [text]: url }));
        try {
            const tIdx = currentTrackIndexRef.current;
            const sIdx = currentIndexRef.current;
            if (tIdx >= 0 && sIdx >= 0) {
                const sentenceKey = `${tIdx}-${sIdx}`;
                const indexMap = audioCacheIndexRef.current;
                if (!indexMap[sentenceKey]) indexMap[sentenceKey] = new Set();
                indexMap[sentenceKey].add(text);
            }
        } catch (_) { }
    }, []);

    const playerRef = useRef(null);
    const shadowTimerRef = useRef(null);
    const folderInputRef = useRef(null);
    const openedFolderHandleRef = useRef(null);
    const openedFolderNameRef = useRef("");
    const selectedFolderFilesRef = useRef({});
    const folderWriteNoticeShownRef = useRef(false);
    const isLoopingRef = useRef(false);
    const currentRepeatRef = useRef(0);
    const timerTokenRef = useRef(0);
    const survivalModeRef = useRef(false);
    const survivalPauseTimerRef = useRef(null);
    const survivalPlayTokenRef = useRef(0);
    const suppressNextAutoWatchRef = useRef(false);
    const quizReviewIdRef = useRef(0);
    const quizUserInteractedRef = useRef(false);

    const getBufferedRange = (sub) => {
        if (!sub) return { start: 0, end: 0 };
        // IMPORTANT: iOS/WebKit MP3 seeking is often imprecise.
        // Removing start padding avoids accidentally including the previous sentence tail.
        const pad = timePadding;
        const baseEnd = Number(sub.end || 0);
        const subDuration = Math.max(0, baseEnd - Number(sub.start || 0));
        const desiredTailPad = estimateSubtitleTailPadding(sub.text || "", subDuration);
        const list = Array.isArray(subtitlesRef.current) ? subtitlesRef.current : [];
        const idx = list.findIndex((item) => (
            item === sub ||
            String(item?.id || "") === String(sub?.id || "") ||
            (Math.abs(Number(item?.start || 0) - Number(sub?.start || 0)) < 0.005 &&
                Math.abs(Number(item?.end || 0) - baseEnd) < 0.005)
        ));
        const nextSub = idx >= 0 ? list[idx + 1] : null;
        let allowedTailPad = desiredTailPad;
        if (nextSub && Number.isFinite(Number(nextSub.start))) {
            const gapToNext = Number(nextSub.start || 0) - baseEnd;
            if (gapToNext > 0.05) {
                allowedTailPad = Math.min(desiredTailPad, Math.max(0, gapToNext - 0.03));
            } else {
                const overlapCap = subDuration <= 1.4
                    ? 0.28
                    : subDuration <= 2.4
                        ? 0.20
                        : subDuration <= 4.0
                            ? 0.14
                            : 0.08;
                allowedTailPad = Math.min(desiredTailPad, overlapCap);
            }
        }
        const durationCap = Number(duration || 0) > 0 ? Number(duration) : Number.POSITIVE_INFINITY;
        return {
            start: Math.max(0, sub.start - pad),
            end: Math.min(durationCap, baseEnd + Math.max(0, allowedTailPad))
        };
    };

    const clearSurvivalPauseTimer = useCallback(() => {
        if (survivalPauseTimerRef.current) {
            clearTimeout(survivalPauseTimerRef.current);
            survivalPauseTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        survivalModeRef.current = isSurvivalMode;
        if (!isSurvivalMode) {
            clearSurvivalPauseTimer();
            survivalPlayTokenRef.current += 1;
        }
    }, [isSurvivalMode, clearSurvivalPauseTimer]);

    useEffect(() => {
        return () => {
            clearSurvivalPauseTimer();
        };
    }, [clearSurvivalPauseTimer]);

    useEffect(() => {
        return () => {
            clearFlashCardAutoTimer();
        };
    }, [clearFlashCardAutoTimer]);

    useEffect(() => {
        return () => {
            clearFlashCardAutoSpeakWatchdog();
        };
    }, [clearFlashCardAutoSpeakWatchdog]);

    useEffect(() => {
        return () => {
            clearPocketUnlockTimer();
            releaseFlashCardWakeLock();
        };
    }, [clearPocketUnlockTimer, releaseFlashCardWakeLock]);

    useEffect(() => {
        if (!flashCardAutoRun) return;
        if (showModal && aiMode === 'flashcards') return;
        stopFlashCardAutoRun();
    }, [showModal, aiMode, flashCardAutoRun, stopFlashCardAutoRun]);

    useEffect(() => {
        if (showModal && aiMode === 'flashcards') return;
        if (!flashCardPocketModeEnabled) return;
        setFlashCardPocketModeEnabled(false);
        setFlashCardPocketUnlockHolding(false);
        clearPocketUnlockTimer();
    }, [showModal, aiMode, flashCardPocketModeEnabled, clearPocketUnlockTimer]);

    useEffect(() => {
        if (showModal && aiMode === 'flashcards' && !flashCardToolbarExpanded) return;
        if (!flashCardTouchLockEnabled) return;
        setFlashCardTouchLockEnabled(false);
    }, [showModal, aiMode, flashCardToolbarExpanded, flashCardTouchLockEnabled]);

    useEffect(() => {
        const shouldHoldWakeLock = flashCardWakeLockEnabled && showModal && aiMode === 'flashcards';
        const syncWakeLock = async () => {
            if (shouldHoldWakeLock) {
                await requestFlashCardWakeLock();
                return;
            }
            await releaseFlashCardWakeLock();
        };
        syncWakeLock();
    }, [aiMode, flashCardWakeLockEnabled, releaseFlashCardWakeLock, requestFlashCardWakeLock, showModal]);

    useEffect(() => {
        const shouldHoldWakeLock = flashCardWakeLockEnabled && showModal && aiMode === 'flashcards';
        if (!shouldHoldWakeLock) return;
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                requestFlashCardWakeLock();
            }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [aiMode, flashCardWakeLockEnabled, requestFlashCardWakeLock, showModal]);

    // Mark all subtitles as watched (used when media finishes)
    const markAllSubtitlesWatched = useCallback(() => {
        if (!subtitles || subtitles.length === 0) return;
        setWatchedSegments(prev => {
            const next = new Set(prev);
            subtitles.forEach(s => next.add(s.id));
            return next;
        });
    }, [subtitles]);

    // Flag to avoid repeated tail marking in a single session
    const tailMarkedRef = useRef(false);

    useEffect(() => {
        // Reset when subtitle list changes
        tailMarkedRef.current = false;
    }, [subtitles]);

    // If playback reaches the last subtitle, mark everything as watched (100%)
    useEffect(() => {
        if (tailMarkedRef.current) return;
        if (!subtitles || subtitles.length === 0) return;
        if (currentTime <= 0.25) return;
        const last = subtitles[subtitles.length - 1];
        // Allow slight early trigger (0.2s before the last line starts)
        if (currentTime >= Math.max(0, last.start - 0.2)) {
            markAllSubtitlesWatched();
            tailMarkedRef.current = true;
        }
    }, [currentTime, subtitles, markAllSubtitlesWatched]);

    // [FIX] NEW: Strictly reset shadow counters when index changes
    useEffect(() => {
        currentRepeatRef.current = 0;
        isGapPausing.current = false;
        setIsWaitingShadow(false);
        isWaitingShadowRef.current = false; // Sync Ref
        setShadowCountdown(0);
        if (shadowTimerRef.current) {
            // [Worker] Cleanup (Not strictly necessary as worker handles reset, but good practice)
            // clearTimeout(shadowTimerRef.current);
        }

        // [NEW] Update Progress
        // [FIX] Use ID instead of Index to handle mode switching (Smart vs Raw)
        if (currentIndex >= 0 && subtitles[currentIndex] && !isSurvivalMode) {
            if (suppressNextAutoWatchRef.current) {
                suppressNextAutoWatchRef.current = false;
                return;
            }
            const subId = subtitles[currentIndex].id;
            setWatchedSegments(prev => new Set(prev).add(subId));
        }

    }, [currentIndex]);

    const cancelWorkerTimer = () => {
        timerTokenRef.current += 1;
        if (workerRef.current) workerRef.current.postMessage({ type: 'STOP_TIMER' });
    };

    const seekThenMaybePlay = (targetTime, shouldPlay) => {
        const player = playerRef.current;
        if (!player) return;

        const t = Math.max(0, Math.min(Number(targetTime) || 0, duration || Number(targetTime) || 0));

        // Avoid stacking multiple listeners across rapid Next/Prev taps
        const token = (timerTokenRef.current = (timerTokenRef.current + 1));

        let resolved = false;
        const cleanup = (onSeeked, onErr, onTu) => {
            try { player.removeEventListener('seeked', onSeeked); } catch (_) { }
            try { player.removeEventListener('error', onErr); } catch (_) { }
            try { player.removeEventListener('timeupdate', onTu); } catch (_) { }
        };

        const tryPlay = () => {
            if (!shouldPlay) return;
            // If another seek started after us, don't force play
            if (token !== timerTokenRef.current) return;
            player.play().then(() => {
                setIsPlaying(true);
            }).catch(e => {
                console.log("Play after seek blocked:", e);
                setIsPlaying(false);
            });
        };

        const onSeeked = () => {
            if (resolved) return;
            resolved = true;
            cleanup(onSeeked, onErr, onTu);
            tryPlay();
        };

        const onErr = () => {
            if (resolved) return;
            resolved = true;
            cleanup(onSeeked, onErr, onTu);
            // Fallback: attempt play anyway
            tryPlay();
        };

        // iOS sometimes delays/never fires seeked for tiny seeks; timeupdate fallback
        const onTu = () => {
            if (resolved) return;
            // When we're close enough to the intended time, treat as complete
            if (Math.abs(player.currentTime - t) <= 0.12) {
                resolved = true;
                cleanup(onSeeked, onErr, onTu);
                tryPlay();
            }
        };

        player.addEventListener('seeked', onSeeked);
        player.addEventListener('error', onErr);
        player.addEventListener('timeupdate', onTu);

        // Hard timeout fallback
        setTimeout(() => {
            if (resolved) return;
            resolved = true;
            cleanup(onSeeked, onErr, onTu);
            tryPlay();
        }, 650);

        player.currentTime = t;
    };

    const jumpTrackByOffset = (offset = 1) => {
        const list = playlistRef.current || [];
        if (list.length === 0) return false;

        const current = currentTrackIndexRef.current;
        let next = current + offset;

        if (next < 0 || next >= list.length) {
            if (playlistLoopModeRef.current === 'all') {
                next = (next + list.length) % list.length;
            } else {
                return false;
            }
        }

        if (next === current) return false;
        autoplayOnLoadRef.current = true;
        setIsPlaying(true);
        loadTrack(next, list);
        return true;
    };

    const jumpToSubtitle = (index) => {
        if (index >= subtitles.length) {
            jumpTrackByOffset(1);
            return;
        }
        if (index < 0) {
            jumpTrackByOffset(-1);
            return;
        }
        cancelWorkerTimer();
        // Clear any pending shadow wait state before manual jumps
        currentRepeatRef.current = 0;
        setIsWaitingShadow(false);
        isWaitingShadowRef.current = false;
        setShadowCountdown(0);

        // [FIX] Same-index check: Avoid mutex lock if index is not changing.
        // This handles loops on single items or manual replays.
        if (index === currentIndex) {
            if (playerRef.current) {
                const { start } = getBufferedRange(subtitles[index]);
                // Manual State Reset for same-index replay
                currentRepeatRef.current = 0;
                setIsWaitingShadow(false);
                isWaitingShadowRef.current = false;
                setShadowCountdown(0);

                // [Worker] Cancel wait
                if (workerRef.current) workerRef.current.postMessage({ type: 'STOP_HEARTBEAT' }); // Temp stop
                if (workerRef.current) workerRef.current.postMessage({ type: 'START_HEARTBEAT' }); // Restart

                seekThenMaybePlay(start, true);
                setIsPlaying(true); // Force UI update
            }
            return;
        }

        // [FIX] Protect against stale `checkPlayback` triggering pause during transition
        // This acts as a mutex until the new currentIndex effect resets it
        isGapPausing.current = true;

        setCurrentIndex(index);

        // State reset handled by useEffect above

        if (playerRef.current) {
            const { start } = getBufferedRange(subtitles[index]);
            seekThenMaybePlay(start, true);
            setIsPlaying(true); // Ensure RAF loop knows we are playing
        }
    };

    const resetShadowStateForSeek = () => {
        currentRepeatRef.current = 0;
        isGapPausing.current = false;
        setIsWaitingShadow(false);
        isWaitingShadowRef.current = false;
        setShadowCountdown(0);
    };

    const findSubtitleIndexByTimeInList = (time, list) => {
        if (!list || list.length === 0) return -1;
        const inRangeIdx = list.findIndex(s => time >= s.start && time < s.end);
        if (inRangeIdx !== -1) return inRangeIdx;
        if (time <= list[0].start) return 0;
        for (let i = list.length - 1; i >= 0; i--) {
            if (time >= list[i].start) return i;
        }
        return list.length - 1;
    };

    const findSubtitleIndexByTime = (time) => {
        return findSubtitleIndexByTimeInList(time, subtitles);
    };

    const seekToSubtitleByTime = (timeSec) => {
        if (!playerRef.current) return;
        const safeTime = Math.max(0, Math.min(timeSec, duration || timeSec));

        if (!subtitles || subtitles.length === 0) {
            playerRef.current.currentTime = safeTime;
            setCurrentTime(safeTime);
            return;
        }

        const targetIndex = findSubtitleIndexByTime(safeTime);
        if (targetIndex === -1) {
            playerRef.current.currentTime = safeTime;
            setCurrentTime(safeTime);
            return;
        }

        const targetSub = subtitles[targetIndex];
        const inRange = safeTime >= targetSub.start && safeTime < targetSub.end;
        const seekTime = inRange ? safeTime : targetSub.start;
        const shouldPlay = isPlaying;

        cancelWorkerTimer();
        resetShadowStateForSeek();
        setCurrentTime(seekTime);

        if (targetIndex !== currentIndex) {
            setCurrentIndex(targetIndex);
        }

        if (shouldPlay) {
            seekThenMaybePlay(seekTime, true);
        } else {
            // Still seek, but do not auto-play
            seekThenMaybePlay(seekTime, false);
            setIsPlaying(false);
        }
    };

    const handleProgressInput = (e) => {
        const val = parseFloat(e.target.value);
        if (Number.isNaN(val)) return;
        lastUserSeekValueRef.current = val;
        setCurrentTime(val);
    };

    const commitProgressSeek = (value) => {
        if (value == null || Number.isNaN(value)) return;
        seekToSubtitleByTime(value);
    };

    const getSubtitleBaseKeys = (fileName) => {
        const lower = fileName.toLowerCase();
        const base = lower.substring(0, lower.lastIndexOf('.'));
        const langSuffixes = ['.en', '.eng', '.ja', '.jp', '.ko', '.kr', '.zh', '.zh-tw', '.zh-hk', '.zh-cn', '.cht', '.chs', '.cn', '.tw', '.hk', '.chinese', '.han', '.zht', '.zhs'];
        let baseNoLang = base;
        for (const suf of langSuffixes) {
            if (base.endsWith(suf)) {
                baseNoLang = base.slice(0, -suf.length);
                break;
            }
        }
        return baseNoLang && baseNoLang != base ? [base, baseNoLang] : [base];
    };

    const pickSubtitleFile = (candidates) => {
        if (!candidates || candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];
        const preferNonChinese = candidates.filter(f => {
            const n = f.name.toLowerCase();
            const hasChineseTag = /(?:\bzh|\bchs|\bcht|zh-tw|zh-hk|zh-cn|chinese|中文|繁體|簡體|cn|tw|hk)/i.test(n);
            return !hasChineseTag;
        });
        if (preferNonChinese.length > 0) return preferNonChinese[0];
        return candidates[0];
    };

    const inferOpenedFolderNameFromFiles = (files) => {
        if (!Array.isArray(files) || files.length === 0) return "";
        const first = files[0];
        const rel = String(first?.webkitRelativePath || "");
        if (!rel.includes('/')) return "";
        return rel.split('/')[0] || "";
    };

    const collectFilesFromDirectoryHandle = async (dirHandle) => {
        const out = [];
        if (!dirHandle || dirHandle.kind !== 'directory') return out;
        const walk = async (handle) => {
            for await (const [, entry] of handle.entries()) {
                if (entry.kind === 'file') {
                    try {
                        const file = await entry.getFile();
                        out.push(file);
                    } catch (_) { }
                } else if (entry.kind === 'directory') {
                    await walk(entry);
                }
            }
        };
        await walk(dirHandle);
        return out;
    };

    const mergeFilesIntoSelectedFolderMap = (files) => {
        if (!Array.isArray(files) || files.length === 0) return selectedFolderFilesRef.current || {};
        const currentMap = selectedFolderFilesRef.current || {};
        const nextMap = { ...currentMap };
        let changed = false;
        for (const f of files) {
            const key = String(f?.name || "").toLowerCase();
            if (!key) continue;
            const prev = nextMap[key];
            const preferCurrent = !!prev && Number(f?.size || 0) < Number(prev?.size || 0);
            if (!preferCurrent && (!prev || prev.size !== f.size || prev.lastModified !== f.lastModified)) {
                nextMap[key] = f;
                changed = true;
            }
        }
        if (changed) {
            selectedFolderFilesRef.current = nextMap;
            syncKnowledgeTxtOptionsFromMap(nextMap);
        }
        return nextMap;
    };

    const stripTrailingSubtitleLanguageSuffix = (rawBaseName) => {
        let out = String(rawBaseName || "").trim();
        if (!out) return "";
        const suffixRe = /\.(?:en|eng|ja|jp|ko|kr|zh(?:-tw|-hk|-cn)?|cht|chs|cn|tw|hk|chinese|han|zht|zhs)$/i;
        while (suffixRe.test(out)) {
            out = out.replace(suffixRe, '').trim();
        }
        return out;
    };

    const normalizeLooseName = (text) => String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9\u3400-\u9fff]+/gi, '');

    const getKnowledgeTxtFilesFromMap = (fileMap = null) => {
        const map = fileMap || selectedFolderFilesRef.current || {};
        return Object.values(map)
            .filter((f) => {
                const lower = String(f?.name || "").toLowerCase();
                return lower.endsWith('.txt') && lower.includes('知識點');
            })
            .sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { numeric: true, sensitivity: 'base' }));
    };

    const syncKnowledgeTxtOptionsFromMap = (fileMap = null) => {
        const files = getKnowledgeTxtFilesFromMap(fileMap);
        const names = files.map((f) => String(f?.name || "")).filter(Boolean);
        setKnowledgeTxtOptions(names);
        setSelectedKnowledgeTxtName((prev) => (prev && names.includes(prev)) ? prev : "");
        return names;
    };

    const getTrackKnowledgeBaseCandidates = (track) => {
        const names = [
            track?.mediaFile?.name,
            track?.name,
            track?.subFile?.name
        ]
            .map((v) => String(v || "").trim())
            .filter(Boolean);
        const out = [];
        const seen = new Set();
        for (const n of names) {
            const noExt = n.replace(/\.[^/.]+$/, '').trim();
            const stripped = stripTrailingSubtitleLanguageSuffix(noExt) || noExt;
            const variants = [stripped, noExt].filter(Boolean);
            for (const v of variants) {
                const key = v.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(v);
            }
        }
        return out;
    };

    const getTrackBaseNameForKnowledge = (track) => {
        const candidates = getTrackKnowledgeBaseCandidates(track);
        return String(candidates[0] || "").trim();
    };

    const buildKnowledgeFileCandidates = (baseName) => {
        const b = String(baseName || "").trim();
        if (!b) return [];
        const stripped = stripTrailingSubtitleLanguageSuffix(b);
        const seedNames = [b, stripped].filter(Boolean);
        const out = [];
        const seen = new Set();
        for (const seed of seedNames) {
            const variants = [
                `${seed}知識點.txt`,
                `${seed}_知識點.txt`,
                `${seed}-知識點.txt`,
                `${seed} 知識點.txt`,
                `${seed}.知識點.txt`
            ];
            for (const name of variants) {
                const key = String(name).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(name);
            }
        }
        return out;
    };

    const findKnowledgeFileInFolderMap = (baseName, fileMap = null) => {
        const map = fileMap || selectedFolderFilesRef.current || {};
        const candidates = buildKnowledgeFileCandidates(baseName);
        for (const name of candidates) {
            const hit = map[String(name).toLowerCase()];
            if (hit) return hit;
        }
        const looseBase = normalizeLooseName(stripTrailingSubtitleLanguageSuffix(baseName) || baseName);
        const allFiles = Object.values(map);
        const fuzzy = allFiles.find((f) => {
            const lower = String(f?.name || "").toLowerCase();
            if (!lower.endsWith('.txt')) return false;
            if (!lower.includes('知識點')) return false;
            if (!looseBase) return true;
            return normalizeLooseName(lower).includes(looseBase);
        });
        return fuzzy || null;
    };

    const extractLeadingTrackToken = (text) => {
        const s = String(text || "").trim();
        if (!s) return "";
        const m = s.match(/^(\d{1,3})(?:\D|$)/);
        return m ? String(m[1]) : "";
    };

    const findKnowledgeFileHeuristically = (baseNames = [], fileMap = null) => {
        const map = fileMap || selectedFolderFilesRef.current || {};
        const allKnowledge = Object.values(map)
            .filter((f) => {
                const lower = String(f?.name || "").toLowerCase();
                return lower.endsWith('.txt') && lower.includes('知識點');
            });
        if (allKnowledge.length === 0) return null;

        const baseList = Array.isArray(baseNames) ? baseNames.map((x) => String(x || "").trim()).filter(Boolean) : [];
        if (baseList.length === 0) return allKnowledge[0] || null;
        const looseBases = baseList.map((b) => normalizeLooseName(b)).filter(Boolean);
        const leadTokens = baseList.map((b) => extractLeadingTrackToken(b)).filter(Boolean);

        let best = null;
        let bestScore = -1;
        for (const f of allKnowledge) {
            const fileName = String(f?.name || "");
            const fileCore = fileName.replace(/知識點\.txt$/i, '').replace(/\.txt$/i, '').trim();
            const looseFile = normalizeLooseName(fileCore);
            const fileToken = extractLeadingTrackToken(fileCore);
            let score = 0;

            for (const lb of looseBases) {
                if (!lb) continue;
                if (looseFile === lb) score += 120;
                else if (looseFile.includes(lb) || lb.includes(looseFile)) score += 80;
            }
            if (fileToken && leadTokens.includes(fileToken)) score += 25;
            score += Math.min(10, Math.max(1, Number(String(fileCore.length || 0))));

            if (score > bestScore) {
                bestScore = score;
                best = f;
            }
        }
        if (bestScore <= 0) return null;
        return best;
    };

    const normalizeKnowledgeFamilyCore = (text) => {
        const raw = String(text || "").trim();
        if (!raw) return "";
        const core = raw
            .replace(/知識點\.txt$/i, '')
            .replace(/\.txt$/i, '')
            .replace(/\(\s*\d+\s+of\s+\d+\s*\)\s*$/i, '')
            .replace(/[_\-.()\s]+$/g, '')
            .trim();
        return normalizeLooseName(stripTrailingSubtitleLanguageSuffix(core) || core);
    };

    const parseKnowledgeSeriesInfo = (fileName) => {
        const raw = String(fileName || "").trim();
        if (!raw) return null;
        const core = raw
            .replace(/知識點\.txt$/i, '')
            .replace(/\.txt$/i, '')
            .trim();
        const match = core.match(/^(.*?)(?:\s*[\[(（]\s*(\d+)\s*(?:of|\/)\s*(\d+)\s*[\])）])\s*$/i);
        if (!match) return null;
        const familyRaw = String(match[1] || "").trim();
        const part = Number(match[2] || 0);
        const total = Number(match[3] || 0);
        const familyKey = normalizeKnowledgeFamilyCore(familyRaw);
        if (!familyRaw || !familyKey || !Number.isFinite(part) || !Number.isFinite(total) || part < 1 || total < 2 || part > total) {
            return null;
        }
        return {
            fileName: raw,
            familyRaw,
            familyKey,
            part,
            total,
            seriesKey: `${familyKey}::${total}`
        };
    };

    const getTrackKnowledgeTxtFiles = (track, fileMap = null) => {
        const files = getKnowledgeTxtFilesFromMap(fileMap);
        if (!track) return files;
        const baseCandidates = getTrackKnowledgeBaseCandidates(track);
        const familyKeys = baseCandidates
            .map((base) => normalizeKnowledgeFamilyCore(base))
            .filter(Boolean);
        if (familyKeys.length === 0) return [];
        return files
            .filter((f) => {
                const fileFamily = normalizeKnowledgeFamilyCore(String(f?.name || ""));
                if (!fileFamily) return false;
                return familyKeys.some((family) =>
                    fileFamily === family ||
                    fileFamily.includes(family) ||
                    family.includes(fileFamily)
                );
            })
            .sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { numeric: true, sensitivity: 'base' }));
    };

    const getKnowledgeSeriesTabEntries = (selectedName, fileMap = null) => {
        const selectedInfo = parseKnowledgeSeriesInfo(selectedName);
        if (!selectedInfo) return [];
        const files = getKnowledgeTxtFilesFromMap(fileMap);
        return files
            .map((file) => {
                const name = String(file?.name || "").trim();
                const info = parseKnowledgeSeriesInfo(name);
                if (!info) return null;
                if (info.seriesKey !== selectedInfo.seriesKey) return null;
                return {
                    name,
                    label: `${info.part}/${info.total}`,
                    order: info.part,
                    total: info.total,
                    file
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    };

    const getKnowledgeTabLabel = (fileName) => {
        const raw = String(fileName || "").trim();
        if (!raw) return "知識點";
        const m = raw.match(/\((\d+)\s+of\s+(\d+)\)/i);
        if (m) return `${m[1]}/${m[2]}`;
        const core = raw.replace(/知識點\.txt$/i, '').replace(/\.txt$/i, '').trim();
        return core.length > 20 ? core.slice(0, 20) + "…" : core;
    };

    const doesKnowledgeFileLikelyBelongToTrack = (file, track) => {
        if (!file) return false;
        const fileName = String(file?.name || "").trim();
        if (!fileName) return false;
        if (!track) return true;

        const baseCandidates = getTrackKnowledgeBaseCandidates(track);
        if (!baseCandidates.length) return true;

        const fileCore = fileName
            .replace(/知識點\.txt$/i, '')
            .replace(/\.txt$/i, '')
            .trim();
        const looseFile = normalizeLooseName(fileCore);
        const fileFamily = normalizeKnowledgeFamilyCore(fileName);

        for (const base of baseCandidates) {
            const normalizedBase = String(base || "").trim();
            if (!normalizedBase) continue;

            const explicitNames = buildKnowledgeFileCandidates(normalizedBase).map((x) => String(x || "").toLowerCase());
            if (explicitNames.includes(fileName.toLowerCase())) return true;

            const looseBase = normalizeLooseName(normalizedBase);
            if (looseBase && (looseFile === looseBase || looseFile.includes(looseBase) || looseBase.includes(looseFile))) {
                return true;
            }
            const baseFamily = normalizeKnowledgeFamilyCore(normalizedBase);
            if (fileFamily && baseFamily && (fileFamily === baseFamily || fileFamily.includes(baseFamily) || baseFamily.includes(fileFamily))) {
                return true;
            }
        }
        return false;
    };

    const probeKnowledgeFileByBaseName = async (baseName, { refreshFromHandle = false, deepScan = false, ignoreCache = false } = {}) => {
        const normalizedBaseName = String(baseName || "").trim();
        if (!normalizedBaseName) return { exists: false, source: "none" };

        if (!ignoreCache) {
            const cacheHit = Object.values(quizKnowledgeBankMap || {}).find((kb) => {
                const kbBase = String(kb?.baseName || "").trim().toLowerCase();
                return kbBase === normalizedBaseName.toLowerCase() && Array.isArray(kb?.points) && kb.points.length > 0;
            });
            if (cacheHit) {
                return {
                    exists: true,
                    filename: cacheHit.filename || `${normalizedBaseName}知識點.txt`,
                    source: "cache",
                    knowledgeBank: cacheHit
                };
            }
        }

        let found = findKnowledgeFileInFolderMap(normalizedBaseName);
        if (found) {
            return { exists: true, filename: found.name || "", source: "snapshot", file: found };
        }

        const dirHandle = openedFolderHandleRef.current;
        if (refreshFromHandle && dirHandle && typeof dirHandle.getFileHandle === 'function') {
            const candidates = buildKnowledgeFileCandidates(normalizedBaseName);
            for (const filename of candidates) {
                try {
                    const fileHandle = await dirHandle.getFileHandle(filename, { create: false });
                    const file = await fileHandle.getFile();
                    mergeFilesIntoSelectedFolderMap([file]);
                    return { exists: true, filename: file.name || filename, source: "handle-direct", file };
                } catch (err) {
                    if (err?.name !== 'NotFoundError') {
                        console.warn("Probe knowledge file by handle failed:", err);
                    }
                }
            }

            if (deepScan) {
                try {
                    const freshFiles = await collectFilesFromDirectoryHandle(dirHandle);
                    const nextMap = mergeFilesIntoSelectedFolderMap(freshFiles);
                    found = findKnowledgeFileInFolderMap(normalizedBaseName, nextMap);
                    if (found) {
                        return { exists: true, filename: found.name || "", source: "handle-scan", file: found };
                    }
                } catch (err) {
                    console.warn("Deep scan knowledge files failed:", err);
                }
            }
        }

        return { exists: false, source: "none" };
    };

    const probeKnowledgeFileForCurrentTrack = async ({ refreshFromHandle = false, deepScan = false } = {}) => {
        const track = (currentTrackIndex >= 0 && playlist[currentTrackIndex]) ? playlist[currentTrackIndex] : null;
        const candidates = getTrackKnowledgeBaseCandidates(track);
        if (!candidates.length) return { exists: false, source: "none", baseName: "", triedBaseNames: [] };

        const selectedKnowledgeFile = getSelectedKnowledgeTxtFileFromFolderMap();
        const selectedMatchesTrack = doesKnowledgeFileLikelyBelongToTrack(selectedKnowledgeFile, track);
        if (selectedKnowledgeFile &&
            selectedMatchesTrack &&
            (typeof selectedKnowledgeFile.text === 'function' || typeof selectedKnowledgeFile.arrayBuffer === 'function')) {
            return {
                exists: true,
                source: "selected-txt",
                file: selectedKnowledgeFile,
                filename: String(selectedKnowledgeFile?.name || ""),
                baseName: candidates[0] || "",
                triedBaseNames: candidates
            };
        }

        for (const baseName of candidates) {
            const hit = await probeKnowledgeFileByBaseName(baseName, { refreshFromHandle, deepScan });
            if (hit?.exists) return { ...hit, baseName, triedBaseNames: candidates };
        }

        const heuristicFile = findKnowledgeFileHeuristically(candidates, selectedFolderFilesRef.current || {});
        if (heuristicFile) {
            return {
                exists: true,
                source: "heuristic",
                file: heuristicFile,
                filename: String(heuristicFile?.name || ""),
                baseName: candidates[0] || "",
                triedBaseNames: candidates
            };
        }
        return { exists: false, source: "none", baseName: candidates[0] || "", triedBaseNames: candidates };
    };

    const applySelectedFolderFiles = (files, { folderHandle = null, folderName = "" } = {}) => {
        if (!Array.isArray(files) || files.length === 0) return;
        openedFolderHandleRef.current = folderHandle || null;
        openedFolderNameRef.current = folderName || inferOpenedFolderNameFromFiles(files) || "";
        const fileMap = {};
        files.forEach((f) => {
            const key = String(f?.name || "").toLowerCase();
            if (!key) return;
            const prev = fileMap[key];
            if (!prev || Number(f?.size || 0) >= Number(prev?.size || 0)) {
                fileMap[key] = f;
            }
        });
        selectedFolderFilesRef.current = fileMap;
        syncKnowledgeTxtOptionsFromMap(fileMap);

        // [FIX] Clear caches to prevent old data from showing for new files
        setAiCache({});
        setTranslationCache({});
        setTargetFixCache({});
        setChatHistory([]);
        chatHistorySentenceKeyRef.current = null;
        setModalHistory([]);
        try {
            const cacheSnap = audioCacheRef.current || {};
            for (const url of Object.values(cacheSnap)) revokeBlobUrl(url);
        } catch (_) { }
        setAudioCache({});
        audioCacheIndexRef.current = {};

        const mediaExts = ['.mp4', '.webm', '.ogg', '.mp3', '.wav', '.m4a'];
        const subExts = ['.srt', '.lrc'];
        const subMap = new Map();

        files.forEach(f => {
            const fName = f.name.toLowerCase();
            if (subExts.some(ext => fName.endsWith(ext))) {
                const keys = getSubtitleBaseKeys(fName);
                keys.forEach(k => {
                    if (!subMap.has(k)) subMap.set(k, []);
                    subMap.get(k).push(f);
                });
            }
        });

        const newPlaylist = [];
        files.forEach(f => {
            const name = f.name.toLowerCase();
            if (f.type.startsWith('video/') || f.type.startsWith('audio/') || mediaExts.some(ext => name.endsWith(ext))) {
                const baseName = name.substring(0, name.lastIndexOf('.'));
                const candidates = subMap.get(baseName) || [];
                const subFile = pickSubtitleFile(candidates);
                newPlaylist.push({ name: f.name, mediaFile: f, subFile: subFile || null });
            }
        });
        newPlaylist.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        setPlaylist(newPlaylist);
        if (newPlaylist.length > 0) loadTrack(0, newPlaylist);
        else {
            setMediaSrc(null);
            setMediaError("");
            setSubtitles([]);
            setRawSubtitles([]);
            setAiCache({});
            setTranslationCache({});
            setTargetFixCache({});
            setChatHistory([]);
            chatHistorySentenceKeyRef.current = null;
            setModalHistory([]);
            try {
                const cacheSnap = audioCacheRef.current || {};
                for (const url of Object.values(cacheSnap)) revokeBlobUrl(url);
            } catch (_) { }
            setAudioCache({});
            audioCacheIndexRef.current = {};
        }
    };

    const detectTrackLanguageGlobal = (subs) => {
        if (!subs || subs.length === 0) return 'en-US';
        // [FIX] Increase sample size to ensure Kana is detected for Japanese tracks
        const sampleText = subs.slice(0, 200).map(s => s.text).join(' ');

        // Japanese: Hiragana/Katakana are strong indicators
        if (/[\u3040-\u30ff]/.test(sampleText)) return 'ja-JP';
        // Korean: Hangul is a strong indicator
        if (/[\uac00-\ud7af]/.test(sampleText)) return 'ko-KR';

        // Chinese vs English: Check ratio. 
        // Prevents "English content with Chinese translation" from being detected as zh-TW.
        const cjkCount = (sampleText.match(/[\u4e00-\u9fff]/g) || []).length;
        const latinCount = (sampleText.match(/[a-zA-Z]/g) || []).length;
        if (cjkCount > 0 && cjkCount > latinCount) return 'zh-TW';

        if (latinCount > 0) return inferLatinScriptLanguage(sampleText, "en-US");
        return 'en-US';
    };

    const handleFolderSelect = (e) => {
        const files = Array.from(e.target.files);
        if (files.length > 0) {
            applySelectedFolderFiles(files, {
                folderHandle: null,
                folderName: inferOpenedFolderNameFromFiles(files)
            });
        }
        e.target.value = null;
    };

    const handlePickFolder = async () => {
        if (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function') {
            try {
                const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                const files = await collectFilesFromDirectoryHandle(dirHandle);
                if (!files || files.length === 0) {
                    alert("資料夾內找不到可用媒體檔。");
                    return;
                }
                applySelectedFolderFiles(files, {
                    folderHandle: dirHandle,
                    folderName: String(dirHandle?.name || "")
                });
                return;
            } catch (err) {
                if (err?.name !== 'AbortError' && err?.name !== 'SecurityError') {
                    console.warn("showDirectoryPicker failed, fallback to webkitdirectory:", err);
                }
            }
        } else if (!folderWriteNoticeShownRef.current) {
            folderWriteNoticeShownRef.current = true;
            alert("目前環境不支援可寫入資料夾模式，下載會使用瀏覽器預設下載資料夾。");
        }
        if (folderInputRef.current) folderInputRef.current.click();
    };

    const loadTrack = (index, list = null) => {
        const targetList = list || playlist;
        if (index < 0 || index >= targetList.length) return;
        const track = targetList[index];
        setMediaError("");
        const prevTrack = (currentTrackIndexRef.current >= 0 && (playlistRef.current || [])[currentTrackIndexRef.current])
            ? (playlistRef.current || [])[currentTrackIndexRef.current]
            : null;
        const isTrackSwitch = !prevTrack || prevTrack.name !== track.name;
        if (isTrackSwitch) {
            setWatchedSegments(new Set());
            suppressNextAutoWatchRef.current = true;
        }
        setCurrentTime(0);
        tailMarkedRef.current = false;
        setCurrentTrackIndex(index);
        currentRepeatRef.current = 0;
        if (mediaSrc) URL.revokeObjectURL(mediaSrc);
        setMediaSrc(URL.createObjectURL(track.mediaFile));
        if (track.subFile) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const content = e.target.result;
                let parsed = [];
                if (track.subFile.name.toLowerCase().endsWith('.lrc')) parsed = parseLRC(content);
                else parsed = parseSRT(content);
                setRawSubtitles(parsed);

                // Calculate language FIRST so we can pass it to smart generator
                const detectedLang = detectTrackLanguageGlobal(parsed);
                setTrackLanguage(detectedLang);

                if (isSmartMode) setSubtitles(generateSmartSubtitles(parsed, timeBuffer, minDuration, maxMergeCount, detectedLang));
                else setSubtitles(parsed);

                setCurrentIndex(0);
            };
            reader.readAsText(track.subFile);
        } else {
            setRawSubtitles([]); setSubtitles([]); setTrackLanguage('en-US'); setCurrentIndex(-1);
        }
        setIsWaitingShadow(false);
        isWaitingShadowRef.current = false; // Sync Ref
    };

    const handlePlaylistEnd = () => {
        const list = playlistRef.current || [];
        if (list.length == 0) { setIsPlaying(false); return; }
        const mode = playlistLoopModeRef.current;
        const idx = currentTrackIndexRef.current;
        autoplayOnLoadRef.current = true;
        setIsPlaying(true);
        if (mode === 'single') {
            loadTrack(idx, list);
        } else if (mode === 'all') {
            const nextIdx = (idx + 1) % list.length;
            loadTrack(nextIdx, list);
        } else {
            autoplayOnLoadRef.current = false;
            setIsPlaying(false);
        }
    };

    // [FIX] Updated togglePlay to handle Shadow Wait cancellation using REF
    const togglePlay = () => {
        if (playerRef.current) {
            // Check REF for truth
            if (isWaitingShadowRef.current) {
                // Cancel worker wait via message if needed (or just ignore it by state change)
                cancelWorkerTimer();
                setIsWaitingShadow(false);
                isWaitingShadowRef.current = false;
                setShadowCountdown(0);
                isGapPausing.current = false;

                // Rewind to start of current sentence for drill practice
                if (subtitles[currentIndex]) {
                    playerRef.current.currentTime = getBufferedRange(subtitles[currentIndex]).start;
                }
                playerRef.current.play().catch(e => console.log("Toggle play blocked:", e));
                setIsPlaying(true);
            } else {
                // Normal toggle
                if (playerRef.current.paused) {
                    // [FIX] If at end of subtitle, rewind to start to prevent immediate shadow re-trigger
                    if (subtitles.length > 0 && currentIndex !== -1) {
                        const currentSub = subtitles[currentIndex];
                        const { start, end } = getBufferedRange(currentSub);
                        // If we are very close to end or past it
                        if (Math.abs(playerRef.current.currentTime - end) < 0.5 || playerRef.current.currentTime >= end) {
                            playerRef.current.currentTime = start;
                            currentRepeatRef.current = 0; // Reset repeat count for new cycle
                        }
                    }

                    playerRef.current.play().catch(e => console.log("Play blocked:", e));
                    setIsPlaying(true);
                } else {
                    playerRef.current.pause();
                    setIsPlaying(false);
                }
            }
        }
    };

    // --- WORKER INTEGRATION ---
    const workerRef = useRef(null);
    const latestStateRef = useRef({}); // Holds fresh state for Worker Callback

    // Update latest state for worker callback to access
    useEffect(() => {
        latestStateRef.current = {
            player: playerRef.current,
            isPlaying,
            isGapPausing: isGapPausing.current,
            subtitles,
            currentIndex,
            isShadowing,
            isWaitingShadowRef,
            loopMode,
            shadowGapAdjustment,
            shadowRepeatCount,
            isShadowInfinite,
            isShadowGapOriginal,
            playbackRate,
            currentRepeatRef,
            jumpToSubtitle, // function
            setIsPlaying, // function
            setIsWaitingShadow,
            setShadowCountdown,
            getBufferedRange // function
        };
    }, [isPlaying, subtitles, currentIndex, isShadowing, loopMode, shadowGapAdjustment, shadowRepeatCount, isShadowInfinite, isShadowGapOriginal, playbackRate]);

    useEffect(() => {
        // Create Worker from Blob
        const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
        workerRef.current = new Worker(URL.createObjectURL(blob));

        // Define Worker Handler
        workerRef.current.onmessage = (e) => {
            const { type } = e.data;
            const state = latestStateRef.current;
            const { player, isPlaying, isGapPausing, subtitles, currentIndex, isShadowing, isWaitingShadowRef, loopMode, shadowGapAdjustment, shadowRepeatCount, isShadowInfinite, isShadowGapOriginal, playbackRate, currentRepeatRef, jumpToSubtitle, setIsPlaying: setPlaying, setIsWaitingShadow, setShadowCountdown, getBufferedRange } = state;

            if (type === 'TICK') {
                if (!player || !isPlaying || isGapPausing) return;

                // If conceptually waiting (shadow gap), ignore ticks
                if (isShadowing && isWaitingShadowRef.current) return;

                const now = player.currentTime;
                // Update UI time (optional, can be throttled if performance issue)
                setCurrentTime(now);

                if (subtitles && subtitles.length > 0 && currentIndex !== -1) {
                    const currentSub = subtitles[currentIndex];
                    if (!currentSub) return;
                    const { end } = getBufferedRange(currentSub);
                    const shouldPauseAtEnd = state.isSmartMode || isShadowing || loopMode === 'single';

                    if (now >= end) {
                        if (shouldPauseAtEnd) {
                            player.pause();
                            player.currentTime = end;
                            state.isGapPausing = true; // Update ref proxy? No, update actual ref if possible or rely on re-render?
                            // We need to update the actual ref. But `isGapPausing` in state is boolean value from ref.current.
                            // Access actual ref via closure? No, we need it in `latestStateRef`.
                            // Correction: `isGapPausing` passed in state is the VALUE. We need to mutate the actual Ref.
                            // Since we can't easily export the Ref object itself in the flat list without confusion, let's assume global `isGapPausing` ref is accessible if we didn't use `latestStateRef`. 
                            // BUT `latestStateRef` is the only way to get fresh values in a stable closure.
                            // WORKAROUND: We won't mutate `isGapPausing` here directly. We will trigger the logic.

                            // To properly set the Lock, we need a function or access to the ref.
                            // Let's assume we dispatch an action.

                            // Actually, let's just execute the logic.
                            // We are in a closure that runs on main thread (onmessage). 
                            // We can access `isGapPausing` REF directly if we remove it from `latestStateRef` destructuring and use the top-level Ref.
                            // NO, `onmessage` is defined ONCE. It needs refs.
                        } else {
                            // Flow mode logic
                            // ... (same as before)
                            // Since we are paused, we don't need to do anything if it flows naturally.
                            // But wait, if we are NOT pausing, we might need to update index.
                            const nextSubIdx = subtitles.findIndex(s => now >= s.start && now <= s.end);
                            if (nextSubIdx !== -1 && nextSubIdx !== currentIndex) {
                                // We need to call setCurrentIndex
                                // But we can't call hooks inside here. We can call the setter passed in state.
                                // state.setCurrentIndex(nextSubIdx); // We didn't pass this.
                                // Pass `jumpToSubtitle` is safer.
                                jumpToSubtitle(nextIdx);
                            }
                        }
                    }
                }
            } else if (type === 'TIMER_DONE') {
                // Shadow Wait Finished
                if (isWaitingShadowRef.current) {
                    isWaitingShadowRef.current = false;
                    setIsWaitingShadow(false);
                    currentRepeatRef.current += 1;

                    const currentSub = subtitles[currentIndex];
                    if (isShadowInfinite || currentRepeatRef.current < shadowRepeatCount) {
                        if (player) {
                            player.currentTime = getBufferedRange(currentSub).start;
                            player.play().catch(e => console.warn(e));
                            setPlaying(true);
                        }
                    } else {
                        currentRepeatRef.current = 0;
                        if (loopMode === 'all') {
                            let nextIdx = currentIndex + 1;
                            if (nextIdx >= subtitles.length) nextIdx = 0;
                            jumpToSubtitle(nextIdx);
                        } else if (loopMode === 'none') {
                            if (currentIndex + 1 < subtitles.length) jumpToSubtitle(currentIndex + 1);
                            else setPlaying(false);
                        } else {
                            setPlaying(false);
                        }
                    }
                }
            }
        };

        // Start Heartbeat
        workerRef.current.postMessage({ type: 'START_HEARTBEAT' });

        return () => {
            if (workerRef.current) workerRef.current.terminate();
        };
    }, []);

    // [WORKER BRIDGE] Update Gap Logic using Worker
    // We need to rewrite the logic that *triggers* the wait to use the worker.
    // Since `handlePlaybackTick` logic is complex and needs to run on main thread (for video control),
    // we put the Logic inside `worker.onmessage` handler (above).

    // BUT: The `onmessage` needs access to the logic. 
    // The implementation above puts the logic inside `onmessage`. 
    // However, `onmessage` needs to access `isGapPausing` Ref which is local to component.
    // Solution: Access `isGapPausing` via `latestStateRef.current.isGapPausing` is READ only.
    // We need WRITE access.

    // REDEFINING `latestStateRef` to include Ref objects, not just values.
    useEffect(() => {
        latestStateRef.current = {
            player: playerRef.current,
            isPlaying,
            isGapPausingRef: isGapPausing, // Pass REF object
            subtitles,
            currentIndex,
            setCurrentIndex, // [FIX] Add setter for Flow Mode to update index without seeking
            isShadowing,
            isWaitingShadowRef,
            loopMode,
            shadowGapAdjustment,
            shadowRepeatCount,
            isShadowInfinite,
            isShadowGapOriginal,
            playbackRate,
            currentRepeatRef,
            jumpToSubtitle,
            setIsPlaying,
            setIsWaitingShadow,
            setShadowCountdown,
            getBufferedRange,
            isSmartMode,
            worker: workerRef.current
        };
    }, [isPlaying, subtitles, currentIndex, isShadowing, loopMode, shadowGapAdjustment, shadowRepeatCount, isShadowInfinite, isShadowGapOriginal, playbackRate, isSmartMode]);

    // Re-implement the `onmessage` logic with correct Ref usage:
    useEffect(() => {
        if (!workerRef.current) return;

        workerRef.current.onmessage = (e) => {
            const { type } = e.data;
            const state = latestStateRef.current;
            if (!state || !state.player) return;

            const { player, isPlaying, isGapPausingRef, subtitles, currentIndex, setCurrentIndex, isShadowing, isWaitingShadowRef, loopMode, shadowGapAdjustment, shadowRepeatCount, isShadowInfinite, isShadowGapOriginal, playbackRate, currentRepeatRef, jumpToSubtitle, setIsPlaying, setIsWaitingShadow, setShadowCountdown, getBufferedRange, isSmartMode, worker } = state;

            if (type === 'TICK') {
                if (!isPlaying || isGapPausingRef.current) return;

                // If conceptually waiting (shadow gap), ignore ticks
                if (isShadowing && isWaitingShadowRef.current) return;

                const now = player.currentTime;
                // Update UI time (using state setter from component scope)
                setCurrentTime(now);

                if (subtitles && subtitles.length > 0 && currentIndex !== -1) {
                    const currentSub = subtitles[currentIndex];
                    if (!currentSub) return;
                    const { end } = getBufferedRange(currentSub);
                    const shouldPauseAtEnd = isSmartMode || isShadowing || loopMode === 'single';

                    if (now >= end) {
                        if (shouldPauseAtEnd) {
                            player.pause();
                            player.currentTime = end;
                            isGapPausingRef.current = true; // Lock

                            // SHADOW LOGIC
                            // Delay Logic handled by Worker now
                            const sentenceDuration = currentSub.end - currentSub.start;
                            const effectiveDuration = sentenceDuration / playbackRate;
                            const baseWait = isShadowGapOriginal ? effectiveDuration : 0;
                            const waitSec = Math.max(0, baseWait + shadowGapAdjustment);
                            const waitMs = waitSec * 1000;

                            // UI Update
                            if (isShadowing) {
                                isWaitingShadowRef.current = true;
                                setIsWaitingShadow(true);
                                setShadowCountdown(waitMs);

                                // Send Wait Command to Worker
                                const token = ++timerTokenRef.current;
                                worker.postMessage({ type: 'START_TIMER', payload: { delay: waitMs, token } });
                            } else {
                                // Non-shadowing Drill Mode (Just small pause then repeat/next)
                                const token = ++timerTokenRef.current;
                                worker.postMessage({ type: 'START_TIMER', payload: { delay: 400, token } });
                            }
                        } else {
                            // Flow mode
                            const nextSubIdx = subtitles.findIndex(s => now >= s.start && now <= s.end);
                            if (nextSubIdx !== -1 && nextSubIdx !== currentIndex) {
                                setCurrentIndex(nextSubIdx); // [FIX] Update index only, don't seek/stutter
                            }
                            // [FIX] Removed manual duration check (now >= duration - 0.5) which caused premature skipping
                            // because 'duration' in this closure was stale (0).
                            // We rely on video.onEnded to handle playlist looping naturally.
                        }
                    }
                }
            } else if (type === 'TIMER_DONE') {
                if (typeof e.data?.token === 'number' && e.data.token !== timerTokenRef.current) return;
                // Timer finished, unlock and proceed
                isGapPausingRef.current = false;

                if (isShadowing) {
                    if (isWaitingShadowRef.current) {
                        isWaitingShadowRef.current = false;
                        setIsWaitingShadow(false);
                        currentRepeatRef.current += 1;

                        if (isShadowInfinite || currentRepeatRef.current < shadowRepeatCount) {
                            if (player) {
                                const currentSub = subtitles[currentIndex];
                                player.currentTime = getBufferedRange(currentSub).start;
                                player.play().catch(e => console.warn(e));
                                setIsPlaying(true);
                            }
                        } else {
                            currentRepeatRef.current = 0;
                            const isLastSubtitle = currentIndex >= subtitles.length - 1;
                            if (loopMode === 'all') {
                                if (isLastSubtitle) {
                                    // Do not switch track here; let <video onEnded> control playlist transitions.
                                    setIsPlaying(false);
                                } else {
                                    let nextIdx = currentIndex + 1;
                                    if (nextIdx >= subtitles.length) nextIdx = 0;
                                    jumpToSubtitle(nextIdx);
                                }
                            } else if (loopMode === 'none') {
                                if (currentIndex + 1 < subtitles.length) jumpToSubtitle(currentIndex + 1);
                                else setIsPlaying(false);
                            } else {
                                setIsPlaying(false);
                            }
                        }
                    }
                } else {
                    // Non-shadowing drill mode behavior (Simple pause -> Next/Repeat)
                    const currentSub = subtitles[currentIndex];
                    if (loopMode === 'single') {
                        player.currentTime = getBufferedRange(currentSub).start;
                        player.play().catch(e => console.warn(e));
                        setIsPlaying(true);
                    } else if (loopMode === 'all') {
                        let nextIdx = currentIndex + 1;
                        if (nextIdx >= subtitles.length) {
                            // Do not switch track here; let <video onEnded> control playlist transitions.
                            setIsPlaying(false);
                            return;
                        }
                        if (nextIdx < subtitles.length) jumpToSubtitle(nextIdx);
                    } else if (loopMode === 'none') {
                        if (currentIndex + 1 < subtitles.length) {
                            jumpToSubtitle(currentIndex + 1);
                        } else {
                            setIsPlaying(false);
                        }
                    }
                }
            }
        };
    }, []); // Empty dependency array because we rely on latestStateRef

    // [FIX] Removed `handlePlaybackTick` and RAF loop completely
    // The Worker TICK message now drives the logic.

    // ... (Rest of component remains same)

    const splitTranslationAndBody = (raw) => {
        const input = String(raw || "");
        const marker = "===TRANSLATION===:";
        const legacy = "[TRANSLATION]:";
        let idx = input.indexOf(marker);
        let token = marker;
        if (idx === -1) {
            idx = input.indexOf(legacy);
            token = legacy;
        }
        if (idx === -1) {
            return { body: input, translation: "" };
        }

        const start = idx + token.length;
        const rest = input.slice(start);
        const boundaryCandidates = [];
        const pushIdx = (n) => { if (Number.isFinite(n) && n > 0) boundaryCandidates.push(n); };

        // 1) Primary boundary: blank line after translation line.
        const blankBreak = rest.search(/\n\s*\n/);
        pushIdx(blankBreak);

        // 2) Secondary boundary: first newline (single-line translation mode).
        const firstLineBreak = rest.indexOf("\n");
        pushIdx(firstLineBreak);

        // 3) Section-heading boundary for structured outputs.
        const sectionHints = [
            "\n### ",
            "<<LKB_SEC:",
            "<<LKB_TABLE_START>>",
            "單字用語總覽",
            "核心詞彙表",
            "搭配用法",
            "替代表達",
            "片語與俚語",
            "介系詞重點對比",
            "句型骨架",
            "文法知識點",
            "變化與替換",
            "實用場景",
            "測驗",
            "可能誤聽/錯字"
        ];
        for (const hint of sectionHints) {
            pushIdx(rest.indexOf(`\n${hint}`));
            pushIdx(rest.indexOf(hint));
        }

        const headingRegex = /\n\s*(?:#{1,6}\s*)?(單字用語總覽|核心詞彙表|搭配用法|替代表達|片語與俚語|介系詞重點對比|句型骨架|文法知識點|變化與替換|實用場景|測驗|可能誤聽\/錯字)\b/;
        const headingMatch = rest.match(headingRegex);
        if (headingMatch && Number.isFinite(headingMatch.index)) {
            pushIdx(headingMatch.index);
        }

        let boundary = boundaryCandidates.length ? Math.min(...boundaryCandidates) : rest.length;
        if (!Number.isFinite(boundary) || boundary < 0) boundary = rest.length;

        let translation = rest
            .slice(0, boundary)
            .replace(/<<LKB_[A-Z0-9_:]+>>/g, "")
            .trim();

        let bodyTail = rest.slice(boundary);
        bodyTail = bodyTail.replace(/^\n\s*\n/, "\n").replace(/^\n/, "");

        // Guardrail: if translation accidentally swallowed tutor body, keep first line only.
        if (!bodyTail.trim() && /(?:^|\n)\s*(Hi\b|Today\b|Let'?s\b|We'll\b|中文提示[:：])/i.test(translation)) {
            const firstLine = translation.split(/\n+/)[0] || "";
            const remain = translation.slice(firstLine.length).replace(/^\s+/, "");
            translation = firstLine.trim();
            bodyTail = remain;
        }

        const body = (input.slice(0, idx) + bodyTail).trim();
        return { body, translation };
    };
    const normalizePrepositionContrastHeading = (line) => {
        const raw = String(line || "").replace(/\*+/g, "").trim();
        if (!raw) return raw;
        const match = raw.match(/^(\d+\.\s*)?([A-Za-z][A-Za-z' -]{0,60}?)\s+vs\.?\s+([A-Za-z][A-Za-z' -]{0,60}?)(?:\s*\([^)\n]{0,80}\))?\s*$/i);
        if (!match) return raw;
        const prefix = String(match[1] || "");
        const left = String(match[2] || "").trim();
        const right = String(match[3] || "").trim();
        return `${prefix}${left} vs. ${right}`;
    };

    const normalizeExplainSections = (input) => {
        let t = String(input || "");
        if (!t) return "";
        t = t.replace(/\[\[RID:[^\]]+\]\]/gi, "");
        t = t.replace(/匯出到試算表/g, "");

        const titles = [
            "單字用語總覽",
            "核心詞彙表",
            "搭配用法",
            "替代表達",
            "片語與俚語",
            "介系詞重點對比",
            "句型骨架",
            "文法知識點",
            "變化與替換",
            "實用場景",
            "測驗",
            "可能誤聽/錯字"
        ];
        const escRe = (s) => String(s || "").replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
        for (const title of titles) {
            const titleEsc = escRe(title);
            const exactHeader = new RegExp(`(^|\\n)\\s*(?:#{1,6}\\s*)?${titleEsc}\\s*(?=\\n|$)`, "g");
            t = t.replace(exactHeader, `$1\n\n### ${title}\n`);

            // Collapsed inline heading fallback: punctuation + title + content
            const inlineHeader = new RegExp(`([。！？!?])\\s*${titleEsc}\\s*(?=\\S)`, "g");
            t = t.replace(inlineHeader, `$1\n\n### ${title}\n`);
        }

        // Dedicated normalizer for "介系詞重點對比" section where model output can be collapsed.
        const fixPrepositionContrastSection = (src) => {
            const marker = "### 介系詞重點對比";
            const start = src.indexOf(marker);
            if (start === -1) return src;
            const bodyStart = start + marker.length;
            const rest = src.slice(bodyStart);
            const nextHeaderRel = rest.search(/\n###\s+/);
            const end = nextHeaderRel === -1 ? src.length : bodyStart + nextHeaderRel;
            let block = src.slice(bodyStart, end);
            if (!block.trim()) return src;
            block = block.replace(/(?:^|\n)\s*介系詞重點對比\s*(?=\n|$)/g, "\n").trim();

            const pairPattern = /(?:<T\b[^>]*>[\s\S]*?<\/T>\s+vs\.?\s+<T\b[^>]*>[\s\S]*?<\/T>|[A-Za-z][A-Za-z' -]{0,40}\s+vs\.?\s+[A-Za-z][A-Za-z' -]{0,40})(?:\s*\([^)\n]{0,60}\))?/g;
            const matches = Array.from(block.matchAll(pairPattern)).filter(m => Number.isFinite(m.index));
            const normalizeChunk = (txt) => String(txt || "")
                .replace(/\s*最小\s*[\r\n\t ]*對比\s*[\r\n\t ]*例句\s*[:：]?\s*/g, "\n最小對比例句：\n")
                .replace(/\s*(核心語意差異)\s*[:：]?\s*/g, "\n核心語意差異：\n")
                .replace(/\s*(為何(?:此句)?(?:要)?用[^：:\n]{0,40})\s*[:：]?\s*/g, "\n$1：\n")
                .replace(/\s*(最小對比例句|對比例句|例句)\s*[:：]?\s*/g, "\n$1：\n")
                .replace(/\n{3,}/g, "\n\n")
                .trim();

            if (matches.length >= 1) {
                const prefix = normalizeChunk(block.slice(0, matches[0].index));
                const chunks = [];
                for (let i = 0; i < matches.length; i += 1) {
                    const s = matches[i].index;
                    const e = i + 1 < matches.length ? matches[i + 1].index : block.length;
                    let chunk = normalizeChunk(block.slice(s, e));
                    if (chunk) {
                        chunk = chunk.replace(/^\s*\d+\s*[.)]\s+/, "").trim();
                    }
                    if (chunk) {
                        chunk = `${i + 1}. ${chunk}`;
                        chunk = chunk.replace(/^(\d+\.\s*[^\n]+)/, (m0) => normalizePrepositionContrastHeading(m0));
                    }
                    if (chunk) chunks.push(chunk);
                }
                const merged = [];
                if (prefix) merged.push(prefix);
                merged.push(...chunks);
                block = merged.join("\n\n");
            } else {
                block = normalizeChunk(block);
            }
            block = block.replace(/^(\s*)(\d+)\s*[.)]\s+\2\s*[.)]\s+/gm, "$1$2. ");
            return src.slice(0, bodyStart) + "\n" + block + "\n" + src.slice(end);
        };
        t = fixPrepositionContrastSection(t);

        // Grammar-detail readability fixes when model emits compact text without line breaks.
        t = t
            .replace(/(###\s*文法知識點)\s*(\d+\.\s*)/g, "$1\n\n$2")
            .replace(/([\n\r]|^)(\s*\d+\.\s*[^\n]+?)\s*(?=概念：)/g, "$1$2\n")
            .replace(/\s*(概念：|用法：|常見錯誤：|例句：|中文翻譯：)/g, "\n$1")
            .replace(/\s*(正式與非正式：|近義詞替換：)/g, "\n$1")
            .replace(/([。！？!?])\s*(With\s+[A-Za-z]|She\s+was\s+unable|Temperatures\s+soared|As\s+oil\s+tankers|Oil\s+tankers\s+being)/g, "$1\n$2")
            .replace(/\n{3,}/g, "\n\n");

        return t.trim();
    };

    const normalizeLooseCoreVocabRows = (input) => {
        let text = String(input || "");
        const marker = "### 核心詞彙表";
        const start = text.indexOf(marker);
        if (start === -1) return text;
        const bodyStart = start + marker.length;
        const rest = text.slice(bodyStart);
        const nextHeaderRel = rest.search(/\n###\s+/);
        const end = nextHeaderRel === -1 ? text.length : bodyStart + nextHeaderRel;
        const block = text.slice(bodyStart, end);
        if (!block.trim()) return text;

        const rawLines = block.split("\n").map(l => String(l || "").trim()).filter(Boolean);
        const tableRows = [];
        const otherLines = [];
        const asCells = (line) => {
            if (!line) return [];
            if (line.startsWith("|")) {
                const cells = line.split("|").slice(1, -1).map(c => c.trim()).filter(Boolean);
                if (cells.length >= 4) return cells;
            }
            if (line.includes("\t")) {
                const cells = line.split(/\t+/).map(c => c.trim()).filter(Boolean);
                if (cells.length >= 4) return cells;
            }
            const pipeCount = (line.match(/\|/g) || []).length;
            if (pipeCount >= 4) {
                const cells = line.split("|").map(c => c.trim()).filter(Boolean);
                if (cells.length >= 4) return cells;
            }
            return [];
        };
        const isHeaderLike = (cells) => /target word\/phrase/i.test(String(cells[0] || ""));
        const cleanCell = (v) => String(v || "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

        for (const line of rawLines) {
            const cells = asCells(line);
            if (cells.length >= 4) {
                const row = cells.slice(0, 6);
                while (row.length < 6) row.push("");
                if (/^[-: ]+$/.test(row[0])) continue;
                if (isHeaderLike(row)) continue;
                tableRows.push(row);
            } else {
                otherLines.push(line);
            }
        }
        if (tableRows.length === 0) return text;

        const header = "| Target Word/Phrase | Pronunciation/Reading (optional) | Part of Speech | Meaning (Chinese) | Collocations (with Chinese) | Example Sentence (Target Lang) |";
        const sep = "| --- | --- | --- | --- | --- | --- |";
        const tableText = [header, sep, ...tableRows.map(r => `| ${r.map(cleanCell).join(" | ")} |`)].join("\n");
        const tail = otherLines.length ? `\n\n${otherLines.join("\n")}` : "";
        const rebuilt = `\n${tableText}${tail}\n`;
        return text.slice(0, bodyStart) + rebuilt + text.slice(end);
    };

    const normalizeExplainByMarkers = (input) => {
        let t = String(input || "");
        if (!/<<\s*LKB_/i.test(t)) return t;

        t = t
            .replace(/\[\[RID:[^\]]+\]\]/gi, "")
            .replace(/匯出到試算表/g, "");

        const sectionMap = {
            OVERVIEW: "單字用語總覽",
            CORE_TABLE: "核心詞彙表",
            COLLOCATIONS: "搭配用法",
            ALTERNATIVES: "替代表達",
            IDIOMS: "片語與俚語",
            PREPOSITIONS: "介系詞重點對比",
            QUIZ: "測驗",
            ERRATA: "可能誤聽/錯字"
        };

        for (const [key, title] of Object.entries(sectionMap)) {
            const re = new RegExp(`<<\\s*LKB_SEC:${key}\\s*>>`, "gi");
            t = t.replace(re, "\n\n### " + title + "\n");
        }

        t = t
            .replace(/<<\s*LKB_TABLE_START\s*>>/gi, "\n")
            .replace(/<<\s*LKB_TABLE_END\s*>>/gi, "\n");

        let prepIdx = 0;
        t = t.replace(/<<\s*LKB_PREP_PAIR\s*>>/gi, () => `\n\n${++prepIdx}. `);

        t = t.replace(/<<[^>]+>>/g, "\n");

        const listSections = new Set(["搭配用法", "替代表達", "片語與俚語"]);
        const escapeRegex = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        const lines = t.split("\n");
        const out = [];
        let currentTitle = "";
        let buffer = [];

        const flush = () => {
            if (!currentTitle) {
                const lead = buffer.join("\n").trim();
                if (lead) out.push(lead);
                buffer = [];
                return;
            }

            const titleRe = new RegExp(`^\\s*${escapeRegex(currentTitle)}\\s*`, "i");
            let body = buffer.join("\n").replace(titleRe, "").trim();
            buffer = [];
            if (!body) {
                const heading = `### ${currentTitle}`;
                if (out[out.length - 1] !== heading) out.push(heading);
                return;
            }

            if (listSections.has(currentTitle)) {
                body = body
                    .replace(/(^|\n)\s*(\d+\.)\s*\n+\s*(?=\S)/g, "$1$2 ")
                    .replace(/\s*•\s*/g, "\n- ")
                    .replace(/\s*;\s*/g, "\n")
                    .replace(/([。！？.!?）)])\s*(?=<T\b)/g, "$1\n")
                    .replace(/(<\/T>)\s*(?=<T\b)/g, "$1\n")
                    .replace(/([）)])\s*(?=[A-Za-z][A-Za-z0-9' -]{1,72}\s*[（(])/g, "$1\n");
                const arr = body
                    .split(/\n+/)
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((line) => {
                        const deTitle = line.replace(titleRe, "").trim();
                        if (!deTitle) return "";
                        const normalized = deTitle.replace(/^(\d+)\.\s*\1\.\s*/, "$1. ");
                        if (/^(?:[-*]|\d+[.)])\s+/.test(normalized)) return normalized;
                        if (/^\|/.test(normalized)) return normalized;
                        return `- ${normalized}`;
                    })
                    .filter(Boolean);
                body = arr.join("\n");
            }

            if (currentTitle === "介系詞重點對比") {
                body = body
                    .replace(/(?:^|\n)\s*介系詞重點對比\s*(?=\n|$)/g, "\n")
                    .replace(/\*{1,3}([^*\n]+?)\*{1,3}/g, "$1")
                    .replace(/^\s*[-*]\s*/gm, "")
                    .replace(/^\s*\*\*(\d+)\.\s*\*\*\s*$/gm, "$1.")
                    .replace(/^\s*(\d+)\.\s*\1\.\s*/gm, "$1. ")
                    .replace(/(^|\n)\s*(\d+\.)\s*\n+\s*(?=\S)/g, "$1$2 ")
                    .replace(/(^|\n)\s*(\d+\.)\s*\n\s*\2\s*/g, "$1$2 ")
                    .replace(/(vs\.)\s*\n\s*([A-Za-z][A-Za-z0-9' -]{1,40})/g, "$1 $2")
                    .replace(/\s*最小\s*[\r\n\t ]*對比\s*[\r\n\t ]*例句\s*[:：]?\s*/g, "\n最小對比例句：\n")
                    .replace(/\s*(核心語意差異)\s*[:：]?\s*/g, "\n核心語意差異：\n")
                    .replace(/\s*(為何(?:此句)?(?:要)?用[^：:\n]{0,40})\s*[:：]?\s*/g, "\n$1：\n")
                    .replace(/\s*(最小對比例句|對比例句|例句)\s*[:：]?\s*/g, "\n$1：\n")
                    .replace(/([^\n])\n(\d+\.\s*)/g, "$1\n\n$2")
                    .replace(/\n{3,}/g, "\n\n")
                    .trim();
                body = body.replace(/^(\d+\.\s*[^\n]+)/gm, (m0) => normalizePrepositionContrastHeading(m0));
            }

            if (currentTitle === "測驗") {
                body = body
                    .replace(/(?:^|\n)\s*測驗\s*(?=Q\d+\s*[（(])/g, "\n")
                    .replace(/([^\n])\s*(Q\d+\s*[（(][^)）\n]*[)）])/g, "$1\n\n$2")
                    .replace(/([^\n])\s*(Q\d+\s*[:：])/g, "$1\n\n$2")
                    .replace(/([^\n])\s*([A-D][\)\.、:：]\s*(?=\S))/g, "$1\n$2")
                    .replace(/([^\n])\s*(正確答案[:：])/g, "$1\n$2")
                    .replace(/([^\n])\s*(題後解析[:：])/g, "$1\n$2");
            }

            const normalizedTitle = String(currentTitle || "").replace(/\s+/g, "").toLowerCase();
            body = body
                .split("\n")
                .filter((ln) => {
                    const raw = String(ln || "").trim();
                    if (!raw) return true;
                    const stripped = raw
                        .replace(/^#{1,6}\s*/, "")
                        .replace(/^\*\*\s*/, "")
                        .replace(/\s*\*\*$/, "")
                        .replace(/\s*[:：-]\s*$/, "")
                        .trim()
                        .replace(/\s+/g, "")
                        .toLowerCase();
                    return stripped !== normalizedTitle;
                })
                .join("\n")
                .replace(/\n{3,}/g, "\n\n")
                .trim();

            const heading = `### ${currentTitle}`;
            if (out[out.length - 1] !== heading) out.push(heading);
            out.push(body.trim());
        };

        for (const rawLine of lines) {
            const line = String(rawLine || "");
            const m = line.match(/^\s*###\s*(.+?)\s*$/);
            if (m) {
                flush();
                currentTitle = String(m[1] || "").trim();
                continue;
            }
            buffer.push(line);
        }
        flush();

        return out.join("\n\n")
            .replace(/<<[^>]+>>/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    };

    const normalizeQuizSectionFormatting = (input) => {
        let text = String(input || "");
        const marker = "### 測驗";
        const start = text.indexOf(marker);
        if (start === -1) return text;
        const bodyStart = start + marker.length;
        const rest = text.slice(bodyStart);
        const nextHeaderRel = rest.search(/\n###\s+/);
        const end = nextHeaderRel === -1 ? text.length : bodyStart + nextHeaderRel;
        let block = text.slice(bodyStart, end);
        if (!block.trim()) return text;

        block = block
            .replace(/(?:^|\n)\s*測驗\s*(?=Q\d+\s*[（(])/g, "\n")
            .replace(/([^\n])\s*(Q\d+\s*[（(][^)）\n]*[)）])/g, "$1\n\n$2")
            .replace(/([^\n])\s*(Q\d+\s*[:：])/g, "$1\n\n$2")
            .replace(/([^\n])\s*([A-D][\)\.、:：]\s*(?=\S))/g, "$1\n$2")
            .replace(/([^\n])\s*(正確答案[:：])/g, "$1\n$2")
            .replace(/([^\n])\s*(題後解析[:：])/g, "$1\n$2")
            .replace(/\n{3,}/g, "\n\n")
            .trim();

        return text.slice(0, bodyStart) + "\n" + block + "\n" + text.slice(end);
    };

    const reflowExplainListSections = (input) => {
        const text = String(input || "");
        if (!text) return "";
        const lines = text.split("\n");
        const out = [];
        const sectionTitles = new Set(["搭配用法", "替代表達", "片語與俚語"]);
        let currentSection = "";

        const normalizeSectionBody = (section, bodyLines) => {
            if (!sectionTitles.has(section)) return bodyLines;
            let body = bodyLines.join("\n").trim();
            if (!body) return [];

            // Remove accidental duplicated section title inside body.
            const dupRe = new RegExp(`^\\s*${section}\\s*`, "i");
            body = body.replace(dupRe, "").trim();

            if (section === "替代表達") {
                body = body.replace(/\s*;\s*/g, "\n");
                body = body.replace(/([^\n])\s+([A-Za-z][A-Za-z0-9' -]{1,48}\s*->)/g, "$1\n$2");
                // Split compact synonym chains: "...(中文)nextTerm(中文)..."
                body = body.replace(/([）)])\s*(?=<T\b|[A-Za-z][A-Za-z0-9' -]{0,40}\s*[（(])/g, "$1\n");
                body = body.replace(/(<\/T>)\s*(?=<T\b)/g, "$1\n");
            } else {
                body = body.replace(/([。！？.!?）)])\s*(?=<T\b)/g, "$1\n");
                body = body.replace(/([。！？.!?）)])\s*(?=[A-Za-z][A-Za-z0-9' -]{1,72}\s*[:：])/g, "$1\n");
                body = body.replace(/([。！？.!?）)])\s*(?=[A-Za-z][A-Za-z0-9' -]{1,72}\s*\()/g, "$1\n");
            }

            const arr = body
                .split("\n")
                .map(s => s.trim())
                .filter(Boolean)
                .map((line) => {
                    if (/^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) return line;
                    if (/^\|/.test(line)) return line;
                    // Keep list-like readability for these sections.
                    return `- ${line}`;
                });
            return arr;
        };

        let buffer = [];
        const flush = () => {
            if (!currentSection) {
                out.push(...buffer);
            } else {
                out.push(...normalizeSectionBody(currentSection, buffer));
            }
            buffer = [];
        };

        for (const line of lines) {
            const m = line.match(/^###\s*(.+?)\s*$/);
            if (m) {
                flush();
                currentSection = String(m[1] || "").trim();
                out.push(line);
                continue;
            }
            buffer.push(line);
        }
        flush();
        return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    };

    const rebuildCompactCoreVocabTable = (input) => {
        let text = String(input || "");
        const title = "### 核心詞彙表";
        const at = text.indexOf(title);
        if (at === -1) return text;
        const coreStart = at + title.length;
        const nextHeaderMatch = text.slice(coreStart).match(/\n###\s*(搭配用法|替代表達|片語與俚語|介系詞重點對比|測驗|可能誤聽\/錯字)/);
        const coreEnd = nextHeaderMatch ? coreStart + nextHeaderMatch.index : text.length;
        const coreBlock = text.slice(coreStart, coreEnd).trim();
        if (!coreBlock || /\n\|/.test(coreBlock)) return text;

        const headerConcatRe = /Target Word\/Phrase\s*Pronunciation\/Reading \(optional\)\s*Part of Speech\s*Meaning \(Chinese\)\s*Collocations \(with Chinese\)\s*Example Sentence \(Target Lang\)/i;
        if (!headerConcatRe.test(coreBlock)) return text;

        let rowsSource = coreBlock.replace(headerConcatRe, "").trim();
        const rowStartRe = /<T\s+lang="[^"]+">[\s\S]*?<\/T>\s*\/[^\/\n]{1,90}\//g;
        const starts = [];
        let m;
        while ((m = rowStartRe.exec(rowsSource)) !== null) {
            starts.push(m.index);
        }
        if (starts.length === 0) return text;

        const splitRows = [];
        for (let i = 0; i < starts.length; i += 1) {
            const s = starts[i];
            const e = i + 1 < starts.length ? starts[i + 1] : rowsSource.length;
            splitRows.push(rowsSource.slice(s, e).trim());
        }

        const cleanCell = (v) => String(v || "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
        const parseRow = (chunk) => {
            const tags = Array.from(chunk.matchAll(/<T\s+lang="[^"]+">[\s\S]*?<\/T>/g)).map(x => x[0]);
            if (tags.length < 2) return null;
            const target = tags[0];
            const pronMatch = chunk.match(/\/[^\/\n]{1,90}\//);
            const pron = pronMatch ? pronMatch[0] : "";
            const pronEnd = pronMatch ? (pronMatch.index + pronMatch[0].length) : 0;
            const secondTagIdx = chunk.indexOf(tags[1], pronEnd);
            const pre = (secondTagIdx > pronEnd ? chunk.slice(pronEnd, secondTagIdx) : chunk.slice(pronEnd)).trim();
            let pos = "";
            let meaning = pre;
            const posMatch = pre.match(/^(n\.|v\.|adj\.|adv\.|prep\.|conj\.|pron\.|det\.|aux\.|modal|phrase|idiom)\s*/i)
                || pre.match(/^([A-Za-z]{1,10}\.)\s+(.+)$/);
            if (posMatch) {
                pos = String(posMatch[1] || "").trim();
                meaning = pre.slice(posMatch[0].length).trim();
            }

            let collocation = tags.length >= 3 ? tags[1] : "";
            let example = tags.length >= 3 ? tags[2] : tags[1];
            const exIdx = example ? chunk.indexOf(example) : -1;
            if (exIdx >= 0) {
                const tail = chunk.slice(exIdx + example.length);
                const small = tail.match(/<small>[\s\S]*?<\/small>/i);
                if (small) example = `${example}<br>${small[0]}`;
            }
            return [target, pron, pos, meaning, collocation, example];
        };

        const parsedRows = splitRows.map(parseRow).filter(Boolean);
        if (parsedRows.length === 0) return text;

        const header = "| Target Word/Phrase | Pronunciation/Reading (optional) | Part of Speech | Meaning (Chinese) | Collocations (with Chinese) | Example Sentence (Target Lang) |";
        const sep = "| --- | --- | --- | --- | --- | --- |";
        const lines = [header, sep, ...parsedRows.map((cells) => `| ${cells.map(cleanCell).join(" | ")} |`)];

        const rebuilt = `\n${lines.join("\n")}\n`;
        text = text.slice(0, coreStart) + rebuilt + text.slice(coreEnd);
        return text.replace(/\n{3,}/g, "\n\n").trim();
    };

    // [FIX] Updated Parser Logic to support prompt's format
    const processAIResponse = (rawText) => {
        if (typeof rawText !== 'string') {
            return { content: "", translation: "", targetFix: "", targetFixConfidence: "" };
        }
        let content = rawText;
        let translation = "";
        let targetFix = "";
        let targetFixConfidence = "";

        const split = splitTranslationAndBody(content);
        content = split.body;
        translation = split.translation;
        if (!translation) {
            const translationMatch = content.match(/(?:^===TRANSLATION===:|\[TRANSLATION\]:)\s*(.*)/m);
            if (translationMatch) {
                translation = translationMatch[1];
                content = content.replace(/(?:^===TRANSLATION===:|\[TRANSLATION\]:).*\n?/m, '').trim();
            }
        }

        // Optional target sentence correction line
        const targetFixMatch = content.match(/^===TARGET_FIX===:\s*(.*)/m);
        if (targetFixMatch) {
            targetFix = targetFixMatch[1];
            content = content.replace(/^===TARGET_FIX===:.*\n?/m, '').trim();
        }

        const targetFixConfMatch = content.match(/(?:^===TARGET_FIX_CONFIDENCE===:|\[TARGET_FIX_CONFIDENCE\]:)\s*(.*)/m);
        if (targetFixConfMatch) {
            targetFixConfidence = (targetFixConfMatch[1] || "").trim().toUpperCase();
            content = content.replace(/(?:^===TARGET_FIX_CONFIDENCE===:|\[TARGET_FIX_CONFIDENCE\]:).*\n?/m, '').trim();
        }

        const hasMarkers = /<<\s*LKB_/i.test(content);
        const alreadyStructuredMarkdown = /(^|\n)\s*#{2,6}\s+\S/m.test(content) || /(^|\n)\s*\|.+\|\s*$/m.test(content) || /(^|\n)\s*[-*]\s+\S/m.test(content);
        if (hasMarkers) {
            content = normalizeExplainByMarkers(content);
        } else if (PRESERVE_GEMINI_MARKDOWN_LAYOUT && alreadyStructuredMarkdown) {
            content = content
                .replace(/\[\[RID:[^\]]+\]\]/gi, "")
                .replace(/匯出到試算表/g, "")
                .trim();
        } else {
            content = normalizeExplainSections(content);
        }

        content = rebuildCompactCoreVocabTable(content);
        content = normalizeLooseCoreVocabRows(content);

        content = content.replace(/<<[^>]+>>/g, "").trim();

        const shouldNormalizeQuiz = hasMarkers || !PRESERVE_GEMINI_MARKDOWN_LAYOUT || !alreadyStructuredMarkdown;
        if (shouldNormalizeQuiz) {
            content = normalizeQuizSectionFormatting(content);
        }
        if (hasMarkers || !PRESERVE_GEMINI_MARKDOWN_LAYOUT || !alreadyStructuredMarkdown) {
            content = reflowExplainListSections(content);
        }

        return { content, translation, targetFix, targetFixConfidence };
    };

    const handleAIText = async (type) => {
        if (playerRef.current) { playerRef.current.pause(); setIsPlaying(false); }
        const sub = subtitles[currentIndex]; if (!sub) return;
        setAiMode('text'); setShowModal(true); setShowRecorder(false);
        setIsFullVocabLoading(false);
        setFullVocabProgress({ done: 0, total: 0 });
        setModalHistory([]);
        const smartSentence = sub.text;
        const targetFixKey = `${currentTrackIndex}-${currentIndex}`;
        const correctedSentence = stripStrike(normalizeTargetSentence(targetFixCache[targetFixKey] || ""));
        const effectiveTargetSentence = correctedSentence || normalizeTargetSentence(smartSentence);

        // [FIX] Explicit Delimiters for Target Sentence to prevent confusion
        const targetSentenceForPrompt = `
--- TARGET SENTENCE ---
"${effectiveTargetSentence}"
--- CONTEXT ---
${subtitles.slice(Math.max(0, currentIndex - 2), Math.min(subtitles.length, currentIndex + 3)).map(s => s.text).join('\n')}
`;

        setSmartTargetDisplay(smartSentence);

        // Check Global Translation Cache first
        const transCacheKey = `${currentTrackIndex}-${currentIndex}`;
        if (translationCache[transCacheKey]) {
            setTargetTranslation(translationCache[transCacheKey]);
        } else {
            setTargetTranslation("");
        }

        const cacheKey = `${currentTrackIndex}-${currentIndex}-${type}-${learnerLevel}-v${AI_NOTES_CACHE_SCHEMA_VERSION}`;

        const cachedAiRaw = aiCache[cacheKey];
        if (cachedAiRaw && !isLikelyBridgeAckText(cachedAiRaw) && !isLikelyBridgeFailureText(cachedAiRaw)) {
            const { content, translation, targetFix, targetFixConfidence } = processAIResponse(cachedAiRaw);
            setModalContent(content);
            // If cache didn't have translation but AI Response does (legacy compat), update cache
            if (translation && !translationCache[transCacheKey]) {
                setTranslationCache(prev => ({ ...prev, [transCacheKey]: translation }));
                setTargetTranslation(translation);
            }
            if (type === 'correction') {
                const fallbackFix = targetFix || extractCorrectionSentenceFromContent(content);
                if (fallbackFix && shouldAcceptTargetFix(smartSentence, fallbackFix, targetFixConfidence)) {
                    setTargetFixCache(prev => ({ ...prev, [transCacheKey]: fallbackFix }));
                }
            }
            setModalTitle(type === 'correction' ? "字幕校正" : type === 'explain' ? "單字用語" : "文法詳解");
            return;
        }

        setIsLoadingAI(true); setModalContent("");

        const systemPrompt = SYSTEM_PROMPT_CORE(learnerLevel);

        let specificPrompt = "";
        let title = "";
        const contextDisambiguationOnly = `
        [CONTEXT RULE]
        You may read CONTEXT only to resolve ambiguity.
        You MUST analyze ONLY the TARGET SENTENCE.
        Do NOT extract words/phrases from CONTEXT.
        `;

        const translationInstruction = `
        [OUTPUT INSTRUCTION]
        1. Start your response EXACTLY with this line:
           ===TRANSLATION===: <Translate the TARGET SENTENCE into Traditional Chinese here>
        2. Leave an empty line.
        3. Proper nouns / interjections / coined terms: keep original (or transliterate), do NOT translate literally. If it is a shout/onomatopoeia, add a short note in Chinese in parentheses.
        4. Provide the requested analysis below.
        `;
        const targetLangTag = String(trackLanguage || "target").trim() || "target";
        const isEnglishTarget = /^en(?:-|$)/i.test(targetLangTag);
        const targetLanguageSafetyInstruction = `
        [TARGET LANGUAGE SAFETY]
        TARGET LANGUAGE CODE: ${trackLanguage}
        - TARGET LANGUAGE CODE is metadata for expected learning language, NOT an instruction to rewrite script.
        - Analyze the provided TARGET SENTENCE directly.
        - Keep TARGET SENTENCE text exactly as given (same script/wording), except optional correction notes.
        - NEVER rewrite/translate TARGET SENTENCE into another non-Chinese language for analysis.
        - If TARGET SENTENCE language differs from TARGET LANGUAGE CODE, keep the original sentence and note the mismatch in Traditional Chinese.
        - The only translation allowed is the line "===TRANSLATION===: ..."(Traditional Chinese).
        `;
        const targetFixInstruction = type === 'correction' ? `
        [TARGET SENTENCE CHECK]
        Do NOT assume the TARGET SENTENCE is always correct.
        If you suspect transcription errors, output ONE line:
        ===TARGET_FIX===: use ~~wrong~~ correct (strikethrough the wrong word, then the corrected word).
        You MUST also output:
        ===TARGET_FIX_CONFIDENCE===: HIGH | MED | LOW
        - Use HIGH only if the correction is very confident and minimal.
        - If unsure, set LOW and keep the original wording in your analysis.
        - Do NOT delete hyphenated interjections/proper nouns unless audio clearly excludes them.
        If no issue, do NOT output ===TARGET_FIX===.
        ` : "";
        const explainStructureMarkerInstruction = `
        [STRUCTURE MARKERS - REQUIRED]
        Use the exact markers on their own lines:
        <<LKB_SEC:OVERVIEW>>
        <<LKB_SEC:CORE_TABLE>>
        <<LKB_SEC:COLLOCATIONS>>
        <<LKB_SEC:ALTERNATIVES>>
        <<LKB_SEC:IDIOMS>>
        <<LKB_SEC:PREPOSITIONS>>
        <<LKB_SEC:QUIZ>>
        <<LKB_SEC:ERRATA>>

        For core vocabulary table, wrap it with:
        <<LKB_TABLE_START>>
        ...markdown table...
        <<LKB_TABLE_END>>

        In PREPOSITIONS section, each contrast item MUST start with:
        <<LKB_PREP_PAIR>>

        Do NOT output "匯出到試算表".
        `;

        if (type === 'correction') {
            title = "字幕校正";
            specificPrompt = `TASK: You are a strict Proofreader AND Audio-based Transcription Judge.
            You will be given (A) the subtitle text and (B) an audio clip of the same segment when available.

            1. **AUDIO-FIRST CHECK (CRITICAL)**: If audio is provided, decide whether the subtitle text matches what is spoken. Identify any misheard words (e.g., Iranian vs Residents). If no mismatch, state "No errors detected".
            1b. If a token looks like an interjection/chant/brand/proper noun (e.g., stylized or hyphenated), keep it unless audio clearly contradicts; mention it as a coined term in analysis.
            2. **PROVIDE CORRECTED SUBTITLE**: If mismatch exists, output the corrected subtitle sentence (Target Language) exactly once.
            3. **LISTENING ANALYSIS**: Explain phonological reasons for the mishearing:
               - Linking/Liaison
               - Reduction/Elision
               - Stress/Accent
               - Similar-sounding syllables

            **OUTPUT FORMAT REQUIREMENT**:
            - Start with translation line per instruction.
            - Then include a section titled "### 校正結果" and "### 為何會聽錯".
            Explain clearly in Traditional Chinese. ${translationInstruction} ${targetLanguageSafetyInstruction} ${targetFixInstruction}`;
        } else if (type === 'explain') {
            title = "單字用語";
            const langPrompt = "Focus on vocabulary usage, collocations, and natural expressions. Avoid grammar deep dive here.";
            const englishPrepositionFocus = isEnglishTarget ? `
            [ENGLISH PREPOSITION FOCUS - REQUIRED]
            - Since target language is English, you MUST include a section: "### 介系詞重點對比".
            - Provide at least 3 preposition contrasts that are relevant to this sentence/context.
            - For each contrast, explain in Traditional Chinese:
              1) Start each item exactly in Markdown as: **A** vs. **B**
              2) 核心語意差異
              3) 為何此句要用 A 而不是 B
              4) 一組最小對比例句（English + Chinese）
            - Example heading format: **to** vs. **for**
            - Bold the compared prepositions/phrases everywhere they appear in this section, not just in the heading.
            - Preferred contrast pairs: in/on/at, to/for, by/with, in/into, on/onto, at/in.
            ` : "";

            specificPrompt = `TASK: ${langPrompt}
            ${contextDisambiguationOnly}
            ${buildPromptTableFormat(trackLanguage)}
            ${explainStructureMarkerInstruction}
            Provide 3-6 key items (words/phrases/idioms if applicable).
            TARGET LANGUAGE CODE: ${trackLanguage}
            **SECTIONS (IN ORDER)**:
            1) ### 單字用語總覽 (1-2 lines in Traditional Chinese)
            2) ### 核心詞彙表 (use the table format above)
            3) ### 搭配用法 (collocations)
            4) ### 替代表達 (synonyms / colloquial / formal)
            5) ### 片語與俚語 (only if relevant)
            6) ### 測驗 (REQUIRED)
            7) ### 可能誤聽/錯字 (if any; 1 line only; do NOT rewrite the target sentence)

            ${englishPrepositionFocus}

            **QUIZ RULE**:
            - Each knowledge point MUST have at least 1 question.
            - Choose the BEST question type for that knowledge point (MCQ / Fill-in / Rewrite / Error-correction / Merge).
            - Questions & options must be in Target Language only.
            - Provide short explanations in Traditional Chinese.
            ${isEnglishTarget ? '- For English target language, include at least 2 questions focused on preposition choice/contrast, and explain why alternative prepositions are wrong.' : ''}
            - **NO SPOILERS**: Do NOT reveal the answer in the question title or labels (e.g., avoid "核心詞彙：<answer>"). Use neutral titles like "Q1 (多選題)".
            - For EVERY question, after listing options, you MUST add:
              正確答案：...
              題後解析：...
            - In 題後解析, you MUST explain why the correct answer is correct and why other options are incorrect.
            - For MCQ, 題後解析 MUST include these 5 lines in order:
              正解理由：...
              A) ...
              B) ...
              C) ...
              D) ...
            - NEVER output empty bullets/options (forbidden examples: "•", "A)", "B)", "C)" alone on a line).
            - If a section has no applicable content, write "無" explicitly instead of leaving blank lines.
            - For MCQ, every option line must contain non-empty text.
            - Reveal answer only in this post-question explanation block, not in the question title/options.
            - If you use "Merge two sentences" (Merge), you MUST show:
              A) Sentence 1
              B) Sentence 2
              C) A single blank line for the merged sentence: <T lang="${targetLangTag}">__________</T>
              Then provide the merged answer and explanation.

            **CRITICAL**: Ensure "Example Sentence" is strictly in the Target Language and uses **simple, high-frequency vocabulary** suitable for Level ${learnerLevel}.
            **TAGGING**: Wrap ALL target-language words/phrases/sentences with <T lang="${targetLangTag}">...</T> (including any non-table text). 
            **EXAMPLE ORDER**: Target-language sentence first, then Chinese translation on the next line using <small>中文翻譯</small>. ${translationInstruction} ${targetLanguageSafetyInstruction} ${targetFixInstruction}`;
        } else if (type === 'deep') {
            title = "文法詳解";
            const langPrompt = "Focus on grammar patterns and usage. Minimize literary analysis unless truly necessary for understanding.";

            specificPrompt = `TASK: ${langPrompt} 
            ${contextDisambiguationOnly}
            TARGET LANGUAGE CODE: ${trackLanguage}
            Explain *why* this phrasing is used and how to apply it.
            [FORMAT - STRICT]
            - Every section title MUST be on its own line and start with "### ".
            - Do NOT place any section title inline after a sentence.
            **SECTIONS (IN ORDER)**:
            1) ### 句型骨架 (brief structure)
            2) ### 文法知識點 (list each point separately)
               - For each point: concept, usage, common mistakes, examples
            3) ### 變化與替換 (colloquial/formal/contracted forms if any)
            4) ### 實用場景 (where this grammar is used)
            5) ### 測驗 (REQUIRED)
            6) ### 可能誤聽/錯字 (if any; 1 line only; do NOT rewrite the target sentence)

            **QUIZ RULE**:
            - Each knowledge point MUST have at least 1 question.
            - Choose the BEST question type for that knowledge point (MCQ / Fill-in / Rewrite / Error-correction / Merge).
            - Questions & options must be in Target Language only.
            - Provide short explanations in Traditional Chinese.
            - **NO SPOILERS**: Do NOT reveal the answer in the question title or labels (e.g., avoid "核心詞彙：<answer>"). Use neutral titles like "Q1 (多選題)".
            - For EVERY question, after listing options, you MUST add:
              正確答案：...
              題後解析：...
            - In 題後解析, you MUST explain why the correct answer is correct and why other options are incorrect.
            - For MCQ, 題後解析 MUST include these 5 lines in order:
              正解理由：...
              A) ...
              B) ...
              C) ...
              D) ...
            - NEVER output empty bullets/options (forbidden examples: "•", "A)", "B)", "C)" alone on a line).
            - If a section has no applicable content, write "無" explicitly instead of leaving blank lines.
            - For MCQ, every option line must contain non-empty text.
            - Reveal answer only in this post-question explanation block, not in the question title/options.
            - If you use "Merge two sentences" (Merge), you MUST show:
              A) Sentence 1
              B) Sentence 2
              C) A single blank line for the merged sentence: <T lang="${targetLangTag}">__________</T>
              Then provide the merged answer and explanation.

            **TAGGING**: Wrap ALL target-language words/phrases/sentences with <T lang="${targetLangTag}">...</T> (including any non-table text).
            **EXAMPLE ORDER**: Target-language sentence first, then Chinese translation on the next line using <small>中文翻譯</small>.
            Explain in Traditional Chinese (繁體中文). ${translationInstruction} ${targetLanguageSafetyInstruction} ${targetFixInstruction}`;
        }

        setModalTitle(title);
        // [FIX] Use targetSentenceForPrompt
        let res = "";
        let explainPinnedContent = "";
        let hasExplainPinnedPreview = false;
        const aiPrompt = systemPrompt + "\n" + targetSentenceForPrompt + "\n" + specificPrompt;
        const hasUsableApiKey = !!resolveApiKey(currentApiKey);
        if (mockMode) {
            res = `===TRANSLATION===: 測試翻譯\n\n### Mock ${title}\nTest [[Learn: Word]]`;
        } else {
            // For correction, try multimodal audio verification first, fallback to text-only.
            if (type === 'correction') {
                let usedAudio = false;
                try {
                    const sliceStart = Math.max(0, sub.start);
                    const maxLenSec = 12;
                    const sliceEnd = Math.min(sub.end, sliceStart + maxLenSec);

                    const blob = await recordAudioSliceFromPlayer(playerRef.current, sliceStart, sliceEnd, playbackRate);
                    if (blob) {
                        const b64 = await blobToBase64(blob);
                        if (b64) {
                            usedAudio = true;
                            res = await callGeminiMultimodal(aiPrompt, b64, currentApiKey);
                        }
                    }
                } catch (e) {
                    console.warn('Audio capture or multimodal call failed, fallback to text-only:', e);
                }

                if (!usedAudio || !res) {
                    res = await callGeminiText(aiPrompt, currentApiKey);
                }
            } else {
                if (type === 'explain') {
                    // Default single-pass for stability/readability.
                    const pass1 = await callGeminiText(aiPrompt, currentApiKey);
                    res = pass1;

                    const pass1Usable = String(pass1 || '').trim() && !isLikelyBridgeAckText(pass1) && !isLikelyBridgeFailureText(pass1);
                    if (EXPLAIN_ENABLE_SECOND_PASS && pass1Usable) {
                        const pass1Parsed = processAIResponse(pass1);
                        const pass1Content = String(pass1Parsed?.content || '').trim();
                        if (pass1Content) {
                            setModalContent(`${pass1Content}

---
（第二輪精煉中…）`);
                        } else {
                            setModalContent('（第一輪完成，第二輪精煉中…）');
                        }

                        const refinePrompt = `${systemPrompt}
${targetSentenceForPrompt}
TASK: Refine the previous answer into a higher-quality final version.
${buildPromptTableFormat(trackLanguage)}
${explainStructureMarkerInstruction}
[REFINE RULES]
- Keep all required sections in order.
- Fix malformed lines, duplicated text, and broken paragraph/table formatting.
- Keep content faithful to the target sentence/context; do not invent facts.
- Keep examples natural and learner-level appropriate.
- Output final polished answer only.

[FIRST_PASS_OUTPUT_START]
${String(pass1 || '').slice(0, 26000)}
[FIRST_PASS_OUTPUT_END]
${translationInstruction}
${targetLanguageSafetyInstruction}
${targetFixInstruction}`;

                        const pass2 = await callGeminiText(refinePrompt, currentApiKey);
                        const pass2Usable = String(pass2 || '').trim() && !isLikelyBridgeAckText(pass2) && !isLikelyBridgeFailureText(pass2);
                        if (pass2Usable) {
                            res = pass2;
                        }
                    }
                } else {
                    res = await callGeminiText(aiPrompt, currentApiKey);
                }
            }
        }

        const { content, translation, targetFix, targetFixConfidence } = processAIResponse(res);
        const finalDisplayContent = (
            type === 'explain' && hasExplainPinnedPreview
        )
            ? mergeStableExplainContent(explainPinnedContent, content)
            : content;
        setModalContent(finalDisplayContent);

        // Update Global Translation Cache
        if (translation) {
            setTranslationCache(prev => ({ ...prev, [transCacheKey]: translation }));
            setTargetTranslation(translation);
        }
        if (type === 'correction') {
            const fallbackFix = targetFix || extractCorrectionSentenceFromContent(content);
            if (fallbackFix && shouldAcceptTargetFix(smartSentence, fallbackFix, targetFixConfidence)) {
                setTargetFixCache(prev => ({ ...prev, [transCacheKey]: fallbackFix }));
            }
        }

        if (!isLikelyBridgeAckText(res) && !isLikelyBridgeFailureText(res)) {
            setAiCache(prev => ({ ...prev, [cacheKey]: res }));
        }
        setIsLoadingAI(false);
    };

    const handleFullVocabExplain = async () => {
        if (isFullVocabLoading) return;
        const sub = subtitles[currentIndex];
        if (!sub) return;

        if (playerRef.current) {
            playerRef.current.pause();
            setIsPlaying(false);
        }

        setAiMode('text');
        setShowModal(true);
        setShowRecorder(false);
        setModalTitle("單字用語（全字彙）");

        const transCacheKey = `${currentTrackIndex}-${currentIndex}`;
        const cacheKey = `${currentTrackIndex}-${currentIndex}-explain-full-${learnerLevel}-v${AI_NOTES_CACHE_SCHEMA_VERSION}`;
        const targetFixKey = `${currentTrackIndex}-${currentIndex}`;
        const effectiveTargetSentence = stripStrike(normalizeTargetSentence(targetFixCache[targetFixKey] || sub.text));
        const contextStr = subtitles
            .slice(Math.max(0, currentIndex - 2), Math.min(subtitles.length, currentIndex + 3))
            .map(s => s.text)
            .join('\n');

        if (aiCache[cacheKey]) {
            const parsed = processAIResponse(aiCache[cacheKey]);
            setModalContent(parsed.content || "");
            if (parsed.translation && !translationCache[transCacheKey]) {
                setTranslationCache(prev => ({ ...prev, [transCacheKey]: parsed.translation }));
                setTargetTranslation(parsed.translation);
            }
            return;
        }

        const terms = extractFullVocabularyTerms(effectiveTargetSentence, trackLanguage);
        if (terms.length === 0) {
            alert("找不到可解析的字彙。請確認目前字幕內容。");
            return;
        }

        const chunks = chunkArray(terms, 10);
        setIsFullVocabLoading(true);
        setIsLoadingAI(true);
        setFullVocabProgress({ done: 0, total: chunks.length });
        setModalContent(`### 全字彙模式\n\n目標詞數：${terms.length}\n批次數：${chunks.length}\n\n準備開始分批解析...`);

        let translation = translationCache[transCacheKey] || "";
        const systemPrompt = SYSTEM_PROMPT_CORE(learnerLevel);
        const tablePrompt = buildPromptTableFormat(trackLanguage);
        const combinedParts = [
            `### 全字彙模式`,
            `目標詞數：${terms.length}（共 ${chunks.length} 批）`,
            `\nTARGET SENTENCE: ${effectiveTargetSentence}`,
            `TARGET LANGUAGE CODE: ${trackLanguage}`
        ];

        try {
            if (!translation) {
                const translationPrompt = `${systemPrompt}
                [TASK]
                Translate TARGET SENTENCE into Traditional Chinese only.
                Output exactly one line in this format:
                ===TRANSLATION===: ...
                Do NOT rewrite TARGET SENTENCE into any other non-Chinese language.
                TARGET LANGUAGE CODE: ${trackLanguage}

                TARGET SENTENCE:
                "${effectiveTargetSentence}"`;
                const transRes = await callGeminiText(translationPrompt, currentApiKey);
                const parsedTrans = processAIResponse(transRes);
                translation = (parsedTrans.translation || parsedTrans.content || "").trim();
                if (translation) {
                    setTranslationCache(prev => ({ ...prev, [transCacheKey]: translation }));
                    setTargetTranslation(translation);
                }
            } else {
                setTargetTranslation(translation);
            }

            for (let i = 0; i < chunks.length; i++) {
                const batch = chunks[i];
                const numberedList = batch.map((t, idx) => `${idx + 1}. <T lang="${String(trackLanguage || 'target').trim() || 'target'}">${t}</T>`).join('\n');
                const batchPrompt = `${systemPrompt}
                ${tablePrompt}
                [FULL VOCAB MODE - STRICT]
                You MUST explain every term in TERM LIST exactly once.
                - Do NOT skip any term.
                - Do NOT add terms outside TERM LIST.
                - Keep examples short and level-appropriate.
                - No quiz in this mode.
                - Do NOT rewrite TARGET SENTENCE into another non-Chinese language.
                - TARGET LANGUAGE CODE: ${trackLanguage}

                [OUTPUT SECTIONS]
                1) ### 批次 ${i + 1}/${chunks.length}
                2) ### 核心詞彙表 (MUST include all terms in this batch)
                3) ### 重點補充 (max 3 lines, Traditional Chinese)

                [TARGET SENTENCE]
                "${effectiveTargetSentence}"

                [CONTEXT]
                ${contextStr}

                [TERM LIST]
                ${numberedList}`;

                try {
                    const res = await callGeminiText(batchPrompt, currentApiKey);
                    const parsed = processAIResponse(res);
                    const batchContent = (parsed.content || res || "").trim();
                    combinedParts.push(batchContent || `### 批次 ${i + 1}/${chunks.length}\n(此批次無回應)`);
                } catch (_) {
                    combinedParts.push(`### 批次 ${i + 1}/${chunks.length}\n(此批次生成失敗，請稍後重試)`);
                }

                setFullVocabProgress({ done: i + 1, total: chunks.length });
                setModalContent(combinedParts.join('\n\n---\n\n'));
            }

            const finalContent = combinedParts.join('\n\n---\n\n');
            const rawCache = translation
                ? `===TRANSLATION===: ${translation}\n\n${finalContent}`
                : finalContent;
            setAiCache(prev => ({ ...prev, [cacheKey]: rawCache }));
        } finally {
            setIsLoadingAI(false);
            setIsFullVocabLoading(false);
        }
    };

    // [FIX] New UX-Optimized Handler
    const handleDeepDiveFollowUp = async () => {
        if (!deepDiveInput.trim()) return;
        const userQ = deepDiveInput;
        setDeepDiveInput("");

        // Don't show full loading screen if we already have content
        const isFollowUp = modalContent.length > 0;
        if (!isFollowUp) setIsLoadingAI(true);
        else setIsLoadingAI(true); // Still set true to show small spinner

        // Inject Styled HTML Question Box
        const safeUserQ = escapeHtml(String(userQ || "").trim());
        const questionHtml = `<div class="question-box" data-question="${safeUserQ}"><div class="question-label">User Question</div><div class="question-text">${safeUserQ}</div></div>`;

        // Append question immediately
        const newContent = modalContent + `\n\n${questionHtml}\n\n**AI:** ...`;
        setModalContent(newContent);

        // Auto-scroll to bottom to show question
        setTimeout(() => {
            if (modalScrollRef.current) modalScrollRef.current.scrollTo({ top: modalScrollRef.current.scrollHeight, behavior: 'smooth' });
        }, 100);

        const sub = subtitles[currentIndex];
        const targetFixKey = `${currentTrackIndex}-${currentIndex}`;
        const effectiveTargetSentence = stripStrike(normalizeTargetSentence(targetFixCache[targetFixKey] || sub.text));
        const contextStr = subtitles.slice(Math.max(0, currentIndex - 2), Math.min(subtitles.length, currentIndex + 3)).map(s => s.text).join('\n');
        const deepDiveTargetSafety = `
        [TARGET LANGUAGE SAFETY]
        TARGET LANGUAGE CODE: ${trackLanguage}
        - TARGET LANGUAGE CODE is metadata only.
        - Keep TARGET SENTENCE wording/script as-is.
        - Do NOT rewrite TARGET SENTENCE into another non-Chinese language.
        `;

        const systemPrompt = SYSTEM_PROMPT_CORE(learnerLevel);
        const prompt = `${systemPrompt}
        
        --- CONTEXT ---
        ${contextStr}
        
        --- TARGET SENTENCE ---
        "${effectiveTargetSentence}"
        
        --- PREVIOUS ANALYSIS ---
        ${modalContent}
        
        --- USER QUESTION ---
        ${userQ}
        
        ${deepDiveTargetSafety}

        INSTRUCTION: Answer the user's question in Traditional Chinese. Be concise and helpful.`;

        try {
            const res = await callGeminiText(prompt, currentApiKey);
            // Replace placeholder with actual response
            // Note: We used "**AI:** ..." as placeholder
            const finalContent = newContent.replace("**AI:** ...", `**AI:**\n${res}`);

            setModalContent(finalContent);

            // [FIX] Update Cache with full new content
            let type = 'deep';
            if (modalTitle.includes("字幕校正")) type = 'correction';
            if (modalTitle.includes("單字用語")) type = 'explain';

            const cacheKey = `${currentTrackIndex}-${currentIndex}-${type}-${learnerLevel}-v${AI_NOTES_CACHE_SCHEMA_VERSION}`;
            const fullContentToCache = `===TRANSLATION===: ${targetTranslation}\n\n${finalContent}`;
            setAiCache(prev => ({ ...prev, [cacheKey]: fullContentToCache }));

            // Scroll to bottom again to show answer
            setTimeout(() => {
                if (modalScrollRef.current) modalScrollRef.current.scrollTo({ top: modalScrollRef.current.scrollHeight, behavior: 'smooth' });
            }, 100);

        } catch (e) {
            console.error(e);
            setModalContent(newContent.replace("...", "(Error generating response)"));
        } finally {
            setIsLoadingAI(false);
        }
    };

    const parseAiJsonPayload = useCallback(async (raw, { arrayField = "", schemaHint = "" } = {}) => {
        const rawText = String(raw || "").trim();
        if (!rawText) throw new Error("AI 回傳空白");
        if (/^Error:/i.test(rawText) || isLikelyBridgeFailureText(rawText)) {
            throw new Error(/^Error:/i.test(rawText) ? rawText : `Error: ${rawText}`);
        }

        try {
            return extractJsonObjectFromText(rawText, { arrayField });
        } catch (firstErr) {
            const compactRaw = rawText.slice(0, 12000);
            const repairPrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
你是 JSON 修復器。請把以下內容修復為「可被 JSON.parse 解析」的合法 JSON。
不可新增任意內容，不可刪除關鍵欄位，只能做語法修復與格式清理。

[OUTPUT RULE]
- 只輸出 JSON，禁止 markdown、禁止多餘文字。
- 若根節點是陣列，請包成物件：
  {"${arrayField || 'data'}": [ ... ]}
${schemaHint ? `- 盡量符合此資料結構提示：${schemaHint}` : ''}

[BROKEN INPUT]
${compactRaw}`;

            const repairedRaw = await callGeminiText(repairPrompt, currentApiKey);
            const repairedText = String(repairedRaw || "").trim();
            if (!repairedText || /^Error:/i.test(repairedText)) {
                throw new Error(firstErr?.message || "AI response is not valid JSON object");
            }
            return extractJsonObjectFromText(repairedText, { arrayField });
        }
    }, [currentApiKey, learnerLevel]);

    const normalizeQuizQuestions = useCallback((items) => {
        const tryParseJsonArray = (text) => {
            if (typeof text !== 'string') return null;
            const t = text.trim();
            if (!t) return null;
            try {
                const parsed = JSON.parse(t);
                return Array.isArray(parsed) ? parsed : null;
            } catch (_) {
                return null;
            }
        };

        const pickQuestionArray = (input) => {
            if (Array.isArray(input)) return input;
            if (typeof input === 'string') {
                const parsed = tryParseJsonArray(input);
                if (parsed) return parsed;
            }
            if (!input || typeof input !== 'object') return [];
            if (
                (input.question || input.stem || input.prompt || input.title)
            ) {
                return [input];
            }

            const directKeys = [
                'questions', 'items', 'data', 'quiz', 'quizItems', 'questionList',
                'question_list', 'questionBank', 'question_bank', 'results', 'output'
            ];
            for (const key of directKeys) {
                if (Array.isArray(input[key])) return input[key];
                const parsed = tryParseJsonArray(input[key]);
                if (parsed) return parsed;
            }

            const nestedKeys = ['result', 'payload', 'response', 'data', 'output'];
            for (const key of nestedKeys) {
                const nested = input[key];
                if (!nested || typeof nested !== 'object') continue;
                for (const candidate of directKeys) {
                    if (Array.isArray(nested[candidate])) return nested[candidate];
                }
                if (Array.isArray(nested)) return nested;
            }

            const seen = new Set();
            const queue = [input];
            const arrays = [];
            while (queue.length > 0) {
                const cur = queue.shift();
                if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
                seen.add(cur);
                for (const value of Object.values(cur)) {
                    if (Array.isArray(value)) arrays.push(value);
                    else if (value && typeof value === 'object') queue.push(value);
                }
            }
            const scored = arrays
                .map(arr => {
                    const sample = arr[0];
                    const score = sample && typeof sample === 'object'
                        ? (
                            (sample.question ? 3 : 0) +
                            (sample.stem ? 3 : 0) +
                            (sample.options ? 3 : 0) +
                            (sample.answerIndex !== undefined ? 2 : 0) +
                            (sample.answer !== undefined ? 1 : 0)
                        )
                        : 0;
                    return { arr, score };
                })
                .sort((a, b) => (b.score - a.score) || (b.arr.length - a.arr.length));
            return scored[0]?.arr || [];
        };

        const parseInlineOptionsFromStem = (text) => {
            const lines = String(text || "").split(/\n+/).map(x => x.trim()).filter(Boolean);
            if (lines.length < 3) return { stem: cleanQuizDisplayText(String(text || "")), options: [] };
            const optionLines = [];
            const stemLines = [];
            for (const line of lines) {
                if (/^[A-Da-d][\s).:：、．-]+\s*/.test(line) || /^\(?[1-4]\)?[\s).:：、．-]+\s*/.test(line)) optionLines.push(line);
                else stemLines.push(line);
            }
            if (optionLines.length < 2) return { stem: cleanQuizDisplayText(String(text || "")), options: [] };
            const normalizedOptions = optionLines
                .map(line => cleanQuizDisplayText(line.replace(/^[A-Da-d][\s).:：、．-]+\s*/, '').replace(/^\(?[1-4]\)?[\s).:：、．-]+\s*/, '')))
                .filter(Boolean);
            return {
                stem: cleanQuizDisplayText(stemLines.join(' ') || String(text || "")),
                options: normalizedOptions
            };
        };

        const parseOptionsFromObject = (obj) => {
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
            const alphaOrder = ['A', 'B', 'C', 'D'];
            const hasAlpha = alphaOrder.some(k => obj[k] !== undefined || obj[k.toLowerCase()] !== undefined);
            if (hasAlpha) {
                return alphaOrder
                    .map(k => obj[k] ?? obj[k.toLowerCase()])
                    .map(v => cleanQuizDisplayText(String(v ?? "")))
                    .filter(Boolean);
            }
            const entries = Object.entries(obj).map(([k, v]) => {
                const key = String(k || "").trim();
                let order = Number.MAX_SAFE_INTEGER;
                if (/^[A-D]$/i.test(key)) order = key.toUpperCase().charCodeAt(0) - 65;
                else if (/^\d+$/.test(key)) {
                    const n = parseInt(key, 10);
                    if (n >= 0 && n <= 10) order = n;
                }
                return { order, value: v };
            }).sort((a, b) => a.order - b.order);
            return entries
                .map(e => e.value)
                .map(v => {
                    if (v && typeof v === 'object') {
                        const cand = v.text ?? v.option ?? v.value ?? v.content ?? v.label ?? v.choice ?? "";
                        return cleanQuizDisplayText(String(cand || ""));
                    }
                    return cleanQuizDisplayText(String(v || ""));
                })
                .filter(Boolean);
        };

        const parseOptionsFromText = (rawText) => {
            const txt = String(rawText || "").trim();
            if (!txt) return [];
            const lines = txt.split(/\n+/).map(x => x.trim()).filter(Boolean);
            const optionLike = lines
                .map(line => {
                    if (/^[A-Da-d][\s).:：、．-]+\s*/.test(line)) return line.replace(/^[A-Da-d][\s).:：、．-]+\s*/, '');
                    if (/^\(?[1-4]\)?[\s).:：、．-]+\s*/.test(line)) return line.replace(/^\(?[1-4]\)?[\s).:：、．-]+\s*/, '');
                    return "";
                })
                .map(x => cleanQuizDisplayText(x))
                .filter(Boolean);
            if (optionLike.length >= 2) return optionLike;
            return txt
                .split(/(?:\s*[;；｜|]\s*)/)
                .map(x => cleanQuizDisplayText(x))
                .filter(Boolean);
        };

        const parseQuestionOptions = (q, inlineOptions = []) => {
            const raw = q?.options ?? q?.choices ?? q?.optionList ?? q?.option_list ?? q?.answerOptions ?? q?.answer_options ?? q?.alternatives;
            let options = [];
            if (Array.isArray(raw)) {
                options = raw
                    .map(v => {
                        if (v && typeof v === 'object') {
                            const cand = v.text ?? v.option ?? v.value ?? v.content ?? v.label ?? v.choice ?? v.answer ?? "";
                            return cleanQuizDisplayText(String(cand || ""));
                        }
                        return cleanQuizDisplayText(String(v || ""));
                    })
                    .filter(Boolean);
            } else if (raw && typeof raw === 'object') {
                options = parseOptionsFromObject(raw);
            } else if (typeof raw === 'string') {
                options = parseOptionsFromText(raw);
            }

            if (options.length < 2) {
                const fieldOptions = [
                    q?.A, q?.B, q?.C, q?.D,
                    q?.a, q?.b, q?.c, q?.d,
                    q?.optionA, q?.optionB, q?.optionC, q?.optionD,
                    q?.option_a, q?.option_b, q?.option_c, q?.option_d,
                    q?.choiceA, q?.choiceB, q?.choiceC, q?.choiceD
                ].map(v => cleanQuizDisplayText(String(v || ""))).filter(Boolean);
                if (fieldOptions.length >= 2) options = fieldOptions;
            }

            if (options.length < 2) {
                const answerText = cleanQuizDisplayText(String(
                    q?.answerText ??
                    q?.correctOption ??
                    q?.correct_option ??
                    q?.correctAnswer ??
                    q?.correct_answer ??
                    q?.correct ??
                    ""
                ));
                const distractorsRaw =
                    q?.distractors ??
                    q?.incorrectOptions ??
                    q?.incorrect_options ??
                    q?.wrongOptions ??
                    q?.wrong_options ??
                    q?.others;
                const distractors = Array.isArray(distractorsRaw)
                    ? distractorsRaw.map(v => cleanQuizDisplayText(String(v || ""))).filter(Boolean)
                    : [];
                const merged = [answerText, ...distractors].filter(Boolean);
                if (merged.length >= 2) options = merged.slice(0, 4);
            }

            if (options.length < 2 && inlineOptions.length >= 2) options = inlineOptions;
            return options;
        };

        const parseAnswerIndex = (q, safeOptions) => {
            let answerIndex = Number.isInteger(q?.answerIndex) ? q.answerIndex : -1;
            if (answerIndex >= 0 && answerIndex < safeOptions.length) return answerIndex;
            if (typeof q?.answerIndex === 'string') {
                const answerIndexRaw = q.answerIndex.trim();
                const byLetter = answerIndexRaw.match(/^([A-D])(?:[\s).:：、．-].*)?$/i);
                if (byLetter) {
                    const idx = byLetter[1].toUpperCase().charCodeAt(0) - 65;
                    if (idx >= 0 && idx < safeOptions.length) return idx;
                }
                if (/^\d+$/.test(answerIndexRaw)) {
                    const n = parseInt(answerIndexRaw, 10);
                    if (n >= 0 && n < safeOptions.length) return n;
                    if (n >= 1 && n <= safeOptions.length) return n - 1;
                }
            }
            if (Number.isInteger(q?.correctIndex) && q.correctIndex >= 0 && q.correctIndex < safeOptions.length) {
                return q.correctIndex;
            }
            if (typeof q?.correctIndex === 'string' && /^\d+$/.test(q.correctIndex.trim())) {
                const n = parseInt(q.correctIndex.trim(), 10);
                if (n >= 0 && n < safeOptions.length) return n;
                if (n >= 1 && n <= safeOptions.length) return n - 1;
            }

            const answerCandidate =
                q?.answer ??
                q?.answerText ??
                q?.correctOption ??
                q?.correct_option ??
                q?.correctAnswer ??
                q?.correct_answer ??
                q?.correct ??
                q?.solution ??
                q?.key ??
                "";
            const answerRaw = cleanQuizDisplayText(String(
                answerCandidate && typeof answerCandidate === 'object'
                    ? (answerCandidate.text ?? answerCandidate.label ?? answerCandidate.value ?? answerCandidate.key ?? "")
                    : answerCandidate
            ));
            if (!answerRaw) return -1;

            const letterMatch = answerRaw.match(/^([A-D])(?:[\s).:：、．-].*)?$/i);
            if (letterMatch) {
                const idx = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
                if (idx >= 0 && idx < safeOptions.length) return idx;
            }

            const numberMatch = answerRaw.match(/^(\d+)$/);
            if (numberMatch) {
                const n = parseInt(numberMatch[1], 10);
                if (n >= 0 && n < safeOptions.length) return n;
                if (n >= 1 && n <= safeOptions.length) return n - 1;
            }

            const byExact = safeOptions.findIndex(opt => opt.toLowerCase() === answerRaw.toLowerCase());
            if (byExact !== -1) return byExact;

            const byContains = safeOptions.findIndex(opt => answerRaw.toLowerCase().includes(opt.toLowerCase()));
            if (byContains !== -1) return byContains;

            const rawRationales =
                q?.optionExplanations ??
                q?.optionRationales ??
                q?.option_explanations ??
                q?.option_rationales ??
                q?.optionReasons ??
                q?.option_reasons;
            const normalizedRationales = normalizeOptionRationales(rawRationales, safeOptions.length);
            const positiveHintIdx = [];
            for (let i = 0; i < normalizedRationales.length; i++) {
                const text = String(normalizedRationales[i] || "");
                if (!text) continue;
                const hasPositive = /(正確|正解|唯一|correct|best answer|grammatically correct|semantically correct)/i.test(text);
                const hasNegative = /(不正確|錯誤|incorrect|wrong|not correct|不自然)/i.test(text);
                if (hasPositive && !hasNegative) positiveHintIdx.push(i);
            }
            if (positiveHintIdx.length === 1) return positiveHintIdx[0];

            return -1;
        };

        const sourceItems = pickQuestionArray(items);
        if (!Array.isArray(sourceItems)) return [];
        const normalized = [];
        for (let i = 0; i < sourceItems.length; i++) {
            const rawItem = sourceItems[i];
            let q = rawItem || {};
            if (typeof rawItem === 'string') {
                try {
                    const parsed = JSON.parse(rawItem);
                    if (parsed && typeof parsed === 'object') q = parsed;
                    else q = { question: rawItem };
                } catch (_) {
                    q = { question: rawItem };
                }
            }
            const parsedStem = parseInlineOptionsFromStem(String(q.question || q.stem || q.prompt || q.title || ""));
            let stem = parsedStem.stem;
            if (!stem) {
                stem = cleanQuizDisplayText(String(
                    q.knowledgePoint ||
                    q.knowledge_point ||
                    q.topic ||
                    q.label ||
                    q.title ||
                    q.prompt ||
                    ""
                ));
            }
            if (!stem) stem = `Question ${i + 1}`;

            let options = parseQuestionOptions(q, parsedStem.options);
            const uniqueOptions = [];
            const seenOptions = new Set();
            for (const opt of options) {
                const key = opt.toLowerCase();
                if (seenOptions.has(key)) continue;
                seenOptions.add(key);
                uniqueOptions.push(opt);
            }
            if (uniqueOptions.length < 4) continue;
            const safeOptions = uniqueOptions.slice(0, 4);

            let answerIndex = parseAnswerIndex(q, safeOptions);
            if (answerIndex < 0 || answerIndex >= safeOptions.length) continue;

            const type = String(q.type || 'mcq').trim().toLowerCase();
            const knowledgePoint = cleanQuizDisplayText(String(
                q.knowledgePoint ||
                q.knowledge_point ||
                q.topic ||
                q.label ||
                "綜合"
            ));
            const knowledgePointLabel = normalizeKnowledgePointLabel(knowledgePoint, type || "綜合");
            const knowledgePointId = cleanQuizDisplayText(String(
                q.knowledgePointId ||
                q.knowledge_point_id ||
                q.kpId ||
                q.kp_id ||
                ""
            )).toUpperCase();
            const knowledgeCategory = normalizeQuizKnowledgeCategory(
                q.knowledgeCategory ||
                q.knowledge_category ||
                q.category ||
                type ||
                knowledgePoint
            );
            const questionZh = cleanQuizDisplayText(String(
                q.questionZh ||
                q.question_zh ||
                q.questionTranslationZh ||
                q.question_translation_zh ||
                q.questionTranslation ||
                q.question_translation ||
                ""
            ));
            const rawOptionRationales =
                q.optionExplanations ??
                q.optionRationales ??
                q.option_explanations ??
                q.option_rationales ??
                q.optionReasons ??
                q.option_reasons;
            const parsedRationales = normalizeOptionRationales(rawOptionRationales, safeOptions.length);
            const optionRationales = safeOptions.map((_, idx) => {
                if (parsedRationales[idx]) return sanitizeSingleAnswerReason(parsedRationales[idx]);
                return idx === answerIndex
                    ? "此選項符合本題句意與語法。"
                    : "此選項不符合本題句意或語法。";
            });
            normalized.push({
                id: String(q.id || `Q${i + 1}`),
                type,
                stem,
                questionZh,
                options: safeOptions,
                answerIndex,
                answerText: safeOptions[answerIndex],
                explanation: sanitizeSingleAnswerReason(String(q.explanation || q.reason || "")),
                wrongDetail: sanitizeSingleAnswerReason(String(q.wrongDetail || q.detailedExplanation || q.whyWrong || q.explanation || "")),
                reviewHint: cleanQuizDisplayText(String(q.reviewHint || q.review_hint || "")),
                knowledgePoint,
                knowledgePointLabel,
                knowledgePointId,
                knowledgeCategory,
                optionRationales,
                isReview: !!q.isReview
            });
            if (normalized.length >= 10) break;
        }
        return normalized;
    }, []);

    const randomizeQuestionOptionOrder = useCallback((question) => {
        if (!question || typeof question !== 'object') return question;
        const options = Array.isArray(question.options) ? question.options : [];
        if (options.length < 2) return question;
        const answerIndexRaw = Number.isInteger(question.answerIndex) ? question.answerIndex : -1;
        if (
            question.optionsShuffled === true &&
            answerIndexRaw >= 0 &&
            answerIndexRaw < options.length
        ) {
            return question;
        }
        const mapped = options.map((opt, idx) => ({
            opt,
            idx,
            rationale: Array.isArray(question.optionRationales) ? question.optionRationales[idx] : ""
        }));
        const shuffled = shuffleArray(mapped);
        const nextAnswerIndex = shuffled.findIndex(item => item.idx === answerIndexRaw);
        const safeAnswerIndex = nextAnswerIndex === -1 ? 0 : nextAnswerIndex;
        return {
            ...question,
            options: shuffled.map(item => item.opt),
            answerIndex: safeAnswerIndex,
            answerText: shuffled[safeAnswerIndex]?.opt || question.answerText || "",
            optionRationales: shuffled.map((item, idx) => sanitizeSingleAnswerReason(String(
                item.rationale || (
                    idx === safeAnswerIndex
                        ? "此選項符合本題句意與語法。"
                        : "此選項不符合本題句意或語法。"
                )
            ))),
            optionsShuffled: true
        };
    }, []);

    const randomizeQuestionBatchOptions = useCallback((questions) => {
        if (!Array.isArray(questions)) return [];
        return questions.map(q => randomizeQuestionOptionOrder(q));
    }, [randomizeQuestionOptionOrder]);

    const generateSimpleQuizFromLrc = useCallback(async ({ sourceText = "", quizTargetLanguage = "en-US", sourceKind = "lrc", requiredCount = 10, minRequiredCount = 10, onPartialQuestions = null } = {}) => {
        const safeSource = String(sourceText || "").trim();
        if (!safeSource) throw new Error("出題來源內容為空，無法出題。");
        const targetCount = Math.max(1, Math.min(10, parseInt(requiredCount, 10) || 10));
        const minRequired = Math.max(1, Math.min(targetCount, parseInt(minRequiredCount, 10) || targetCount));
        const isKnowledgeSource = sourceKind === "knowledge" || /LRC\s*知識點整理|===\s*(單字|用語|文法|句型|閱讀|聽力)/.test(safeSource);
        const sourceLabel = isKnowledgeSource ? "knowledge" : "lrc";
        const sourceHeading = isKnowledgeSource ? "KNOWLEDGE_TXT" : "LRC";

        const isJaTrack = /^ja/i.test(quizTargetLanguage || "");
        const isCjkTrack = /^(zh|ja|ko)/i.test(quizTargetLanguage || "");
        const diagnostics = { main: 0, mainText: 0, rescue: 0, rescueText: 0, improve: 0, last: 0 };
        const rawSnippets = { main: "", rescue: "", improve: "", last: "" };
        const TRACE_SIMPLE_QUIZ = true;
        const rawPreview = (text, max = 420) => String(text || "").replace(/\r/g, "").replace(/\n/g, "\\n").slice(0, max);
        const rejectStats = {};
        const rejectSamples = {};
        const markRejected = (reason, q) => {
            rejectStats[reason] = (rejectStats[reason] || 0) + 1;
            if (!rejectSamples[reason]) {
                rejectSamples[reason] = rawPreview(
                    JSON.stringify({
                        stem: q?.stem || q?.question || "",
                        options: Array.isArray(q?.options) ? q.options : [],
                        answerIndex: q?.answerIndex
                    }),
                    220
                );
            }
        };
        const traceSimpleQuiz = (step, data = {}) => {
            if (!TRACE_SIMPLE_QUIZ) return;
            try {
                let text = "";
                if (typeof data === "string") text = data;
                else {
                    try { text = JSON.stringify(data); } catch (_) { text = String(data); }
                }
                console.log(`[LRC_QUIZ_TRACE] ${step} ${String(text || "").slice(0, 1200)}`);
            } catch (_) { }
        };
        let lastPartialCount = 0;
        const emitPartial = (list, step = "") => {
            if (typeof onPartialQuestions !== 'function') return;
            const partial = Array.isArray(list)
                ? randomizeQuestionBatchOptions(list.slice(0, 10))
                : [];
            if (partial.length <= 0) return;
            if (partial.length === lastPartialCount) return;
            lastPartialCount = partial.length;
            try { onPartialQuestions(partial, step); } catch (_) { }
        };
        const isFatalAuth401 = (text) => /(?:^|\b)Error:\s*Text Gen API Error 401\b/i.test(String(text || ""));

        traceSimpleQuiz("start", {
            sourceChars: safeSource.length,
            sourceLines: safeSource.split('\n').length,
            sourceKind: sourceLabel,
            quizTargetLanguage,
            isJaTrack,
            isCjkTrack
        });

        const simpleCompactText = (text, maxChars = 10000) => {
            let s = String(text || "").replace(/\r/g, "").trim();
            if (s.length <= maxChars) return s;
            const lines = s.split('\n').map(x => x.trim()).filter(Boolean);
            const head = lines.slice(0, 180);
            const tail = lines.slice(-80);
            const merged = [...head, ...tail].join('\n');
            return (merged.length > maxChars ? merged.slice(0, maxChars) : merged) + "\n...(truncated)";
        };

        const hasJa = (text) => /[\u3040-\u30ff\u3400-\u9fff]/.test(String(text || ""));
        const hasPlaceholderToken = (text) => {
            const t = cleanQuizDisplayText(String(text || "")).toLowerCase();
            if (!t) return true;
            return (
                /^choice[_\s-]*\d+$/.test(t) ||
                /^option\s*[a-d]$/.test(t) ||
                /^選項\s*[a-d]$/.test(t) ||
                /^choice$/.test(t) ||
                /^option$/.test(t) ||
                /\bimc\b/i.test(t) ||
                (/__+/.test(t) && t.length < 5) ||
                (isJaTrack && /^[a-z0-9_ -]+$/i.test(t))
            );
        };
        const isUnusableStem = (text) => {
            const raw = cleanQuizDisplayText(String(text || ""));
            if (!raw) return true;
            const core = raw.replace(/[_＿\-\s—―•….,!?！？()（）「」『』【】\[\]{}<>]/g, '');
            if (core.length < 4) return true;
            if (/^[_＿\-\s—―•….,!?！？()（）「」『』【】\[\]{}<>]+$/.test(raw)) return true;
            return false;
        };
        const toSemanticKey = (text) => cleanQuizDisplayText(String(text || ""))
            .toLowerCase()
            .replace(/[^0-9a-z\u00c0-\u024f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, '');
        const hasBlankMarker = (text) => /_{2,}|＿{2,}|（\s*[_＿?？]+\s*）|\(\s*[_＿?？]+\s*\)|\[\s*[_＿?？]+\s*\]/.test(String(text || ""));
        const isLikelyCategoryQuestion = (text) => {
            const t = cleanQuizDisplayText(String(text || ""));
            return (
                /(何者|哪個|哪一個|哪一項|下列何者|下列哪個|次のうち|どれ|どの|which\s+(one|item|option)|what\s+is|what\s+are)/i.test(t) &&
                /(是|屬於|当てはまる|belongs?\s+to|category|type|kind|group)/i.test(t)
            );
        };
        const hasSufficientContext = (text) => {
            const stem = cleanQuizDisplayText(String(text || ""));
            if (!stem) return false;
            const core = stem.replace(/[_＿]/g, '').trim();
            if (!core) return false;
            if (isJaTrack) {
                const jaTokens = core.match(/[ぁ-ゖァ-ヺー々〆〤一-龯]{2,}/g) || [];
                const hasParticle = /[はがをにでとのへも]/.test(core);
                const hasPredicate = /(です|ます|だ|だった|でした|ますか|ですか|してください|しなさい)/.test(core);
                const cloze = hasBlankMarker(stem);
                if (cloze) {
                    if (core.length < 4) return false;
                    if (jaTokens.length < 1) return false;
                    if (!hasParticle && !hasPredicate) return false;
                    return true;
                }
                if (core.length < 6) return false;
                if (jaTokens.length < 1) return false;
                if (!hasParticle && !hasPredicate) return false;
                return true;
            }
            if (isCjkTrack) {
                const cjkChars = (core.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
                return cjkChars >= 6 || core.length >= 10;
            }
            const words = core.split(/\s+/).filter(Boolean);
            if (words.length >= 5) return true;
            return core.length >= 18;
        };
        const hasPassageDependency = (text) => /(根據|依據|按照).{0,6}(課文|本文|上文|本課|本篇|lrc)|\b(in|from)\s+(this|the)\s+(text|passage|lrc)\b|according to (the )?(text|passage|lrc)/i.test(String(text || ""));
        const hasNearDuplicateOptions = (options) => {
            const keys = (options || []).map(toSemanticKey);
            for (let i = 0; i < keys.length; i++) {
                for (let j = i + 1; j < keys.length; j++) {
                    const a = keys[i];
                    const b = keys[j];
                    if (!a || !b) continue;
                    if (a === b) return true;
                    if (!isCjkTrack && a.length >= 3 && b.length >= 3) {
                        const shorter = a.length <= b.length ? a : b;
                        const longer = a.length > b.length ? a : b;
                        if (shorter.length >= 3 && longer.includes(shorter) && Math.abs(a.length - b.length) <= 2) {
                            return true;
                        }
                    }
                }
            }
            return false;
        };
        const hasAmbiguousCategoryRisk = (stem, options) => {
            if (!isLikelyCategoryQuestion(stem)) return false;
            const cleanedOptions = (options || []).map(x => cleanQuizDisplayText(String(x || ""))).filter(Boolean);
            if (cleanedOptions.length < 4) return true;
            const shortTokens = cleanedOptions.filter(opt => {
                if (isJaTrack) return /^[ぁ-ゖァ-ヺー々〆〤一-龯]{1,8}$/.test(opt);
                const words = opt.split(/\s+/).filter(Boolean);
                return words.length <= 2 && opt.length <= 12;
            }).length;
            const suffixCount = {};
            const prefixCount = {};
            for (const opt of cleanedOptions) {
                const key = toSemanticKey(opt);
                if (!key) continue;
                const suffix = key.slice(-1);
                const prefix = key.slice(0, 1);
                suffixCount[suffix] = (suffixCount[suffix] || 0) + 1;
                prefixCount[prefix] = (prefixCount[prefix] || 0) + 1;
            }
            const maxSuffix = Math.max(0, ...Object.values(suffixCount));
            const maxPrefix = Math.max(0, ...Object.values(prefixCount));
            return shortTokens >= 3 || maxSuffix >= 3 || maxPrefix >= 3;
        };
        const hasAmbiguousTemporalClozeRisk = (stem, options) => {
            if (!hasBlankMarker(stem)) return false;
            const cleanedStem = cleanQuizDisplayText(String(stem || ""));
            const cleanedOptions = (options || []).map(x => cleanQuizDisplayText(String(x || ""))).filter(Boolean);
            if (cleanedOptions.length < 4) return false;

            const temporalReCjk = /^(每(日|天|早|晚|週|周|月|年)|每天|每日|每早|每晚|每週|每周|每月|每年|早上|清晨|上午|中午|下午|傍晚|晚上|夜晚|夜裡|有時|偶爾|常常|經常|通常|總是|從不|永不)$/;
            const temporalReLatin = /^(always|usually|often|sometimes|occasionally|rarely|seldom|never|daily|weekly|monthly|every day|every morning|every evening|every night|at night|in the morning)$/i;
            const temporalCount = cleanedOptions.filter(opt => temporalReCjk.test(opt) || temporalReLatin.test(opt)).length;
            if (temporalCount < 3) return false;

            const hasTemporalCueInStem = /(早上|清晨|上午|中午|下午|傍晚|晚上|夜晚|夜裡|每日|每天|每週|每月|always|usually|often|sometimes|never|at night|in the morning|every day|every morning|every evening|every night)/i.test(cleanedStem);
            const prefixCount = {};
            for (const opt of cleanedOptions) {
                const key = toSemanticKey(opt);
                if (!key) continue;
                const prefix = key.slice(0, 1);
                prefixCount[prefix] = (prefixCount[prefix] || 0) + 1;
            }
            const maxPrefix = Math.max(0, ...Object.values(prefixCount));
            return !hasTemporalCueInStem || maxPrefix >= 3;
        };

        const ensureQuestionDefaults = (q, idx = 0, source = "ai") => {
            const stem = cleanQuizDisplayText(String(q.stem || q.question || ""));
            const safeOptions = Array.isArray(q.options)
                ? q.options.map(x => cleanQuizDisplayText(String(x || ""))).filter(Boolean).slice(0, 4)
                : [];
            if (!stem || isUnusableStem(stem)) { markRejected("badStem", q); return null; }
            if (safeOptions.length < 4) { markRejected("optionsLt4", q); return null; }
            if (!hasSufficientContext(stem)) { markRejected("weakContext", q); return null; }
            if (hasPassageDependency(stem) || hasPassageDependency(q?.questionZh) || hasPassageDependency(q?.explanation) || hasPassageDependency(q?.wrongDetail)) {
                markRejected("passageDependent", q);
                return null;
            }
            if (hasAmbiguousCategoryRisk(stem, safeOptions)) { markRejected("ambiguousCategory", q); return null; }
            if (hasAmbiguousTemporalClozeRisk(stem, safeOptions)) { markRejected("ambiguousTemporalCloze", q); return null; }
            if (safeOptions.some(hasPlaceholderToken)) { markRejected("placeholderOption", q); return null; }
            if (hasNearDuplicateOptions(safeOptions)) { markRejected("nearDuplicateOption", q); }
            if (isJaTrack) {
                const jaCount = safeOptions.filter(hasJa).length;
                if (!hasJa(stem)) { markRejected("jaStemMissing", q); return null; }
                if (jaCount < 3) { markRejected("jaOptionsLt3", q); return null; }
            }
            const answerIndex = Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < 4 ? q.answerIndex : -1;
            if (answerIndex < 0) { markRejected("badAnswerIndex", q); return null; }
            const answerText = safeOptions[answerIndex];
            if (!hasBlankMarker(stem) && answerText) {
                const stemKey = toSemanticKey(stem);
                const answerKey = toSemanticKey(answerText);
                if (answerKey && answerKey.length >= 2 && stemKey.includes(answerKey)) {
                    markRejected("answerLeak", q);
                    return null;
                }
            }
            return {
                ...q,
                id: q.id || `SQ${idx + 1}`,
                type: q.type || "vocab",
                stem,
                options: safeOptions,
                answerIndex,
                answerText: safeOptions[answerIndex],
                questionZh: q.questionZh || "請依前後文與語法搭配，選出唯一最自然的答案。",
                explanation: q.explanation || `正解是「${safeOptions[answerIndex]}」，因為在此句語境與搭配上最自然。`,
                wrongDetail: q.wrongDetail || "其他選項雖可能相關，但在本題語境、語法或搭配上不成立。",
                reviewHint: q.reviewHint || "先找句中線索，再排除語法或語意不通的選項。",
                generationSource: source,
                optionRationales: Array.isArray(q.optionRationales) && q.optionRationales.length >= 4
                    ? q.optionRationales.slice(0, 4)
                    : safeOptions.map((opt, i) =>
                        i === answerIndex
                            ? `「${opt}」在此句語法與語意最完整。`
                            : `「${opt}」與題幹語境或搭配不符，因此不正確。`
                    )
            };
        };

        const scoreQuestionQuality = (q) => {
            const stem = cleanQuizDisplayText(String(q?.stem || ""));
            const options = Array.isArray(q?.options) ? q.options.map(x => cleanQuizDisplayText(String(x || ""))).filter(Boolean) : [];
            if (!stem || isUnusableStem(stem) || options.length < 4) return 0;
            const unique = new Set(options.map(x => x.toLowerCase())).size;
            let score = 0;
            if (stem.length >= 6) score += 2;
            if (unique >= 4) score += 2;
            if (hasSufficientContext(stem)) score += 3;
            if (!hasPlaceholderToken(stem)) score += 2;
            if (options.every(opt => !hasPlaceholderToken(opt))) score += 3;
            if (options.every(opt => opt.length >= 1 && opt.length <= 30)) score += 1;
            if (Array.isArray(q.optionRationales) && q.optionRationales.length >= 4) score += 1;
            if (!hasNearDuplicateOptions(options)) score += 2;
            if (!hasAmbiguousCategoryRisk(stem, options)) score += 2;
            if (!hasAmbiguousTemporalClozeRisk(stem, options)) score += 2;
            if (isJaTrack) {
                const jaOptCount = options.filter(hasJa).length;
                if (hasJa(stem)) score += 1;
                if (jaOptCount >= 3) score += 2;
            } else if (!isCjkTrack) {
                const cjkCount = (stem.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
                if (cjkCount === 0) score += 1;
            }
            return score;
        };

        const pickBestQuestions = (list, source = "ai", maxCount = 10) => {
            const seen = new Set();
            const prepared = (list || [])
                .map((q, idx) => ensureQuestionDefaults(q, idx, q?.generationSource || source))
                .filter(Boolean)
                .map((q, idx) => ({ q, score: scoreQuestionQuality(q), idx }))
                .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
            const out = [];
            for (const item of prepared) {
                const key = `${item.q.stem}||${item.q.options.join("||")}`.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(item.q);
                if (out.length >= maxCount) break;
            }
            return out;
        };

        const mergeQuestions = (base, incoming, source = "ai") => pickBestQuestions([...(base || []), ...(incoming || [])], source, 10);

        const tryNormalizeFromAny = (payload, source = "ai") => {
            let out = normalizeQuizQuestions(payload);
            if (out.length > 0) {
                const picked = pickBestQuestions(out, source);
                traceSimpleQuiz(`${source}.normalize`, { normalized: out.length, picked: picked.length });
                return picked;
            }
            if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                const objectValues = Object.values(payload).filter(v => v && typeof v === 'object');
                if (objectValues.length > 0) {
                    out = normalizeQuizQuestions(objectValues);
                    if (out.length > 0) {
                        const picked = pickBestQuestions(out, source);
                        traceSimpleQuiz(`${source}.normalize.objectValues`, { normalized: out.length, picked: picked.length });
                        return picked;
                    }
                }
            }
            traceSimpleQuiz(`${source}.normalize`, { normalized: 0, picked: 0 });
            return [];
        };

        const parseQuestionsFromPlainText = (rawText, source = "ai-text") => {
            const text = String(rawText || "").replace(/\r/g, "").trim();
            if (!text) return [];
            const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
            const parsed = [];
            let current = null;
            const pushCurrent = () => {
                if (!current) return;
                if (!current.question && current.stem) current.question = current.stem;
                if (Array.isArray(current.options) && current.options.length >= 2) parsed.push(current);
                current = null;
            };
            for (const line of lines) {
                if (/^(Q\s*\d+|\d+)\s*[.)、．:：-]/i.test(line)) {
                    pushCurrent();
                    current = { id: `T${parsed.length + 1}`, question: line.replace(/^(Q\s*\d+|\d+)\s*[.)、．:：-]\s*/i, ''), options: [] };
                    continue;
                }
                if (/^[A-Da-d]\s*[.)、．:：-]\s*/.test(line)) {
                    if (!current) current = { id: `T${parsed.length + 1}`, question: "", options: [] };
                    current.options.push(line.replace(/^[A-Da-d]\s*[.)、．:：-]\s*/, '').trim());
                    continue;
                }
                const ans = line.match(/^(答案|answer)\s*[:：]\s*([A-Da-d]|\d+)/i);
                if (ans && current) {
                    current.answer = ans[2];
                    continue;
                }
                if (!current) continue;
                if (!current.question) current.question = line;
            }
            pushCurrent();
            const normalized = normalizeQuizQuestions(parsed);
            const picked = pickBestQuestions(normalized, source);
            traceSimpleQuiz(`${source}.plainText`, { parsedBlocks: parsed.length, normalized: normalized.length, picked: picked.length });
            return picked;
        };

        const sourcePromptText = simpleCompactText(safeSource, 10000);
        traceSimpleQuiz(`${sourceLabel}.compacted`, {
            compactChars: sourcePromptText.length,
            compactLines: sourcePromptText.split('\n').length,
            compactPreview: rawPreview(sourcePromptText, 180)
        });
        const mainPrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
${isKnowledgeSource ? "請根據知識點 txt 內容生成 10 題四選一單選題。" : "請根據 LRC 內容直接生成 10 題四選一單選題。"}

[OUTPUT]
只輸出 JSON：
{
  "questions": [
    {
      "id": "Q1",
      "type": "vocab|collocation|grammar|pattern|context|inference|listening",
      "question": "題目（目標語言）",
      "questionZh": "題目繁中白話",
      "options": ["A","B","C","D"],
      "answerIndex": 0,
      "optionExplanations": ["A解析","B解析","C解析","D解析"],
      "explanation": "繁中詳解",
      "wrongDetail": "繁中錯因",
      "reviewHint": "繁中複習提示"
    }
  ]
}

[STRICT RULES]
- 必須輸出剛好 10 題。
- 題目與選項是目標語言（${quizTargetLanguage}）。
- 禁止占位符：choice_1 / optionA / IMC / ??? / 空字串。
- 每題只有一個正確答案，其餘三個要明確錯誤。
- 題幹必須有足夠語境線索，避免只有單字或分類問句。
- 若是填空，空格前後都要有可判斷線索，不可只有「名詞 + 空格」。
- 禁止模糊分類題（例如多個選項其實都可能正確）。
- 若一題可能有 2 個以上合理答案，必須重寫該題。
- 答案判定依一般語言知識（詞義/語法/搭配），不可用「課文中出現過」當唯一理由。
- 題目可取材課文主題，但不得要求使用者知道該課文細節才可作答。
- optionExplanations 必須逐一說明四個選項為何對/錯（繁中）。
- 不要 markdown、不要 HTML tags、不要 <T lang="TARGET">、不要 {{ }}。

[${sourceHeading}]
${sourcePromptText}`;

        let questions = [];
        let rawMain = "";
        traceSimpleQuiz("main.request", { promptChars: mainPrompt.length });
        try {
            rawMain = await callGeminiText(mainPrompt, currentApiKey);
            rawSnippets.main = String(rawMain || "").slice(0, 240);
            traceSimpleQuiz("main.response", {
                rawChars: String(rawMain || "").length,
                rawPreview: rawPreview(rawMain)
            });
            if (isFatalAuth401(rawMain)) throw new Error(String(rawMain || "Text Gen API Error 401"));
            const payload = await parseAiJsonPayload(rawMain, {
                arrayField: "questions",
                schemaHint: "{ questions: [{ id, question, options, answerIndex }] }"
            });
            const q = tryNormalizeFromAny(payload, "ai-main");
            diagnostics.main = q.length;
            questions = mergeQuestions(questions, q, "ai-main");
            emitPartial(questions, "main");
            traceSimpleQuiz("main.parsed", { parsedCount: q.length, mergedCount: questions.length });
        } catch (err) {
            traceSimpleQuiz("main.failed", {
                error: String(err?.message || err),
                rawChars: String(rawMain || "").length,
                rawPreview: rawPreview(rawMain)
            });
            if (isFatalAuth401(err?.message || rawMain)) throw err;
        }
        if (questions.length < targetCount && rawMain) {
            const q = parseQuestionsFromPlainText(rawMain, "ai-main-text");
            diagnostics.mainText = q.length;
            questions = mergeQuestions(questions, q, "ai-main-text");
            emitPartial(questions, "main.text");
            traceSimpleQuiz("main.textParsed", { parsedCount: q.length, mergedCount: questions.length });
        }

        let rawRescue = "";
        if (questions.length < targetCount && rawMain) {
            traceSimpleQuiz("rescue.request", { baseRawChars: String(rawMain || "").length });
            try {
                const rescuePrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
將以下內容轉成合法 JSON 題庫，必須剛好 10 題，且每題 4 選 1。

[OUTPUT]
{ "questions": [ { "id":"Q1", "type":"vocab|collocation|grammar|pattern|context|inference|listening", "question":"...", "questionZh":"...", "options":["A","B","C","D"], "answerIndex":0, "optionExplanations":["","","",""], "explanation":"...", "wrongDetail":"...", "reviewHint":"..." } ] }

[STRICT]
- 禁止 choice_1/optionA/IMC/空題幹。
- 選項必須同語言且自然。
- 若原題屬模糊分類題或多解題，請重寫題幹與選項，確保唯一正解。
- optionExplanations 需逐一說明四個選項的對錯原因（繁中）。
- 不可用「課文中出現過」作為唯一正解依據。

[RAW]
${String(rawMain || "").slice(0, 15000)}`;
                rawRescue = await callGeminiText(rescuePrompt, currentApiKey);
                rawSnippets.rescue = String(rawRescue || "").slice(0, 240);
                traceSimpleQuiz("rescue.response", {
                    rawChars: String(rawRescue || "").length,
                    rawPreview: rawPreview(rawRescue)
                });
                if (isFatalAuth401(rawRescue)) throw new Error(String(rawRescue || "Text Gen API Error 401"));
                const payload = await parseAiJsonPayload(rawRescue, {
                    arrayField: "questions",
                    schemaHint: "{ questions: [{ id, question, options, answerIndex }] }"
                });
                const q = tryNormalizeFromAny(payload, "ai-rescue");
                diagnostics.rescue = q.length;
                questions = mergeQuestions(questions, q, "ai-rescue");
                emitPartial(questions, "rescue");
                traceSimpleQuiz("rescue.parsed", { parsedCount: q.length, mergedCount: questions.length });
                if (questions.length < targetCount) {
                    const qt = parseQuestionsFromPlainText(rawRescue, "ai-rescue-text");
                    diagnostics.rescueText = qt.length;
                    questions = mergeQuestions(questions, qt, "ai-rescue-text");
                    emitPartial(questions, "rescue.text");
                    traceSimpleQuiz("rescue.textParsed", { parsedCount: qt.length, mergedCount: questions.length });
                }
            } catch (err) {
                traceSimpleQuiz("rescue.failed", {
                    error: String(err?.message || err),
                    rawChars: String(rawRescue || "").length,
                    rawPreview: rawPreview(rawRescue)
                });
                if (isFatalAuth401(err?.message || rawRescue)) throw err;
            }
        }

        if (questions.length < targetCount || questions.some(q => hasPlaceholderToken(q.stem) || q.options.some(hasPlaceholderToken))) {
            traceSimpleQuiz("improve.request", {
                currentCount: questions.length,
                hasPlaceholder: questions.some(q => hasPlaceholderToken(q.stem) || q.options.some(hasPlaceholderToken))
            });
            let rawImprove = "";
            try {
                const improvePrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
重做成高品質題庫。${isKnowledgeSource ? "請根據知識點 txt 生成剛好 10 題。" : "請根據 LRC 直接生成剛好 10 題。"}

[OUTPUT]
{ "questions": [ { "id":"Q1", "type":"vocab|collocation|grammar|pattern|context|inference|listening", "question":"...", "questionZh":"...", "options":["A","B","C","D"], "answerIndex":0, "optionExplanations":["","","",""], "explanation":"...", "wrongDetail":"...", "reviewHint":"..." } ] }

[MUST]
- 禁止占位符選項 (choice_*, optionA, IMC)。
- 每題題幹不可為空白/底線。
- 單字/用語/文法至少覆蓋 8 題。
- 每題需解釋四個選項對錯。
- 每題要有語境線索（完整句或對話），不能只考分類常識。
- 若發現兩個以上選項可成立，請重寫該題到只有唯一正解。
- 不可把「課文中有提到」當成唯一正確依據，需用一般語言知識判定。
- 語言：${quizTargetLanguage}

[${sourceHeading}]
${sourcePromptText}`;
                rawImprove = await callGeminiText(improvePrompt, currentApiKey);
                rawSnippets.improve = String(rawImprove || "").slice(0, 240);
                traceSimpleQuiz("improve.response", {
                    rawChars: String(rawImprove || "").length,
                    rawPreview: rawPreview(rawImprove)
                });
                if (isFatalAuth401(rawImprove)) throw new Error(String(rawImprove || "Text Gen API Error 401"));
                const payload = await parseAiJsonPayload(rawImprove, {
                    arrayField: "questions",
                    schemaHint: "{ questions: [{ id, question, options, answerIndex }] }"
                });
                const q = tryNormalizeFromAny(payload, "ai-improve");
                diagnostics.improve = q.length;
                questions = mergeQuestions(questions, q, "ai-improve");
                emitPartial(questions, "improve");
                traceSimpleQuiz("improve.parsed", { parsedCount: q.length, mergedCount: questions.length });
            } catch (err) {
                traceSimpleQuiz("improve.failed", {
                    error: String(err?.message || err),
                    rawChars: String(rawImprove || "").length,
                    rawPreview: rawPreview(rawImprove || rawSnippets.improve)
                });
                if (isFatalAuth401(err?.message || rawImprove)) throw err;
            }
        }

        if (questions.length < targetCount) {
            traceSimpleQuiz("last.request", { currentCount: questions.length });
            let rawLast = "";
            try {
                const lastPrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
最後一次：請從零生成 10 題，僅輸出 JSON，不可任何額外文字。

[OUTPUT]
{"questions":[{"id":"Q1","type":"vocab","question":"...","questionZh":"...","options":["A","B","C","D"],"answerIndex":0,"optionExplanations":["","","",""],"explanation":"...","wrongDetail":"...","reviewHint":"..."}]}

[${sourceHeading}]
${sourcePromptText}

[LANG]
${quizTargetLanguage}

[QUALITY MUST]
- 題幹必須有前後文語境，禁止「單字 + 空格」或模糊分類題。
- 每題只能有 1 個語意與語法都正確的答案。
- optionExplanations 必須逐一說明四個選項的正誤（繁中）。`;
                rawLast = await callGeminiText(lastPrompt, currentApiKey);
                rawSnippets.last = String(rawLast || "").slice(0, 240);
                traceSimpleQuiz("last.response", {
                    rawChars: String(rawLast || "").length,
                    rawPreview: rawPreview(rawLast)
                });
                if (isFatalAuth401(rawLast)) throw new Error(String(rawLast || "Text Gen API Error 401"));
                const payload = await parseAiJsonPayload(rawLast, {
                    arrayField: "questions",
                    schemaHint: "{ questions: [{ id, question, options, answerIndex }] }"
                });
                const q = tryNormalizeFromAny(payload, "ai-last");
                diagnostics.last = q.length;
                questions = mergeQuestions(questions, q, "ai-last");
                emitPartial(questions, "last");
                traceSimpleQuiz("last.parsed", { parsedCount: q.length, mergedCount: questions.length });
            } catch (err) {
                traceSimpleQuiz("last.failed", {
                    error: String(err?.message || err),
                    rawChars: String(rawLast || "").length,
                    rawPreview: rawPreview(rawLast || rawSnippets.last)
                });
                if (isFatalAuth401(err?.message || rawLast)) throw err;
            }
        }

        const finalQs = randomizeQuestionBatchOptions(pickBestQuestions(questions, "ai-final", 10));
        emitPartial(finalQs, "final");
        traceSimpleQuiz("final.summary", {
            finalCount: finalQs.length,
            diagnostics,
            rejectStats,
            rejectSamples,
            rawLens: {
                main: rawSnippets.main.length,
                rescue: rawSnippets.rescue.length,
                improve: rawSnippets.improve.length,
                last: rawSnippets.last.length
            },
            firstRaw: {
                main: rawPreview(rawSnippets.main),
                rescue: rawPreview(rawSnippets.rescue),
                improve: rawPreview(rawSnippets.improve),
                last: rawPreview(rawSnippets.last)
            }
        });
        if (finalQs.length < minRequired) {
            throw new Error(
                `AI 僅生成 ${finalQs.length}/${targetCount} 題。` +
                ` [main:${diagnostics.main}, mainText:${diagnostics.mainText}, rescue:${diagnostics.rescue}, rescueText:${diagnostics.rescueText}, improve:${diagnostics.improve}, last:${diagnostics.last}]` +
                ` [raw.main:${rawSnippets.main.length}, raw.rescue:${rawSnippets.rescue.length}, raw.improve:${rawSnippets.improve.length}, raw.last:${rawSnippets.last.length}]` +
                ` [reject:${JSON.stringify(rejectStats)}]`
            );
        }
        return finalQs;
    }, [currentApiKey, learnerLevel, normalizeQuizQuestions, parseAiJsonPayload, randomizeQuestionBatchOptions]);

    const buildLrcQuizSource = useCallback(() => {
        const source = (rawSubtitles && rawSubtitles.length > 0) ? rawSubtitles : subtitles;
        if (!source || source.length === 0) return "";
        const seen = new Set();
        const lines = [];
        for (const s of source) {
            const text = String(s?.text || "").replace(/\s+/g, ' ').trim();
            if (!text) continue;
            const key = text.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            lines.push(text);
        }
        return lines.map((text, idx) => `${idx + 1}. ${text}`).join('\n');
    }, [rawSubtitles, subtitles]);

    const getEnabledQuizFocusTypes = useCallback((focusMap = null) => {
        const current = focusMap || quizFocusTypes;
        const enabled = QUIZ_FOCUS_TYPE_ORDER.filter((k) => !!current?.[k]);
        return enabled.length > 0 ? enabled : [...QUIZ_FOCUS_TYPE_ORDER];
    }, [quizFocusTypes]);

    const toggleQuizFocusType = useCallback((key) => {
        if (!QUIZ_FOCUS_TYPE_LABELS[key]) return;
        setQuizFocusTypes(prev => {
            const current = !!prev[key];
            const next = { ...prev, [key]: !current };
            const enabledCount = Object.values(next).filter(Boolean).length;
            if (enabledCount === 0) return prev;
            return next;
        });
    }, []);

    const normalizeQuizKnowledgeBankPayload = useCallback((payload) => {
        const categoryAliases = {
            vocab: ['vocab', 'vocabulary', 'words', 'lexicon', '單字', '詞彙', '字彙'],
            usage: ['usage', 'expressions', 'collocations', 'phrases', 'prepositions', '用語', '片語', '搭配', '介詞'],
            grammar: ['grammar', 'syntax', '文法', '語法'],
            pattern: ['pattern', 'patterns', 'sentencePatterns', 'sentence_patterns', 'dialogue', 'rewrite', '句型', '對話', '造句'],
            reading: ['reading', 'comprehension', 'inference', '閱讀', '閱讀理解', '推論'],
            listening: ['listening', 'pronunciation', '聽力', '發音', '連音', '語調']
        };

        const cleanArray = (value) => {
            if (!value) return [];
            if (Array.isArray(value)) return value;
            return [value];
        };

        const normalizeItem = (raw, fallbackCategory) => {
            const category = normalizeQuizKnowledgeCategory(raw?.category || raw?.type || fallbackCategory);
            const rawTextFallback = (raw != null && typeof raw !== 'object') ? raw : "";
            const label = cleanQuizDisplayText(String(
                raw?.point ??
                raw?.knowledgePoint ??
                raw?.name ??
                raw?.term ??
                raw?.title ??
                raw?.label ??
                rawTextFallback ??
                ""
            ));
            if (!label) return null;
            const detail = cleanQuizDisplayText(String(
                raw?.explanationZh ??
                raw?.explanation_zh ??
                raw?.explanation ??
                raw?.description ??
                raw?.note ??
                ""
            ));

            const rawExamples = raw?.examples ?? raw?.example ?? [];
            const examples = cleanArray(rawExamples)
                .map(x => cleanQuizDisplayText(String(x || "")))
                .filter(Boolean)
                .slice(0, 3);

            const rawTags = raw?.tags ?? raw?.keywords ?? raw?.tag ?? [];
            const tags = cleanArray(rawTags)
                .flatMap(x => String(x || "").split(/[、,，;；|]/))
                .map(x => cleanQuizDisplayText(x))
                .filter(Boolean)
                .slice(0, 8);

            const key = `${category}:${label.toLowerCase()}`;
            return { key, category, label, detail, examples, tags };
        };

        const root = payload?.knowledgePoints || payload?.knowledge_points || payload?.points || payload?.knowledge || payload || {};
        const byCategory = {
            vocab: [],
            usage: [],
            grammar: [],
            pattern: [],
            reading: [],
            listening: []
        };

        const pushItems = (category, rawItems) => {
            const list = cleanArray(rawItems);
            for (const item of list) {
                const normalized = normalizeItem(item, category);
                if (!normalized) continue;
                byCategory[normalized.category].push(normalized);
            }
        };

        if (Array.isArray(root)) {
            for (const item of root) {
                const normalized = normalizeItem(item, item?.category || item?.type || 'vocab');
                if (!normalized) continue;
                byCategory[normalized.category].push(normalized);
            }
        } else if (root && typeof root === 'object') {
            for (const [category, aliases] of Object.entries(categoryAliases)) {
                for (const alias of aliases) {
                    if (root[alias] == null) continue;
                    pushItems(category, root[alias]);
                    break;
                }
            }
        }

        const seen = new Set();
        const dedupe = (arr) => {
            const out = [];
            for (const item of arr) {
                if (!item || !item.key) continue;
                if (seen.has(item.key)) continue;
                seen.add(item.key);
                out.push(item);
            }
            return out;
        };

        const normalizedByCategory = {};
        for (const k of QUIZ_FOCUS_TYPE_ORDER) {
            normalizedByCategory[k] = dedupe(byCategory[k] || []);
        }
        const points = QUIZ_FOCUS_TYPE_ORDER.flatMap(k => normalizedByCategory[k]);
        return { points, byCategory: normalizedByCategory };
    }, []);

    const buildQuizKnowledgeTxt = useCallback((knowledgeBank) => {
        if (!knowledgeBank || !Array.isArray(knowledgeBank.points)) return "";
        const lines = [];
        const generatedAt = new Date(knowledgeBank.generatedAt || Date.now());
        const displayDate = `${generatedAt.getFullYear()}-${String(generatedAt.getMonth() + 1).padStart(2, '0')}-${String(generatedAt.getDate()).padStart(2, '0')} ${String(generatedAt.getHours()).padStart(2, '0')}:${String(generatedAt.getMinutes()).padStart(2, '0')}`;
        lines.push(`LRC 知識點整理`);
        lines.push(`檔名：${knowledgeBank.baseName || 'LRC'}`);
        lines.push(`語言：${knowledgeBank.targetLanguage || trackLanguage}`);
        lines.push(`生成時間：${displayDate}`);
        lines.push(`總知識點：${knowledgeBank.points.length}`);
        lines.push('');

        for (const key of QUIZ_FOCUS_TYPE_ORDER) {
            const arr = knowledgeBank.byCategory?.[key] || [];
            lines.push(`=== ${QUIZ_FOCUS_TYPE_LABELS[key]} (${arr.length}) ===`);
            if (arr.length === 0) {
                lines.push('（無）');
                lines.push('');
                continue;
            }
            arr.forEach((item, idx) => {
                lines.push(`${idx + 1}. ${item.label}`);
                if (item.detail) lines.push(`   說明：${item.detail}`);
                if (item.examples?.length) lines.push(`   例句：${item.examples.join(' / ')}`);
                if (item.tags?.length) lines.push(`   Tags：${item.tags.join(', ')}`);
            });
            lines.push('');
        }
        return lines.join('\n').trim();
    }, [trackLanguage]);

    const compactAiPromptText = useCallback((text, maxChars = 12000) => {
        let s = String(text || "").replace(/\r/g, "");
        // Keep structure, drop verbose lines first.
        s = s
            .replace(/^\s*例句[:：].*$/gm, "")
            .replace(/^\s*Tags[:：].*$/gm, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        if (s.length <= maxChars) return s;

        const lines = s.split('\n').map(x => x.trim()).filter(Boolean);
        const keepHead = lines.slice(0, 160);
        const keepCore = lines.filter(x =>
            /^===/.test(x) ||
            /^\d+\.\s+/.test(x) ||
            /^(檔名|語言|總知識點|生成時間)[:：]/.test(x)
        ).slice(0, 260);
        const keepTail = lines.slice(-80);
        const merged = [...keepHead, ...keepCore, ...keepTail].filter(Boolean).join('\n');
        const finalText = merged.length > maxChars ? merged.slice(0, maxChars) : merged;
        return `${finalText}\n...(truncated for bridge limit)`;
    }, []);

    const parseKnowledgeTxtToPayload = useCallback((txt) => {
        const byCategory = {
            vocab: [],
            usage: [],
            grammar: [],
            pattern: [],
            reading: [],
            listening: []
        };
        const sectionMap = {
            '單字': 'vocab',
            '詞彙': 'vocab',
            '字彙': 'vocab',
            'vocab': 'vocab',
            'vocabulary': 'vocab',
            'word': 'vocab',
            'words': 'vocab',
            '用語': 'usage',
            '片語': 'usage',
            '搭配': 'usage',
            '慣用語': 'usage',
            'usage': 'usage',
            'phrase': 'usage',
            'phrases': 'usage',
            '文法': 'grammar',
            '語法': 'grammar',
            'grammar': 'grammar',
            '句型': 'pattern',
            'pattern': 'pattern',
            'patterns': 'pattern',
            '閱讀': 'reading',
            'reading': 'reading',
            '聽力': 'listening',
            'listening': 'listening'
        };

        const normalizeSection = (name) => {
            const cleaned = cleanQuizDisplayText(String(name || ""));
            const lower = cleaned.toLowerCase();
            if (sectionMap[lower]) return sectionMap[lower];
            if (sectionMap[cleaned]) return sectionMap[cleaned];
            return normalizeQuizKnowledgeCategory(cleaned);
        };

        const detailLabelRe = /^(?:說明|解釋|解释|Explanation|Meaning|Definition|備註|註解|Note)\s*[:：]\s*(.*)$/i;
        const exampleLabelRe = /^(?:例句|例子|Examples?|Samples?|Sentence)\s*[:：]\s*(.*)$/i;
        const tagLabelRe = /^(?:Tags?|Tag|關鍵字|Keywords?)\s*[:：]\s*(.*)$/i;
        const inlineLabelRe = /(說明|解釋|解释|Explanation|Meaning|Definition|備註|註解|Note|例句|例子|Examples?|Samples?|Sentence|Tags?|Tag|關鍵字|Keywords?)\s*[:：]/ig;

        const cleanList = (text, splitter) => String(text || "")
            .split(splitter)
            .map(x => cleanQuizDisplayText(x))
            .filter(Boolean);

        const appendDetail = (item, text) => {
            const cleaned = cleanQuizDisplayText(text);
            if (!cleaned) return;
            item.explanationZh = item.explanationZh
                ? `${item.explanationZh} ${cleaned}`
                : cleaned;
        };

        const pushExamples = (item, text) => {
            const parts = cleanList(text, /(?:\s*[\/／|；;]\s*|\s+\|\s+)/);
            if (parts.length > 0) item.examples.push(...parts);
        };

        const pushTags = (item, text) => {
            const parts = cleanList(text, /[、,，;；|]/);
            if (parts.length > 0) item.tags.push(...parts);
        };

        const pushAndDedupe = (arr, maxCount) => {
            const seen = new Set();
            const out = [];
            for (const v of arr || []) {
                const key = String(v || "").toLowerCase();
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push(v);
                if (out.length >= maxCount) break;
            }
            return out;
        };

        const splitInlineLabeled = (text) => {
            const line = String(text || "");
            const markers = [];
            let match;
            inlineLabelRe.lastIndex = 0;
            while ((match = inlineLabelRe.exec(line)) !== null) {
                markers.push({ index: match.index, label: match[1], valueStart: inlineLabelRe.lastIndex });
            }
            if (markers.length === 0) {
                return { point: cleanQuizDisplayText(line), segments: [] };
            }
            const point = cleanQuizDisplayText(line.slice(0, markers[0].index));
            const segments = markers.map((m, idx) => {
                const end = idx + 1 < markers.length ? markers[idx + 1].index : line.length;
                return {
                    label: String(m.label || "").toLowerCase(),
                    value: cleanQuizDisplayText(line.slice(m.valueStart, end))
                };
            }).filter(seg => seg.value);
            return { point, segments };
        };

        const applySegment = (item, label, value) => {
            const l = String(label || "").toLowerCase();
            if (!item || !value) return "detail";
            if (/^(例句|例子|example|examples|samples?|sentence)$/i.test(l)) {
                pushExamples(item, value);
                return "examples";
            }
            if (/^(tags?|tag|關鍵字|keywords?)$/i.test(l)) {
                pushTags(item, value);
                return "tags";
            }
            appendDetail(item, value);
            return "detail";
        };

        const bodyText = extractKnowledgeBodyText(txt) || String(txt || "");
        const allLines = String(bodyText || "").replace(/\r/g, '').split('\n');
        const totalCountLineIdx = allLines.findIndex((line) => /總知識點\s*[:：]/i.test(String(line || "").trim()));
        const lines = (totalCountLineIdx >= 0 && totalCountLineIdx + 1 < allLines.length)
            ? allLines.slice(totalCountLineIdx + 1)
            : allLines;
        let currentCategory = "";
        let currentItem = null;
        let lastField = "detail";
        let prevLineBlank = true;

        const looksLikeStandalonePointLine = (text) => {
            const t = cleanQuizDisplayText(String(text || ""));
            if (!t) return false;
            if (t.length > 120) return false;
            if (/^[（(]?無[)）]?$/.test(t)) return false;
            if (/[:：]/.test(t)) return false;
            if (/^(?:說明|解釋|解释|Explanation|Meaning|Definition|備註|註解|Note|例句|例子|Examples?|Samples?|Sentence|Tags?|Tag|關鍵字|Keywords?)\b/i.test(t)) return false;
            if (/^(LRC\s*知識點整理|檔名|語言|生成時間|總知識點)$/i.test(t)) return false;
            if (/^[,.;:!?，。；：！？、)\]】）]/.test(t)) return false;
            return true;
        };

        const splitMergedTagTail = (rawText) => {
            const raw = cleanQuizDisplayText(String(rawText || ""));
            if (!raw) return { tagsText: "", nextPoint: "" };

            const tagLexicon = [
                "noun phrase", "phrasal verb", "adverbial phrase", "causative verb", "relative clause",
                "noun", "verb", "adjective", "adverb", "idiom", "phrase", "formal", "business", "economy",
                "economics", "finance", "policy", "politics", "logistics", "trend", "impact", "general",
                "quality", "technology", "development", "strategy", "condition", "control", "metaphor",
                "daily", "trade", "power", "situation", "process", "mindset", "quantity", "comparison",
                "syntax", "passive", "hypothetical", "participle", "emphasis", "continuous", "punctuation",
                "grammar", "concession", "purpose", "prediction", "focus", "contrast", "sacrifice", "reasoning",
                "assertion", "analysis", "context", "conclusion", "history", "geopolitics", "psychology",
                "numbers", "nuance", "pronunciation", "logic", "spelling", "tone", "rhythm", "terminology"
            ].sort((a, b) => b.length - a.length);

            const trySplitGluedTagPrefix = (headWithIpa = "") => {
                const m = String(headWithIpa || "").match(/^([A-Za-z][A-Za-z0-9'’\- ]{1,120}?)(\s*\/[^\/\n]{2,100}\/\s*)$/);
                if (!m) return null;
                const headWordPart = String(m[1] || "").trim();
                const ipaPart = String(m[2] || "");
                if (!headWordPart || /\s/.test(headWordPart)) return null;

                const lower = headWordPart.toLowerCase();
                for (const tag of tagLexicon) {
                    const t = String(tag || "").toLowerCase();
                    if (!t || !lower.startsWith(t)) continue;
                    if (lower.length <= t.length + 2) continue;

                    const tailWord = headWordPart.slice(t.length);
                    if (!/^[A-Za-z][A-Za-z0-9'’\-]{2,}$/.test(tailWord)) continue;
                    return {
                        tagPrefix: tag,
                        nextPoint: cleanQuizDisplayText(`${tailWord}${ipaPart}`)
                    };
                }
                return null;
            };

            // Case 1: Tags line accidentally glued to next EN head with IPA.
            const enIpaTail = raw.match(/^(.*?)([A-Za-z][A-Za-z0-9'’\-\s]{1,120}\s*\/[^\/\n]{2,100}\/)\s*$/);
            if (enIpaTail) {
                let tagsText = cleanQuizDisplayText(enIpaTail[1]);
                let nextPoint = cleanQuizDisplayText(enIpaTail[2]);

                // e.g. "noun, economyemanate /.../" => tags "noun, economy" + next "emanate /.../"
                const glued = trySplitGluedTagPrefix(nextPoint);
                if (glued && glued.nextPoint) {
                    tagsText = cleanQuizDisplayText([tagsText, glued.tagPrefix].filter(Boolean).join(", "));
                    nextPoint = glued.nextPoint;
                }

                return { tagsText, nextPoint };
            }

            // Case 2: Tags line accidentally glued to next CJK head, e.g. "nuance比較級...".
            const isCjkChar = (ch) => /[\u3400-\u9fff\u3040-\u30ff\u31f0-\u31ff\u3005\u303b\u30fc]/.test(ch);
            const isAsciiWordChar = (ch) => /[A-Za-z0-9]/.test(ch);
            let cjkStart = -1;
            for (let i = 1; i < raw.length; i++) {
                if (isCjkChar(raw[i]) && isAsciiWordChar(raw[i - 1])) {
                    cjkStart = i;
                    break;
                }
            }
            if (cjkStart > 0) {
                const tagsText = cleanQuizDisplayText(raw.slice(0, cjkStart));
                const nextPoint = cleanQuizDisplayText(raw.slice(cjkStart));
                if (nextPoint && looksLikeStandalonePointLine(nextPoint)) {
                    return { tagsText, nextPoint };
                }
            }

            return { tagsText: raw, nextPoint: "" };
        };

        const startItem = (pointText) => {
            const point = cleanQuizDisplayText(pointText);
            if (!point) return null;
            if (!currentCategory) currentCategory = 'vocab';
            const item = {
                point,
                explanationZh: "",
                examples: [],
                tags: []
            };
            byCategory[currentCategory].push(item);
            currentItem = item;
            lastField = "detail";
            return item;
        };

        for (const rawLine of lines) {
            const line = String(rawLine || "").trim();
            if (!line) {
                prevLineBlank = true;
                continue;
            }
            const wasPrevBlank = prevLineBlank;
            prevLineBlank = false;

            if (isKnowledgeOriginalMarkerLine(line)) {
                break;
            }

            if (/^(LRC\s*知識點整理|檔名[:：]|語言[:：]|生成時間[:：]|總知識點[:：]|@K_HEADER@|@FN@|@LG@|@TS@|@TT@|@SEC@|@ITEM@|@HEAD@|@DESC@|@EX@|@TAG@)/i.test(line)) continue;

            const sec = line.match(/^===\s*(.*?)\s*(?:\(\s*\d+\s*\))?\s*===$/);
            if (sec) {
                currentCategory = normalizeSection(sec[1]);
                currentItem = null;
                lastField = "detail";
                continue;
            }

            const secLite = line.match(/^(單字|詞彙|字彙|用語|片語|搭配|文法|語法|句型|閱讀|聽力|vocab(?:ulary)?|usage|grammar|pattern|reading|listening)\s*(?:\(\s*\d+\s*\))?$/i);
            if (secLite) {
                currentCategory = normalizeSection(secLite[1]);
                currentItem = null;
                lastField = "detail";
                continue;
            }

            const itemMatch = line.match(/^(?:[-*•]\s*)?(?:\d{1,4})\s*[.)、．]\s*(.+)$/);
            if (itemMatch) {
                const parsed = splitInlineLabeled(itemMatch[1]);
                const item = startItem(parsed.point || itemMatch[1]);
                if (item && parsed.segments.length > 0) {
                    for (const seg of parsed.segments) {
                        lastField = applySegment(item, seg.label, seg.value);
                    }
                }
                continue;
            }

            const detailMatch = line.match(detailLabelRe);
            if (detailMatch && currentItem) {
                appendDetail(currentItem, detailMatch[1]);
                lastField = "detail";
                continue;
            }

            const exampleMatch = line.match(exampleLabelRe);
            if (exampleMatch && currentItem) {
                pushExamples(currentItem, exampleMatch[1]);
                lastField = "examples";
                continue;
            }

            const tagsMatch = line.match(tagLabelRe);
            if (tagsMatch && currentItem) {
                const { tagsText, nextPoint } = splitMergedTagTail(tagsMatch[1]);
                if (tagsText) pushTags(currentItem, tagsText);
                lastField = "tags";
                if (nextPoint) {
                    startItem(nextPoint);
                }
                continue;
            }

            const pairMatch = line.match(/^([^:：]{1,80})[:：]\s*(.+)$/);
            if (pairMatch && !detailLabelRe.test(line) && !exampleLabelRe.test(line) && !tagLabelRe.test(line)) {
                const item = startItem(pairMatch[1]);
                if (item) appendDetail(item, pairMatch[2]);
                continue;
            }

            // Support plugin format:
            // objective
            // 說明：...
            // 例句：...
            // Tags：...
            if (currentCategory && currentItem && wasPrevBlank && looksLikeStandalonePointLine(line)) {
                startItem(line);
                continue;
            }

            if (
                currentCategory &&
                currentItem &&
                !wasPrevBlank &&
                lastField === "detail" &&
                (currentItem.explanationZh || (currentItem.examples && currentItem.examples.length > 0) || (currentItem.tags && currentItem.tags.length > 0)) &&
                looksLikeStandalonePointLine(line)
            ) {
                startItem(line);
                continue;
            }

            if (!currentCategory) continue;
            if (!currentItem) {
                if (/^[（(]?無[)）]?$/.test(line)) continue;
                startItem(line);
                continue;
            }

            if (lastField === "examples") {
                pushExamples(currentItem, line);
            } else if (lastField === "tags") {
                pushTags(currentItem, line);
            } else {
                appendDetail(currentItem, line);
            }
        }

        for (const key of QUIZ_FOCUS_TYPE_ORDER) {
            byCategory[key] = (byCategory[key] || [])
                .filter(item => cleanQuizDisplayText(item?.point || ""))
                .map(item => ({
                    point: cleanQuizDisplayText(item.point || ""),
                    explanationZh: cleanQuizDisplayText(item.explanationZh || ""),
                    examples: pushAndDedupe(item.examples || [], 4),
                    tags: pushAndDedupe(item.tags || [], 8)
                }));
        }
        return { knowledgePoints: byCategory };
    }, []);

    const parseKnowledgeTxtToFlashCards = useCallback((txt) => {
        const payload = parseKnowledgeTxtToPayload(txt);
        const normalized = normalizeQuizKnowledgeBankPayload(payload);
        const toCardsFromNormalized = (normalizedPayload) => {
            const list = [];
            for (const category of QUIZ_FOCUS_TYPE_ORDER) {
                const items = normalizedPayload?.byCategory?.[category] || [];
                for (const item of items) {
                    const front = cleanQuizDisplayText(item?.label || item?.point || "");
                    if (!front) continue;
                    const frontSpeakText = extractFrontTermForSpeech(front) || front;
                    const detail = cleanQuizDisplayText(item?.detail || item?.explanationZh || "");
                    const examples = Array.isArray(item?.examples)
                        ? item.examples.map(x => cleanQuizDisplayText(String(x || ""))).filter(Boolean).slice(0, 3)
                        : [];
                    const tags = Array.isArray(item?.tags)
                        ? item.tags.map(x => cleanQuizDisplayText(String(x || ""))).filter(Boolean).slice(0, 8)
                        : [];

                    const backLines = [];
                    if (detail) backLines.push(detail);
                    if (examples.length > 0) backLines.push(`例句：${examples.join(' / ')}`);
                    if (tags.length > 0) backLines.push(`Tags：${tags.join(', ')}`);
                    if (backLines.length === 0) backLines.push(`分類：${QUIZ_FOCUS_TYPE_LABELS[category]}`);
                    const speakSegments = examples
                        .flatMap(x => splitExampleSegmentsPreservingParens(x))
                        .flatMap(x => stripExampleZhTranslationForSpeech(x).split(/\n+/))
                        .map(x => normalizeJapaneseRubyForSpeech(x, trackLanguage))
                        .map(x => cleanQuizDisplayText(x))
                        .filter(Boolean);
                    const speakText = speakSegments.join('\n');
                    const backZhSpeakText = /[\u4e00-\u9fff]/.test(detail)
                        ? sanitizeSpeakerText(normalizeJapaneseRubyForSpeech(detail, "zh-TW"))
                        : "";

                    list.push({
                        id: `${category}-${list.length + 1}`,
                        category,
                        categoryLabel: QUIZ_FOCUS_TYPE_LABELS[category],
                        front,
                        frontSpeakText,
                        back: backLines.join('\n'),
                        speakText,
                        backZhSpeakText
                    });
                }
            }

            // Extra "sentence" cards:
            // Priority order:
            // 1) [原文] bilingual pairs (most complete)
            // 2) examples inside knowledge sections
            // 3) whole-text heuristic fallback
            const sentencePairs = [];
            const sentenceSeenByBack = new Set();
            const sentenceSeenPair = new Set();

            const addSentencePair = (pair) => {
                const front = cleanQuizDisplayText(pair?.frontZh || "");
                const back = cleanQuizDisplayText(pair?.backTarget || "");
                if (!front || !back) return;
                const backKey = back.toLowerCase();
                const pairKey = `${front.toLowerCase()}::${backKey}`;
                if (sentenceSeenPair.has(pairKey)) return;
                if (sentenceSeenByBack.has(backKey)) return;
                sentenceSeenByBack.add(backKey);
                sentenceSeenPair.add(pairKey);
                sentencePairs.push({ frontZh: front, backTarget: back });
            };

            const originalPairs = extractBilingualSentencePairsFromOriginalBlock(txt);
            for (const pair of originalPairs) addSentencePair(pair);

            for (const category of QUIZ_FOCUS_TYPE_ORDER) {
                const items = normalizedPayload?.byCategory?.[category] || [];
                for (const item of items) {
                    const pairs = extractBilingualSentencePairs(item?.examples || []);
                    for (const pair of pairs) addSentencePair(pair);
                }
            }

            if (sentencePairs.length < 8) {
                const fallbackPairs = extractBilingualSentencePairsFromWholeText(txt);
                for (const pair of fallbackPairs) addSentencePair(pair);
            }

            for (const pair of sentencePairs) {
                const front = pair.backTarget;
                const back = pair.frontZh;
                list.push({
                    id: `sentence-${list.length + 1}`,
                    category: "sentence",
                    categoryLabel: QUIZ_FOCUS_TYPE_LABELS.sentence,
                    front,
                    frontSpeakText: sanitizeSpeakerText(normalizeJapaneseRubyForSpeech(front)),
                    back,
                    speakText: sanitizeSpeakerText(normalizeJapaneseRubyForSpeech(front)),
                    backZhSpeakText: sanitizeSpeakerText(normalizeJapaneseRubyForSpeech(back, "zh-TW"))
                });
            }
            return list;
        };

        const cards = toCardsFromNormalized(normalized);
        if (cards.length > 0) return cards;

        const fallbackSource = extractKnowledgeBodyText(txt) || String(txt || "");
        const fallbackCards = String(fallbackSource || "")
            .split('\n')
            .map(x => x.trim())
            .filter(Boolean)
            .filter(line => !isKnowledgeMetaLine(line))
            .filter(line => !isKnowledgeOriginalMarkerLine(line))
            .filter(line => !/^(@K_HEADER@|@FN@|@LG@|@TS@|@TT@|@SEC@|@ITEM@|@HEAD@|@DESC@|@EX@|@TAG@)/i.test(line))
            .map(line => line.replace(/^\d+\s*[.)、．]\s*/, '').trim())
            .filter(line => looksLikeKnowledgeFallbackPointLine(line))
            .filter(Boolean)
            .slice(0, 200)
            .map((line, idx) => ({
                id: `fallback-${idx + 1}`,
                category: "vocab",
                categoryLabel: QUIZ_FOCUS_TYPE_LABELS.vocab,
                front: cleanQuizDisplayText(line),
                frontSpeakText: extractFrontTermForSpeech(line),
                back: "請回想這個知識點在原文中的語境與用法。",
                speakText: "",
                backZhSpeakText: ""
            }))
            .filter(card => card.front);

        return fallbackCards;
    }, [normalizeQuizKnowledgeBankPayload, parseKnowledgeTxtToPayload]);

    const getSelectedKnowledgeTxtFileFromFolderMap = useCallback(() => {
        const selectedName = String(selectedKnowledgeTxtName || "").trim();
        if (!selectedName) return null;
        const map = selectedFolderFilesRef.current || {};
        return map[selectedName.toLowerCase()] || null;
    }, [selectedKnowledgeTxtName]);

    const loadKnowledgeBankFromTxtFile = useCallback(async (file, { baseName = "", quizTargetLanguage = "", trackKey = "" } = {}) => {
        if (!file || (typeof file.text !== 'function' && typeof file.arrayBuffer !== 'function')) {
            throw new Error("指定知識點檔不存在或無法讀取。");
        }
        const rawTxt = String(await readTextFileRobust(file, { purpose: "knowledge" }) || "").trim();
        const txt = rawTxt;
        if (!txt) {
            throw new Error(`知識點檔為空：${String(file?.name || "unknown")}`);
        }
        const declaredTargetLanguage = extractKnowledgeTxtDeclaredLanguage(rawTxt, quizTargetLanguage || trackLanguage);

        let normalized = normalizeQuizKnowledgeBankPayload(parseKnowledgeTxtToPayload(txt));
        let points = Array.isArray(normalized?.points) ? normalized.points : [];
        if (points.length === 0) {
            const fallbackItems = [];
            const lines = txt.split('\n');
            for (const rawLine of lines) {
                const line = String(rawLine || "").trim();
                if (!line) continue;
                if (isKnowledgeMetaLine(line) || isKnowledgeOriginalMarkerLine(line)) continue;
                const m = line.match(/^\d+\.\s*(.+)$/);
                const point = cleanQuizDisplayText(m ? m[1] : line);
                if (!point) continue;
                fallbackItems.push({ point, explanationZh: "從知識點檔載入" });
                if (fallbackItems.length >= 80) break;
            }
            if (fallbackItems.length > 0) {
                normalized = normalizeQuizKnowledgeBankPayload({
                    knowledgePoints: { vocab: fallbackItems, usage: [], grammar: [], pattern: [], reading: [], listening: [] }
                });
                points = Array.isArray(normalized?.points) ? normalized.points : [];
            }
        }
        if (points.length === 0) {
            throw new Error(`知識點檔格式無法解析：${String(file?.name || "unknown")}`);
        }

        const activeTrack = (currentTrackIndex >= 0 && playlist[currentTrackIndex]) ? playlist[currentTrackIndex] : null;
        const fallbackBaseName = String(file?.name || "").replace(/\.txt$/i, "").trim();
        const safeBaseName = String(baseName || getTrackBaseNameForKnowledge(activeTrack) || fallbackBaseName || "knowledge").trim();
        const safeTrackKey = String(trackKey || `${currentTrackIndex >= 0 ? currentTrackIndex : "manual"}:${String(file?.name || safeBaseName).toLowerCase()}`);
        return {
            trackKey: safeTrackKey,
            baseName: safeBaseName,
            filename: String(file?.name || `${safeBaseName}知識點.txt`),
            generatedAt: Date.now(),
            targetLanguage: declaredTargetLanguage || quizTargetLanguage || trackLanguage,
            points: normalized.points,
            byCategory: normalized.byCategory,
            txt: rawTxt
        };
    }, [currentTrackIndex, normalizeQuizKnowledgeBankPayload, parseKnowledgeTxtToPayload, playlist, trackLanguage]);

    const getKnowledgeTxtFileByName = useCallback((name) => {
        const targetName = String(name || "").trim();
        if (!targetName) return null;
        const map = selectedFolderFilesRef.current || {};
        return map[targetName.toLowerCase()] || null;
    }, []);

    const loadFlashCardsFromKnowledgeTxtName = useCallback(async (name, {
        markSelected = true,
        preserveCategories = false,
        preserveAutoRun = false
    } = {}) => {
        const file = getKnowledgeTxtFileByName(name);
        if (!file || (typeof file.text !== 'function' && typeof file.arrayBuffer !== 'function')) {
            throw new Error(`找不到指定的知識點 txt：${String(name || "")}`);
        }
        const knowledgeBank = await loadKnowledgeBankFromTxtFile(file, {
            quizTargetLanguage: trackLanguage,
            trackKey: `${currentTrackIndex >= 0 ? currentTrackIndex : "manual"}:flashcards:${String(file?.name || "").toLowerCase()}`
        });
        const txt = String(knowledgeBank?.txt || "").trim();
        const cards = parseKnowledgeTxtToFlashCards(txt);
        if (!Array.isArray(cards) || cards.length === 0) {
            throw new Error(`知識點格式無法解析成 flash cards：${String(file?.name || "")}`);
        }
        const filename = String(knowledgeBank?.filename || file?.name || "知識點").trim() || "知識點";
        const targetLang = String(
            knowledgeBank?.targetLanguage ||
            extractKnowledgeTxtDeclaredLanguage(txt, trackLanguage) ||
            trackLanguage
        ).trim() || trackLanguage;

        if (preserveAutoRun) {
            flashCardPreserveAutoRunOnDataChangeRef.current = true;
        }
        setFlashCards(cards);
        setFlashCardSourceName(filename);
        if (preserveCategories) {
            setFlashCardCategories((prev) => {
                const now = Array.isArray(prev) && prev.length > 0 ? prev : ["all"];
                if (now.includes("all")) return ["all"];
                const kept = now.filter((k) => k && k !== "all");
                return kept.length > 0 ? kept : ["all"];
            });
        } else {
            setFlashCardCategories(["all"]);
        }
        setFlashCardIndex(0);
        setFlashCardFlipped(false);
        setFlashCardError("");
        setQuizKnowledgeFileInfo(prev => ({
            ...(prev || {}),
            filename,
            total: cards.length,
            generatedAt: knowledgeBank?.generatedAt || Date.now(),
            targetLanguage: targetLang
        }));
        if (markSelected) {
            const nextName = String(file?.name || filename);
            setSelectedKnowledgeTxtName(nextName);
            setActiveTrackKnowledgeTabName(nextName);
        }
        return { filename, cardsCount: cards.length, targetLanguage: targetLang };
    }, [currentTrackIndex, getKnowledgeTxtFileByName, loadKnowledgeBankFromTxtFile, parseKnowledgeTxtToFlashCards, trackLanguage]);

    const openKnowledgeTxtInModal = useCallback(async (nameOrFile, { markSelected = true, allowPlainText = false } = {}) => {
        const file = (nameOrFile && typeof nameOrFile === 'object')
            ? nameOrFile
            : getKnowledgeTxtFileByName(nameOrFile);
        if (!file) {
            throw new Error("找不到指定的知識點 txt。");
        }
        const rawTxt = allowPlainText
            ? String(await readManualDocumentText(file) || "").trim()
            : String(await readTextFileRobust(file, { purpose: "knowledge" }) || "").trim();
        const isKnowledgeLikeText = KNOWN_KNOWLEDGE_TEXT_RE.test(rawTxt);
        let knowledgeBank = null;
        try {
            knowledgeBank = await loadKnowledgeBankFromTxtFile(file, {
                quizTargetLanguage: trackLanguage,
                trackKey: `${currentTrackIndex >= 0 ? currentTrackIndex : "manual"}:manual:${String(file?.name || "").toLowerCase()}`
            });
        } catch (err) {
            console.warn("openKnowledgeTxtInModal parse failed, show raw only:", err);
        }
        if (knowledgeBank) {
            setQuizKnowledgeBankMap(prev => ({ ...prev, [knowledgeBank.trackKey]: knowledgeBank }));
            setQuizKnowledgePointsPool(knowledgeBank.points || []);
            setQuizKnowledgeFileInfo({
                filename: knowledgeBank.filename,
                total: Array.isArray(knowledgeBank.points) ? knowledgeBank.points.length : 0,
                generatedAt: knowledgeBank.generatedAt,
                targetLanguage: knowledgeBank.targetLanguage || trackLanguage
            });
        } else {
            setQuizKnowledgePointsPool([]);
            setQuizKnowledgeFileInfo({
                filename: String(file?.name || "知識點.txt"),
                total: 0,
                generatedAt: Date.now(),
                targetLanguage: extractKnowledgeTxtDeclaredLanguage(rawTxt, trackLanguage)
            });
        }
        // Knowledge-txt view is file-level; clear single-sentence preview panel to avoid blocking picker actions.
        setSmartTargetDisplay("");
        setTargetTranslation("");
        setAiMode('text');
        setModalTitle(isKnowledgeLikeText ? "LRC 知識點整理 (預覽)" : "文字檔預覽");
        setModalContent(String((knowledgeBank && knowledgeBank.txt) || rawTxt || "").trim() || "（知識點檔為空）");
        if (markSelected) {
            const nextName = String(file?.name || "");
            setSelectedKnowledgeTxtName(nextName);
            setActiveTrackKnowledgeTabName(nextName);
        }
        setShowKnowledgeTxtPicker(false);
        setKnowledgeTxtPickerError("");
        setIsLoadingAI(false);
        return knowledgeBank || {
            trackKey: `${currentTrackIndex >= 0 ? currentTrackIndex : "manual"}:manual:${String(file?.name || "").toLowerCase()}`,
            baseName: String(file?.name || "").replace(/\.txt$/i, ""),
            filename: String(file?.name || "知識點.txt"),
            generatedAt: Date.now(),
            targetLanguage: trackLanguage,
            points: [],
            byCategory: { vocab: [], usage: [], grammar: [], pattern: [], reading: [], listening: [] },
            txt: rawTxt
        };
    }, [currentTrackIndex, getKnowledgeTxtFileByName, loadKnowledgeBankFromTxtFile, trackLanguage]);

    const tryOpenExistingKnowledgeTxtForCurrentTrack = async () => {
        const track = (currentTrackIndex >= 0 && playlist[currentTrackIndex]) ? playlist[currentTrackIndex] : null;
        const baseCandidates = getTrackKnowledgeBaseCandidates(track);
        const map = selectedFolderFilesRef.current || {};
        const tried = new Set();
        const fileQueue = [];
        const pushFile = (f) => {
            if (!f) return;
            const key = String(f?.name || "").toLowerCase();
            if (!key || tried.has(key)) return;
            tried.add(key);
            fileQueue.push(f);
        };

        const selected = getSelectedKnowledgeTxtFileFromFolderMap();
        const activeTrackKnowledgeFile = getKnowledgeTxtFileByName(activeTrackKnowledgeTabName);

        try {
            const hit = await probeKnowledgeFileForCurrentTrack({ refreshFromHandle: true, deepScan: true });
            if (hit?.knowledgeBank) {
                const kb = hit.knowledgeBank;
                const txtFromKb = String(kb?.txt || buildQuizKnowledgeTxt(kb) || "").trim();
                if (txtFromKb) {
                    const kbTrackKey = String(kb?.trackKey || "").trim();
                    if (kbTrackKey) setQuizKnowledgeBankMap(prev => ({ ...prev, [kbTrackKey]: kb }));
                    setQuizKnowledgePointsPool(Array.isArray(kb?.points) ? kb.points : []);
                    setQuizKnowledgeFileInfo({
                        filename: String(kb?.filename || `${hit?.baseName || "LRC"}知識點.txt`),
                        total: Array.isArray(kb?.points) ? kb.points.length : 0,
                        generatedAt: Number(kb?.generatedAt || Date.now()),
                        targetLanguage: String(kb?.targetLanguage || trackLanguage || "en-US")
                    });
                    setAiMode('text');
                    setModalTitle("LRC 知識點整理 (預覽)");
                    setModalContent(txtFromKb);
                    setIsLoadingAI(false);
                    return { ok: true, source: "cache", attemptedFiles: 0 };
                }
            }
            pushFile(hit?.file || null);
        } catch (_) { }

        if (doesKnowledgeFileLikelyBelongToTrack(activeTrackKnowledgeFile, track)) {
            pushFile(activeTrackKnowledgeFile);
        }
        for (const b of baseCandidates) pushFile(findKnowledgeFileInFolderMap(b, map));
        pushFile(findKnowledgeFileHeuristically(baseCandidates, map));
        // 使用者手動選的 TXT 只作為最後 fallback，且需與目前 track 看起來相符，
        // 避免一直停在上一首的知識點。
        if (doesKnowledgeFileLikelyBelongToTrack(selected, track)) {
            pushFile(selected);
        }
        Object.values(map)
            .filter((f) => {
                const lower = String(f?.name || "").toLowerCase();
                return lower.endsWith('.txt') && lower.includes('知識點');
            })
            .sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { numeric: true, sensitivity: 'base' }))
            .slice(0, 3)
            .forEach(pushFile);

        let lastErr = "";
        for (const f of fileQueue) {
            try {
                await openKnowledgeTxtInModal(f, { markSelected: true });
                return { ok: true, source: "file", attemptedFiles: fileQueue.length };
            } catch (err) {
                lastErr = String(err?.message || err || "未知錯誤");
                try {
                    // Last-resort: if strict knowledge-text detection rejects this file,
                    // still open raw text and stop AI generation.
                    const rawTxt = String(await readTextFileRobust(f, { purpose: "text" }) || "").trim();
                    if (!rawTxt) continue;
                    setQuizKnowledgePointsPool([]);
                    setQuizKnowledgeFileInfo({
                        filename: String(f?.name || "知識點.txt"),
                        total: 0,
                        generatedAt: Date.now(),
                        targetLanguage: extractKnowledgeTxtDeclaredLanguage(rawTxt, trackLanguage)
                    });
                    setSmartTargetDisplay("");
                    setTargetTranslation("");
                    setAiMode('text');
                    setModalTitle("LRC 知識點整理 (預覽)");
                    setModalContent(rawTxt);
                    setSelectedKnowledgeTxtName(String(f?.name || ""));
                    setShowKnowledgeTxtPicker(false);
                    setKnowledgeTxtPickerError("");
                    setIsLoadingAI(false);
                    return { ok: true, source: "file-raw", attemptedFiles: fileQueue.length };
                } catch (_) { }
            }
        }
        return {
            ok: false,
            attemptedFiles: fileQueue.length,
            error: lastErr
        };
    };

    const handlePickKnowledgeTxtInModal = useCallback(async (name) => {
        setIsLoadingAI(true);
        setKnowledgeTxtPickerError("");
        try {
            await openKnowledgeTxtInModal(name, { markSelected: true });
        } catch (err) {
            const msg = String(err?.message || err || "未知錯誤");
            setKnowledgeTxtPickerError(msg);
            setIsLoadingAI(false);
        }
    }, [openKnowledgeTxtInModal]);

    const openManualKnowledgeTxtPickerForModal = useCallback(() => {
        if (manualKnowledgeTxtInputRef.current) {
            manualKnowledgeTxtInputRef.current.value = "";
            manualKnowledgeTxtInputRef.current.click();
        }
    }, []);

    const handleManualKnowledgeTxtFileForModal = useCallback(async (file) => {
        if (!file) return;
        setIsLoadingAI(true);
        setKnowledgeTxtPickerError("");
        try {
            mergeFilesIntoSelectedFolderMap([file]);
            await openKnowledgeTxtInModal(file, { markSelected: true, allowPlainText: true });
            setShowModal(true);
        } catch (err) {
            setKnowledgeTxtPickerError(String(err?.message || err || "開啟文字檔失敗。"));
            setIsLoadingAI(false);
        }
    }, [mergeFilesIntoSelectedFolderMap, openKnowledgeTxtInModal]);

    const saveBlobByBrowserDownload = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const saveBlobToOpenedFolder = async (blob, filename) => {
        const dirHandle = openedFolderHandleRef.current;
        if (!dirHandle || typeof dirHandle.getFileHandle !== 'function') return false;
        try {
            let perm = 'granted';
            if (typeof dirHandle.queryPermission === 'function') {
                perm = await dirHandle.queryPermission({ mode: 'readwrite' });
            }
            if (perm !== 'granted' && typeof dirHandle.requestPermission === 'function') {
                perm = await dirHandle.requestPermission({ mode: 'readwrite' });
            }
            if (perm !== 'granted') return false;

            const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            try {
                const savedFile = await fileHandle.getFile();
                mergeFilesIntoSelectedFolderMap([savedFile]);
            } catch (_) { }
            return true;
        } catch (err) {
            console.warn(`Save to opened folder failed (${openedFolderNameRef.current || 'unknown folder'}):`, err);
            return false;
        }
    };

    const saveBlobToPreferredFolder = async (blob, filename, { allowBrowserDownload = false } = {}) => {
        const written = await saveBlobToOpenedFolder(blob, filename);
        if (written) return { mode: 'opened-folder' };
        if (allowBrowserDownload) {
            saveBlobByBrowserDownload(blob, filename);
            return { mode: 'browser-download' };
        }
        return { mode: 'not-saved' };
    };

    const prepareLrcKnowledgeBank = useCallback(async ({ sourceText, quizTargetLanguage, onProgress, onDraft = null } = {}) => {
        const track = (currentTrackIndex >= 0 && playlist[currentTrackIndex]) ? playlist[currentTrackIndex] : null;
        const rawName = String(track?.mediaFile?.name || track?.name || track?.subFile?.name || `LRC_${Math.max(1, currentTrackIndex + 1)}`);
        const baseName = String(getTrackBaseNameForKnowledge(track) || rawName.replace(/\.[^/.]+$/, '').trim() || `LRC_${Math.max(1, currentTrackIndex + 1)}`);
        const KP_TRACE = true;
        const kpRawPreview = (text, max = 420) => String(text || "").replace(/\r/g, "").replace(/\n/g, "\\n").slice(0, max);
        const kpTrace = (step, data = {}) => {
            if (!KP_TRACE) return;
            try {
                let text = "";
                if (typeof data === "string") text = data;
                else {
                    try { text = JSON.stringify(data); } catch (_) { text = String(data); }
                }
                console.warn(`[LRC_KP_TRACE] ${step} ${String(text || "").slice(0, 1200)}`);
            } catch (_) { }
        };
        const kpCounts = (normalized) => ({
            total: normalized?.points?.length || 0,
            vocab: normalized?.byCategory?.vocab?.length || 0,
            usage: normalized?.byCategory?.usage?.length || 0,
            grammar: normalized?.byCategory?.grammar?.length || 0,
            pattern: normalized?.byCategory?.pattern?.length || 0,
            reading: normalized?.byCategory?.reading?.length || 0,
            listening: normalized?.byCategory?.listening?.length || 0
        });

        const digestSeed = `${rawName}|${quizTargetLanguage}|${sourceText.length}|${sourceText.slice(0, 240)}|${sourceText.slice(-120)}|v2_examples`;
        let hash = 0;
        for (let i = 0; i < digestSeed.length; i++) {
            hash = ((hash << 5) - hash) + digestSeed.charCodeAt(i);
            hash |= 0;
        }
        const trackKey = `${baseName}:${Math.abs(hash).toString(36)}`;
        kpTrace("start", {
            rawName,
            baseName,
            trackKey,
            quizTargetLanguage,
            sourceChars: String(sourceText || "").length,
            sourceLines: String(sourceText || "").split('\n').length
        });
        const sourceCharsForQuality = String(sourceText || "").length;
        const isLongSourceForQuality = sourceCharsForQuality >= 1800;
        const requiredCachedVocab = isLongSourceForQuality ? 12 : 8;
        const requiredCachedUsage = isLongSourceForQuality ? 6 : 4;
        const cached = quizKnowledgeBankMap[trackKey];
        const cachedVocabCount = cached?.byCategory?.vocab?.length || 0;
        const cachedUsageCount = cached?.byCategory?.usage?.length || 0;
        const cachedCoreCount = cachedVocabCount + cachedUsageCount;
        const cachedPoints = Array.isArray(cached?.points) ? cached.points : [];
        const cachedGenericDetailRegex = /^(字幕關鍵字|常見搭配(?:\/連用)?|句式觀察|句型練習|教材關鍵字彙|常見口語句型|可替換名詞做造句)$/;
        const meaningfulDetailCount = cachedPoints.filter(p => {
            const d = String(p?.detail || "");
            return /[\u4e00-\u9fff]/.test(d) && d.length >= 8 && !cachedGenericDetailRegex.test(d);
        }).length;
        const cachedDetailRatio = cachedPoints.length > 0 ? (meaningfulDetailCount / cachedPoints.length) : 0;
        const shouldUseCached = !!(
            cached &&
            Array.isArray(cached.points) &&
            cached.points.length > 0 &&
            cachedCoreCount >= 2 &&
            cachedVocabCount >= requiredCachedVocab &&
            cachedUsageCount >= requiredCachedUsage &&
            cachedDetailRatio >= 0.4
        );
        if (shouldUseCached) {
            kpTrace("cache.hit", {
                source: "quizKnowledgeBankMap",
                cachedCoreCount,
                cachedDetailRatio: Number(cachedDetailRatio.toFixed(3)),
                requiredCachedVocab,
                requiredCachedUsage,
                counts: kpCounts(cached)
            });
            setQuizKnowledgePointsPool(cached.points);
            setQuizKnowledgeFileInfo({
                filename: cached.filename,
                total: cached.points.length,
                generatedAt: cached.generatedAt,
                targetLanguage: cached.targetLanguage || trackLanguage
            });
            return cached;
        }
        kpTrace("cache.miss", {
            cachedPoints: cached?.points?.length || 0,
            cachedCoreCount,
            cachedDetailRatio: Number(cachedDetailRatio.toFixed(3)),
            requiredCachedVocab
        });

        const baseNameCandidates = getTrackKnowledgeBaseCandidates(track);
        const existingKnowledgeFileCandidates = baseNameCandidates.flatMap((b) => buildKnowledgeFileCandidates(b));
        let existingKnowledgeProbe = { exists: false, source: "none" };

        // Highest priority: if user already selected a knowledge txt in folder, use it.
        const selectedKnowledgeFile = getSelectedKnowledgeTxtFileFromFolderMap();
        if (selectedKnowledgeFile && (typeof selectedKnowledgeFile.text === 'function' || typeof selectedKnowledgeFile.arrayBuffer === 'function')) {
            existingKnowledgeProbe = {
                exists: true,
                source: "selected-txt",
                file: selectedKnowledgeFile,
                filename: String(selectedKnowledgeFile?.name || "")
            };
        }

        if (!existingKnowledgeProbe?.exists) {
            for (const candidateBase of (baseNameCandidates.length > 0 ? baseNameCandidates : [baseName])) {
                const hit = await probeKnowledgeFileByBaseName(candidateBase, {
                    refreshFromHandle: true,
                    deepScan: true,
                    ignoreCache: false
                });
                if (hit?.exists) {
                    existingKnowledgeProbe = { ...hit, baseName: candidateBase };
                    break;
                }
            }
        }

        if (!existingKnowledgeProbe?.exists) {
            const heuristicFile = findKnowledgeFileHeuristically(baseNameCandidates, selectedFolderFilesRef.current || {});
            if (heuristicFile) {
                existingKnowledgeProbe = {
                    exists: true,
                    source: "heuristic",
                    file: heuristicFile,
                    filename: String(heuristicFile?.name || "")
                };
            }
        }
        const existingKnowledgeFile = existingKnowledgeProbe?.file || null;
        kpTrace("folder.lookup", {
            baseName,
            baseNameCandidates,
            candidates: existingKnowledgeFileCandidates,
            found: !!existingKnowledgeFile,
            foundName: existingKnowledgeFile?.name || "",
            source: existingKnowledgeProbe?.source || "none"
        });
        if (existingKnowledgeFile && (typeof existingKnowledgeFile.text === 'function' || typeof existingKnowledgeFile.arrayBuffer === 'function')) {
            try {
                const rawTxt = await readTextFileRobust(existingKnowledgeFile, { purpose: "knowledge" });
                const txt = String(rawTxt || "");
                const parsedPayload = parseKnowledgeTxtToPayload(txt);
                let normalizedFromTxt = normalizeQuizKnowledgeBankPayload(parsedPayload);
                let txtPoints = Array.isArray(normalizedFromTxt?.points) ? normalizedFromTxt.points : [];
                let txtVocabCount = normalizedFromTxt?.byCategory?.vocab?.length || 0;
                let txtUsageCount = normalizedFromTxt?.byCategory?.usage?.length || 0;
                const txtMeaningfulDetailCount = txtPoints.filter(p => {
                    const d = String(p?.detail || "");
                    return /[\u4e00-\u9fff]/.test(d) && d.length >= 8 && !cachedGenericDetailRegex.test(d);
                }).length;
                const txtDetailRatio = txtPoints.length > 0 ? (txtMeaningfulDetailCount / txtPoints.length) : 0;
                const txtRequiredVocab = requiredCachedVocab;
                const txtRequiredUsage = requiredCachedUsage;

                // 若解析器因格式差異抓不到點，退回以純文字行抽取，避免重生。
                if (!txtPoints.length) {
                    const fallbackItems = [];
                    const lines = String(txt || "").split('\n');
                    for (const rawLine of lines) {
                        const line = String(rawLine || "").trim();
                        if (!line) continue;
                        if (isKnowledgeMetaLine(line) || isKnowledgeOriginalMarkerLine(line)) continue;
                        const m = line.match(/^\d+\.\s*(.+)$/);
                        const point = cleanQuizDisplayText(m ? m[1] : line);
                        if (!point) continue;
                        fallbackItems.push({ point, explanationZh: "從既有知識點檔載入" });
                        if (fallbackItems.length >= 50) break;
                    }
                    if (fallbackItems.length) {
                        normalizedFromTxt = normalizeQuizKnowledgeBankPayload({
                            knowledgePoints: { vocab: fallbackItems, usage: [], grammar: [], pattern: [], reading: [], listening: [] }
                        });
                        txtPoints = Array.isArray(normalizedFromTxt?.points) ? normalizedFromTxt.points : [];
                        txtVocabCount = normalizedFromTxt?.byCategory?.vocab?.length || 0;
                        txtUsageCount = normalizedFromTxt?.byCategory?.usage?.length || 0;
                        kpTrace("folder.txt.fallbackParsed", {
                            fallbackPoints: fallbackItems.length,
                            counts: kpCounts(normalizedFromTxt)
                        });
                    }
                }

                // 需求：授權資料夾中已有知識點 txt 時，不重新生成。
                const txtQualityPass = txtPoints.length > 0;
                kpTrace("folder.txt.parsed", {
                    txtChars: String(txt || "").length,
                    counts: kpCounts(normalizedFromTxt),
                    txtDetailRatio: Number(txtDetailRatio.toFixed(3)),
                    txtRequiredVocab,
                    txtRequiredUsage,
                    txtQualityPass
                });
                if (txtQualityPass) {
                    const declaredTargetLanguage = extractKnowledgeTxtDeclaredLanguage(rawTxt, quizTargetLanguage || trackLanguage);
                    const knowledgeBankFromTxt = {
                        trackKey,
                        baseName,
                        filename: existingKnowledgeFile.name || `${baseName}知識點.txt`,
                        generatedAt: Date.now(),
                        targetLanguage: declaredTargetLanguage || quizTargetLanguage || trackLanguage,
                        points: normalizedFromTxt.points,
                        byCategory: normalizedFromTxt.byCategory,
                        txt: rawTxt
                    };
                    setQuizKnowledgeBankMap(prev => ({ ...prev, [trackKey]: knowledgeBankFromTxt }));
                    setQuizKnowledgePointsPool(knowledgeBankFromTxt.points);
                    setQuizKnowledgeFileInfo({
                        filename: knowledgeBankFromTxt.filename,
                        total: knowledgeBankFromTxt.points.length,
                        generatedAt: knowledgeBankFromTxt.generatedAt,
                        targetLanguage: knowledgeBankFromTxt.targetLanguage || quizTargetLanguage || trackLanguage
                    });
                    setQuizGenerationStage("已從同資料夾知識點檔讀取（不重新生成）。");
                    kpTrace("folder.txt.use", {
                        filename: knowledgeBankFromTxt.filename,
                        total: knowledgeBankFromTxt.points.length
                    });
                    return knowledgeBankFromTxt;
                }
                kpTrace("folder.txt.skipLowQuality", {
                    txtPoints: txtPoints.length,
                    txtVocabCount,
                    txtUsageCount,
                    txtDetailRatio: Number(txtDetailRatio.toFixed(3))
                });
            } catch (err) {
                console.warn("Load knowledge txt from folder failed:", err);
                kpTrace("folder.txt.failed", {
                    error: String(err?.message || err)
                });
            }
        }

        setQuizGenerationStage("AI 正在分析全篇內容...");

        const MAX_SOURCE_CHARS = 22000;
        const safeSource = sourceText.length > MAX_SOURCE_CHARS
            ? `${sourceText.slice(0, MAX_SOURCE_CHARS)}\n...`
            : sourceText;
        const chunks = [safeSource];
        kpTrace("chunk.prepare", {
            chunkCount: chunks.length,
            safeSourceChars: safeSource.length
        });

        const mergedRawKnowledge = {
            knowledgePoints: {
                vocab: [], usage: [], grammar: [], pattern: [], reading: [], listening: []
            }
        };
        const buildHeuristicKnowledgePayload = (text) => {
            const langTag = String(quizTargetLanguage || trackLanguage || "").toLowerCase();
            const isJapanese = /^ja/.test(langTag);
            const sanitizeLine = (line) => String(line || "")
                .replace(/\[[0-9:.]+\]/g, ' ')
                .replace(/<[^>]*>/g, ' ')
                .replace(/^\s*(?:\d+\s*[.)、．]\s*)+/g, '')
                .replace(/^\s*第\s*\d+\s*[課课篇章節节]\s*/i, '')
                .replace(/\s+/g, ' ')
                .trim();

            const rawLines = String(text || "").split('\n').map(sanitizeLine).filter(Boolean);
            const lines = [];
            const lineSeen = new Set();
            for (const line of rawLines) {
                if (lineSeen.has(line)) continue;
                lineSeen.add(line);
                lines.push(line);
                if (lines.length >= 120) break;
            }

            if (isJapanese) {
                const jpTokenRegex = /[ぁ-ゖァ-ヺー々〆〤一-龯]{2,}/g;
                const jpSingleTokenRegex = /^[ぁ-ゖァ-ヺー々〆〤一-龯]{2,}$/;
                const headingRegex = /^(言葉|ことば|単語|語彙|文法|会話|例文|れいぶん|例|練習|れんしゅう|第\s*\d+\s*課)$/i;
                const sentenceHintRegex = /(です|ます|でした|ません|ましょう|ください|ですか|ますか|[。！？?!])$/;
                const tokenSeen = new Set();
                const tokenList = [];
                const vocabList = [];
                const vocabSeen = new Set();
                const pushVocab = (raw, sourceLine) => {
                    const term = String(raw || "")
                        .replace(/^\s*(?:\d+\s*[.)、．]\s*)+/g, '')
                        .replace(/[「」『』（）()\[\]【】]/g, '')
                        .replace(/[。．、，,・･]/g, '')
                        .trim();
                    if (!term) return;
                    if (headingRegex.test(term)) return;
                    if (!jpSingleTokenRegex.test(term)) return;
                    if (sentenceHintRegex.test(term)) return;

                    const key = term.toLowerCase();
                    if (vocabSeen.has(key)) return;
                    vocabSeen.add(key);

                    let example = sourceLine || "";
                    if (example.trim() === term) {
                        const better = lines.find(l => l.includes(term) && l.length > term.length && l.length < 60);
                        if (better) example = better;
                    }
                    vocabList.push({ point: term, explanationZh: "教材關鍵字彙", example: example });
                };

                for (const line of lines) {
                    const splitTerms = line
                        .split(/[、，,／/・･\s]+/)
                        .map(x => x.trim())
                        .filter(Boolean);
                    const isSentence = sentenceHintRegex.test(line);
                    if (splitTerms.length >= 1 && splitTerms.length <= 8 && !isSentence) {
                        for (const term of splitTerms) pushVocab(term, line);
                    } else if (splitTerms.length === 1 && !isSentence) {
                        pushVocab(splitTerms[0], line);
                    }
                }

                for (const line of lines) {
                    const tokens = line.match(jpTokenRegex) || [];
                    for (const t of tokens) {
                        const key = t.toLowerCase();
                        if (tokenSeen.has(key)) continue;
                        tokenSeen.add(key);
                        tokenList.push({ term: t, line: line });
                        if (tokenList.length >= 80) break;
                    }
                    if (tokenList.length >= 80) break;
                }

                for (const item of tokenList) pushVocab(item.term, item.line);
                const TARGET_VOCAB_COUNT = 40;
                const vocab = vocabList.slice(0, TARGET_VOCAB_COUNT);

                const usage = [];
                const usageSeen = new Set();
                for (const line of lines) {
                    const tokens = line.match(jpTokenRegex) || [];
                    if (tokens.length >= 2) {
                        const phrase = `${tokens[0]} ${tokens[1]}`;
                        const key = phrase.toLowerCase();
                        if (!usageSeen.has(key)) {
                            usageSeen.add(key);
                            usage.push({ point: phrase, explanationZh: "常見搭配/連用", example: line });
                        }
                    } else if (/(です|ます|でした|ません|ましょう|ください)/.test(line)) {
                        const key = line.toLowerCase();
                        if (!usageSeen.has(key)) {
                            usageSeen.add(key);
                            usage.push({ point: line.slice(0, 24), explanationZh: "常見口語句型", example: line });
                        }
                    }
                    if (usage.length >= 10) break;
                }

                if (usage.length < 4) {
                    const templates = ['ここです', 'そこです', 'あそこです', 'どこです', 'こちらです', 'そちらです', 'あちらです', 'どちらです'];
                    for (const t of templates) {
                        if (usage.length >= 8) break;
                        if (usageSeen.has(t)) continue;
                        usageSeen.add(t);
                        usage.push({ point: t, explanationZh: "指示詞基本句", example: t });
                    }
                }

                const grammar = [];
                const hasKosoado = tokenList.some(item => /^(ここ|そこ|あそこ|どこ|こちら|そちら|あちら|どちら)$/.test(item.term));
                if (hasKosoado) {
                    grammar.push({ point: "こそあど詞", explanationZh: "近稱/中稱/遠稱/疑問的指示系統", example: "ここは教室です" });
                }
                if (lines.some(line => /(は).*(です|だ)/.test(line) || /です$/.test(line))) {
                    grammar.push({ point: "NはNです", explanationZh: "日文基本判斷句型", example: "私は学生です" });
                }
                if (lines.some(line => /の/.test(line))) {
                    grammar.push({ point: "N1のN2", explanationZh: "名詞修飾與所屬關係", example: "私の本" });
                }
                if (grammar.length < 3) {
                    grammar.push({ point: "疑問詞 + ですか", explanationZh: "基礎問句句尾型", example: "これは何ですか" });
                }

                const pattern = [];
                for (const line of lines) {
                    const cleaned = line.replace(/\s+/g, ' ').trim();
                    if (!cleaned) continue;
                    if ((cleaned.match(jpTokenRegex) || []).length === 0) continue;
                    if (!/(です|ます|か|は|を|に|で|の|へ|と)/.test(cleaned)) continue;
                    if (cleaned.length > 28) continue;
                    pattern.push({ point: cleaned, explanationZh: "可替換名詞做造句", example: cleaned });
                    if (pattern.length >= 8) break;
                }

                return {
                    knowledgePoints: {
                        vocab,
                        usage,
                        grammar: grammar.slice(0, 6),
                        pattern,
                        reading: [],
                        listening: []
                    }
                };
            }

            const vocabSeen = new Set();
            const vocab = [];
            for (const line of lines) {
                const words = line.match(/[A-Za-z][A-Za-z'-]{3,}/g) || [];
                for (const w of words) {
                    const key = w.toLowerCase();
                    if (vocabSeen.has(key)) continue;
                    vocabSeen.add(key);
                    vocab.push({ point: w, explanationZh: "字幕關鍵字", example: line });
                    if (vocab.length >= 12) break;
                }
                if (vocab.length >= 12) break;
            }

            const usage = [];
            const usageSeen = new Set();
            for (const line of lines) {
                const words = (line.match(/[A-Za-z][A-Za-z'-]{2,}/g) || []).slice(0, 12);
                for (let i = 0; i < words.length - 1; i++) {
                    const phrase = `${words[i]} ${words[i + 1]}`.trim();
                    if (phrase.length < 5 || phrase.length > 28) continue;
                    const key = phrase.toLowerCase();
                    if (usageSeen.has(key)) continue;
                    usageSeen.add(key);
                    usage.push({ point: phrase, explanationZh: "常見搭配", example: line });
                    if (usage.length >= 8) break;
                }
                if (usage.length >= 8) break;
            }

            const sentenceSnips = lines.map(x => x.slice(0, 36)).filter(Boolean);
            const grammar = sentenceSnips.slice(0, 6).map(x => ({ point: x, explanationZh: "句式觀察", example: x }));
            const pattern = sentenceSnips.slice(6, 14).map(x => ({ point: x, explanationZh: "句型練習", example: x }));

            return {
                knowledgePoints: {
                    vocab,
                    usage,
                    grammar,
                    pattern,
                    reading: [],
                    listening: []
                }
            };
        };

        // Keep prompt length bridge-friendly; oversized prompts frequently miss runtime bridge and fall back to 401 fetch path.
        const sourcePromptText = compactAiPromptText(chunks[0] || safeSource, 2800);
        const ALLOW_LOCAL_KNOWLEDGE_FALLBACK = false;
        kpTrace("source.compacted", {
            compactChars: sourcePromptText.length,
            compactLines: sourcePromptText.split('\n').length,
            compactPreview: kpRawPreview(sourcePromptText, 220)
        });

        const isFatalAuth401 = (text) => /(?:^|\b)Error:\s*Text Gen API Error 401\b/i.test(String(text || ""));
        const englishStopwords = new Set([
            "the", "a", "an", "this", "that", "these", "those", "and", "or", "but", "if", "then", "so", "than",
            "to", "of", "in", "on", "at", "for", "with", "from", "by", "as", "is", "am", "are", "was", "were", "be",
            "been", "being", "do", "does", "did", "have", "has", "had", "will", "would", "can", "could", "shall",
            "should", "may", "might", "must", "it", "its", "he", "she", "they", "we", "you", "i", "me", "him", "her",
            "them", "our", "your", "their", "his", "hers", "my", "mine", "yours", "ours", "theirs"
        ]);
        const genericDetailRegex = /^(字幕關鍵字|常見搭配(?:\/連用)?|句式觀察|句型練習|教材關鍵字彙|常見口語句型|可替換名詞做造句)$/;
        const hasZh = (text) => /[\u4e00-\u9fff]/.test(String(text || ""));
        const isEnglishOnly = (text) => /^[A-Za-z][A-Za-z'\- ]*$/.test(String(text || "").trim());
        const countWords = (text) => String(text || "").trim().split(/\s+/).filter(Boolean).length;
        const defaultDetailByCategory = {
            vocab: "說明此字在本篇語境中的中文義與常見用法。",
            usage: "說明此搭配的語意、語氣與常見使用情境。",
            grammar: "說明此文法結構的形式、語意與使用時機。",
            pattern: "說明此句型可替換的成分與溝通功能。",
            reading: "說明此閱讀重點與推論依據。",
            listening: "說明此聽力辨識重點與易混處。"
        };

        const absorbKnowledgePayload = (payload, source = "ai") => {
            const kp = payload?.knowledgePoints || payload?.knowledge_points || payload || {};
            const added = { vocab: 0, usage: 0, grammar: 0, pattern: 0, reading: 0, listening: 0 };
            ['vocab', 'usage', 'grammar', 'pattern', 'reading', 'listening'].forEach(cat => {
                if (Array.isArray(kp[cat])) {
                    mergedRawKnowledge.knowledgePoints[cat].push(...kp[cat]);
                    added[cat] = kp[cat].length;
                }
            });
            kpTrace(`${source}.parsed`, { added });
            return added;
        };

        const filterKnowledgeQuality = (normalized) => {
            const byCategory = {};
            for (const cat of QUIZ_FOCUS_TYPE_ORDER) {
                const items = Array.isArray(normalized?.byCategory?.[cat]) ? normalized.byCategory[cat] : [];
                byCategory[cat] = items
                    .map(item => {
                        const label = cleanQuizDisplayText(String(item?.label || ""));
                        const detailRaw = cleanQuizDisplayText(String(item?.detail || ""));
                        const detail = (!detailRaw || genericDetailRegex.test(detailRaw) || !hasZh(detailRaw))
                            ? defaultDetailByCategory[cat]
                            : detailRaw;
                        const examples = Array.isArray(item?.examples)
                            ? item.examples.map(x => cleanQuizDisplayText(String(x || ""))).filter(Boolean).slice(0, 2)
                            : [];
                        const tags = Array.isArray(item?.tags)
                            ? item.tags.map(x => cleanQuizDisplayText(String(x || ""))).filter(Boolean).slice(0, 8)
                            : [];
                        return { ...item, label, detail, examples, tags };
                    })
                    .filter(item => {
                        const label = String(item?.label || "");
                        if (!label) return false;
                        if (cat === 'vocab') {
                            if (/^\d+$/.test(label)) return false;
                            if (isEnglishOnly(label)) {
                                const low = label.toLowerCase().trim();
                                if (englishStopwords.has(low)) return false;
                                if (/^[A-Z][a-z]+$/.test(label)) return false; // likely proper noun
                                if (countWords(label) > 3) return false;
                                if (low.length < 3) return false;
                            }
                        }
                        if (cat === 'usage') {
                            if (countWords(label) < 2) return false;
                            if (isEnglishOnly(label)) {
                                const words = label.toLowerCase().split(/\s+/).filter(Boolean);
                                const contentWordCount = words.filter(w => !englishStopwords.has(w) && w.length >= 3).length;
                                if (contentWordCount < 1) return false;
                            }
                        }
                        if (cat === 'grammar') {
                            if (label.length < 4) return false;
                            if (isEnglishOnly(label) && countWords(label) > 14 && !/(?:to\s+V|have to|be going to|if\s+|relative clause|passive|present perfect|past perfect|modal|gerund|infinitive)/i.test(label)) {
                                return false;
                            }
                        }
                        if (cat === 'pattern') {
                            if (label.length < 4) return false;
                            if (isEnglishOnly(label) && countWords(label) < 3) return false;
                        }
                        return true;
                    });
            }
            const points = QUIZ_FOCUS_TYPE_ORDER.flatMap(k => byCategory[k] || []);
            return { points, byCategory };
        };

        const evaluateKnowledgeQuality = (normalized) => {
            const counts = kpCounts(normalized);
            const isLongSource = safeSource.length >= 1800;
            const minSpec = isLongSource
                ? { total: 26, vocab: 12, usage: 8, grammar: 4, pattern: 4 }
                : { total: 14, vocab: 6, usage: 4, grammar: 2, pattern: 2 };
            const detailList = (normalized?.points || []).map(p => String(p?.detail || ""));
            const meaningfulDetails = detailList.filter(d => hasZh(d) && d.length >= 8 && !genericDetailRegex.test(d));
            const detailRatio = detailList.length > 0 ? (meaningfulDetails.length / detailList.length) : 0;
            const passCounts =
                counts.total >= minSpec.total &&
                counts.vocab >= minSpec.vocab &&
                counts.usage >= minSpec.usage &&
                counts.grammar >= minSpec.grammar &&
                counts.pattern >= minSpec.pattern;
            const passDetail = detailRatio >= (isLongSource ? 0.55 : 0.4);
            return {
                counts,
                minSpec,
                detailRatio: Number(detailRatio.toFixed(3)),
                passCounts,
                passDetail,
                pass: passCounts && passDetail
            };
        };

        const normalizeMergedKnowledge = (tag = "normalize") => {
            const normalized = filterKnowledgeQuality(normalizeQuizKnowledgeBankPayload(mergedRawKnowledge));
            const quality = evaluateKnowledgeQuality(normalized);
            kpTrace(`${tag}.result`, quality);
            return { normalized, quality };
        };

        let lastDraftCount = 0;
        const emitKnowledgeDraft = (stage = "") => {
            if (typeof onDraft !== 'function') return;
            const normalizedDraft = filterKnowledgeQuality(normalizeQuizKnowledgeBankPayload(mergedRawKnowledge));
            const points = Array.isArray(normalizedDraft?.points) ? normalizedDraft.points : [];
            if (points.length <= 0) return;
            if (points.length <= lastDraftCount) return;
            lastDraftCount = points.length;
            const draftBank = {
                trackKey,
                baseName,
                filename: `${baseName}知識點.txt`,
                generatedAt: Date.now(),
                targetLanguage: quizTargetLanguage,
                points,
                byCategory: normalizedDraft.byCategory
            };
            draftBank.txt = buildQuizKnowledgeTxt(draftBank);
            try {
                onDraft({
                    stage,
                    counts: kpCounts(draftBank),
                    knowledgeBank: draftBank
                });
            } catch (_) { }
        };

        const runKnowledgeStage = async ({ stage, prompt, schemaHint }) => {
            const stageOrder = { "ai.main": 0, "ai.rescue": 1, "ai.improve": 2, "ai.last": 3 };
            const stageIdx = Number.isInteger(stageOrder[stage]) ? stageOrder[stage] : 0;
            if (onProgress) onProgress(`${stage} 執行中`, stageIdx, 4);
            kpTrace(`${stage}.request`, { promptChars: prompt.length });
            const raw = await callGeminiText(prompt, currentApiKey);
            kpTrace(`${stage}.response`, {
                rawChars: String(raw || "").length,
                rawPreview: kpRawPreview(raw)
            });
            if (isFatalAuth401(raw)) throw new Error(String(raw || "Text Gen API Error 401"));
            const payload = await parseAiJsonPayload(raw, {
                arrayField: "knowledgePoints",
                schemaHint
            });
            absorbKnowledgePayload(payload, stage);
            const parsedPreview = []
                .concat((payload?.knowledgePoints?.vocab || []).map(x => x?.point).filter(Boolean).slice(0, 2))
                .concat((payload?.knowledgePoints?.usage || []).map(x => x?.point).filter(Boolean).slice(0, 2))
                .slice(0, 4)
                .join(", ");
            if (onProgress) onProgress(`${stage} 完成`, stageIdx + 1, 4, parsedPreview);
            emitKnowledgeDraft(stage);
            return raw;
        };

        const knowledgeFormatRules = `
- 單字/用語 front 格式規則：
  - 若目標語言為英文：point 必須為「單字 + 空格 + IPA 音標」，例如：abandon /əˈbændən/
  - 若目標語言為日文且 point 含漢字：point 必須為「漢字（讀音）」，例如：交渉（こうしょう）
  - 若來源有 ruby 疊字格式（如：攻撃こうげき、大統領だいとうりょう），先正規化為「漢字（讀音）」再輸出，禁止保留重複寫法
  - 若日文詞條不含漢字：維持原詞即可
- examples 中每一句都必須含繁中翻譯，格式：
  <目標語言句子>（中譯：<繁中翻譯>）
`;

        let rawMain = "";
        try {
            setQuizGenerationStage("AI 正在分析全篇 LRC 並抽取高品質知識點...");
            const mainPrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
請根據整份 LRC 生成高品質「知識點檔」資料（不是摘要），需可直接用於出題。

[OUTPUT]
僅輸出 JSON（不要 markdown）：
{
  "knowledgePoints": {
    "vocab": [{ "point": "字詞(目標語言)", "explanationZh": "繁中中文義與用法重點", "examples": ["取自LRC的例句（中譯：繁中翻譯）"], "tags": ["詞性","主題"] }],
    "usage": [{ "point": "搭配/片語/固定用法", "explanationZh": "繁中解釋（何時用、語氣）", "examples": ["例句（中譯：繁中翻譯）"], "tags": ["搭配"] }],
    "grammar": [{ "point": "文法規則或結構名稱", "explanationZh": "繁中規則說明（有意義、可操作）", "examples": ["例句（中譯：繁中翻譯）"], "tags": ["文法"] }],
    "pattern": [{ "point": "句型模板（可替換成分）", "explanationZh": "繁中句型說明", "examples": ["例句（中譯：繁中翻譯）"], "tags": ["句型"] }],
    "reading": [{ "point": "閱讀理解重點", "explanationZh": "繁中推論/理解說明", "examples": ["例句（中譯：繁中翻譯）"], "tags": ["閱讀"] }],
    "listening": [{ "point": "聽力辨識重點", "explanationZh": "繁中聽辨說明", "examples": ["例句（中譯：繁中翻譯）"], "tags": ["聽力"] }]
  }
}

[HARD RULES]
- point 必須是目標語言（trackLanguage: ${quizTargetLanguage}）。
${knowledgeFormatRules}
- explanationZh 必須是繁體中文，且要具體有意義，禁止空泛字樣（如：字幕關鍵字、常見搭配、句式觀察、句型練習）。
- vocab 僅收「可學習詞彙」：避免冠詞/連接詞/代名詞/單純專有名詞/日期月份。
- usage 必須是可教的搭配或片語，不可是隨機相鄰兩詞。
- grammar 必須是文法規則或結構，不可是截斷句子片段。
- pattern 必須是可替換的句型模板，不能只有單字。
- examples 盡量取自 LRC 原句或貼近原句，每點 1-2 句。
- 請盡量覆蓋不同知識點，不要重複同義點。

[TARGET COUNTS]
- vocab 16-30
- usage 8-18
- grammar 4-10
- pattern 4-10
- reading 2-6
- listening 2-6

[FULL LRC]
${sourcePromptText}`;
            rawMain = await runKnowledgeStage({
                stage: "ai.main",
                prompt: mainPrompt,
                schemaHint: "{ knowledgePoints: { vocab:[{point,explanationZh,examples,tags}], usage:[...], grammar:[...], pattern:[...], reading:[...], listening:[...] } }"
            });
        } catch (e) {
            kpTrace("ai.main.failed", { error: String(e?.message || e) });
        }

        let { normalized, quality } = normalizeMergedKnowledge("quality.main");
        let rawRescue = "";
        if (!quality.pass && rawMain) {
            try {
                setQuizGenerationStage("AI 正在修正知識點格式與品質...");
                const rescuePrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
把下列內容重整為「高品質知識點 JSON」。若原內容有空泛說明或亂組搭配，請直接重寫。

[OUTPUT]
{
  "knowledgePoints": {
    "vocab": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }],
    "usage": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }],
    "grammar": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }],
    "pattern": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }],
    "reading": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }],
    "listening": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }]
  }
}

[RULES]
${knowledgeFormatRules}
- explanationZh 必須繁中且具體，不可空泛。
- 禁止把專有名詞當核心單字（除非是該主題關鍵詞）。
- usage 必須是自然搭配，不可「World This」這種無效組合。
- grammar/pattern 不可用截斷句子充數。
- 只輸出 JSON。

[RAW]
${String(rawMain || "").slice(0, 5200)}`;
                rawRescue = await runKnowledgeStage({
                    stage: "ai.rescue",
                    prompt: rescuePrompt,
                    schemaHint: "{ knowledgePoints: { vocab:[], usage:[], grammar:[], pattern:[], reading:[], listening:[] } }"
                });
            } catch (e) {
                kpTrace("ai.rescue.failed", { error: String(e?.message || e) });
            }
            ({ normalized, quality } = normalizeMergedKnowledge("quality.afterRescue"));
        }

        let rawImprove = "";
        if (!quality.pass) {
            try {
                setQuizGenerationStage("AI 正在重新生成更完整的知識點...");
                const improvePrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
從零重做整份 LRC 的知識點檔，優先保證內容可教、可出題。

[OUTPUT]
{
  "knowledgePoints": {
    "vocab": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }],
    "usage": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }],
    "grammar": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }],
    "pattern": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }],
    "reading": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }],
    "listening": [{ "point": "...", "explanationZh": "...", "examples": ["..."], "tags": ["..."] }]
  }
}

[QUALITY MUST]
- 目標語言：${quizTargetLanguage}
${knowledgeFormatRules}
- 中文說明要有意義，可協助學習，不可模板化空話。
- 單字要挑可學詞彙，不要大量功能詞與專有名詞。
- 用語要是自然搭配/片語，不可亂拼兩詞。
- 文法要是規則或結構；句型要有可替換模板。
- reading/listening 至少各 2 點（若內容足夠）。
- 只輸出 JSON，不要任何額外文字。

[FULL LRC]
${sourcePromptText}`;
                rawImprove = await runKnowledgeStage({
                    stage: "ai.improve",
                    prompt: improvePrompt,
                    schemaHint: "{ knowledgePoints: { vocab:[], usage:[], grammar:[], pattern:[], reading:[], listening:[] } }"
                });
            } catch (e) {
                kpTrace("ai.improve.failed", { error: String(e?.message || e) });
            }
            ({ normalized, quality } = normalizeMergedKnowledge("quality.afterImprove"));
        }

        let rawLast = "";
        if (!quality.pass) {
            try {
                setQuizGenerationStage("AI 最後補救中（知識點重整）...");
                const lastPrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
最後一次：只輸出合法 JSON 的 knowledgePoints（六類），內容必須可教、可出題。

[OUTPUT]
{"knowledgePoints":{"vocab":[],"usage":[],"grammar":[],"pattern":[],"reading":[],"listening":[]}}

[MUST]
- point 用目標語言（${quizTargetLanguage}）
${knowledgeFormatRules}
- explanationZh 為繁中且具體
- usage 不可亂拼
- grammar/pattern 不可截斷句
- 只輸出 JSON

[FULL LRC]
${sourcePromptText}`;
                rawLast = await runKnowledgeStage({
                    stage: "ai.last",
                    prompt: lastPrompt,
                    schemaHint: "{ knowledgePoints: { vocab:[], usage:[], grammar:[], pattern:[], reading:[], listening:[] } }"
                });
            } catch (e) {
                kpTrace("ai.last.failed", { error: String(e?.message || e) });
            }
            ({ normalized, quality } = normalizeMergedKnowledge("quality.afterLast"));
        }

        let rawMini = "";
        if (!quality.pass) {
            try {
                setQuizGenerationStage("AI 快速模式補救中（短提示）...");
                const miniPrompt = `請從以下 LRC 直接輸出 JSON：
{"knowledgePoints":{"vocab":[],"usage":[],"grammar":[],"pattern":[],"reading":[],"listening":[]}}
規則：
1) point 用 ${quizTargetLanguage}
2) explanationZh 用繁中且具體，不可空泛
3) vocab 不要 the/and/this 等功能詞，也避免一般專有名詞
4) usage 要自然搭配，不可亂拼
5) grammar/pattern 要可教，不可截斷句
6) 只輸出 JSON
7) 單字/用語若為英文，point 要帶 IPA（例：abandon /əˈbændən/）
8) 單字/用語若為日文且含漢字，point 要寫成 漢字（讀音）（例：交渉（こうしょう））
9) 若來源有 ruby 疊字（例如：攻撃こうげき、大統領だいとうりょう），必須正規化為 漢字（讀音），不可輸出重複字形
10) examples 每句都要含繁中翻譯，格式：<目標語句>（中譯：<繁中翻譯>）
LRC:
${sourcePromptText}`;
                rawMini = await runKnowledgeStage({
                    stage: "ai.mini",
                    prompt: miniPrompt,
                    schemaHint: "{ knowledgePoints: { vocab:[], usage:[], grammar:[], pattern:[], reading:[], listening:[] } }"
                });
            } catch (e) {
                kpTrace("ai.mini.failed", { error: String(e?.message || e) });
            }
            ({ normalized, quality } = normalizeMergedKnowledge("quality.afterMini"));
        }

        if (!quality.pass && ALLOW_LOCAL_KNOWLEDGE_FALLBACK && ((normalized?.byCategory?.vocab?.length || 0) < requiredCachedVocab)) {
            setQuizGenerationStage("AI 結果不足，補強教材單字中...");
            const heuristicPayload = buildHeuristicKnowledgePayload(safeSource);
            const hkp = heuristicPayload?.knowledgePoints || {};
            ['vocab', 'usage', 'grammar', 'pattern', 'reading', 'listening'].forEach(cat => {
                if (Array.isArray(hkp[cat])) {
                    mergedRawKnowledge.knowledgePoints[cat].push(...hkp[cat]);
                }
            });
            ({ normalized, quality } = normalizeMergedKnowledge("quality.afterHeuristicBoost"));
            emitKnowledgeDraft("local.heuristic");
        }

        if (!normalized.points || normalized.points.length < 3) {
            if (!ALLOW_LOCAL_KNOWLEDGE_FALLBACK) {
                kpTrace("final.aiOnly.failed", {
                    quality,
                    rawLens: {
                        main: String(rawMain || "").length,
                        rescue: String(rawRescue || "").length,
                        improve: String(rawImprove || "").length,
                        last: String(rawLast || "").length,
                        mini: String(rawMini || "").length
                    },
                    rawPreview: {
                        main: kpRawPreview(rawMain, 160),
                        rescue: kpRawPreview(rawRescue, 160),
                        improve: kpRawPreview(rawImprove, 160),
                        last: kpRawPreview(rawLast, 160),
                        mini: kpRawPreview(rawMini, 160)
                    }
                });
                throw new Error(
                    `知識點 AI 生成失敗（AI-only，未啟用 local fallback）。` +
                    ` [total:${quality?.counts?.total || 0}, vocab:${quality?.counts?.vocab || 0}, usage:${quality?.counts?.usage || 0}, grammar:${quality?.counts?.grammar || 0}, pattern:${quality?.counts?.pattern || 0}, detailRatio:${quality?.detailRatio || 0}]`
                );
            }
            setQuizGenerationStage("AI 抽取不足，改用本地快速整理...");
            normalized = filterKnowledgeQuality(normalizeQuizKnowledgeBankPayload(buildHeuristicKnowledgePayload(safeSource)));
            quality = evaluateKnowledgeQuality(normalized);
            kpTrace("quality.localHeuristicOnly", quality);
        }

        if (!normalized.points || normalized.points.length < 3) {
            kpTrace("final.failed", { reason: "points < 3", quality });
            throw new Error("知識點提取過少，請重試或檢查內容。");
        }

        const filename = `${baseName}知識點.txt`;
        const knowledgeBank = {
            trackKey,
            baseName,
            filename,
            generatedAt: Date.now(),
            targetLanguage: quizTargetLanguage,
            points: normalized.points,
            byCategory: normalized.byCategory
        };
        const txt = buildQuizKnowledgeTxt(knowledgeBank);
        knowledgeBank.txt = txt;
        emitKnowledgeDraft("final");

        setQuizKnowledgeBankMap(prev => ({ ...prev, [trackKey]: knowledgeBank }));
        setQuizKnowledgePointsPool(knowledgeBank.points);
        setQuizKnowledgeFileInfo({
            filename: knowledgeBank.filename,
            total: knowledgeBank.points.length,
            generatedAt: knowledgeBank.generatedAt,
            targetLanguage: knowledgeBank.targetLanguage || quizTargetLanguage || trackLanguage
        });

        const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        const saveResult = await saveBlobToPreferredFolder(blob, filename, { allowBrowserDownload: true });
        kpTrace("save.result", {
            mode: saveResult?.mode || "unknown",
            filename,
            counts: kpCounts(knowledgeBank)
        });
        if (saveResult?.mode === 'browser-download') {
            setQuizGenerationStage("未取得資料夾寫入權限，已改為瀏覽器下載知識點檔。");
        } else if (saveResult?.mode !== 'opened-folder') {
            setQuizGenerationStage("未取得資料夾讀寫授權，知識點檔未寫入磁碟。請先用「授權資料夾」授權。");
        }

        kpTrace("done", {
            trackKey,
            filename,
            counts: kpCounts(knowledgeBank)
        });
        return knowledgeBank;
    }, [buildQuizKnowledgeTxt, compactAiPromptText, currentApiKey, currentTrackIndex, learnerLevel, normalizeQuizKnowledgeBankPayload, parseAiJsonPayload, parseKnowledgeTxtToPayload, playlist, quizKnowledgeBankMap]);

    const pickKnowledgePointsForBatch = useCallback((knowledgeBank, { wrongPool = [] } = {}) => {
        const enabledCategories = getEnabledQuizFocusTypes();
        const poolByFocus = (knowledgeBank?.points || []).filter(p => enabledCategories.includes(p.category));
        const candidates = poolByFocus.length >= 10 ? poolByFocus : (knowledgeBank?.points || []);
        if (!Array.isArray(candidates) || candidates.length === 0) return [];

        const usageMap = quizKnowledgeUsageMapRef.current?.[knowledgeBank.trackKey] || {};
        const ranked = shuffleArray(candidates).sort((a, b) => {
            const ua = usageMap[a.key] || 0;
            const ub = usageMap[b.key] || 0;
            return ua - ub;
        });

        const selected = [];
        const selectedKeys = new Set();
        const loweredWrong = (wrongPool || [])
            .map(x => String(x || "").trim().toLowerCase())
            .filter(Boolean);

        for (const w of loweredWrong) {
            if (selected.length >= 3) break; // Reserve space for random coverage.
            const hit = ranked.find(p => {
                const label = String(p.label || "").toLowerCase();
                return !selectedKeys.has(p.key) && (label.includes(w) || w.includes(label));
            });
            if (!hit) continue;
            selected.push(hit);
            selectedKeys.add(hit.key);
        }

        for (const p of ranked) {
            if (selected.length >= 10) break;
            if (selectedKeys.has(p.key)) continue;
            selected.push(p);
            selectedKeys.add(p.key);
        }

        const withBatchId = selected.slice(0, 10).map((p, idx) => ({
            ...p,
            batchId: `KP${String(idx + 1).padStart(2, '0')}`
        }));
        return withBatchId;
    }, [getEnabledQuizFocusTypes]);

    const markKnowledgeBatchUsage = useCallback((trackKey, selectedBatch) => {
        if (!trackKey || !Array.isArray(selectedBatch) || selectedBatch.length === 0) return;
        setQuizKnowledgeUsageMap(prev => {
            const nextTrackMap = { ...(prev[trackKey] || {}) };
            for (const p of selectedBatch) {
                if (!p?.key) continue;
                nextTrackMap[p.key] = (nextTrackMap[p.key] || 0) + 1;
            }
            return { ...prev, [trackKey]: nextTrackMap };
        });
    }, []);

    const createReviewQuestion = useCallback((question) => {
        const mapped = (question.options || []).map((opt, idx) => ({
            opt,
            idx,
            rationale: question.optionRationales?.[idx] || ""
        }));
        const shuffled = shuffleArray(mapped);
        const answerIndex = shuffled.findIndex(x => x.idx === question.answerIndex);
        quizReviewIdRef.current += 1;
        const safeAnswerIndex = answerIndex === -1 ? 0 : answerIndex;
        return {
            ...question,
            id: `${question.id}-R${quizReviewIdRef.current}`,
            stem: `【複習】${question.stem}`,
            options: shuffled.map(x => x.opt),
            answerIndex: safeAnswerIndex,
            answerText: shuffled[safeAnswerIndex]?.opt || question.answerText,
            optionRationales: shuffled.map((x, idx) => {
                if (x.rationale) return x.rationale;
                return idx === safeAnswerIndex
                    ? "此選項符合本題句意與語法。"
                    : "此選項不符合本題句意或語法。";
            }),
            isReview: true,
            optionsShuffled: true
        };
    }, []);

    const isKnowledgePreviewModalState = (mode, title, content, fileInfo) => {
        if (mode !== 'text') return false;
        if (fileInfo && typeof fileInfo === 'object') return true;
        const titleText = String(title || "").trim();
        if (/知識點/.test(titleText)) return true;
        const contentText = String(content || "").trim();
        if (!contentText) return false;
        return (
            contentText.includes("@K_HEADER@") ||
            contentText.includes("LRC 知識點整理") ||
            contentText.includes("[原文]")
        );
    };

    const handleGenerateKnowledgeBankOnly = async () => {
        if (playerRef.current) { playerRef.current.pause(); setIsPlaying(false); }

        setShowModal(true);
        // Knowledge mode is whole-document based, not current sentence based.
        setSmartTargetDisplay("");
        setTargetTranslation("");
        setAiMode('text');
        setModalTitle("LRC 知識點整理 (預覽)");
        setModalContent("正在準備...");
        setIsLoadingAI(true);
        setShowKnowledgeTxtPicker(false);
        setKnowledgeTxtPickerError("");

        try {
            const localOpen = await tryOpenExistingKnowledgeTxtForCurrentTrack();
            if (localOpen?.ok) return;
            if (Number(localOpen?.attemptedFiles || 0) > 0) {
                setModalContent(`已偵測到知識點檔，但讀取失敗：${String(localOpen?.error || "未知錯誤")}\n請用「開啟文字檔」或「選其他TXT」手動指定可讀文字檔。`);
                setIsLoadingAI(false);
                return;
            }
        } catch (_) { }

        setModalContent("目前找不到可用的知識點 txt。請先按「授權資料夾」，或在右上使用「選其他TXT／開啟文字檔」載入既有檔案。");
        setIsLoadingAI(false);
        return;

        const sourceText = buildLrcQuizSource();

        if (!sourceText) {
            const fallbackName = String(selectedKnowledgeTxtName || knowledgeTxtOptions[0] || "").trim();
            if (fallbackName) {
                try {
                    await openKnowledgeTxtInModal(fallbackName, { markSelected: true });
                    return;
                } catch (err) {
                    setModalContent(`錯誤：${String(err?.message || err || "未知錯誤")}`);
                    setIsLoadingAI(false);
                    return;
                }
            }
            setModalContent("目前沒有可用的 mp3/lrc 來自動生成知識點，且尚未找到可載入的知識點 txt。\n請先按「授權資料夾」，再用右上「選其他TXT」載入。");
            setIsLoadingAI(false);
            return;
        }

        try {
            const quizTargetLanguage = inferQuizTargetLanguage(sourceText, trackLanguage);

            let progressLog = "";
            let latestProgressHeader = "";
            const onProgress = (msg, idx, total, preview) => {
                if (msg && !preview) progressLog += `\n[${idx + 1}/${total}] ${msg}`;
                if (preview) progressLog += ` => 提取: ${preview}`;
                if (msg) progressLog += `\n${msg}`;
                if (preview) progressLog += `\n${preview}`;
                latestProgressHeader = `### 處理進度 (${idx + 1}/${total})\n${progressLog}`;
                setModalContent(latestProgressHeader);
            };
            const onDraft = ({ stage, knowledgeBank }) => {
                const draftTxt = String(knowledgeBank?.txt || "").trim();
                if (!draftTxt) return;
                const progressBlock = latestProgressHeader ? `${latestProgressHeader}\n\n---\n\n` : "";
                setModalContent(`${progressBlock}${draftTxt}\n\n---\n（背景持續補強中：${stage || "draft"}）`);
            };

            const kb = await prepareLrcKnowledgeBank({ sourceText, quizTargetLanguage, onProgress, onDraft });
            setModalContent(kb.txt || "完成，但無內容？");
        } catch (e) {
            setModalContent(`錯誤：${e.message}`);
        } finally {
            setIsLoadingAI(false);
        }
    };

    const openKnowledgeFlashCards = async () => {
        if (playerRef.current) { playerRef.current.pause(); setIsPlaying(false); }
        const currentModalKnowledgeText = isKnowledgePreviewModalState(
            aiMode,
            modalTitle,
            modalContent,
            quizKnowledgeFileInfo
        ) ? String(modalContent || "").trim() : "";
        if (currentModalKnowledgeText) {
            setKnowledgePreviewReturnState({
                title: String(modalTitle || "LRC 知識點整理 (預覽)"),
                content: currentModalKnowledgeText,
                fileInfo: quizKnowledgeFileInfo ? { ...quizKnowledgeFileInfo } : null
            });
        }

        setShowModal(true);
        setAiMode('flashcards');
        setModalTitle("知識點 Flash Cards");
        setShowRecorder(false);
        setModalHistory([]);
        setModalContent("");
        setFlashCardError("");
        setFlashCardNotice("");
        setFlashCardTermPopup(null);
        setFlashCards([]);
        setFlashCardSourceName("");
        setFlashCardCategories(["all"]);
        setFlashCardToolbarExpanded(true);
        setFlashCardIndex(0);
        setFlashCardFlipped(false);
        setFlashCardFrontPauseSec(2);
        setFlashCardBackPauseSec(1);
        setFlashCardFrontPauseInput("2");
        setFlashCardBackPauseInput("1");
        setFlashCardAutoSpeakBackIncludeZh(false);
        setFlashCardAutoRun(false);
        setFlashCardBackExampleSpeakSignalNonce(0);
        setFlashCardBackZhSpeakSignalNonce(0);
        clearFlashCardAutoTimer();
        resetFlashCardAutoFileQueue();
        flashCardAutoPendingSpeakRef.current = null;
        flashCardAutoSessionRef.current += 1;
        setIsFlashCardLoading(true);

        try {
            let cards = [];
            let sourceName = "";
            let cardsTargetLanguage = "";
            if (currentModalKnowledgeText) {
                cards = parseKnowledgeTxtToFlashCards(currentModalKnowledgeText);
                if (cards.length > 0) {
                    sourceName = quizKnowledgeFileInfo?.filename || "目前知識點預覽";
                    cardsTargetLanguage = extractKnowledgeTxtDeclaredLanguage(
                        currentModalKnowledgeText,
                        quizKnowledgeFileInfo?.targetLanguage || trackLanguage
                    );
                }
            }

            if (cards.length === 0) {
                const hit = await probeKnowledgeFileForCurrentTrack({
                    refreshFromHandle: true,
                    deepScan: true
                });
                sourceName = sourceName || String(hit?.filename || "");

                if (hit?.knowledgeBank) {
                    const kb = hit.knowledgeBank;
                    const txtFromKb = String(kb?.txt || buildQuizKnowledgeTxt(kb) || "").trim();
                    if (txtFromKb) {
                        cards = parseKnowledgeTxtToFlashCards(txtFromKb);
                        sourceName = kb?.filename || sourceName || `${hit?.baseName || "LRC"}知識點.txt`;
                        cardsTargetLanguage = String(
                            kb?.targetLanguage ||
                            extractKnowledgeTxtDeclaredLanguage(txtFromKb, trackLanguage) ||
                            cardsTargetLanguage
                        ).trim();
                    }
                }

                if (cards.length === 0 && hit?.file && (typeof hit.file.text === 'function' || typeof hit.file.arrayBuffer === 'function')) {
                    const txtFromFile = String(await readTextFileRobust(hit.file, { purpose: "knowledge" }) || "").trim();
                    if (txtFromFile) {
                        cards = parseKnowledgeTxtToFlashCards(txtFromFile);
                        sourceName = hit.file.name || sourceName;
                        cardsTargetLanguage = extractKnowledgeTxtDeclaredLanguage(txtFromFile, trackLanguage);
                    }
                }

                // Fallback: if track-name matching failed but folder already has knowledge txt files,
                // try selected one first, then the first available txt in folder.
                if (cards.length === 0) {
                    const selectedName = String(selectedKnowledgeTxtName || "").trim();
                    const fallbackFiles = [];
                    if (selectedName) {
                        const selectedFile = getKnowledgeTxtFileByName(selectedName);
                        if (selectedFile) fallbackFiles.push(selectedFile);
                    }
                    if (fallbackFiles.length === 0) {
                        const map = selectedFolderFilesRef.current || {};
                        const allKnowledge = Object.values(map)
                            .filter((f) => String(f?.name || "").toLowerCase().endsWith('.txt') && String(f?.name || "").includes("知識點"))
                            .sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { numeric: true, sensitivity: 'base' }));
                        if (allKnowledge.length > 0) fallbackFiles.push(allKnowledge[0]);
                    }

                    for (const f of fallbackFiles) {
                        const txtFromFallback = String(await readTextFileRobust(f, { purpose: "knowledge" }) || "").trim();
                        if (!txtFromFallback) continue;
                        const parsedCards = parseKnowledgeTxtToFlashCards(txtFromFallback);
                        if (!Array.isArray(parsedCards) || parsedCards.length === 0) continue;
                        cards = parsedCards;
                        sourceName = String(f?.name || sourceName || "知識點.txt");
                        cardsTargetLanguage = extractKnowledgeTxtDeclaredLanguage(txtFromFallback, trackLanguage);
                        break;
                    }
                }
            }

            if (cards.length === 0) {
                throw new Error("找不到可用的知識點 txt。請先在預覽頁載入既有檔案，再切換 Flash Card。");
                const sourceText = String(buildLrcQuizSource() || "").trim();
                if (sourceText) {
                    const quizTargetLanguage = inferQuizTargetLanguage(sourceText, trackLanguage);
                    const kb = await prepareLrcKnowledgeBank({ sourceText, quizTargetLanguage });
                    const txtFromGenerated = String(kb?.txt || buildQuizKnowledgeTxt(kb) || "").trim();
                    if (txtFromGenerated) {
                        cards = parseKnowledgeTxtToFlashCards(txtFromGenerated);
                        sourceName = kb?.filename || sourceName || "新生成知識點";
                        cardsTargetLanguage = String(kb?.targetLanguage || quizTargetLanguage || trackLanguage).trim();
                    }
                }
            }

            if (!Array.isArray(cards) || cards.length === 0) {
                throw new Error("知識點格式無法解析成 flash cards。");
            }

            setFlashCards(cards);
            setFlashCardSourceName(sourceName || "知識點");
            setFlashCardNotice("");
            setFlashCardTermPopup(null);
            setQuizKnowledgeFileInfo(prev => ({
                ...(prev || {}),
                filename: sourceName || prev?.filename || "知識點",
                total: cards.length,
                generatedAt: prev?.generatedAt || Date.now(),
                targetLanguage: String(cardsTargetLanguage || prev?.targetLanguage || trackLanguage).trim() || trackLanguage
            }));
        } catch (err) {
            setFlashCardError(String(err?.message || err || "未知錯誤"));
        } finally {
            setIsFlashCardLoading(false);
        }
    };

    const returnToKnowledgePreview = useCallback(() => {
        const snapshot = knowledgePreviewReturnState;
        if (!snapshot || !String(snapshot.content || "").trim()) return;
        stopFlashCardAutoRun();
        setIsFlashCardLoading(false);
        setFlashCardError("");
        setFlashCardTermPopup(null);
        setKnowledgePreviewTermPopup(null);
        setShowKnowledgeTxtPicker(false);
        setKnowledgeTxtPickerError("");
        if (snapshot.fileInfo) {
            setQuizKnowledgeFileInfo(snapshot.fileInfo);
        }
        setAiMode('text');
        setModalTitle(String(snapshot.title || "LRC 知識點整理 (預覽)"));
        setModalContent(String(snapshot.content || ""));
    }, [knowledgePreviewReturnState, stopFlashCardAutoRun]);

    const generateLrcQuizBatch = useCallback(async ({ focusOverride = null } = {}) => {
        setShowModal(true);
        setAiMode('quiz');
        setModalTitle("知識點出題闖關");
        setShowRecorder(false);
        setModalHistory([]);
        setSmartTargetDisplay("");
        setTargetTranslation("");
        setModalContent("");
        setQuizError("");
        setQuizGenerationStage("準備中...");
        setQuizIsGenerating(true);
        setQuizQuestions([]);
        setQuizCurrentIndex(0);
        setQuizSelectedOption(null);
        setQuizAnswerState(null);
        setQuizSelectedKnowledgeBatch([]);
        setQuizDeepDiveInput("");
        setQuizDeepDiveHistory([]);
        setIsQuizDeepDiveLoading(false);
        quizUserInteractedRef.current = false;

        const sourceText = String(buildLrcQuizSource() || "");
        const manualKnowledgeFile = getSelectedKnowledgeTxtFileFromFolderMap();
        const quizTargetLanguage = sourceText
            ? inferQuizTargetLanguage(sourceText, trackLanguage)
            : trackLanguage;
        if (!sourceText && !manualKnowledgeFile) {
            setQuizIsGenerating(false);
            setQuizGenerationStage("");
            setQuizError("請先載入含字幕的音檔（LRC/SRT），或先在上方選擇知識點 txt。");
            return;
        }

        if (playerRef.current) {
            playerRef.current.pause();
            setIsPlaying(false);
        }

        // AI-only knowledge-txt fallback batch (still generated by AI, no local mock).
        let quickKnowledgeText = "";
        const requestKnowledgeOnlyFallbackBatch = async () => {
            const safeKnowledgeText = String(quickKnowledgeText || "").trim();
            if (!safeKnowledgeText) {
                throw new Error("知識點檔內容為空，無法補題。");
            }
            return generateSimpleQuizFromLrc({
                sourceText: safeKnowledgeText,
                quizTargetLanguage,
                sourceKind: "knowledge",
                requiredCount: 10,
                minRequiredCount: 1
            });
        };

        let knowledgeBank = null;
        let selectedKnowledgeBatch = [];
        try {
            if (manualKnowledgeFile) {
                try {
                    setQuizGenerationStage("讀取指定知識點檔...");
                    knowledgeBank = await loadKnowledgeBankFromTxtFile(manualKnowledgeFile, {
                        quizTargetLanguage,
                        trackKey: `${currentTrackIndex >= 0 ? currentTrackIndex : "manual"}:manual:${String(manualKnowledgeFile?.name || "").toLowerCase()}`
                    });
                    setQuizKnowledgeBankMap(prev => ({ ...prev, [knowledgeBank.trackKey]: knowledgeBank }));
                    setQuizKnowledgePointsPool(knowledgeBank.points || []);
                    setQuizKnowledgeFileInfo({
                        filename: knowledgeBank.filename,
                        total: Array.isArray(knowledgeBank.points) ? knowledgeBank.points.length : 0,
                        generatedAt: knowledgeBank.generatedAt,
                        targetLanguage: knowledgeBank.targetLanguage || quizTargetLanguage || trackLanguage
                    });
                    setQuizGenerationStage(`已載入指定知識點：${knowledgeBank.filename}`);
                } catch (manualErr) {
                    console.warn("Load selected knowledge txt for quiz failed, fallback to auto mode:", manualErr);
                    if (!sourceText) throw manualErr;
                }
            } else {
                setQuizGenerationStage("AI 正在整理知識點...");
                knowledgeBank = await prepareLrcKnowledgeBank({
                    sourceText,
                    quizTargetLanguage,
                    onDraft: ({ stage, knowledgeBank: draft }) => {
                        if (!draft) return;
                        setQuizKnowledgePointsPool(draft.points || []);
                        setQuizKnowledgeFileInfo({
                            filename: draft.filename,
                            total: Array.isArray(draft.points) ? draft.points.length : 0,
                            generatedAt: draft.generatedAt,
                            targetLanguage: draft.targetLanguage || quizTargetLanguage || trackLanguage
                        });
                        setQuizGenerationStage(`知識點分批整理中：${Array.isArray(draft.points) ? draft.points.length : 0} 點（${stage || "draft"}）`);
                    }
                });
            }
            if (!knowledgeBank) {
                setQuizGenerationStage("AI 正在整理知識點...");
                knowledgeBank = await prepareLrcKnowledgeBank({
                    sourceText,
                    quizTargetLanguage,
                    onDraft: ({ stage, knowledgeBank: draft }) => {
                        if (!draft) return;
                        setQuizKnowledgePointsPool(draft.points || []);
                        setQuizKnowledgeFileInfo({
                            filename: draft.filename,
                            total: Array.isArray(draft.points) ? draft.points.length : 0,
                            generatedAt: draft.generatedAt,
                            targetLanguage: draft.targetLanguage || quizTargetLanguage || trackLanguage
                        });
                        setQuizGenerationStage(`知識點分批整理中：${Array.isArray(draft.points) ? draft.points.length : 0} 點（${stage || "draft"}）`);
                    }
                });
            }
            quickKnowledgeText = String(
                knowledgeBank?.txt ||
                buildQuizKnowledgeTxt(knowledgeBank) ||
                ""
            ).trim();
            if (!quickKnowledgeText) {
                throw new Error("找不到知識點檔內容，請先生成或放入同資料夾的知識點 txt。");
            }

            setQuizGenerationStage("AI 正在用簡化模式（知識點 txt）出題...");
            try {
                let shownPartial = false;
                const simpleQuestions = await generateSimpleQuizFromLrc({
                    sourceText: quickKnowledgeText,
                    quizTargetLanguage,
                    sourceKind: "knowledge",
                    requiredCount: 10,
                    minRequiredCount: 1,
                    onPartialQuestions: (partial) => {
                        if (!Array.isArray(partial) || partial.length === 0) return;
                        if (quizUserInteractedRef.current) return;
                        if (!shownPartial) {
                            shownPartial = true;
                            setQuizQuestions(randomizeQuestionBatchOptions(partial.slice(0, 10)));
                            setQuizCurrentIndex(0);
                            setQuizSelectedOption(null);
                            setQuizAnswerState(null);
                            setQuizBatchNo(prev => prev + 1);
                            setQuizReviewInsertions(0);
                            quizReviewIdRef.current = 0;
                        } else {
                            setQuizQuestions(randomizeQuestionBatchOptions(partial.slice(0, 10)));
                        }
                        setQuizGenerationStage(`已先生成 ${Math.min(partial.length, 10)} 題，背景補題中...`);
                    }
                });
                if (Array.isArray(simpleQuestions) && simpleQuestions.length > 0) {
                    setQuizSelectedKnowledgeBatch([]);
                    setQuizKnowledgePointsPool(knowledgeBank?.points || []);
                    if (!quizUserInteractedRef.current) {
                        setQuizQuestions(randomizeQuestionBatchOptions(simpleQuestions));
                    }
                    if (!shownPartial) {
                        setQuizCurrentIndex(0);
                        setQuizSelectedOption(null);
                        setQuizAnswerState(null);
                        setQuizBatchNo(prev => prev + 1);
                        setQuizReviewInsertions(0);
                        quizReviewIdRef.current = 0;
                    }
                    return;
                }
            } catch (simpleErr) {
                console.warn("Simple knowledge-txt quiz mode failed, fallback to detailed knowledge mode:", simpleErr);
            }

            const wrongPool = Array.isArray(focusOverride) ? focusOverride : quizWrongKnowledge;
            if (!knowledgeBank) {
                knowledgeBank = await prepareLrcKnowledgeBank({ sourceText, quizTargetLanguage });
            }
            selectedKnowledgeBatch = pickKnowledgePointsForBatch(knowledgeBank, { wrongPool });
            if (selectedKnowledgeBatch.length < 10) {
                throw new Error(`可用知識點不足（${selectedKnowledgeBatch.length}/10）`);
            }
            const generationStats = { main: 0, rescue: 0, supplement: 0, single: 0, lrcFallback: 0 };
            setQuizSelectedKnowledgeBatch(selectedKnowledgeBatch);
            setQuizKnowledgePointsPool(knowledgeBank.points || []);

            const knowledgeSourceText = String(
                quickKnowledgeText ||
                knowledgeBank?.txt ||
                buildQuizKnowledgeTxt(knowledgeBank) ||
                ""
            ).trim();
            if (!knowledgeSourceText) {
                throw new Error("找不到知識點檔內容，請先生成或放入同資料夾的知識點 txt。");
            }
            const knowledgePromptText = compactAiPromptText(knowledgeSourceText, 12000);

            const kpMap = new Map(selectedKnowledgeBatch.map(p => [p.batchId, p]));
            const expectedIds = selectedKnowledgeBatch.map(p => p.batchId);
            const enabledFocus = getEnabledQuizFocusTypes();
            const focusLabelText = enabledFocus.map(k => QUIZ_FOCUS_TYPE_LABELS[k]).join('、');
            const selectedKpText = selectedKnowledgeBatch
                .map((p, idx) => `${idx + 1}. ${p.batchId} | ${p.category} | ${p.label}${p.detail ? ` | ${p.detail}` : ''}`)
                .join('\n');

            const typeCounts = { vocab: 0, grammar: 0, reading: 0 };
            for (const p of selectedKnowledgeBatch) {
                if (p.category === 'vocab' || p.category === 'usage') typeCounts.vocab++;
                else if (p.category === 'grammar' || p.category === 'pattern') typeCounts.grammar++;
                else typeCounts.reading++;
            }

            const buildMainPrompt = (batchPoints = selectedKnowledgeBatch, batchMeta = null) => {
                const targetPoints = Array.isArray(batchPoints) && batchPoints.length > 0 ? batchPoints : selectedKnowledgeBatch;
                const targetCount = Math.max(1, Math.min(10, targetPoints.length || 10));
                const batchKpText = targetPoints
                    .map((p, idx) => `${idx + 1}. ${p.batchId} | ${p.category} | ${p.label}${p.detail ? ` | ${p.detail}` : ''}`)
                    .join('\n');
                const batchTag = (batchMeta && Number.isInteger(batchMeta.index) && Number.isInteger(batchMeta.total))
                    ? `\n[BATCH]\n目前為第 ${batchMeta.index + 1}/${batchMeta.total} 批，請只針對本批知識點出題。`
                    : "";

                return `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
你是「遊戲化語言教練」。根據知識點檔與指定知識點，設計 ${targetCount} 題闖關題。${batchTag}

[OUTPUT RULE]
- 只輸出 JSON 物件，不要 markdown，不要額外文字。
- JSON 結構：
{
  "title": "本回合標題",
  "questions": [
    {
      "id": "Q1",
      "type": "vocab|collocation|grammar|pattern|context|inference|listening",
      "knowledgePointId": "KP01",
      "knowledgeCategory": "vocab|usage|grammar|pattern|reading|listening",
      "knowledgePoint": "知識點標籤（短）",
      "question": "題目（目標語言）",
      "questionZh": "題目中文白話（繁中）",
      "options": ["A","B","C","D"],
      "answerIndex": 0,
      "optionExplanations": ["A解析","B解析","C解析","D解析"],
      "explanation": "繁中詳解",
      "wrongDetail": "繁中錯因詳解",
      "reviewHint": "繁中複習提示"
    }
  ]
}

[HARD CONSTRAINTS]
- 必須剛好 ${targetCount} 題，每題對應下方一個 knowledgePointId，且每個 ID 只能出現一次。
- 題目與選項必須使用目標語言（trackLanguage: ${quizTargetLanguage}）。
- 若 trackLanguage 非 zh/ja/ko，題目與選項不得使用中文。
- explanation / wrongDetail / reviewHint / questionZh 必須是繁體中文。
- 每題四選一，且只有 1 個語意上正確答案（不是「依 LRC 才算正確」）。
- 其餘 3 個選項必須明確不正確；optionExplanations 需逐一解釋對錯。
- 題幹必須有語境（完整句子或對話片段），不可只有單字或分類常識題。
- 若是填空題，空格前後都需有足夠線索，避免多解。
- 禁止模糊題型：如「何者是XX」但多個選項都可成立。
- 禁止出現 <T lang="TARGET">、{{ }}、HTML tags。
- 題目要有遊戲感與情境，但不可脫離知識點檔內容。
- 題型配比請大致對齊本回合知識點：vocab/collocation 約 ${typeCounts.vocab} 題、grammar/pattern 約 ${typeCounts.grammar} 題、context/inference/listening 約 ${typeCounts.reading} 題。
- 目前使用者加強類型：${focusLabelText}。

[THIS BATCH KNOWLEDGE POINTS]
${batchKpText}

[KNOWLEDGE TXT CONTENT]
${knowledgePromptText}`;
            };

            const alignQuestionsToKnowledgeBatch = (items) => {
                const out = [];
                const used = new Set();
                const findNextMissing = () => expectedIds.find(id => !used.has(id)) || "";
                for (const q of items || []) {
                    let kpId = String(q?.knowledgePointId || "").toUpperCase().trim();
                    if (!kpMap.has(kpId) || used.has(kpId)) {
                        const fromText = String(q?.knowledgePoint || "").toUpperCase().match(/KP\d{2}/);
                        if (fromText && kpMap.has(fromText[0]) && !used.has(fromText[0])) kpId = fromText[0];
                    }
                    if (!kpMap.has(kpId) || used.has(kpId)) kpId = findNextMissing();
                    if (!kpMap.has(kpId) || used.has(kpId)) continue;

                    const kp = kpMap.get(kpId);
                    used.add(kpId);
                    out.push({
                        ...q,
                        knowledgePointId: kpId,
                        knowledgeCategory: kp?.category || q?.knowledgeCategory || normalizeQuizKnowledgeCategory(q?.type || q?.knowledgePoint || ""),
                        knowledgePoint: kp?.label || q?.knowledgePoint || "綜合",
                        knowledgePointLabel: normalizeKnowledgePointLabel(kp?.label || q?.knowledgePoint || "綜合", q?.type || "綜合")
                    });
                    if (out.length >= 10) break;
                }
                return out;
            };

            let detailedPartialShown = false;
            const publishDetailedPartial = (items, stageText = "背景補題中") => {
                const partial = alignQuestionsToKnowledgeBatch(items).slice(0, 10);
                if (!Array.isArray(partial) || partial.length === 0) return partial;
                if (!quizUserInteractedRef.current) {
                    setQuizQuestions(partial);
                    if (!detailedPartialShown) {
                        setQuizCurrentIndex(0);
                        setQuizSelectedOption(null);
                        setQuizAnswerState(null);
                        setQuizBatchNo(prev => prev + 1);
                        setQuizReviewInsertions(0);
                        quizReviewIdRef.current = 0;
                    }
                }
                detailedPartialShown = true;
                setQuizGenerationStage(`已先生成 ${partial.length}/10 題，${stageText}...`);
                return partial;
            };

            const requestSupplementForMissing = async (missingPoints) => {
                if (!Array.isArray(missingPoints) || missingPoints.length === 0) return [];
                const missingText = missingPoints
                    .map((p, idx) => `${idx + 1}. ${p.batchId} | ${p.category} | ${p.label}${p.detail ? ` | ${p.detail}` : ''}`)
                    .join('\n');

                const prompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
請只針對以下缺漏知識點補題。輸出 JSON，不要 markdown。

[OUTPUT]
{
  "questions": [
    {
      "id": "R1",
      "type": "vocab|collocation|grammar|pattern|context|inference|listening",
      "knowledgePointId": "KP01",
      "knowledgeCategory": "vocab|usage|grammar|pattern|reading|listening",
      "knowledgePoint": "知識點標籤",
      "question": "題目（目標語言）",
      "questionZh": "繁中白話",
      "options": ["A","B","C","D"],
      "answerIndex": 0,
      "optionExplanations": ["A解析","B解析","C解析","D解析"],
      "explanation": "繁中詳解",
      "wrongDetail": "繁中錯因",
      "reviewHint": "繁中複習提示"
    }
  ]
}

[CONSTRAINTS]
- 只生成 ${missingPoints.length} 題，且每題 knowledgePointId 必須來自清單且不重複。
- 題目與選項使用目標語言（trackLanguage: ${quizTargetLanguage}），若非 zh/ja/ko 不可含中文。
- 每題單選且唯一正解，optionExplanations 需完整。
- 題幹要有語境，避免純分類題或單字題幹。
- 禁止使用「根據 LRC 才算正確」的判準。

[MISSING KNOWLEDGE POINTS]
${missingText}

[KNOWLEDGE TXT CONTENT]
${knowledgePromptText}`;

                const raw = await callGeminiText(prompt, currentApiKey);
                const payload = await parseAiJsonPayload(raw, {
                    arrayField: "questions",
                    schemaHint: "{ questions: [{ id, knowledgePointId, question, options, answerIndex }] }"
                });
                return normalizeQuizQuestions(payload);
            };

            const requestSingleQuestionForPoint = async (point, index = 0) => {
                if (!point) return [];
                const prompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
請僅針對指定知識點出 1 題四選一單選題。輸出 JSON，不要 markdown。

[OUTPUT]
{
  "id": "S${index + 1}",
  "type": "vocab|collocation|grammar|pattern|context|inference|listening",
  "knowledgePointId": "${point.batchId}",
  "knowledgeCategory": "${point.category}",
  "knowledgePoint": "${point.label}",
  "question": "題目（目標語言）",
  "questionZh": "題目繁中白話",
  "options": ["A","B","C","D"],
  "answerIndex": 0,
  "optionExplanations": ["A解析","B解析","C解析","D解析"],
  "explanation": "繁中詳解",
  "wrongDetail": "繁中錯因",
  "reviewHint": "繁中複習提示"
}

[CONSTRAINTS]
- 題目與選項使用目標語言（trackLanguage: ${quizTargetLanguage}），若非 zh/ja/ko 不可含中文。
- 單選且唯一正解，其他 3 個選項要明確不正確。
- optionExplanations 要逐一說明為何對/錯。
- 題幹需有語境線索，禁止「單字 + 空格」或模糊分類題。
- 禁止 <T lang="TARGET">、{{ }}、HTML tags。

[TARGET KNOWLEDGE POINT]
${point.batchId} | ${point.category} | ${point.label}${point.detail ? ` | ${point.detail}` : ''}

[KNOWLEDGE TXT CONTENT]
${knowledgePromptText}`;

                const raw = await callGeminiText(prompt, currentApiKey);
                const payload = await parseAiJsonPayload(raw, {
                    arrayField: "questions",
                    schemaHint: "{ id, knowledgePointId, question, options, answerIndex }"
                });
                const one = normalizeQuizQuestions(payload).slice(0, 1);
                if (one.length === 0) return [];
                return one.map(q => ({
                    ...q,
                    knowledgePointId: point.batchId,
                    knowledgeCategory: point.category || q.knowledgeCategory,
                    knowledgePoint: point.label || q.knowledgePoint,
                    knowledgePointLabel: normalizeKnowledgePointLabel(point.label || q.knowledgePoint || "綜合", q.type || "綜合")
                }));
            };

            const repairQuestionLanguage = async (baseQuestions) => {
                const langEval = evaluateQuizQuestionLanguage(baseQuestions, quizTargetLanguage);
                if (langEval.ok) return baseQuestions;
                const languageRepairPrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
你會收到一份題庫 JSON。請只做語言修復：
1) 題目 stem 與 options 轉成目標語言（trackLanguage: ${quizTargetLanguage}）
2) 若 trackLanguage 非 zh/ja/ko，stem/options 不可含中文
3) 保留 id / type / knowledgePointId / knowledgeCategory / answerIndex
4) explanation / wrongDetail / reviewHint / questionZh 維持繁中
5) optionExplanations 維持完整
6) 移除 tags / <T lang="TARGET"> / {{ }} / HTML

[OUTPUT]
{ "questions": [ ... ] }

[INPUT QUIZ JSON]
${JSON.stringify({ questions: baseQuestions })}`;

                const raw = await callGeminiText(languageRepairPrompt, currentApiKey);
                const payload = await parseAiJsonPayload(raw, {
                    arrayField: "questions",
                    schemaHint: "{ questions: [{ id, knowledgePointId, question, options, answerIndex }] }"
                });
                const repaired = normalizeQuizQuestions(payload);
                if (!Array.isArray(repaired) || repaired.length === 0) return baseQuestions;
                return repaired.slice(0, baseQuestions.length);
            };

            let questions = [];
            let mainRawCombined = "";
            const kpBatches = chunkArray(selectedKnowledgeBatch, 3);
            for (let bi = 0; bi < kpBatches.length; bi++) {
                const batchPoints = kpBatches[bi];
                if (!Array.isArray(batchPoints) || batchPoints.length === 0) continue;
                setQuizGenerationStage(`AI 正在分批生成題目（${bi + 1}/${kpBatches.length}）...`);
                const batchPrompt = buildMainPrompt(batchPoints, { index: bi, total: kpBatches.length });
                try {
                    const batchRaw = await callGeminiText(batchPrompt, currentApiKey);
                    mainRawCombined += `\n\n### BATCH ${bi + 1}\n${String(batchRaw || "")}`;
                    const batchPayload = await parseAiJsonPayload(batchRaw, {
                        arrayField: "questions",
                        schemaHint: "{ title, questions: [{ id, knowledgePointId, question, options, answerIndex }] }"
                    });
                    const batchQuestions = normalizeQuizQuestions(batchPayload);
                    questions = alignQuestionsToKnowledgeBatch([...(questions || []), ...batchQuestions]);
                    generationStats.main = questions.length;
                    publishDetailedPartial(questions, `第 ${bi + 1}/${kpBatches.length} 批完成`);
                } catch (batchErr) {
                    console.warn(`Batch ${bi + 1} quiz generation failed:`, batchErr);
                }
            }

            if (questions.length === 0) {
                setQuizGenerationStage("AI 題目格式整理中...");
                const rescuePrompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
你會收到一段題庫原始輸出，請把它整理成可解析 JSON，且至少輸出 10 題。
- 僅輸出 JSON，不要 markdown，不要任何說明。
- 根物件格式必須是：
{
  "questions": [
    {
      "id": "Q1",
      "knowledgePointId": "KP01",
      "knowledgeCategory": "vocab|usage|grammar|pattern|reading|listening",
      "knowledgePoint": "知識點標籤",
      "question": "題目（目標語言）",
      "questionZh": "繁中白話",
      "options": ["A","B","C","D"],
      "answerIndex": 0,
      "optionExplanations": ["A解析","B解析","C解析","D解析"],
      "explanation": "繁中詳解",
      "wrongDetail": "繁中錯因",
      "reviewHint": "繁中複習提示"
    }
  ]
}
- 不可輸出 HTML / tags / <T lang="TARGET"> / {{ }}。
- 題目與選項使用目標語言（trackLanguage: ${quizTargetLanguage}），若非 zh/ja/ko 不可含中文。

[TARGET KNOWLEDGE IDs]
${selectedKpText}

[RAW QUIZ OUTPUT]
${String(mainRawCombined || "").slice(0, 15000)}`;
                const rescueRaw = await callGeminiText(rescuePrompt, currentApiKey);
                const rescuePayload = await parseAiJsonPayload(rescueRaw, {
                    arrayField: "questions",
                    schemaHint: "{ questions: [{ id, knowledgePointId, question, options, answerIndex }] }"
                });
                questions = normalizeQuizQuestions(rescuePayload);
                questions = alignQuestionsToKnowledgeBatch(questions);
                generationStats.rescue = questions.length;
                publishDetailedPartial(questions, "格式整理完成");
            }

            if (questions.length < 10) {
                const missing = selectedKnowledgeBatch.filter(p => !questions.find(q => q.knowledgePointId === p.batchId));
                if (missing.length > 0) {
                    setQuizGenerationStage("AI 正在補齊缺漏知識點題目...");
                    const supplements = await requestSupplementForMissing(missing);
                    questions = alignQuestionsToKnowledgeBatch([...(questions || []), ...(supplements || [])]);
                    generationStats.supplement = questions.length;
                    publishDetailedPartial(questions, "補齊缺漏中");
                }
            }

            if (questions.length < 10) {
                const missing = selectedKnowledgeBatch.filter(p => !questions.find(q => q.knowledgePointId === p.batchId));
                if (missing.length > 0) {
                    setQuizGenerationStage("AI 正在逐題補齊知識點...");
                    const oneByOne = [];
                    for (let i = 0; i < missing.length; i++) {
                        try {
                            const generated = await requestSingleQuestionForPoint(missing[i], i);
                            if (generated.length > 0) oneByOne.push(...generated);
                        } catch (_) {
                            // keep going; we'll throw once all repair paths are exhausted
                        }
                    }
                    questions = alignQuestionsToKnowledgeBatch([...(questions || []), ...oneByOne]);
                    generationStats.single = questions.length;
                    publishDetailedPartial(questions, "逐題補齊中");
                }
            }

            if (questions.length < 10) {
                setQuizGenerationStage("知識點模式不足，改用知識點 txt 補齊...");
                try {
                    const lrcFallbackQuestions = await requestKnowledgeOnlyFallbackBatch();
                    questions = alignQuestionsToKnowledgeBatch([...(questions || []), ...(lrcFallbackQuestions || [])]);
                    generationStats.lrcFallback = questions.length;
                    publishDetailedPartial(questions, "知識點 txt 補齊中");
                } catch (_) {
                    // keep original error path
                }
            }

            if (questions.length < 1) {
                throw new Error(`AI 未生成可用題目（0）。 [main:${generationStats.main}, rescue:${generationStats.rescue}, supplement:${generationStats.supplement}, single:${generationStats.single}, lrcFallback:${generationStats.lrcFallback}]`);
            }

            let workingQuestions = questions.slice(0, 10);
            const langEval = evaluateQuizQuestionLanguage(workingQuestions, quizTargetLanguage);
            if (!langEval.ok) {
                setQuizGenerationStage("AI 正在修正題目語言...");
                workingQuestions = await repairQuestionLanguage(workingQuestions);
                const langEvalAfterRepair = evaluateQuizQuestionLanguage(workingQuestions, quizTargetLanguage);
                // Relaxed mode: language mismatch no longer blocks generation.
            }

            const finalQuestions = alignQuestionsToKnowledgeBatch(workingQuestions).slice(0, 10);
            if (finalQuestions.length < 1) {
                throw new Error(`AI 題目解析後為 0。 [main:${generationStats.main}, rescue:${generationStats.rescue}, supplement:${generationStats.supplement}, single:${generationStats.single}, lrcFallback:${generationStats.lrcFallback}]`);
            }

            if (!quizUserInteractedRef.current) {
                if (detailedPartialShown) {
                    setQuizQuestions(finalQuestions);
                } else {
                    setQuizQuestions(randomizeQuestionBatchOptions(finalQuestions));
                }
            }
            if (!detailedPartialShown) {
                setQuizCurrentIndex(0);
                setQuizSelectedOption(null);
                setQuizAnswerState(null);
                setQuizBatchNo(prev => prev + 1);
                setQuizReviewInsertions(0);
                quizReviewIdRef.current = 0;
            }
            markKnowledgeBatchUsage(knowledgeBank.trackKey, selectedKnowledgeBatch);
        } catch (err) {
            console.error(err);
            const rawMsg = String(err?.message || '未知錯誤');
            const isAuthError = /401|unauth|api\s*key|credential|permission denied/i.test(rawMsg);
            if (isAuthError) {
                setQuizError(`AI 授權失敗（401）。本版不使用手動 API key，請確認同頁 JSX bridge/平台注入授權可用。\n技術訊息：${rawMsg}`);
            } else {
                setQuizError(`出題失敗：${rawMsg}`);
            }
        } finally {
            setQuizIsGenerating(false);
            setQuizGenerationStage("");
        }
    }, [
        buildLrcQuizSource,
        buildQuizKnowledgeTxt,
        compactAiPromptText,
        currentApiKey,
        currentTrackIndex,
        generateSimpleQuizFromLrc,
        getEnabledQuizFocusTypes,
        getSelectedKnowledgeTxtFileFromFolderMap,
        learnerLevel,
        loadKnowledgeBankFromTxtFile,
        markKnowledgeBatchUsage,
        normalizeQuizQuestions,
        parseAiJsonPayload,
        pickKnowledgePointsForBatch,
        prepareLrcKnowledgeBank,
        quizWrongKnowledge,
        randomizeQuestionBatchOptions,
        trackLanguage
    ]);

    const generateSimpleLrcQuizBatchForTest = useCallback(async () => {
        setShowModal(true);
        setAiMode('quiz');
        setModalTitle("知識點出題（測試）");
        setShowRecorder(false);
        setModalHistory([]);
        setSmartTargetDisplay("");
        setTargetTranslation("");
        setModalContent("");
        setQuizError("");
        setQuizGenerationStage("準備中...");
        setQuizIsGenerating(true);
        setQuizQuestions([]);
        setQuizCurrentIndex(0);
        setQuizSelectedOption(null);
        setQuizAnswerState(null);
        setQuizSelectedKnowledgeBatch([]);
        setQuizKnowledgePointsPool([]);
        setQuizDeepDiveInput("");
        setQuizDeepDiveHistory([]);
        setIsQuizDeepDiveLoading(false);
        quizUserInteractedRef.current = false;

        try {
            const lrcSourceText = String(buildLrcQuizSource() || "");
            const manualKnowledgeFile = getSelectedKnowledgeTxtFileFromFolderMap();
            const quizTargetLanguage = lrcSourceText
                ? inferQuizTargetLanguage(lrcSourceText, trackLanguage)
                : trackLanguage;
            if (!lrcSourceText && !manualKnowledgeFile) throw new Error("請先載入含字幕的音檔（LRC/SRT），或先在上方選擇知識點 txt。");

            if (playerRef.current) {
                playerRef.current.pause();
                setIsPlaying(false);
            }

            let knowledgeBank = null;
            if (manualKnowledgeFile) {
                try {
                    setQuizGenerationStage("讀取指定知識點檔...");
                    knowledgeBank = await loadKnowledgeBankFromTxtFile(manualKnowledgeFile, {
                        quizTargetLanguage,
                        trackKey: `${currentTrackIndex >= 0 ? currentTrackIndex : "manual"}:manual:${String(manualKnowledgeFile?.name || "").toLowerCase()}`
                    });
                    setQuizKnowledgeBankMap(prev => ({ ...prev, [knowledgeBank.trackKey]: knowledgeBank }));
                    setQuizKnowledgeFileInfo({
                        filename: knowledgeBank.filename,
                        total: Array.isArray(knowledgeBank.points) ? knowledgeBank.points.length : 0,
                        generatedAt: knowledgeBank.generatedAt,
                        targetLanguage: knowledgeBank.targetLanguage || quizTargetLanguage || trackLanguage
                    });
                } catch (manualErr) {
                    console.warn("Load selected knowledge txt for simple quiz failed, fallback to auto mode:", manualErr);
                    if (!lrcSourceText) throw manualErr;
                }
            } else {
                setQuizGenerationStage("AI 正在整理知識點...");
                knowledgeBank = await prepareLrcKnowledgeBank({
                    sourceText: lrcSourceText,
                    quizTargetLanguage
                });
            }
            if (!knowledgeBank) {
                setQuizGenerationStage("AI 正在整理知識點...");
                knowledgeBank = await prepareLrcKnowledgeBank({
                    sourceText: lrcSourceText,
                    quizTargetLanguage
                });
            }
            const knowledgeSourceText = String(
                knowledgeBank?.txt ||
                buildQuizKnowledgeTxt(knowledgeBank) ||
                ""
            ).trim();
            if (!knowledgeSourceText) {
                throw new Error("知識點檔內容為空，請先生成知識點。");
            }
            setQuizKnowledgePointsPool(knowledgeBank?.points || []);

            setQuizGenerationStage("AI 正在依知識點 txt 出題...");
            let shownPartial = false;
            const questions = await generateSimpleQuizFromLrc({
                sourceText: knowledgeSourceText,
                quizTargetLanguage,
                sourceKind: "knowledge",
                requiredCount: 10,
                minRequiredCount: 1,
                onPartialQuestions: (partial) => {
                    if (!Array.isArray(partial) || partial.length === 0) return;
                    if (quizUserInteractedRef.current) return;
                    if (!shownPartial) {
                        shownPartial = true;
                        setQuizQuestions(randomizeQuestionBatchOptions(partial.slice(0, 10)));
                        setQuizCurrentIndex(0);
                        setQuizSelectedOption(null);
                        setQuizAnswerState(null);
                        setQuizBatchNo(prev => prev + 1);
                        setQuizReviewInsertions(0);
                        quizReviewIdRef.current = 0;
                    } else {
                        setQuizQuestions(randomizeQuestionBatchOptions(partial.slice(0, 10)));
                    }
                    setQuizGenerationStage(`已先生成 ${Math.min(partial.length, 10)} 題，背景補題中...`);
                }
            });
            if (!Array.isArray(questions) || questions.length === 0) {
                throw new Error("簡化模式未生成可用題目（0）; all parsers exhausted");
            }

            if (!quizUserInteractedRef.current) {
                setQuizQuestions(randomizeQuestionBatchOptions(questions));
            }
            if (!shownPartial) {
                setQuizCurrentIndex(0);
                setQuizSelectedOption(null);
                setQuizAnswerState(null);
                setQuizBatchNo(prev => prev + 1);
                setQuizReviewInsertions(0);
                quizReviewIdRef.current = 0;
            }
        } catch (err) {
            console.error(err);
            setQuizError(`出題失敗：${String(err?.message || "未知錯誤")}`);
        } finally {
            setQuizIsGenerating(false);
            setQuizGenerationStage("");
        }
    }, [
        buildLrcQuizSource,
        buildQuizKnowledgeTxt,
        currentTrackIndex,
        generateSimpleQuizFromLrc,
        getSelectedKnowledgeTxtFileFromFolderMap,
        loadKnowledgeBankFromTxtFile,
        prepareLrcKnowledgeBank,
        randomizeQuestionBatchOptions,
        trackLanguage
    ]);

    const startSimpleLrcQuizGame = () => {
        setQuizScore(0);
        setQuizStreak(0);
        setQuizBatchNo(0);
        setQuizSessionStats({ correct: 0, wrong: 0 });
        setQuizWrongKnowledge([]);
        setQuizReviewInsertions(0);
        quizReviewIdRef.current = 0;
        generateSimpleLrcQuizBatchForTest();
    };

    const startLrcQuizGame = () => {
        setQuizScore(0);
        setQuizStreak(0);
        setQuizBatchNo(0);
        setQuizSessionStats({ correct: 0, wrong: 0 });
        setQuizWrongKnowledge([]);
        setQuizReviewInsertions(0);
        quizReviewIdRef.current = 0;
        generateLrcQuizBatch({ focusOverride: [] });
    };

    const continueLrcQuizGame = () => {
        generateLrcQuizBatch();
    };

    const handleQuizPickOption = (optionIdx) => {
        if (quizAnswerState) return;
        const question = quizQuestions[quizCurrentIndex];
        if (!question) return;
        quizUserInteractedRef.current = true;

        setQuizSelectedOption(optionIdx);
        const isCorrect = optionIdx === question.answerIndex;
        setQuizAnswerState(isCorrect ? 'correct' : 'wrong');

        if (isCorrect) {
            const gain = question.isReview ? 6 : (10 + Math.min(quizStreak, 5) * 2);
            setQuizScore(prev => prev + gain);
            setQuizStreak(prev => prev + 1);
            setQuizSessionStats(prev => ({ ...prev, correct: prev.correct + 1 }));
            return;
        }

        setQuizStreak(0);
        setQuizSessionStats(prev => ({ ...prev, wrong: prev.wrong + 1 }));
        if (question.knowledgePoint) {
            setQuizWrongKnowledge(prev => [...prev, question.knowledgePoint]);
        }

        if (!question.isReview && quizReviewInsertions < 8) {
            const reviewQuestion = createReviewQuestion(question);
            setQuizQuestions(prev => {
                const next = [...prev];
                const insertAt = Math.min(next.length, quizCurrentIndex + 2);
                next.splice(insertAt, 0, reviewQuestion);
                return next;
            });
            setQuizReviewInsertions(prev => prev + 1);
        }
    };

    const handleQuizNext = () => {
        if (!quizAnswerState) return;
        if (quizCurrentIndex + 1 >= quizQuestions.length) {
            setQuizCurrentIndex(quizQuestions.length); // Mark batch done
        } else {
            setQuizCurrentIndex(prev => prev + 1);
        }
        setQuizSelectedOption(null);
        setQuizAnswerState(null);
        setQuizDeepDiveInput("");
        setQuizDeepDiveHistory([]);
        setIsQuizDeepDiveLoading(false);
    };

    const handleQuizDeepDive = async () => {
        const q = quizQuestions[quizCurrentIndex];
        if (!q) return;
        const userQ = (quizDeepDiveInput || "").trim();
        if (!userQ) return;

        setQuizDeepDiveInput("");
        setQuizDeepDiveHistory(prev => [...prev, { role: 'user', text: userQ }]);
        setIsQuizDeepDiveLoading(true);

        try {
            const optionLines = (q.options || []).map((opt, idx) => `${String.fromCharCode(65 + idx)}. ${opt}`).join('\n');
            const optionReasonLines = (q.options || []).map((opt, idx) => {
                const reason = q.optionRationales?.[idx] || (idx === q.answerIndex ? "此選項符合本題句意與語法。" : "此選項不符合本題句意或語法。");
                return `${String.fromCharCode(65 + idx)}. ${opt}\n理由：${reason}`;
            }).join('\n\n');

            const prompt = `${SYSTEM_PROMPT_CORE(learnerLevel)}
[TASK]
你是測驗教練，請針對這一題做「繁體中文」教學解答。
要求：
1) 先用 1-2 句中文白話重述題意。
2) 明確說明正確答案為何正確（語意/文法/搭配）。
3) 逐一點名其餘選項為何錯誤。
4) 若句子較難，補充最多 3 個關鍵字彙的簡短中文意思。
5) 用初學者可懂的說法，不要過度術語化。
6) 不要使用「根據 LRC 才算正確」這種判準。

[QUESTION]
${q.stem}

[QUESTION_ZH]
${q.questionZh || '(無)'}

[OPTIONS]
${optionLines}

[CORRECT ANSWER]
${String.fromCharCode(65 + q.answerIndex)}. ${q.answerText}

[OPTION RATIONALES]
${optionReasonLines}

[USER QUESTION]
${userQ}`;

            const res = await callGeminiText(prompt, currentApiKey);
            const answer = String(res || "").trim() || "目前無法取得補充解釋。";
            setQuizDeepDiveHistory(prev => [...prev, { role: 'ai', text: answer }]);
        } catch (err) {
            setQuizDeepDiveHistory(prev => [...prev, { role: 'ai', text: `補充解釋失敗：${err.message || '未知錯誤'}` }]);
        } finally {
            setIsQuizDeepDiveLoading(false);
        }
    };

    const toggleSmartMode = () => {
        const newMode = !isSmartMode;
        const nowTime = playerRef.current ? playerRef.current.currentTime : currentTime;
        const nextSubtitles = rawSubtitles.length > 0
            ? (newMode ? generateSmartSubtitles(rawSubtitles, timeBuffer, minDuration, maxMergeCount, trackLanguage) : rawSubtitles)
            : [];

        setIsSmartMode(newMode);
        setSubtitles(nextSubtitles);

        if (nextSubtitles.length > 0 && nowTime != null && !Number.isNaN(nowTime)) {
            const mappedIdx = findSubtitleIndexByTimeInList(nowTime, nextSubtitles);
            if (mappedIdx !== -1) setCurrentIndex(mappedIdx);
        }
    };

    // [NEW] Survival Mode Logic
    const survivalQuestionPool = useMemo(() => {
        const source = (rawSubtitles && rawSubtitles.length > 0) ? rawSubtitles : subtitles;
        if (!source || source.length === 0) return [];

        const cleaned = source
            .map((s, idx) => ({
                idx,
                start: Number(s?.start) || 0,
                end: Number(s?.end) || 0,
                text: (s?.text || "").replace(/\s+/g, ' ').trim()
            }))
            .filter(s => s.text && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
        if (cleaned.length === 0) return [];

        const contextPool = [];
        const maxGap = 1.4;
        const maxDuration = 18;

        // Build context clips where the question focus is the middle sentence.
        // This avoids using the first/last sentence as answer anchor.
        for (let center = 1; center < cleaned.length - 1; center++) {
            const radiusCandidates = [2, 1]; // Prefer 5-sentence context, then 3-sentence.
            let built = false;

            for (const radius of radiusCandidates) {
                const startIdx = Math.max(0, center - radius);
                const endIdx = Math.min(cleaned.length - 1, center + radius);
                if (center === startIdx || center === endIdx) continue;
                if (startIdx === 0 || endIdx === cleaned.length - 1) continue;

                let contiguous = true;
                for (let i = startIdx; i < endIdx; i++) {
                    if ((cleaned[i + 1].start - cleaned[i].end) > maxGap) {
                        contiguous = false;
                        break;
                    }
                }
                if (!contiguous) continue;

                const start = cleaned[startIdx].start;
                const end = cleaned[endIdx].end;
                if ((end - start) > maxDuration) continue;

                const text = cleaned.slice(startIdx, endIdx + 1).map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
                const focusText = cleaned[center].text;
                if (!text || !focusText) continue;

                contextPool.push({
                    start,
                    end,
                    text,
                    focusText,
                    subIndex: cleaned[center].idx,
                    sourceRange: [cleaned[startIdx].idx, cleaned[endIdx].idx],
                });
                built = true;
                break;
            }

            if (built) continue;
        }

        if (contextPool.length > 0) return contextPool;

        // Fallback for very short subtitle files.
        return cleaned.map(s => ({
            start: s.start,
            end: s.end,
            text: s.text,
            focusText: s.text,
            subIndex: s.idx,
            sourceRange: [s.idx, s.idx],
        }));
    }, [rawSubtitles, subtitles]);

    const stopSurvivalMode = useCallback(() => {
        clearSurvivalPauseTimer();
        survivalPlayTokenRef.current += 1;
        survivalModeRef.current = false;
        if (playerRef.current) playerRef.current.pause();
        setIsPlaying(false);
        setIsSurvivalMode(false);
        setSurvivalQuestion(null);
        setSurvivalFeedback(null);
    }, [clearSurvivalPauseTimer]);

    const playSurvivalAudio = useCallback((sub) => {
        const player = playerRef.current;
        if (!player || !sub) return;

        const start = Math.max(0, Number(sub.start) || 0);
        const end = Number(sub.end) || 0;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

        clearSurvivalPauseTimer();
        survivalPlayTokenRef.current += 1;
        const token = survivalPlayTokenRef.current;
        let resolved = false;

        const cleanup = (onSeeked, onErr, onCanPlay) => {
            try { player.removeEventListener('seeked', onSeeked); } catch (_) { }
            try { player.removeEventListener('error', onErr); } catch (_) { }
            try { player.removeEventListener('canplay', onCanPlay); } catch (_) { }
        };

        const armPauseTimer = () => {
            const durationMs = Math.max(250, Math.round((end - start) * 1000) + 250);
            clearSurvivalPauseTimer();
            survivalPauseTimerRef.current = setTimeout(() => {
                if (token !== survivalPlayTokenRef.current) return;
                if (survivalModeRef.current && playerRef.current) {
                    playerRef.current.pause();
                    setIsPlaying(false);
                }
            }, durationMs);
        };

        const tryPlay = () => {
            if (token !== survivalPlayTokenRef.current) return;
            const p = player.play();
            if (p && typeof p.then === 'function') {
                p.then(() => {
                    setIsPlaying(true);
                    armPauseTimer();
                }).catch(() => {
                    setIsPlaying(false);
                });
            } else {
                setIsPlaying(true);
                armPauseTimer();
            }
        };

        const onSeeked = () => {
            if (resolved) return;
            resolved = true;
            cleanup(onSeeked, onErr, onCanPlay);
            tryPlay();
        };
        const onErr = () => {
            if (resolved) return;
            resolved = true;
            cleanup(onSeeked, onErr, onCanPlay);
        };
        const onCanPlay = () => {
            if (resolved) return;
            resolved = true;
            cleanup(onSeeked, onErr, onCanPlay);
            tryPlay();
        };

        player.pause();
        setIsPlaying(false);
        player.addEventListener('seeked', onSeeked);
        player.addEventListener('error', onErr);
        player.addEventListener('canplay', onCanPlay);

        try {
            player.currentTime = start;
        } catch (_) {
            cleanup(onSeeked, onErr, onCanPlay);
            return;
        }

        // iOS fallback: seeked may not fire reliably.
        setTimeout(() => {
            if (resolved) return;
            resolved = true;
            cleanup(onSeeked, onErr, onCanPlay);
            tryPlay();
        }, 350);
    }, [clearSurvivalPauseTimer]);

    const generateSurvivalQuestion = useCallback(() => {
        setSurvivalFeedback(null);
        if (!survivalQuestionPool || survivalQuestionPool.length === 0) return;

        let attempts = 0;
        while (attempts < 40) {
            const idx = Math.floor(Math.random() * survivalQuestionPool.length);
            const sub = survivalQuestionPool[idx];
            const text = (sub?.text || "").trim();
            const focusText = (sub?.focusText || text).trim();
            if (!text || !focusText) {
                attempts++;
                continue;
            }

            // Find a suitable "Ghost Word" (length >= 3 for Latin, >= 2 chars for CJK)
            const latinMatch = focusText.match(/[a-zA-Z]{4,}/g);
            const cjkMatch = focusText.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g);
            const candidates = [...(latinMatch || []), ...(cjkMatch || [])];
            if (candidates.length === 0) {
                attempts++;
                continue;
            }

            const target = candidates[Math.floor(Math.random() * candidates.length)];
            const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const maskRegex = /[A-Za-z]/.test(target) ? new RegExp(`\\b${escaped}\\b`) : new RegExp(escaped);
            let maskedText = text;
            if (sub?.focusText) {
                const maskedFocusText = focusText.replace(maskRegex, '______');
                if (maskedFocusText === focusText) {
                    attempts++;
                    continue;
                }
                const focusPos = text.indexOf(focusText);
                maskedText = focusPos >= 0
                    ? `${text.slice(0, focusPos)}${maskedFocusText}${text.slice(focusPos + focusText.length)}`
                    : text.replace(maskRegex, '______');
            } else {
                maskedText = text.replace(maskRegex, '______');
            }
            if (maskedText === text) {
                attempts++;
                continue;
            }

            // Generate distractors from the same pool as the audio source.
            const distractors = [];
            let dAttempts = 0;
            while (distractors.length < 3 && dAttempts < 100) {
                const dSub = survivalQuestionPool[Math.floor(Math.random() * survivalQuestionPool.length)];
                const dText = (dSub?.focusText || dSub?.text || "").trim();
                const dCandidates = [...(dText.match(/[a-zA-Z]{4,}/g) || []), ...(dText.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g) || [])];
                if (dCandidates.length > 0) {
                    const dWord = dCandidates[Math.floor(Math.random() * dCandidates.length)];
                    if (dWord !== target && !distractors.includes(dWord)) {
                        distractors.push(dWord);
                    }
                }
                dAttempts++;
            }

            if (distractors.length === 3) {
                const options = [...distractors, target].sort(() => Math.random() - 0.5);
                setSurvivalQuestion({ text, answer: target, options, subIndex: sub.subIndex, maskedText, sourceSub: sub });
                playSurvivalAudio(sub);
                return;
            }
            attempts++;
        }

        alert("無法生成題目（字幕太短或無可用音段）");
        stopSurvivalMode();
    }, [survivalQuestionPool, playSurvivalAudio, stopSurvivalMode]);

    const startSurvivalMode = () => {
        if (!playerRef.current || !mediaSrc) {
            alert("請先載入可播放的音檔。");
            return;
        }
        if (!survivalQuestionPool || survivalQuestionPool.length === 0) {
            alert("請先載入字幕。");
            return;
        }

        clearSurvivalPauseTimer();
        survivalPlayTokenRef.current += 1;
        survivalModeRef.current = true;
        if (playerRef.current) playerRef.current.pause();
        setIsPlaying(false);
        setSurvivalLives(3);
        setSurvivalScore(0);
        setSurvivalCorrectCount(0);
        setIsSurvivalMode(true);
        setSurvivalQuestion(null);
        generateSurvivalQuestion();
    };

    const replaySurvivalQuestionAudio = useCallback(() => {
        if (!survivalQuestion?.sourceSub) return;
        playSurvivalAudio(survivalQuestion.sourceSub);
    }, [survivalQuestion, playSurvivalAudio]);

    const handleSurvivalAnswer = (option) => {
        if (!survivalQuestion) return;
        if (option === survivalQuestion.answer) {
            const nextCorrect = survivalCorrectCount + 1;
            const nextScore = survivalScore + 10;
            setSurvivalCorrectCount(nextCorrect);
            setSurvivalScore(nextScore);
            setSurvivalFeedback('correct');

            if (nextCorrect >= SURVIVAL_PASS_TARGET) {
                setTimeout(() => {
                    if (!survivalModeRef.current) return;
                    alert(`通關成功！得分: ${nextScore}`);
                    stopSurvivalMode();
                }, 300);
            } else if (survivalModeRef.current) {
                setTimeout(() => {
                    if (survivalModeRef.current) generateSurvivalQuestion();
                }, 250);
            }
            return;
        }

        setSurvivalFeedback('wrong');
        setSurvivalLives((prev) => {
            const next = prev - 1;
            if (next <= 0) {
                setTimeout(() => {
                    alert(`挑戰失敗！答對 ${survivalCorrectCount} 題，得分 ${survivalScore}`);
                    stopSurvivalMode();
                }, 500);
            } else {
                setTimeout(() => {
                    if (survivalModeRef.current) replaySurvivalQuestionAudio();
                }, 250);
            }
            return next;
        });
    };

    const downloadNotes = async (opts = {}) => {
        const {
            trackIndex = currentTrackIndex,
            index = currentIndex,
            silent = false,
            subtitleTextOverride,
            aiCacheOverride,
            translationCacheOverride,
            targetFixCacheOverride,
            audioCacheOverride,
            chatHistoryOverride,
            trackLanguageOverride,
            preferredVoiceOverride,
            learnerLevelOverride,
            tutorLangOverride
        } = opts;

        const effectiveAiCache = aiCacheOverride || aiCache;
        const effectiveTranslationCache = translationCacheOverride || translationCache;
        const effectiveTargetFixCache = targetFixCacheOverride || targetFixCache;
        const effectiveAudioCache = audioCacheOverride || audioCache;
        const effectiveChatHistory = chatHistoryOverride || chatHistory;
        const effectiveTrackLanguage = trackLanguageOverride || trackLanguage;
        const effectivePreferredVoice = preferredVoiceOverride || preferredVoice;
        const effectiveLearnerLevel = learnerLevelOverride || learnerLevel;
        const effectiveTutorLang = tutorLangOverride || tutorLang;

        const sentenceKey = `${trackIndex}-${index}`;
        const currentSub = subtitleTextOverride ? { text: subtitleTextOverride } : (subtitles[index] || null);
        const relevantKeys = Object.keys(effectiveAiCache).filter(key => key.startsWith(`${sentenceKey}-`));
        const hasNotes = relevantKeys.length > 0
            || (effectiveChatHistory && effectiveChatHistory.length > 0)
            || !!effectiveTranslationCache[sentenceKey]
            || !!effectiveTargetFixCache[sentenceKey];

        if (!currentSub || !currentSub.text || !hasNotes) {
            if (!silent) alert("請先進行 AI 互動後再下載筆記。");
            return;
        }

        if (!silent) setIsLoadingAI(true);
        try {
            // [FIX] Use Local Time for Filename Timestamp
            const now = new Date();
            const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

            // [FIX] Updated Regex for CJK/Kana support in filename
            let safeTarget = (currentSub?.text || "Unknown").slice(0, 20).replace(/[^a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af\s]/g, '').trim().replace(/\s+/g, '_');
            if (safeTarget.length === 0) safeTarget = "Lesson";

            let filename = `語伴筆記_${safeTarget}_${timestamp}`;
            let htmlBody = "";

            const blobToBase64 = async (blobUrl) => {
                if (!blobUrl || !blobUrl.startsWith('blob:')) return null;
                try {
                    const response = await fetch(blobUrl);
                    const blob = await response.blob();
                    return new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.readAsDataURL(blob);
                    });
                } catch (e) { console.error("Blob Convert Error", e); return null; }
            };

            const targetSentence = currentSub?.text || 'Unknown';
            const isCjkTrack = /^(ja|ko|zh)/i.test(effectiveTrackLanguage);
            const hasCjkScript = (text) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(text);
            const hasKanaScript = (text) => /[\u3040-\u30ff]/.test(text);
            const hasHangulScript = (text) => /[\uac00-\ud7af]/.test(text);

            // [FIX] Get Translation from Cache
            const transKey = `${trackIndex}-${index}`;
            const targetTrans = effectiveTranslationCache[transKey] || "";
            const targetFix = effectiveTargetFixCache[transKey] || "";
            const targetSentenceHtml = renderTargetSentenceHtml(targetSentence, targetFix);
            const targetSentenceForAudio = stripStrike(normalizeTargetSentence(targetFix || targetSentence));
            // Pass preferred voice name to export
            const exportVoiceName = effectivePreferredVoice ? effectivePreferredVoice.name : '';

            // [FIX] Inline SVG Icons for Export (Matches Lucide Volume2 style - Outline)
            const getSpeakerIcon = (type) => {
                const colorClass = type === 'ai' ? 'color:#2563eb;' : 'color:#9ca3af;';
                // Always use fill="none" to match Lucide outline style found in UI
                return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="${colorClass} cursor:pointer;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`;
            }

            let headerAudioHtml = "";
            // [FIX] Use raw text as key for audio cache lookup (NO CLEANING)
            if (effectiveAudioCache[targetSentenceForAudio]) {
                const b64 = await blobToBase64(effectiveAudioCache[targetSentenceForAudio]);
                if (b64) {
                    headerAudioHtml = `
                     <div style="margin-top: 10px; display:flex; align-items:center;">
                        <button onclick="document.getElementById('header_audio').play()" style="background:none; border:none; padding:0;">${getSpeakerIcon('ai')}</button>
                        <audio id="header_audio" src="${b64}"></audio>
                     </div>`;
                }
            } else {
                // Fallback for Header Target Sentence
                const safeTarget = targetSentenceForAudio.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                headerAudioHtml = `
                <div style="margin-top: 10px; display:flex; align-items:center;">
                    <button onclick="speak('${safeTarget}', '${effectiveTrackLanguage}')" style="background:none; border:none; padding:0;">${getSpeakerIcon('native')}</button>
                </div>`;
            }

            const renderMarkdownLine = (line) => {
                const html = stripTargetLangTags(line)
                    .replace(/\{\{(.*?)\}\}/g, '$1')
                    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
                    .replace(/\*\*(.*?)\*\*/g, '<span class="highlight">$1</span>')
                    .replace(/\*(?!\*)([^*<>]+)\*/g, '<em>$1</em>')
                    .replace(/^(\d+)\.\s+(.+)/, '$1. $2')
                    .replace(/^\s*[*-]\s*(概念|用法|常見錯誤|例句)(.*)/, '<div class="ai-subhead">$1$2</div>')
                    .replace(/^(概念|用法|常見錯誤|例句)(.*)/, '<div class="ai-subhead">$1$2</div>')
                    .replace(/^##### (.*)/, '<div class="ai-h4">$1</div>')
                    .replace(/^#### (.*)/, '<div class="ai-h4">$1</div>')
                    .replace(/^### (.*)/, '<div class="ai-h3">$1</div>')
                    .replace(/^## (.*)/, '<div class="ai-h2">$1</div>');
                return shrinkReadingParenthesesHtml(html);
            };

            for (const key of relevantKeys) {
                const parts = key.split('-');
                const type = parts[2];
                if (!['explain', 'correction', 'deep'].includes(type)) continue;
                if (typeof effectiveAiCache[key] !== 'string') continue;
                const { content } = processAIResponse(effectiveAiCache[key]);

                htmlBody += `<div class="card">
                    <h2 class="section-title">${type === 'explain' ? '單字用語' : type === 'correction' ? '校正' : '文法詳解'}</h2>
                    <div class="content">`;

                if (typeof content === 'string') {
                    const lines = content.split('\n');

                    // [FIX] Export Table Logic Re-write
                    let tableMode = false;
                    let tableRowCount = 0;
                    let tableHtml = "";
                    let tableHeaders = []; // Track headers for this specific table
                    let lastTextType = null;

                    for (let line of lines) {
                        const trimmed = line.trim();
                        // Check if it's a table line
                        if (trimmed.startsWith('|')) {
                            if (!tableMode) {
                                tableMode = true;
                                tableRowCount = 0;
                                tableHtml = '<div class="table-wrapper"><table class="styled-table">';
                                tableHeaders = []; // Reset headers
                                lastTextType = null;
                            }
                            tableRowCount++;

                            // Check separator line (only | - : space)
                            const isSeparator = /^\|[\s\-:|]+$/.test(trimmed) || (trimmed.replace(/[\s|:-]/g, '') === '');
                            if (isSeparator) continue; // Skip rendering separator line

                            const cells = trimmed.split('|').filter(c => c).map(c => c.trim());

                            // 1st non-separator row is header
                            const isHeader = (tableRowCount === 1);

                            if (isHeader) {
                                // Capture headers for column-aware logic
                                tableHeaders = cells.map(c => stripTargetTagsForDisplay(c).replace(/<[^>]*>/g, '').trim());
                            }

                            let rowHtml = '<tr>';

                            for (let i = 0; i < cells.length; i++) {
                                let cell = cells[i];
                                let cellContent = cell;
                                // 1. Highlight
                                // [FIX] Updated logic for Blue Bold Text (sync with MarkdownView)
                                cellContent = stripTargetLangTags(cellContent) // remove <T ...>
                                    .replace(/\{\{(.*?)\}\}/g, '$1') // remove {{ }}
                                    .replace(/\*\*(.*?)\*\*/g, '<span class="highlight">$1</span>');

                                // 2. Speaker Logic (Same as MarkdownView)
                                if (!isHeader) {
                                    // [FIX] Use extractTargetText logic for consistency
                                    const hasExplicitTag = hasTargetLangTag(cell) || /\{\{.*?\}\}/.test(cell);
                                    let targetForAudio = "";
                                    if (hasExplicitTag) {
                                        targetForAudio = extractTaggedTargetText(cell) || extractTargetText(cell);
                                    }

                                    // [NEW] SMART EXPORT COLUMN LOGIC
                                    const headerText = tableHeaders[i] || "";
                                    // [FIX] Expanded target column regex
                                    const isTargetColumn = /target|word|phrase|example|sentence|collocation|原文|例句|目標|單字|詞語|片語|句子|搭配|英文內容|英文片段|原文片段|日文內容|日文片段|韓文內容|韓文片段|西文內容|西文片段|德文內容|德文片段|外語內容|外語片段|日文|日本語|日語|韓文|韓語|德文|德語|西文|西語|法文|法語|範例/i.test(headerText);
                                    // [FIX] Allow Collocations/Examples to have audio
                                    const isExcludedColumn = !/collocation|搭配|example|例句|範例/i.test(headerText) && /meaning|chinese|explanation|pos|part of speech|phonetic|reading|中文|翻譯|解釋|詞性|發音|音標|讀音|意思/i.test(headerText);
                                    const audioSource = cleanTextForDisplay(cell)
                                        .replace(/<small>[\s\S]*?<\/small>/gi, '')
                                        .split(/<br\s*\/?>/i)[0];
                                    // [FIX] Don't extract Latin phrases if CJK is present
                                    const sourceHasCjk = hasCjkScript(audioSource);
                                    const latinPhrases = (isCjkTrack || sourceHasCjk) ? "" : extractLatinPhrasesForAudio(audioSource);
                                    const fallbackText = (latinPhrases || audioSource).replace(/<[^>]*>/g, '').trim();
                                    const fallbackHasLatin = /[A-Za-z]/.test(fallbackText);
                                    const hasKana = hasKanaScript(fallbackText);
                                    const hasHangul = hasHangulScript(fallbackText);
                                    const allowNonLatin = (isCjkTrack || hasKana || hasHangul || hasCjkScript(fallbackText)) && fallbackText.length > 0;
                                    const passesChineseGuard = (isCjkTrack || hasKana || hasHangul) ? true : !isPredominantlyChinese(fallbackText);

                                    const speakerTextRaw = hasExplicitTag
                                        ? chooseTaggedSpeakerText({ taggedText: targetForAudio, fallbackText, trackLanguage: effectiveTrackLanguage })
                                        : fallbackText;
                                    const speakerText = sanitizeSpeakerText(speakerTextRaw, effectiveTrackLanguage);
                                    const shouldShowSpeaker = hasExplicitTag
                                        ? speakerText.length > 0
                                        : (isTargetColumn && !isExcludedColumn && !isPhonetic(fallbackText) && passesChineseGuard && (fallbackHasLatin || allowNonLatin));
                                    if (shouldShowSpeaker) targetForAudio = speakerText;

                                    if (shouldShowSpeaker) {
                                        if (effectiveAudioCache[targetForAudio]) {
                                            const b64 = await blobToBase64(effectiveAudioCache[targetForAudio]);
                                            if (b64) {
                                                const aid = `aud_${Math.random().toString(36).substr(2, 5)}`;
                                                cellContent += `<br><div style="margin-top:4px;"><button onclick="document.getElementById('${aid}').play()" style="background:none; border:none; padding:0;">${getSpeakerIcon('ai')}</button><audio id="${aid}" src="${b64}"></audio></div>`;
                                            }
                                        } else {
                                            const safeText = targetForAudio.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                                            cellContent += `<br><div style="margin-top:4px;"><button onclick="speak('${safeText}', '${effectiveTrackLanguage}')" style="background:none; border:none; padding:0;">${getSpeakerIcon('native')}</button></div>`;
                                        }
                                    }
                                }

                                rowHtml += `<${isHeader ? 'th' : 'td'}>${cellContent}</${isHeader ? 'th' : 'td'}>`;
                            }
                            rowHtml += '</tr>';
                            tableHtml += rowHtml;
                        } else {
                            if (tableMode) {
                                tableHtml += '</table></div>';
                                htmlBody += tableHtml;
                                tableMode = false;
                            }
                            const trimmedLineText = line.trim();
                            const isHeadingLine = /^\s*#{2,6}\s+/.test(trimmedLineText);
                            const isNumberedLine = /^\d+\.\s+/.test(trimmedLineText);
                            const isSubheadLine = /^\s*[*-]\s*(概念|用法|常見錯誤|例句)\b/.test(trimmedLineText) || /^(概念|用法|常見錯誤|例句)\b/.test(trimmedLineText);
                            const lineType = isHeadingLine ? 'heading' : isNumberedLine ? 'kp' : isSubheadLine ? 'subhead' : 'paragraph';

                            // [FIX] Preserve deep-dive question block styling in export
                            const trimmedLine = line.trim();
                            if (trimmedLine.startsWith('<div') && trimmedLine.includes('User Question')) {
                                const attrMatch = trimmedLine.match(/\sdata-question="([\s\S]*?)"/i);
                                const match = trimmedLine.match(/<div class="question-text">([\s\S]*?)<\/div>/)
                                    || trimmedLine.match(/<div class="font-medium">([\s\S]*?)<\/div>/);
                                const qText = String((attrMatch && attrMatch[1]) || (match ? match[1] : '') || '');
                                if (tableMode) { tableHtml += '</table></div>'; htmlBody += tableHtml; tableMode = false; }
                                htmlBody += `<div class="question-box"><div class="question-label">User Question</div><div class="question-text">${qText}</div></div>`;
                                continue;
                            }

                            // [FIX] Process Markdown for text lines (preserve order)
                            let processedLine = renderMarkdownLine(line);
                            if (/^\s*<div\b/.test(processedLine)) {
                                htmlBody += processedLine;
                            } else {
                                const pClass = lineType === 'paragraph' && lastTextType === 'subhead' ? ' class="ai-subtext"' : '';
                                htmlBody += `<p${pClass}>${processedLine}</p>`;
                            }
                            lastTextType = lineType;
                        }
                    }
                    if (tableMode) { tableHtml += '</table></div>'; htmlBody += tableHtml; }
                }
                htmlBody += `</div></div>`;
            }

            const tutorKeyPattern = new RegExp(`^${trackIndex}-${index}-tutor-(\\d+)-(.*)$`);
            const tutorEntries = Object.keys(effectiveAiCache)
                .map((k) => {
                    const m = k.match(tutorKeyPattern);
                    if (!m) return null;
                    const history = effectiveAiCache[k];
                    if (!Array.isArray(history)) return null;
                    return { key: k, level: m[1], lang: m[2], history };
                })
                .filter(Boolean);

            const tutorFallback = (tutorEntries.length === 0 && Array.isArray(effectiveChatHistory) && effectiveChatHistory.length > 0)
                ? [{ key: 'current-tutor', level: effectiveLearnerLevel, lang: effectiveTutorLang, history: effectiveChatHistory }]
                : [];

            for (const entry of [...tutorEntries, ...tutorFallback]) {
                htmlBody += `<div class="card">
                    <h2 class="section-title">語音家教（LV ${entry.level} / ${entry.lang}）</h2>
                    <div class="content">`;

                for (const msg of entry.history) {
                    const role = msg.role || 'ai';
                    const msgText = (msg.text || msg.content || "").toString();
                    const lines = msgText.split('\n');
                    let msgHtml = "";
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        msgHtml += `<p>${renderMarkdownLine(line)}</p>`;
                    }

                    let audioHtml = "";
                    if (msg.type === 'audio' && msg.content) {
                        const b64 = await blobToBase64(msg.content);
                        if (b64) {
                            const aid = `tutor_aud_${Math.random().toString(36).substr(2, 5)}`;
                            audioHtml = `<div style="margin-top:6px;"><button onclick="document.getElementById('${aid}').play()" style="background:none; border:none; padding:0;">${getSpeakerIcon('ai')}</button><audio id="${aid}" src="${b64}"></audio></div>`;
                        }
                    } else if (role === 'ai' && msgText) {
                        const safeText = msgText.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                        audioHtml = `<div style="margin-top:6px;"><button onclick="speak('${safeText}', '${effectiveTrackLanguage}')" style="background:none; border:none; padding:0;">${getSpeakerIcon('native')}</button></div>`;
                    }

                    htmlBody += `<div class="tutor-msg tutor-${role}">
                        <div class="tutor-role">${role === 'user' ? 'User' : 'AI'}</div>
                        <div class="tutor-text">${msgHtml || ''}</div>
                        ${audioHtml}
                    </div>`;
                }

                htmlBody += `</div></div>`;
            }

            // [FIX] Enhanced Export CSS & JS for Voice
            const fullHtml = `
                <!DOCTYPE html>
                <html lang="zh-TW">
                <head>
                    <meta charset="UTF-8">
                    <title>${filename}</title>
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: #f3f4f6; padding: 40px; color: #1f2937; line-height: 1.6; }
                        .container { max-width: 800px; margin: 0 auto; }
                        .header { text-align: center; margin-bottom: 30px; background: white; padding: 30px; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border: 1px solid #e5e7eb; }
                        .header h1 { margin: 0 0 20px 0; color: #111827; font-size: 24px; font-weight: 800; }
                        .target-box { background: #eff6ff; padding: 20px; border-radius: 12px; border: 1px solid #dbeafe; text-align: left; }
                        .target-text { font-size: 20px; font-weight: 700; color: #1f2937; margin: 0 0 10px 0; line-height: 1.4; }
                        .target-trans { font-size: 16px; color: #4b5563; margin: 0; font-weight: 500; background: rgba(255,255,255,0.6); display: inline-block; padding: 4px 8px; border-radius: 6px; border: 1px solid #bfdbfe; }
                        
                        .card { background: white; padding: 25px; border-radius: 16px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border: 1px solid #e5e7eb; }
                        .section-title { font-size: 14px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0; margin-bottom: 20px; border-bottom: 2px solid #f3f4f6; padding-bottom: 10px; }
                        
                        .table-wrapper { overflow-x: auto; margin: 20px 0; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
                        .styled-table { width: 100%; border-collapse: collapse; font-size: 14px; background: white; }
                        .styled-table th { background: #f9fafb; text-align: left; padding: 12px 16px; font-weight: 600; color: #374151; border-bottom: 1px solid #e5e7eb; text-transform: uppercase; font-size: 12px; letter-spacing: 0.05em; }
                        .styled-table td { padding: 12px 16px; border-bottom: 1px solid #e5e7eb; vertical-align: top; color: #374151; }
                        .styled-table tr:last-child td { border-bottom: none; }
                        .styled-table tr:hover { background-color: #f9fafb; }

                        .highlight { color: #2563eb; font-weight: 700; }
                        .inline-code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; background: #f3f4f6; border: 1px solid #e5e7eb; padding: 0 4px; border-radius: 4px; font-size: 0.9em; }
                        .ai-subhead { margin: 8px 0 4px; padding-left: 16px; font-weight: 700; color: #0f172a; }
                        .ai-subtext { padding-left: 16px; color: #334155; }
                        .question-box { margin: 16px 0; padding: 16px; background: #ecfdf5; color: #064e3b; border: 1px solid #d1fae5; border-radius: 12px; }
                        .question-label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #059669; margin-bottom: 6px; }
                        .question-text { font-weight: 600; }
                        .tutor-msg { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; margin: 10px 0; }
                        .tutor-user { background: #f3f4f6; }
                        .tutor-ai { background: #eff6ff; border-color: #dbeafe; }
                        .tutor-role { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6b7280; margin-bottom: 6px; }
                        .play-btn { background: none; border: none; cursor: pointer; font-size: 18px; transition: transform 0.1s; }
                        .play-btn:hover { transform: scale(1.1); }
                        p { margin: 12px 0; }
                        h2 { font-size: 20px; font-weight: 800; margin-top: 28px; margin-bottom: 12px; color: #111827; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
                        h3 { font-size: 18px; font-weight: 700; margin-top: 24px; margin-bottom: 12px; color: #1f2937; }
                        h4 { font-size: 16px; font-weight: 600; margin-top: 20px; margin-bottom: 10px; color: #374151; }
                        .ai-h2 { margin: 18px 0 10px; padding: 10px 14px; background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%); border: 1px solid #e5e7eb; border-left: 4px solid #2563eb; border-radius: 12px; font-size: 18px; font-weight: 800; color: #111827; }
                        .ai-h3 { margin: 14px 0 8px; padding: 8px 12px; background: #f8fafc; border: 1px solid #e5e7eb; border-left: 3px solid #10b981; border-radius: 10px; font-size: 16px; font-weight: 700; color: #1f2937; }
                        .ai-h4 { margin: 10px 0 6px; padding-left: 10px; border-left: 2px solid #cbd5e1; font-size: 14px; font-weight: 700; color: #374151; }
                    </style>
                    <script>
                        const preferredVoiceName = "${exportVoiceName}";
                        function speak(text, lang) {
                            window.speechSynthesis.cancel();
                            const u = new SpeechSynthesisUtterance(text);
                            u.lang = lang;
                            const voices = window.speechSynthesis.getVoices();
                            if (preferredVoiceName) {
                                const v = voices.find(v => v.name === preferredVoiceName);
                                if (v) u.voice = v;
                            }
                            window.speechSynthesis.speak(u);
                        }
                        // Preload voices
                        window.speechSynthesis.getVoices();
                    </script>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>Gemini 語伴筆記</h1>
                            <div class="target-box">
                                <p class="target-text">${targetSentenceHtml}</p>
                                <p class="target-trans">${targetTrans}</p>
                                ${headerAudioHtml}
                            </div>
                        </div>
                        ${htmlBody}
                    </div>
                </body>
                </html>
            `;

            const blob = new Blob([fullHtml], { type: 'text/html' });
            const saveResult = await saveBlobToPreferredFolder(blob, `${filename}.html`, { allowBrowserDownload: true });
            if (saveResult?.mode === 'not-saved') {
                throw new Error("筆記檔寫入失敗，且瀏覽器下載也未完成。請檢查瀏覽器下載權限後重試。");
            }
            if (!silent && saveResult?.mode === 'browser-download') {
                alert("尚未取得資料夾讀寫授權，已改用瀏覽器下載。若要直接存回原資料夾，請先按「授權資料夾」。");
            }

        } catch (e) {
            console.error(e);
            if (!silent) alert("下載失敗：" + e.message);
        } finally {
            if (!silent) setIsLoadingAI(false);
        }
    };

    const revokeBlobUrl = (url) => {
        if (typeof url === 'string' && url.startsWith('blob:')) {
            try { URL.revokeObjectURL(url); } catch (_) { }
        }
    };

    const buildAutoNotesSnapshot = (trackIdx, idx, subtitleText) => {
        if (trackIdx < 0 || idx < 0) return null;
        const text = subtitleText || (subtitlesRef.current?.[idx]?.text || "");
        if (!text) return null;
        const sentenceKey = `${trackIdx}-${idx}`;
        const chatKey = chatHistorySentenceKeyRef.current;
        const chatHistoryForSentence = (chatKey === sentenceKey) ? (chatHistoryRef.current || []) : [];
        return {
            trackIndex: trackIdx,
            index: idx,
            subtitleText: text,
            aiCache: aiCacheRef.current || {},
            translationCache: translationCacheRef.current || {},
            targetFixCache: targetFixCacheRef.current || {},
            audioCache: audioCacheRef.current || {},
            chatHistory: chatHistoryForSentence,
            trackLanguage: trackLanguageRef.current || trackLanguage,
            preferredVoice: preferredVoiceRef.current || preferredVoice,
            learnerLevel: learnerLevelRef.current || learnerLevel,
            tutorLang: tutorLangRef.current || tutorLang
        };
    };

    const clearAiMemoryForSentence = (trackIdx, idx) => {
        const sentenceKey = `${trackIdx}-${idx}`;
        const keyPrefix = `${sentenceKey}-`;

        // Revoke any tutor audio URLs stored in aiCache for this sentence
        try {
            const cacheSnap = aiCacheRef.current || {};
            for (const k of Object.keys(cacheSnap)) {
                if (!k.startsWith(keyPrefix)) continue;
                const val = cacheSnap[k];
                if (Array.isArray(val)) {
                    for (const msg of val) {
                        if (msg && msg.type === 'audio' && typeof msg.content === 'string') {
                            revokeBlobUrl(msg.content);
                        }
                    }
                }
            }
        } catch (_) { }

        // Revoke any tutor audio URLs in current chat history
        try {
            const hist = chatHistoryRef.current || [];
            for (const msg of hist) {
                if (msg && msg.type === 'audio' && typeof msg.content === 'string') {
                    revokeBlobUrl(msg.content);
                }
            }
        } catch (_) { }

        setAiCache(prev => {
            let changed = false;
            const next = { ...prev };
            for (const k of Object.keys(next)) {
                if (k.startsWith(keyPrefix)) {
                    delete next[k];
                    changed = true;
                }
            }
            return changed ? next : prev;
        });

        setTranslationCache(prev => {
            if (!(sentenceKey in prev)) return prev;
            const next = { ...prev };
            delete next[sentenceKey];
            return next;
        });

        setTargetFixCache(prev => {
            if (!(sentenceKey in prev)) return prev;
            const next = { ...prev };
            delete next[sentenceKey];
            return next;
        });

        if (chatHistorySentenceKeyRef.current === sentenceKey) {
            setChatHistory([]);
            chatHistorySentenceKeyRef.current = null;
        }

        const indexMap = audioCacheIndexRef.current;
        const textSet = indexMap[sentenceKey];
        if (textSet && textSet.size > 0) {
            setAudioCache(prev => {
                const next = { ...prev };
                for (const t of textSet) {
                    revokeBlobUrl(next[t]);
                    delete next[t];
                }
                return next;
            });
            delete indexMap[sentenceKey];
        }
    };

    const autoArchiveSentence = async (snapshot) => {
        if (!snapshot) return;
        const sentenceKey = `${snapshot.trackIndex}-${snapshot.index}`;
        const relevantKeys = Object.keys(snapshot.aiCache || {}).filter(key => key.startsWith(`${sentenceKey}-`));
        const hasNotes = relevantKeys.length > 0
            || (snapshot.chatHistory && snapshot.chatHistory.length > 0)
            || !!snapshot.translationCache?.[sentenceKey]
            || !!snapshot.targetFixCache?.[sentenceKey];

        if (hasNotes) {
            await downloadNotes({
                trackIndex: snapshot.trackIndex,
                index: snapshot.index,
                silent: true,
                subtitleTextOverride: snapshot.subtitleText,
                aiCacheOverride: snapshot.aiCache,
                translationCacheOverride: snapshot.translationCache,
                targetFixCacheOverride: snapshot.targetFixCache,
                audioCacheOverride: snapshot.audioCache,
                chatHistoryOverride: snapshot.chatHistory,
                trackLanguageOverride: snapshot.trackLanguage,
                preferredVoiceOverride: snapshot.preferredVoice,
                learnerLevelOverride: snapshot.learnerLevel,
                tutorLangOverride: snapshot.tutorLang
            });
        }

        clearAiMemoryForSentence(snapshot.trackIndex, snapshot.index);
    };

    useEffect(() => {
        const prev = lastSentenceRef.current;
        const hasCurrent = currentTrackIndex >= 0 && currentIndex >= 0 && subtitles[currentIndex];
        const curr = hasCurrent
            ? { trackIndex: currentTrackIndex, index: currentIndex, text: subtitles[currentIndex].text }
            : null;

        if (prev && (prev.trackIndex !== currentTrackIndex || prev.index !== currentIndex)) {
            const snapshot = buildAutoNotesSnapshot(prev.trackIndex, prev.index, prev.text);
            if (snapshot) {
                void autoArchiveSentence(snapshot);
            }
        }
        lastSentenceRef.current = curr;
    }, [currentTrackIndex, currentIndex, subtitles]);

    const handlePronounce = () => {
        if (playerRef.current) { playerRef.current.pause(); setIsPlaying(false); }
        const sub = subtitles[currentIndex]; if (!sub) return;
        setAiMode('pronounce'); setModalTitle("發音教練");
        setSmartTargetDisplay(sub.text);
        // Reset Pronunciation State
        setPronunciationState('idle');
        setPronunciationResult(null);
        setUserAudioUrl(null);

        // Use Global Translation Cache
        const transCacheKey = `${currentTrackIndex}-${currentIndex}`;
        if (translationCache[transCacheKey]) {
            setTargetTranslation(translationCache[transCacheKey]);
        } else {
            setTargetTranslation("");
        }

        setShowModal(true); setShowRecorder(true);
    };

    // Helper to get supported mime type
    const getSupportedMimeType = () => {
        const types = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'];
        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        return ''; // Let browser pick default if none match (unlikely)
    };

    // Recording Logic for Pronunciation
    const startPronunciationRecord = async () => {
        if (pronunciationState !== 'idle' && pronunciationState !== 'done') return; // Prevent double click

        setPronunciationState('preparing'); // Start with 'preparing' state
        try {
            let stream;
            try {
                // Try High Quality First
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });
            } catch (e) {
                console.warn("HQ Audio failed, falling back to simple audio", e);
                // Fallback to simple audio
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            // Store stream in ref for safe cleanup
            streamRef.current = stream;

            // Use supported mime type
            const mimeType = getSupportedMimeType();
            recordingMimeTypeRef.current = mimeType;

            const options = mimeType ? { mimeType } : undefined;
            mediaRecorderRef.current = new MediaRecorder(stream, options);
            audioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) audioChunksRef.current.push(event.data);
            };

            // Add timeslice for smoother data handling
            mediaRecorderRef.current.start(200);
            setPronunciationState('recording'); // Switch to 'recording' only after start
        } catch (err) {
            console.error(err);
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                alert("錄音失敗：請允許麥克風權限。\n\n注意：若您之前曾拒絕權限，更改設定可能會導致頁面重新整理，請先備份目前的進度。");
            } else {
                alert(`無法啟動麥克風 (${err.message})。請檢查設備設定。`);
            }
            setPronunciationState('idle');
        }
    };

    // Cancel Recording Function
    const cancelPronunciationRecord = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            // Unbind the onstop handler so analysis doesn't trigger
            mediaRecorderRef.current.onstop = null;
            mediaRecorderRef.current.stop();

            // Cleanup stream
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }

            // Reset UI state
            setPronunciationState('idle');
            audioChunksRef.current = [];
        }
    };

    const stopPronunciationRecord = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
            setPronunciationState('processing');

            mediaRecorderRef.current.onstop = async () => {
                // Use detected mime type for blob creation
                const mimeType = recordingMimeTypeRef.current || 'audio/webm';
                const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });

                // Check if blob has size
                if (audioBlob.size === 0) {
                    alert("錄音失敗：沒有偵測到聲音。請檢查麥克風權限或瀏覽器相容性。");
                    setPronunciationState('idle');
                    return;
                }

                // Create URL for User Playback
                const url = URL.createObjectURL(audioBlob);
                setUserAudioUrl(url);

                const reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = async () => {
                    const base64Audio = reader.result.split(',')[1];
                    await analyzePronunciation(base64Audio);
                };

                // Safely stop tracks using streamRef
                if (streamRef.current) {
                    streamRef.current.getTracks().forEach(track => track.stop());
                    streamRef.current = null;
                }
            };
        }
    };

    const analyzePronunciation = async (audioBase64) => {
        try {
            const targetFixKey = `${currentTrackIndex}-${currentIndex}`;
            const effectiveTargetText = stripStrike(normalizeTargetSentence(targetFixCache[targetFixKey] || smartTargetDisplay));
            const prompt = SYSTEM_PROMPT_PRONUNCIATION.replace("${targetText}", effectiveTargetText) + `\nTARGET TEXT: "${effectiveTargetText}"`;
            const rawResponse = await callGeminiMultimodal(prompt, audioBase64, currentApiKey);

            // Clean Markdown fences
            const cleanJson = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const result = JSON.parse(cleanJson);

            // Update Global Translation Cache from Pronunciation result
            if (result.translation) {
                const transCacheKey = `${currentTrackIndex}-${currentIndex}`;
                setTranslationCache(prev => ({ ...prev, [transCacheKey]: result.translation }));
                setTargetTranslation(result.translation);
            }

            setPronunciationResult(result);
            setPronunciationState('done');
        } catch (error) {
            console.error("Analysis Error:", error);
            alert("分析失敗，請重試");
            setPronunciationState('idle');
        }
    };

    const handleBack = () => {
        if (modalHistory.length === 0) return;
        const prev = modalHistory[modalHistory.length - 1];
        setModalHistory(prevHist => prevHist.slice(0, -1));
        setModalTitle(prev.title);
        setModalContent(prev.content);
        setAiMode(prev.mode);
    };

    const handleVoiceTutor = async () => {
        const sub = subtitles[currentIndex]; if (!sub) return;
        if (playerRef.current) { playerRef.current.pause(); setIsPlaying(false); }
        setAiMode('tutor'); setModalTitle("語音家教"); setShowModal(true); setShowRecorder(false);

        setSmartTargetDisplay(sub.text);
        const transCacheKey = `${currentTrackIndex}-${currentIndex}`;
        const hasTranslation = !!translationCache[transCacheKey];
        const effectiveTargetSentence = stripStrike(normalizeTargetSentence(targetFixCache[transCacheKey] || sub.text));
        if (hasTranslation) {
            setTargetTranslation(translationCache[transCacheKey]);
        } else {
            setTargetTranslation("");
        }


        const sentenceKey = `${currentTrackIndex}-${currentIndex}`;
        const cacheKey = `${currentTrackIndex}-${currentIndex}-tutor-${learnerLevel}-${tutorLang}`;
        if (aiCache[cacheKey]) {
            setChatHistory(aiCache[cacheKey]);
            chatHistorySentenceKeyRef.current = sentenceKey;
            return;
        }

        setChatHistory([]);
        chatHistorySentenceKeyRef.current = sentenceKey;
        setIsLoadingAI(true);
        const systemPrompt = tutorLang === 'target'
            ? SYSTEM_PROMPT_TUTOR_TARGET(learnerLevel)
            : SYSTEM_PROMPT_CORE(learnerLevel);
        const langPrompt = tutorLang === 'target'
            ? "INSTRUCTION: Speak naturally in the Target Language. Use 10-12 short sentences. Friendly tone. STRICT: no Traditional Chinese and no '中文提示:' line."
            : "INSTRUCTION: Explain in **Traditional Chinese**.";
        const correctionAwarenessNote = "NOTE: If you notice likely misspellings/mishearings in the target sentence, mention them briefly (one short line). Do NOT rewrite the target sentence.";
        const translationInstruction = hasTranslation ? "" : `
        [OUTPUT INSTRUCTION]
        1. Start your response EXACTLY with this line:
           ===TRANSLATION===: <Translate the TARGET SENTENCE into Traditional Chinese here>
        2. Leave an empty line.
        3. Proper nouns / interjections / coined terms: keep original (or transliterate), do NOT translate literally. If it is a shout/onomatopoeia, add a short note in Chinese in parentheses.
        4. Continue with the tutor response (Target Language or Traditional Chinese, per instruction).
        `;
        const initialPrompt = `${systemPrompt}\n${langPrompt}\n${correctionAwarenessNote}\n${translationInstruction}\nTARGET: "${effectiveTargetSentence}". Say hello and explain this sentence briefly.`;

        const res = await callGeminiText(initialPrompt, currentApiKey);
        const parsed = hasTranslation ? { content: res, translation: "", targetFix: "" } : processAIResponse(res);
        const tutorContentRaw = formatTutorText(parsed.content);
        const tutorContent = tutorLang === "target" ? stripTutorChineseHintLines(tutorContentRaw) : tutorContentRaw;
        if (parsed.translation) {
            setTranslationCache(prev => ({ ...prev, [transCacheKey]: parsed.translation }));
            setTargetTranslation(parsed.translation);
        }
        const aiMsgId = Date.now();
        const initialHistoryItem = { role: 'ai', type: 'text', text: tutorContent, content: null, id: aiMsgId };
        setChatHistory([initialHistoryItem]);
        setAiCache(prev => ({ ...prev, [cacheKey]: [initialHistoryItem] }));

        try {
            const blob = await callGeminiTTS_Chunked(tutorContent, currentApiKey);
            if (blob) {
                const audioUrl = URL.createObjectURL(blob);
                setChatHistory(prev => [{ ...prev[0], type: 'audio', content: audioUrl }]);
                setAiCache(prev => ({ ...prev, [cacheKey]: [{ ...prev[cacheKey][0], type: 'audio', content: audioUrl }] }));
            }
        } catch (e) { }
        setIsLoadingAI(false);
    };

    const handleTutorReply = async () => {
        if (!chatInput.trim()) return;
        const userMsg = chatInput; setChatInput("");
        const newHist = [...chatHistory, { role: 'user', content: userMsg }];
        chatHistorySentenceKeyRef.current = `${currentTrackIndex}-${currentIndex}`;
        setChatHistory(newHist); setIsLoadingAI(true);

        try {
            const context = newHist.map(m => `${m.role}: ${m.text || m.content}`).join('\n');
            const systemPrompt = tutorLang === 'target'
                ? SYSTEM_PROMPT_TUTOR_TARGET(learnerLevel)
                : SYSTEM_PROMPT_CORE(learnerLevel);
            const tutorLangInstruction = tutorLang === 'target'
                ? "LANGUAGE: Use Target Language only. STRICT: no Traditional Chinese and no '中文提示:' line."
                : "LANGUAGE: Use Traditional Chinese.";
            // [FIX] Injected Correction Instructions for Chat
            const prompt = `${systemPrompt}
            
            [INSTRUCTION]
            1. Respond to the user's input naturally.
            2. **CORRECTION**: If the user made a mistake, explain it briefly and provide the correct form.
            3. **SUGGESTION**: Suggest a more natural way to say it if applicable.
            4. Keep your response level-appropriate (Level ${learnerLevel}).
            5. Prefer 10-12 short sentences unless the user asked for a very short reply.
            6. ${tutorLangInstruction}
            
            CONTEXT:\n${context}\nUser: ${userMsg}`;

            const res = await callGeminiText(prompt, currentApiKey);
            const formattedRaw = formatTutorText(res);
            const formatted = tutorLang === "target" ? stripTutorChineseHintLines(formattedRaw) : formattedRaw;
            const aiMsgId = Date.now();
            const aiMsg = { role: 'ai', content: null, text: formatted, type: 'text', id: aiMsgId };
            setChatHistory([...newHist, aiMsg]);

            const blob = await callGeminiTTS_Chunked(formatted, currentApiKey);
            if (blob) {
                const audioUrl = URL.createObjectURL(blob);
                setChatHistory(prev => prev.map(m => m.id === aiMsgId ? { ...m, type: 'audio', content: audioUrl } : m));
            }
        } catch (e) { } finally { setIsLoadingAI(false); }
    };

    const startLiveCall = async () => {
        if (playerRef.current) playerRef.current.pause();
        setShowLiveCall(true); setLiveCallStatus("listening"); isLiveActiveRef.current = true;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
            streamRef.current = stream; startLiveRecording(stream);
        } catch (err) { alert("Mic Error"); endLiveCall(); }
    };

    const endLiveCall = () => {
        isLiveActiveRef.current = false; stopLiveRecording(); setShowLiveCall(false);
        if (liveAudioRef.current) liveAudioRef.current.pause();
    };

    const startLiveRecording = async (stream) => {
        if (!isLiveActiveRef.current || isGeneratingRef.current || isPlayingQueueRef.current) return;
        try {
            mediaRecorderRef.current = new MediaRecorder(stream);
            audioChunksRef.current = [];
            mediaRecorderRef.current.ondataavailable = e => audioChunksRef.current.push(e.data);
            mediaRecorderRef.current.onstop = async () => {
                if (!isLiveActiveRef.current) return;
                const blob = new Blob(audioChunksRef.current, { type: 'audio/mp3' });
                const reader = new FileReader();
                reader.readAsDataURL(blob);
                reader.onloadend = () => processLiveTurn(reader.result.split(',')[1]);
            };
            mediaRecorderRef.current.start();
            setTimeout(() => { if (mediaRecorderRef.current.state === 'recording') mediaRecorderRef.current.stop(); }, 4000); // Simple 4s slice for demo
        } catch (err) { }
    };

    const stopLiveRecording = () => { if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop(); };

    const processLiveTurn = async (b64) => {
        isGeneratingRef.current = true; setLiveCallStatus("processing");
        try {
            const prompt = SYSTEM_PROMPT_LIVE_CALL(learnerLevel) + `\nUser audio attached.`;
            const res = await callGeminiMultimodal(prompt, b64, currentApiKey);
            setLiveCallStatus("buffering");
            const blob = await callGeminiTTS_Single(res, currentApiKey);
            if (blob) {
                const url = URL.createObjectURL(blob);
                liveAudioRef.current.src = url;
                setLiveCallStatus("speaking");
                liveAudioRef.current.play();
                liveAudioRef.current.onended = () => {
                    isGeneratingRef.current = false; setLiveCallStatus("listening"); startLiveRecording(streamRef.current);
                };
            } else { isGeneratingRef.current = false; startLiveRecording(streamRef.current); }
        } catch (e) { isGeneratingRef.current = false; startLiveRecording(streamRef.current); }
    };

    const onTouchStart = (e) => { touchStartRef.current = e.targetTouches[0].clientX; };
    const onTouchEnd = (e) => {
        if (!touchStartRef.current) return;
        if (touchStartRef.current - e.changedTouches[0].clientX > 50 && !showModal) handleVoiceTutor();
        touchStartRef.current = null;
    };

    const targetKey = `${currentTrackIndex}-${currentIndex}`;
    const targetFixText = targetFixCache[targetKey] || "";
    const targetSentenceHtml = renderTargetSentenceHtml(smartTargetDisplay, targetFixText);
    const targetSentenceSpeak = stripStrike(normalizeTargetSentence(targetFixText || smartTargetDisplay));
    const isKnowledgePreviewTextMode = isKnowledgePreviewModalState(
        aiMode,
        modalTitle,
        modalContent,
        quizKnowledgeFileInfo
    );
    const shouldAllowKnowledgePreviewPopup = isKnowledgePreviewTextMode || aiMode === 'flashcards';
    const shouldShowTargetSentencePanel = Boolean(smartTargetDisplay) && !isKnowledgePreviewTextMode;

    useEffect(() => {
        if (!showKnowledgeTxtPicker || !isKnowledgePreviewTextMode) return;
        requestAnimationFrame(() => {
            const panel = knowledgeTxtPickerPanelRef.current;
            if (panel && typeof panel.scrollIntoView === 'function') {
                panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
                return;
            }
            if (modalScrollRef.current && typeof modalScrollRef.current.scrollTo === 'function') {
                modalScrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    }, [showKnowledgeTxtPicker, isKnowledgePreviewTextMode]);

    const getTutorWholeSpeakText = (msg) => {
        const raw = String(msg?.text || msg?.content || '');
        if (!raw) return '';
        const noHint = stripTutorChineseHintLines(raw);
        const cleaned = stripTargetTagsForDisplay(cleanTextForDisplay(noHint))
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return sanitizeSpeakerText(normalizeJapaneseRubyForSpeech(cleaned, trackLanguage));
    };

    // Progress Calculation
    // [FIX] Calculate progress based on how many of the CURRENT subtitles' IDs are in the watched set
    // This ensures 100% is reachable even if modes are switched
    const watchedCount = subtitles.filter(s => watchedSegments.has(s.id)).length;
    const totalSegments = subtitles.length;
    const remainingSegments = Math.max(0, totalSegments - watchedCount);
    const progressPercent = subtitles.length > 0 ? Math.min(100, Math.round((watchedCount / subtitles.length) * 100)) : 0;
    // Unlock condition: 100% progress (or > 95% to be safe)
    const isSurvivalUnlocked = progressPercent >= 100;
    const progressStatusText = totalSegments === 0
        ? "未載入"
        : (isSurvivalUnlocked ? "已解鎖" : `差${remainingSegments}`);
    // For testing, you might want: const isSurvivalUnlocked = true;
    const currentQuizQuestion = quizQuestions[quizCurrentIndex] || null;
    const isQuizBatchDone = quizQuestions.length > 0 && quizCurrentIndex >= quizQuestions.length;
    const quizTotalCount = quizQuestions.length;
    const quizProgress = quizTotalCount > 0
        ? Math.min(100, Math.round((Math.min(quizCurrentIndex + (isQuizBatchDone ? 0 : 1), quizTotalCount) / quizTotalCount) * 100))
        : 0;
    const quizAnsweredCount = quizSessionStats.correct + quizSessionStats.wrong;
    const quizAccuracy = quizAnsweredCount > 0
        ? Math.round((quizSessionStats.correct / quizAnsweredCount) * 100)
        : 0;
    const flashCardDetectedCategories = Array.from(new Set(
        flashCards
            .map(card => String(card?.category || "").trim())
            .filter(Boolean)
    ));
    const flashCardCategoryOptions = [
        'all',
        // Always show the complete learning taxonomy. A category can be empty for
        // this particular file, but it must remain available for predictable UI.
        ...FLASH_CARD_CATEGORY_ORDER,
        ...flashCardDetectedCategories.filter((key) => !FLASH_CARD_CATEGORY_ORDER.includes(key))
    ];
    const activeFlashCardCategories = flashCardCategories.includes('all')
        ? []
        : flashCardCategories.filter((k) => k && k !== 'all');
    const getFlashCardMasteryForCard = useCallback((card) => {
        const cards = flashCardMasteryData?.cards || {};
        const cardId = buildFlashCardId(card);
        const frontKey = String(getFlashCardFrontText(card) || "");
        return cards[cardId] || cards[frontKey] || null;
    }, [flashCardMasteryData]);
    const parseFlashCardFilterMin = useCallback((raw) => {
        const s = String(raw || "").trim();
        if (!s) return null;
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? Math.max(0, n) : null;
    }, []);
    const flashCardRememberedMin = parseFlashCardFilterMin(flashCardRememberedMinInput);
    const flashCardForgotMin = parseFlashCardFilterMin(flashCardForgotMinInput);
    const flashCardReviewMin = parseFlashCardFilterMin(flashCardReviewMinInput);
    const filteredFlashCards = flashCards.filter((card) => {
        const categoryMatch = activeFlashCardCategories.length === 0 || activeFlashCardCategories.includes(card.category);
        if (!categoryMatch) return false;

        const mastery = getFlashCardMasteryForCard(card) || { rememberedCount: 0, forgotCount: 0, reviewCount: 0 };
        if (mastery.discardedAt) return false;
        const rememberedCount = Number(mastery.rememberedCount || mastery.level || 0);
        const forgotCount = Number(mastery.forgotCount || mastery.wrongCount || 0);
        const reviewCount = Number(mastery.reviewCount || rememberedCount + forgotCount);
        if (flashCardRememberedMin !== null && rememberedCount < flashCardRememberedMin) return false;
        if (flashCardForgotMin !== null && forgotCount < flashCardForgotMin) return false;
        if (flashCardReviewMin !== null && reviewCount < flashCardReviewMin) return false;

        if (flashCardFilterMode !== 'all') {
            switch (flashCardFilterMode) {
                case 'unseen':
                    if (reviewCount > 0) return false;
                    break;
                case 'wrong':
                    if (forgotCount === 0) return false;
                    break;
                case 'wrong_2':
                    if (forgotCount < 2) return false;
                    break;
                case 'learning':
                    if (rememberedCount >= 3) return false;
                    break;
                default:
                    break;
            }
        }

        return true;
    });
    const flashCardMasteryStats = useMemo(() => {
        const total = flashCards.length;
        let reviewed = 0;
        let remembered = 0;
        let forgot = 0;
        let clean = 0;
        let unseen = 0;
        let discarded = 0;
        for (const card of flashCards) {
            const mastery = getFlashCardMasteryForCard(card);
            if (mastery?.discardedAt) {
                discarded += 1;
                continue;
            }
            const rememberedCount = Number(mastery?.rememberedCount || mastery?.level || 0);
            const forgotCount = Number(mastery?.forgotCount || mastery?.wrongCount || 0);
            const reviewCount = Number(mastery?.reviewCount || rememberedCount + forgotCount);
            if (reviewCount > 0) reviewed += 1;
            else unseen += 1;
            if (rememberedCount > 0) remembered += 1;
            if (forgotCount > 0) forgot += 1;
            if (reviewCount > 0 && forgotCount === 0) clean += 1;
        }
        return { total, reviewed, remembered, forgot, clean, unseen, discarded };
    }, [flashCards, getFlashCardMasteryForCard]);
    const flashCardKnowledgeTermEntries = useMemo(() => {
        const normalizeMatchTerm = (rawFront = "") => {
            let s = cleanQuizDisplayText(String(rawFront || ""));
            if (!s) return "";
            s = s.replace(/^\s*(?:[-*•]\s*)+/, "").trim();
            s = s.replace(/^\s*(?:\d{1,4}\s*[.)、．]\s*)+/, "").trim();
            s = s.replace(/^(?:句型|文法|語法|pattern|grammar)\s*[:：]\s*/i, "").trim();
            s = s.replace(/^["“”'‘’`]+|["“”'‘’`]+$/g, "").trim();
            s = s.replace(/^例句\s*[:：]\s*/i, "").trim();
            s = s.replace(/\s*\/[^\/\n]{1,120}\/\s*$/u, "").trim();
            s = s.replace(/\s*\[[^\]\n]{1,120}\]\s*$/u, "").trim();
            const rubyMatch = s.match(/^(.*?)\s*[（(][^)）]{1,80}[)）]\s*$/u);
            if (rubyMatch) {
                const base = cleanQuizDisplayText(rubyMatch[1] || "");
                if (base) s = base;
            }
            return s.replace(/\s+/g, " ").trim();
        };

        const map = new Map();
        for (const card of flashCards) {
            const category = String(card?.category || "").trim();
            if (category !== 'vocab' && category !== 'usage') continue;

            const term = normalizeMatchTerm(card?.front || "");
            if (!term) continue;
            const latinOnly = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9'’._\- ]+$/u.test(term);
            const latinLetterCount = (term.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/gu) || []).length;
            if (latinOnly && latinLetterCount > 0 && latinLetterCount < 3) continue;

            const key = latinOnly ? term.toLowerCase() : term;
            let entry = map.get(key);
            if (!entry) {
                entry = { term, latinOnly, items: [], itemKeys: new Set() };
                map.set(key, entry);
            }

            const front = cleanQuizDisplayText(String(card?.front || ""));
            const back = cleanQuizDisplayText(String(card?.back || ""));
            const itemKey = `${category}::${front}::${back}`;
            if (entry.itemKeys.has(itemKey)) continue;
            entry.itemKeys.add(itemKey);
            entry.items.push({
                id: String(card?.id || itemKey),
                category,
                categoryLabel: String(card?.categoryLabel || QUIZ_FOCUS_TYPE_LABELS[category] || category),
                front,
                back
            });
        }

        return Array.from(map.values())
            .map(({ term, latinOnly, items }) => ({ term, latinOnly, items }))
            .filter((entry) => entry.term && Array.isArray(entry.items) && entry.items.length > 0)
            .sort((a, b) => b.term.length - a.term.length);
    }, [flashCards]);
    const buildKnowledgeTermEntriesFromTxt = useCallback((sourceTxtInput = "") => {
        const sourceTxt = String(sourceTxtInput || "").trim();
        if (!sourceTxt) return [];

        let cards = [];
        try {
            cards = parseKnowledgeTxtToFlashCards(sourceTxt);
        } catch (err) {
            console.warn("knowledgePreviewTermEntries parse failed:", err);
            return [];
        }
        if (!Array.isArray(cards) || cards.length === 0) return [];

        const normalizeMatchTerm = (rawFront = "") => {
            let s = cleanQuizDisplayText(String(rawFront || ""));
            if (!s) return "";
            s = s.replace(/^\s*(?:[-*•]\s*)+/, "").trim();
            s = s.replace(/^\s*(?:\d{1,4}\s*[.)、．]\s*)+/, "").trim();
            s = s.replace(/^(?:句型|文法|語法|pattern|grammar)\s*[:：]\s*/i, "").trim();
            s = s.replace(/^["“”'‘’`]+|["“”'‘’`]+$/g, "").trim();
            s = s.replace(/^例句\s*[:：]\s*/i, "").trim();
            s = s.replace(/\s*\/[^\/\n]{1,120}\/\s*$/u, "").trim();
            s = s.replace(/\s*\[[^\]\n]{1,120}\]\s*$/u, "").trim();
            const rubyMatch = s.match(/^(.*?)\s*[（(][^)）]{1,80}[)）]\s*$/u);
            if (rubyMatch) {
                const base = cleanQuizDisplayText(rubyMatch[1] || "");
                if (base) s = base;
            }
            return s.replace(/\s+/g, " ").trim();
        };
        const buildMatchTerms = (rawFront = "", categoryForAnchors = "") => {
            const raw = String(rawFront || "");
            const out = [];
            const seen = new Set();
            const buildPatternFrontVariants = (inputRaw = "") => {
                const seed = String(inputRaw || "");
                if (!seed) return [];
                const result = new Set([seed]);

                // Expand optional parenthesized token, e.g. "(the)" -> with/without.
                const optionalRe = /\(([^()]{1,24})\)/;
                for (let round = 0; round < 4; round += 1) {
                    let changed = false;
                    const snapshot = Array.from(result);
                    for (const v of snapshot) {
                        const m = String(v || "").match(optionalRe);
                        if (!m) continue;
                        const inside = String(m[1] || "").trim();
                        if (!inside) continue;
                        const withInside = String(v).replace(optionalRe, ` ${inside} `).replace(/\s+/g, " ").trim();
                        const withoutInside = String(v).replace(optionalRe, " ").replace(/\s+/g, " ").trim();
                        if (withInside && !result.has(withInside)) {
                            result.add(withInside);
                            changed = true;
                        }
                        if (withoutInside && !result.has(withoutInside)) {
                            result.add(withoutInside);
                            changed = true;
                        }
                    }
                    if (!changed) break;
                }

                // Expand common pattern placeholders to likely surface forms in source text.
                const placeholderSpecs = [
                    { re: /\b(?:someone|somebody|sb)\b/gi, reps: ["someone", "somebody", "people", "person"] },
                    { re: /\b(?:something|sth)\b/gi, reps: ["something", "it", "this", "that"] },
                    { re: /\b(?:someone's|somebody's|sb's)\b/gi, reps: ["someone's", "somebody's", "people's", "person's"] }
                ];
                for (const spec of placeholderSpecs) {
                    const snapshot = Array.from(result);
                    for (const v of snapshot) {
                        if (!spec.re.test(v)) {
                            spec.re.lastIndex = 0;
                            continue;
                        }
                        spec.re.lastIndex = 0;
                        for (const rep of spec.reps) {
                            const replaced = String(v).replace(spec.re, rep).replace(/\s+/g, " ").trim();
                            if (replaced) result.add(replaced);
                        }
                        // Also allow dropping placeholder word to make anchor less brittle.
                        const dropped = String(v).replace(spec.re, " ").replace(/\s+/g, " ").trim();
                        if (dropped) result.add(dropped);
                    }
                }

                return Array.from(result).filter(Boolean).slice(0, 32);
            };
            const pushTerm = (candidate, fromPattern = false) => {
                let t = normalizeMatchTerm(candidate);
                if (!t) return;
                t = t.replace(/^[\s"'“”‘’`~!@#$%^&*()\-_=+\[\]{};:,.<>/?\\|]+/g, "")
                    .replace(/[\s"'“”‘’`~!@#$%^&*()\-_=+\[\]{};:,.<>/?\\|]+$/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
                if (!t) return;
                const latinOnly = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9'’._\- ]+$/u.test(t);
                const latinLetters = (t.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/gu) || []).length;
                if (latinOnly && latinLetters > 0) {
                    if (latinLetters < 3) return;
                    if (fromPattern) {
                        const wordCount = t.split(/\s+/).filter(Boolean).length;
                        if (wordCount < 2 && t.length < 7) return;
                        if (/^(?:if|to|of|and|or|in|on|at|for|with|by|a|an|the)$/i.test(t)) return;
                    }
                } else if (fromPattern && t.length < 2) {
                    return;
                }
                const key = latinOnly ? t.toLowerCase() : t;
                if (seen.has(key)) return;
                seen.add(key);
                out.push(t);
            };
            const pushEnglishVerbPhraseVariants = (phrase) => {
                const base = normalizeMatchTerm(phrase);
                if (!base) return;
                const m = base.match(/^([A-Za-z][A-Za-z'’\-]{2,})(\s+.+)$/);
                if (!m) return;
                const head = String(m[1] || "");
                const tail = String(m[2] || "");
                const lower = head.toLowerCase();
                if (/(?:ing|ed|en|s)$/.test(lower)) return; // already inflected
                if (/^(?:be|have|do|go|say|get|make|take|put|set|let)$/i.test(head)) return;
                if (/^(?:if|to|of|and|or|in|on|at|for|with|by|a|an|the)$/i.test(head)) return;

                const forms = new Set();
                if (/[sxz]$/.test(lower) || /(?:sh|ch|o)$/.test(lower)) forms.add(`${head}es${tail}`);
                else forms.add(`${head}s${tail}`);

                if (/e$/.test(lower)) {
                    forms.add(`${head}d${tail}`);
                    forms.add(`${head.slice(0, -1)}ing${tail}`);
                } else if (/[^aeiou]y$/.test(lower)) {
                    forms.add(`${head.slice(0, -1)}ied${tail}`);
                    forms.add(`${head.slice(0, -1)}ies${tail}`);
                    forms.add(`${head}ing${tail}`);
                } else {
                    forms.add(`${head}ed${tail}`);
                    forms.add(`${head}ing${tail}`);
                }
                for (const f of forms) pushTerm(f, true);
            };
            const pushLatinContentAnchors = (phrase) => {
                const base = normalizeMatchTerm(phrase);
                const anchorCategory = String(categoryForAnchors || "").trim();
                if (!/^(?:usage|vocab)$/i.test(anchorCategory)) return;
                if (!/^[A-Za-zÀ-ÖØ-öø-ÿ0-9'’._\- ]+$/u.test(base)) return;
                const words = base
                    .split(/\s+/)
                    .map((x) => x.replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/gu, ""))
                    .filter(Boolean);
                if (words.length < 2) return;
                const stop = /^(?:if|to|of|and|or|in|on|at|for|with|by|from|into|onto|over|under|a|an|the|this|that|these|those|be|is|are|was|were|been|being|have|has|had|do|does|did|will|would|shall|should|can|could|may|might|must|not|no|yes|first|second|third|fourth|fifth|last|next|new|old|good|bad|big|small|more|most|less|least|much|many|few|same|other|another)$/i;
                for (const word of words) {
                    if (stop.test(word)) continue;
                    if (word.length < 4 && !/^(?:tap|tax|cap|cut|hit|run|bid|bar|ban|curb|crimp)$/i.test(word)) continue;
                    pushTerm(word, false);
                }
            };

            const frontVariants = buildPatternFrontVariants(raw);
            if (frontVariants.length === 0) frontVariants.push(raw);
            for (const frontVariant of frontVariants) {
                pushTerm(frontVariant, false);
                pushLatinContentAnchors(frontVariant);
                // Direct anchor extraction for verb+to patterns (e.g. "threaten to").
                // This reduces misses when source uses inflected verb forms like "threatened to".
                const plainRaw = stripTargetTagsForDisplay(frontVariant)
                    .replace(/<[^>]*>/g, " ")
                    .replace(/\{\{(.*?)\}\}/g, "$1")
                    .replace(/\s+/g, " ")
                    .trim();
                if (plainRaw) {
                    const verbToRe = /\b([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]{2,})\s+to\b/gu;
                    let m;
                    while ((m = verbToRe.exec(plainRaw)) !== null) {
                        const verb = String(m[1] || "").trim();
                        if (!verb) continue;
                        const phrase = `${verb} to`;
                        pushTerm(phrase, true);
                        pushEnglishVerbPhraseVariants(phrase);
                    }
                }

                if (/(?:\.\.\.|…|⋯|．．．)/.test(frontVariant)) {
                    const chunks = frontVariant
                        .split(/(?:\.\.\.|…|⋯|．．．)+/g)
                        .map((x) => String(x || "").trim())
                        .filter(Boolean);
                    for (const chunk of chunks) {
                        pushTerm(chunk, true);
                        pushEnglishVerbPhraseVariants(chunk);
                    }
                }
            }
            return out;
        };

        const map = new Map();
        for (const card of cards) {
            const category = String(card?.category || "").trim();
            if (!category || category === 'sentence') continue;

            const front = cleanQuizDisplayText(String(card?.front || ""));
            const back = cleanQuizDisplayText(String(card?.back || ""));
            const itemKey = `${category}::${front}::${back}`;
            const terms = buildMatchTerms(card?.front || "", category);
            if (terms.length === 0) continue;

            for (const term of terms) {
                const latinOnly = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9'’._\- ]+$/u.test(term);
                const key = latinOnly ? term.toLowerCase() : term;
                let entry = map.get(key);
                if (!entry) {
                    entry = { term, latinOnly, items: [], itemKeys: new Set() };
                    map.set(key, entry);
                }
                if (entry.itemKeys.has(itemKey)) continue;
                entry.itemKeys.add(itemKey);
                entry.items.push({
                    id: String(card?.id || itemKey),
                    category,
                    categoryLabel: String(card?.categoryLabel || QUIZ_FOCUS_TYPE_LABELS[category] || category),
                    front,
                    back
                });
            }
        }

        return Array.from(map.values())
            .map(({ term, latinOnly, items }) => ({ term, latinOnly, items }))
            .filter((entry) => entry.term && Array.isArray(entry.items) && entry.items.length > 0)
            .sort((a, b) => b.term.length - a.term.length);
    }, [parseKnowledgeTxtToFlashCards]);
    const knowledgePreviewTermEntries = useMemo(() => {
        if (!isKnowledgePreviewTextMode) return [];
        return buildKnowledgeTermEntriesFromTxt(modalContent);
    }, [buildKnowledgeTermEntriesFromTxt, isKnowledgePreviewTextMode, modalContent]);
    const embeddedKnowledgeTermEntries = useMemo(() => {
        return buildKnowledgeTermEntriesFromTxt(embeddedKnowledgeText);
    }, [buildKnowledgeTermEntriesFromTxt, embeddedKnowledgeText]);
    const embeddedKnowledgeSubtitleMatch = useMemo(() => {
        const subtitleText = subtitles[currentIndex]?.text || "";
        return findKnowledgeSubtitleMatch(embeddedKnowledgeText, subtitleText);
    }, [embeddedKnowledgeText, subtitles, currentIndex]);
    useEffect(() => {
        if (topPanelMode !== 'document' || !embeddedKnowledgeSubtitleMatch || !embeddedKnowledgeContentRef.current) return;
        const timer = setTimeout(() => {
            const container = embeddedKnowledgeContentRef.current;
            const target = container?.querySelector?.(`[data-knowledge-source-line="${embeddedKnowledgeSubtitleMatch.sourceLine}"]`);
            if (!container || !target) return;
            const containerRect = container.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            const topPadding = Math.min(56, Math.max(20, container.clientHeight * 0.12));
            const desiredTop = container.scrollTop + targetRect.top - containerRect.top - topPadding;
            const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
            container.scrollTo({ top: Math.max(0, Math.min(maxTop, desiredTop)), behavior: 'smooth' });
        }, 0);
        return () => clearTimeout(timer);
    }, [topPanelMode, currentIndex, embeddedKnowledgeSubtitleMatch]);
    const isLatinTermWordChar = useCallback((ch = "") => /[A-Za-zÀ-ÖØ-öø-ÿ0-9'’\-]/u.test(ch), []);
    const matchFlashCardTermAt = useCallback((text, at, entry) => {
        const source = String(text || "");
        const term = String(entry?.term || "");
        if (!source || !term) return false;
        if (at < 0 || (at + term.length) > source.length) return false;

        if (entry?.latinOnly) {
            const slice = source.slice(at, at + term.length);
            if (slice.toLowerCase() !== term.toLowerCase()) return false;
            const prev = at > 0 ? source[at - 1] : "";
            const next = (at + term.length) < source.length ? source[at + term.length] : "";
            if (isLatinTermWordChar(prev) || isLatinTermWordChar(next)) return false;
            return true;
        }

        return source.startsWith(term, at);
    }, [isLatinTermWordChar]);
    const flashCardCategoryKey = activeFlashCardCategories.length === 0
        ? 'all'
        : [...activeFlashCardCategories].sort().join(',');
    const normalizedFlashCardIndex = filteredFlashCards.length > 0
        ? Math.min(flashCardIndex, filteredFlashCards.length - 1)
        : 0;
    const flashCardFolderKnowledgeCount = knowledgeTxtOptions.length;
    const knowledgeTxtPickerEntries = useMemo(() => {
        const map = selectedFolderFilesRef.current || {};
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        const entries = (knowledgeTxtOptions || []).map((name) => {
            const file = map[String(name || "").toLowerCase()] || null;
            return {
                name: String(name || ""),
                lastModified: Number(file?.lastModified || 0),
                size: Number(file?.size || 0)
            };
        });
        const dirFactor = knowledgeTxtPickerSortDir === 'asc' ? 1 : -1;
        entries.sort((a, b) => {
            if (knowledgeTxtPickerSortKey === 'name') {
                return collator.compare(String(a?.name || ""), String(b?.name || "")) * dirFactor;
            }
            const diff = (Number(a?.lastModified || 0) - Number(b?.lastModified || 0)) * dirFactor;
            if (diff !== 0) return diff;
            return collator.compare(String(a?.name || ""), String(b?.name || "")) * dirFactor;
        });
        return entries;
    }, [knowledgeTxtOptions, knowledgeTxtPickerSortDir, knowledgeTxtPickerSortKey]);
    const formatKnowledgeTxtPickerTime = useCallback((ts) => {
        const n = Number(ts || 0);
        if (!Number.isFinite(n) || n <= 0) return "—";
        try {
            return new Date(n).toLocaleString();
        } catch (_) {
            return "—";
        }
    }, []);
    const formatKnowledgeTxtPickerSize = useCallback((size) => {
        const n = Number(size || 0);
        if (!Number.isFinite(n) || n <= 0) return "—";
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(n >= 10 * 1024 ? 0 : 1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }, []);
    const flashCardAutoRunStartDisabled = flashCardAutoRun
        ? false
        : (flashCardAutoRunAllKnowledgeTxt
            ? flashCardFolderKnowledgeCount < 1
            : filteredFlashCards.length < 1);
    const currentFlashCard = filteredFlashCards[normalizedFlashCardIndex] || null;
    const flashCardMasterySyncStatusLabel = {
        local_only: isFileSystemAccessSupported() ? "Local only" : "Local only / Import-Export available",
        folder_sync_active: "Folder sync active",
        loading: "Loading...",
        saving: "Saving...",
        saved: "Saved",
        save_failed: "Save failed",
        unsupported: "Unsupported"
    }[flashCardMasterySyncStatus] || "Local only";
    const flashCardFrontSpeakText = cleanQuizDisplayText(
        String(currentFlashCard?.frontSpeakText || extractFrontTermForSpeech(currentFlashCard?.front || "") || currentFlashCard?.front || "")
    );
    const flashCardBackExampleSpeakText = sanitizeSpeakerText(
        normalizeJapaneseRubyForSpeech(
            extractBackExamplesForSpeech(currentFlashCard),
            trackLanguage
        )
    );
    const flashCardBackZhSpeakText = sanitizeSpeakerText(
        normalizeJapaneseRubyForSpeech(String(currentFlashCard?.backZhSpeakText || ""), "zh-TW")
    );
    const flashCardReverseFrontSpeakText = flashCardBackZhSpeakText || flashCardBackExampleSpeakText || sanitizeSpeakerText(
        normalizeJapaneseRubyForSpeech(String(currentFlashCard?.back || ""), trackLanguage)
    );
    const flashCardFrontExampleZhText = String(currentFlashCard?.back || "").match(/例句\s*[:：]/i)
        ? extractBackExampleZhTranslations(currentFlashCard)
        : "";
    const shouldShowFlashCardFrontExamples = Boolean(flashCardFrontExampleZhText);

    const flashCardBackDisplayData = useMemo(() => {
        const frontText = String(currentFlashCard?.front || "");
        const backText = String(currentFlashCard?.back || "");
        
        const buildNodes = (textToParse) => {
            if (!textToParse) return "";
            if (currentFlashCard?.category !== 'sentence') return textToParse;
            if (flashCardKnowledgeTermEntries.length === 0) return textToParse;

            const nodes = [];
            let cursor = 0;
            let tokenIdx = 0;
            while (cursor < textToParse.length) {
                let hitPos = -1;
                let hitEntry = null;

                for (let pos = cursor; pos < textToParse.length; pos += 1) {
                    for (const entry of flashCardKnowledgeTermEntries) {
                        if (matchFlashCardTermAt(textToParse, pos, entry)) {
                            hitPos = pos;
                            hitEntry = entry;
                            break;
                        }
                    }
                    if (hitEntry) break;
                }

                if (!hitEntry) {
                    if (cursor < textToParse.length) {
                        nodes.push(<React.Fragment key={`fc-back-text-${tokenIdx++}`}>{textToParse.slice(cursor)}</React.Fragment>);
                    }
                    break;
                }

                if (hitPos > cursor) {
                    nodes.push(<React.Fragment key={`fc-back-text-${tokenIdx++}`}>{textToParse.slice(cursor, hitPos)}</React.Fragment>);
                }

                const matchedText = textToParse.slice(hitPos, hitPos + hitEntry.term.length);
                const popupItems = Array.isArray(hitEntry.items) ? hitEntry.items : [];
                nodes.push(
                    <button
                        key={`fc-back-link-${tokenIdx++}`}
                        type="button"
                        className="inline p-0 m-0 border-0 bg-transparent font-semibold text-cyan-800 underline decoration-2 underline-offset-2 decoration-cyan-400 hover:text-cyan-900 hover:decoration-cyan-600"
                        onMouseDown={(e) => e.stopPropagation()}
                        onTouchStart={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!popupItems.length) return;
                            const currPos = knowledgePreviewPopupPosRef.current || { x: 24, y: 112 };
                            setKnowledgePreviewPopupPos({
                                x: Number(currPos?.x) || 24,
                                y: Number(currPos?.y) || 112
                            });
                            setKnowledgePreviewTermPopup({
                                term: cleanQuizDisplayText(matchedText || hitEntry.term || ""),
                                items: popupItems.slice(0, 8)
                            });
                        }}
                        title="查看同檔知識點"
                    >
                        {matchedText}
                    </button>
                );
                cursor = hitPos + hitEntry.term.length;
            }

            return nodes.length > 0 ? nodes : textToParse;
        };

        const match = backText.match(/(例句\s*[:：]\s*[\s\S]*)/i);
        let explanationText = backText;
        let exampleText = "";
        if (match && match.index !== undefined) {
            explanationText = backText.substring(0, match.index).trim();
            exampleText = backText.substring(match.index).trim();
        }

        return {
            front: buildNodes(frontText),
            full: currentFlashCard?.category === 'sentence' ? backText : buildNodes(backText),
            explanation: currentFlashCard?.category === 'sentence' ? explanationText : buildNodes(explanationText),
            example: currentFlashCard?.category === 'sentence' ? exampleText : buildNodes(exampleText)
        };
    }, [currentFlashCard?.back, currentFlashCard?.category, currentFlashCard?.front, flashCardKnowledgeTermEntries, matchFlashCardTermAt]);
    const flashCardFrontSpeakLang = null;
    const flashCardSpeakLang = (() => {
        const explicit = String(currentFlashCard?.speakLang || "").trim();
        if (explicit) return normalizeDeclaredLanguage(explicit, trackLanguage || "en-US");
        const fromKnowledge = String(quizKnowledgeFileInfo?.targetLanguage || "").trim();
        if (fromKnowledge) {
            return normalizeDeclaredLanguage(fromKnowledge, trackLanguage || "en-US");
        }
        const fallback = fromKnowledge || trackLanguage || "en-US";
        const sample = `${flashCardFrontSpeakText || currentFlashCard?.front || ""}\n${flashCardBackExampleSpeakText || ""}`;
        return detectTtsLanguageFromText(sample, fallback);
    })();
    const flashCardReverseFrontSpeakLang = flashCardBackZhSpeakText ? "zh-TW" : flashCardSpeakLang;
    const getKnowledgePreviewPopupDefaultPos = useCallback(() => {
        if (typeof window === 'undefined') return { x: 24, y: 112 };
        const panelW = 560;
        const panelH = 420;
        const margin = 12;
        const x = Math.max(margin, Math.min(window.innerWidth - panelW - margin, window.innerWidth - panelW - 28));
        const y = Math.max(72, Math.min(128, window.innerHeight - panelH - margin));
        return { x, y };
    }, []);
    const clampKnowledgePreviewPopupPos = useCallback((rawX, rawY) => {
        if (typeof window === 'undefined') return { x: rawX, y: rawY };
        const margin = 8;
        const panel = knowledgePreviewPopupPanelRef.current;
        const panelW = panel?.offsetWidth || 520;
        const panelH = panel?.offsetHeight || 380;
        const maxX = Math.max(margin, window.innerWidth - panelW - margin);
        const maxY = Math.max(margin, window.innerHeight - panelH - margin);
        const x = Math.max(margin, Math.min(maxX, Number(rawX) || 0));
        const y = Math.max(margin, Math.min(maxY, Number(rawY) || 0));
        return { x, y };
    }, []);
    const startKnowledgePreviewPopupDrag = useCallback((e) => {
        const point = e?.touches?.[0] || e;
        if (!point) return;
        knowledgePreviewPopupDragRef.current = {
            startX: Number(point.clientX) || 0,
            startY: Number(point.clientY) || 0,
            originX: Number(knowledgePreviewPopupPosRef.current?.x) || 0,
            originY: Number(knowledgePreviewPopupPosRef.current?.y) || 0
        };
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
    }, []);
    const startKnowledgePreviewSplitDrag = useCallback((e) => {
        const point = e?.touches?.[0] || e;
        if (!point) return;
        knowledgePreviewSplitDragRef.current = {
            startX: Number(point.clientX) || 0,
            originW: knowledgePreviewSplitWidth
        };
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
    }, [knowledgePreviewSplitWidth]);
    const parseKnowledgePreviewPopupItem = useCallback((backRaw) => {
        const normalizedText = String(backRaw || "")
            .replace(/\s+(說明\s*[:：])/gi, "\n$1")
            .replace(/\s+(例句\s*[:：])/gi, "\n$1")
            .replace(/\s+(tags?\s*[:：])/gi, "\n$1");
        const lines = normalizedText
            .split(/\r?\n+/)
            .map((line) => cleanQuizDisplayText(String(line || "")).trim())
            .filter(Boolean);
        const detailParts = [];
        const exampleParts = [];
        const tagParts = [];
        for (const line of lines) {
            if (/^例句\s*[:：]/i.test(line)) {
                const v = line.replace(/^例句\s*[:：]\s*/i, "").trim();
                if (v) exampleParts.push(v);
                continue;
            }
            if (/^tags?\s*[:：]/i.test(line)) {
                const v = line.replace(/^tags?\s*[:：]\s*/i, "").trim();
                if (v) tagParts.push(v);
                continue;
            }
            const detail = line.replace(/^說明\s*[:：]\s*/i, "").trim();
            if (detail) detailParts.push(detail);
        }
        return {
            detail: detailParts.join(" "),
            example: exampleParts.join(" / "),
            tags: tagParts.join(" / ")
        };
    }, []);
    const knowledgePreviewPopupSpeakLang = String(quizKnowledgeFileInfo?.targetLanguage || trackLanguage || "").trim();
    const getKnowledgePreviewPopupFrontSpeakText = useCallback((item) => {
        return cleanQuizDisplayText(
            String(extractFrontTermForSpeech(item?.front || "") || item?.front || "")
        );
    }, []);
    const getKnowledgePreviewPopupExampleSpeakText = useCallback((exampleText) => {
        const safeExample = String(exampleText || "").trim();
        if (!safeExample) return "";
        return sanitizeSpeakerText(
            normalizeJapaneseRubyForSpeech(
                extractBackExamplesForSpeech({
                    back: `例句：${safeExample}`,
                    speakLang: knowledgePreviewPopupSpeakLang,
                    targetLanguage: knowledgePreviewPopupSpeakLang
                }),
                knowledgePreviewPopupSpeakLang || undefined
            ),
            knowledgePreviewPopupSpeakLang || undefined
        );
    }, [knowledgePreviewPopupSpeakLang]);
    const handleKnowledgePreviewTermClick = useCallback((payload) => {
        const term = cleanQuizDisplayText(String(payload?.term || ""));
        const rawItems = Array.isArray(payload?.items) ? payload.items : [];
        const seen = new Set();
        const items = [];
        for (const item of rawItems) {
            const front = cleanQuizDisplayText(String(item?.front || ""));
            const back = cleanQuizDisplayText(String(item?.back || ""));
            const category = String(item?.category || "").trim();
            const k = `${category}::${front}::${back}`;
            if (!front || seen.has(k)) continue;
            seen.add(k);
            items.push({
                id: String(item?.id || k),
                category,
                categoryLabel: String(item?.categoryLabel || QUIZ_FOCUS_TYPE_LABELS[category] || category || "知識點"),
                front,
                back
            });
            if (items.length >= 12) break;
        }
        if (!term || items.length === 0) return;
        const nextPos = !knowledgePreviewTermPopup
            ? getKnowledgePreviewPopupDefaultPos()
            : {
                x: Number(knowledgePreviewPopupPosRef.current?.x) || 0,
                y: Number(knowledgePreviewPopupPosRef.current?.y) || 0
            };
        setKnowledgePreviewPopupPos(clampKnowledgePreviewPopupPos(nextPos.x, nextPos.y));
        setKnowledgePreviewTermPopup({ term, items });
    }, [clampKnowledgePreviewPopupPos, getKnowledgePreviewPopupDefaultPos, knowledgePreviewTermPopup]);
    const renderKnowledgePreviewPopupPanel = useCallback((isSplitCaller = false) => {
        if (!knowledgePreviewTermPopup || !Array.isArray(knowledgePreviewTermPopup.items) || knowledgePreviewTermPopup.items.length <= 0) return null;
        
        const isSplitMode = knowledgePreviewPopupMode === 'split';
        if (isSplitCaller && !isSplitMode) return null;
        if (!isSplitCaller && isSplitMode) return null;
        
        const isSplit = isSplitMode;
        
        const innerContent = (
            <>
                <div
                    className={`flex items-center justify-between gap-3 mb-3 select-none ${!isSplit ? 'cursor-move' : ''}`}
                    onMouseDown={!isSplit ? startKnowledgePreviewPopupDrag : undefined}
                    onTouchStart={!isSplit ? startKnowledgePreviewPopupDrag : undefined}
                >
                    <p className="text-sm sm:text-base font-bold text-cyan-900 truncate pr-2">
                        知識點視窗：{knowledgePreviewTermPopup.term}
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                        <div className="flex items-center gap-1 rounded-full border border-cyan-200 bg-cyan-50/70 px-1 py-0.5">
                            <button
                                type="button"
                                onClick={() => setKnowledgePreviewPopupFontSize((v) => Math.max(12, Number(v || 16) - 2))}
                                className="p-1 rounded hover:bg-white text-cyan-700"
                                title="縮小字體"
                            >
                                <Minus size={12} />
                            </button>
                            <button
                                type="button"
                                onClick={() => setKnowledgePreviewPopupFontSize(16)}
                                className="px-1.5 py-1 rounded hover:bg-white text-[11px] font-semibold text-cyan-700"
                                title="還原字體"
                            >
                                A
                            </button>
                            <button
                                type="button"
                                onClick={() => setKnowledgePreviewPopupFontSize((v) => Math.min(30, Number(v || 16) + 2))}
                                className="p-1 rounded hover:bg-white text-cyan-700"
                                title="放大字體"
                            >
                                <Plus size={12} />
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={() => setKnowledgePreviewPopupMode(isSplit ? 'floating' : 'split')}
                            className="p-1 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                            title={isSplit ? "切換為浮動視窗" : "切換為右側分欄"}
                        >
                            {isSplit ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                        </button>
                        {!isSplit && <span className="text-[11px] text-cyan-600 hidden sm:inline">拖曳移動</span>}
                        <button
                            type="button"
                            onClick={() => setKnowledgePreviewTermPopup(null)}
                            className="px-2.5 py-1 rounded-full border border-cyan-300 bg-white text-cyan-700 text-xs font-semibold hover:bg-cyan-50"
                        >
                            關閉
                        </button>
                    </div>
                </div>
                <div className={`overflow-y-auto space-y-2 pr-1 ${isSplit ? 'flex-1' : 'max-h-[60vh] h-full'}`}>
                        {knowledgePreviewTermPopup.items.map((item, idx) => {
                            const parsed = parseKnowledgePreviewPopupItem(item?.back || "");
                            const frontSpeakText = getKnowledgePreviewPopupFrontSpeakText(item);
                            const exampleSpeakText = getKnowledgePreviewPopupExampleSpeakText(parsed.example);
                            return (
                                <div key={`${item.id || item.front || idx}-${idx}`} className="rounded-xl border border-cyan-100 bg-cyan-50/30 p-3">
                                    <p
                                        className="text-cyan-700 font-bold mb-1"
                                        style={{ fontSize: `${Math.max(10, knowledgePreviewPopupFontSize - 4)}px` }}
                                    >
                                        {item.categoryLabel || item.category || "知識點"}
                                    </p>
                                    <div className="flex items-start gap-2">
                                        <p className="leading-relaxed flex-1" style={{ fontSize: `${knowledgePreviewPopupFontSize}px` }}>
                                            <span className="font-semibold text-gray-900">{cleanQuizDisplayText(String(item?.front || ""))}</span>
                                            {parsed.detail && (
                                                <span className="text-gray-700">　{parsed.detail}</span>
                                            )}
                                        </p>
                                        {frontSpeakText ? <QuickSpeakBtn text={frontSpeakText} mode="native" forceNativeLang={knowledgePreviewPopupSpeakLang} size={14} className="mt-0.5 shrink-0" /> : null}
                                    </div>
                                    {parsed.example && (
                                        <div className="mt-1 flex items-start gap-2">
                                            <p
                                                className="text-gray-700 leading-relaxed whitespace-pre-wrap flex-1"
                                                style={{ fontSize: `${Math.max(11, knowledgePreviewPopupFontSize - 2)}px` }}
                                            >
                                                <span className="font-semibold text-gray-500">例句：</span>{parsed.example}
                                            </p>
                                            {exampleSpeakText ? <QuickSpeakBtn text={exampleSpeakText} mode="native" forceNativeLang={knowledgePreviewPopupSpeakLang} pauseBetweenLinesMs={1000} size={14} className="mt-0.5 shrink-0" /> : null}
                                        </div>
                                    )}
                                    {parsed.tags && (
                                        <p
                                            className="mt-1 text-cyan-700"
                                            style={{ fontSize: `${Math.max(10, knowledgePreviewPopupFontSize - 3)}px` }}
                                        >
                                            <span className="font-semibold">Tags：</span>{parsed.tags}
                                        </p>
                                    )}
                                </div>
                            );
                        })}
                    </div>
            </>
        );

        if (isSplit) {
            return (
                <div className="flex flex-col h-full bg-cyan-50/10 p-4 border-l border-cyan-200 overflow-hidden shrink-0" style={{ width: knowledgePreviewSplitWidth }}>
                    {innerContent}
                </div>
            );
        }

        return (
            <div className="fixed inset-0 z-[72] pointer-events-none">
                <div
                    ref={knowledgePreviewPopupPanelRef}
                    className="pointer-events-auto absolute min-w-[280px] min-h-[200px] w-[min(92vw,640px)] max-h-[85vh] rounded-2xl border border-cyan-200 bg-white p-4 sm:p-5 shadow-2xl flex flex-col"
                    style={{ left: `${knowledgePreviewPopupPos.x}px`, top: `${knowledgePreviewPopupPos.y}px`, resize: 'both', overflow: 'hidden' }}
                >
                    {innerContent}
                </div>
            </div>
        );
    }, [knowledgePreviewTermPopup, knowledgePreviewPopupMode, knowledgePreviewSplitWidth, knowledgePreviewPopupPos, knowledgePreviewPopupFontSize, parseKnowledgePreviewPopupItem, getKnowledgePreviewPopupFrontSpeakText, getKnowledgePreviewPopupExampleSpeakText, startKnowledgePreviewPopupDrag, knowledgePreviewPopupSpeakLang]);
    useEffect(() => {
        setFlashCardTermPopup(null);
        setKnowledgePreviewTermPopup(null);
    }, [flashCardSourceName, normalizedFlashCardIndex]);
    useEffect(() => {
        const onMove = (e) => {
            const drag = knowledgePreviewPopupDragRef.current;
            const splitDrag = knowledgePreviewSplitDragRef.current;
            if (!drag && !splitDrag) return;
            const point = e?.touches?.[0] || e;
            if (!point) return;

            if (drag) {
                const dx = (Number(point.clientX) || 0) - drag.startX;
                const dy = (Number(point.clientY) || 0) - drag.startY;
                const next = clampKnowledgePreviewPopupPos(drag.originX + dx, drag.originY + dy);
                setKnowledgePreviewPopupPos(next);
            } else if (splitDrag) {
                const dx = splitDrag.startX - (Number(point.clientX) || 0); // dragging left increases right pane width
                const nextW = Math.max(200, Math.min(window.innerWidth * 0.8, splitDrag.originW + dx));
                setKnowledgePreviewSplitWidth(nextW);
            }
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
        };
        const onUp = () => {
            knowledgePreviewPopupDragRef.current = null;
            knowledgePreviewSplitDragRef.current = null;
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
        window.addEventListener('touchcancel', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onUp);
            window.removeEventListener('touchcancel', onUp);
        };
    }, [clampKnowledgePreviewPopupPos]);
    useEffect(() => {
        if (!shouldAllowKnowledgePreviewPopup) {
            knowledgePreviewPopupDragRef.current = null;
            setKnowledgePreviewTermPopup(null);
            return;
        }
        knowledgePreviewPopupDragRef.current = null;
        setKnowledgePreviewTermPopup(null);
    }, [shouldAllowKnowledgePreviewPopup, modalContent]);
    useEffect(() => {
        if (!showModal) {
            knowledgePreviewPopupDragRef.current = null;
            setKnowledgePreviewTermPopup(null);
        }
    }, [showModal]);
    useEffect(() => {
        if (!knowledgePreviewTermPopup || !showModal || typeof window === 'undefined') return;
        const clampNow = () => {
            const curr = knowledgePreviewPopupPosRef.current || { x: 24, y: 112 };
            const next = clampKnowledgePreviewPopupPos(curr.x, curr.y);
            setKnowledgePreviewPopupPos(next);
        };
        clampNow();
        window.addEventListener('resize', clampNow);
        return () => window.removeEventListener('resize', clampNow);
    }, [clampKnowledgePreviewPopupPos, knowledgePreviewTermPopup, showModal]);
    const finishFlashCardAutoRun = useCallback(async () => {
        stopFlashCardAutoRun();
        setFlashCardWakeLockEnabled(false);
        await releaseFlashCardWakeLock();
    }, [releaseFlashCardWakeLock, stopFlashCardAutoRun]);

    const advanceFlashCardAutoFileQueue = useCallback(async (session) => {
        if (!flashCardAutoRunAllKnowledgeTxt) return false;
        const queue = Array.isArray(flashCardAutoFileQueueRef.current) ? flashCardAutoFileQueueRef.current : [];
        const cursor = Number(flashCardAutoFileCursorRef.current);
        if (queue.length < 2 || cursor < 0 || cursor >= queue.length - 1) return false;
        if (flashCardAutoFileLoadingRef.current) return true;

        const nextName = String(queue[cursor + 1] || "").trim();
        if (!nextName) return false;

        flashCardAutoFileLoadingRef.current = true;
        try {
            await loadFlashCardsFromKnowledgeTxtName(nextName, {
                markSelected: true,
                preserveCategories: true,
                preserveAutoRun: true
            });
            if (flashCardAutoSessionRef.current !== session) return true;
            flashCardAutoFileCursorRef.current = cursor + 1;
            clearFlashCardAutoTimer();
            flashCardAutoPendingSpeakRef.current = null;
            setFlashCardSpeakSignalNonce(v => v + 1);
            return true;
        } catch (err) {
            setFlashCardError(String(err?.message || err || "切換下一個知識點失敗。"));
            return false;
        } finally {
            flashCardAutoFileLoadingRef.current = false;
        }
    }, [clearFlashCardAutoTimer, flashCardAutoRunAllKnowledgeTxt, loadFlashCardsFromKnowledgeTxtName]);

    const executeFlashCardAdvance = useCallback(async (session, cardIndex) => {
        if (cardIndex >= filteredFlashCards.length - 1) {
            const switched = await advanceFlashCardAutoFileQueue(session);
            if (switched) return;
            await finishFlashCardAutoRun();
            return;
        }
        setFlashCardIndex(cardIndex + 1);
        setFlashCardFlipped(false);
    }, [advanceFlashCardAutoFileQueue, filteredFlashCards.length, finishFlashCardAutoRun]);

    const updateFlashCardMasteryForFeedback = useCallback((card, result, sourceName) => {
        if (!card) return;
        const now = new Date().toISOString();
        const cardId = buildFlashCardId(card);
        const normalizedPrev = normalizeFlashCardMasteryData(flashCardMasteryDataRef.current);
        const existing = normalizedPrev.cards[cardId] || {};
        const remembered = result === "remembered";
        const next = {
            ...normalizedPrev,
            updatedAt: now,
            cards: {
                ...normalizedPrev.cards,
                [cardId]: {
                    ...existing,
                    cardId,
                    head: String(getFlashCardFrontText(card) || existing.head || ""),
                    headNormalized: normalizeFlashCardText(getFlashCardFrontText(card) || existing.head || ""),
                    rememberedCount: Math.max(0, Number(existing.rememberedCount || existing.level || 0)) + (remembered ? 1 : 0),
                    forgotCount: Math.max(0, Number(existing.forgotCount || existing.wrongCount || 0)) + (remembered ? 0 : 1),
                    reviewCount: Math.max(0, Number(existing.reviewCount || 0)) + 1,
                    lastResult: remembered ? "remembered" : "forgot",
                    lastReviewedAt: now
                }
            }
        };
        flashCardMasteryDataRef.current = next;
        setFlashCardMasteryData(() => next);
        scheduleFlashCardMasteryAutoSave(next);
        flashCardMasteryFeedbackCountSinceFlushRef.current += 1;
        if (flashCardMasteryFeedbackCountSinceFlushRef.current >= FLASHCARD_MASTERY_FORCE_FLUSH_EVERY) {
            flashCardMasteryFeedbackCountSinceFlushRef.current = 0;
            flushFlashCardMasteryToFolder(next);
        }
    }, [flushFlashCardMasteryToFolder, scheduleFlashCardMasteryAutoSave]);

    const handleFeedback = useCallback((isCorrect) => {
        if (!currentFlashCard || !currentFlashCard.front) return;
        updateFlashCardMasteryForFeedback(currentFlashCard, isCorrect ? "remembered" : "forgot", flashCardSourceName);

        if (flashCardAutoRun) {
            setFlashCardWaitingFeedback(false);
            executeFlashCardAdvance(flashCardAutoSessionRef.current, normalizedFlashCardIndex);
        } else {
            if (filteredFlashCards.length < 1) return;
            const nextIdx = (normalizedFlashCardIndex + 1) % filteredFlashCards.length;
            setFlashCardIndex(nextIdx);
            setFlashCardFlipped(false);
        }
    }, [currentFlashCard, flashCardAutoRun, normalizedFlashCardIndex, executeFlashCardAdvance, filteredFlashCards.length, flashCardSourceName, updateFlashCardMasteryForFeedback]);

    const scheduleFlashCardAutoAdvance = useCallback((session, side, cardIndex) => {
        if (side === 'back') {
            setFlashCardWaitingFeedback(true);
            return;
        }

        const waitMs = Math.max(0, Math.round((Number(flashCardFrontPauseSec) || 0) * 1000));
        clearFlashCardAutoTimer();
        flashCardAutoTimerRef.current = setTimeout(async () => {
            if (flashCardAutoSessionRef.current !== session) return;
            setFlashCardFlipped(true);
        }, waitMs);
    }, [clearFlashCardAutoTimer, flashCardFrontPauseSec]);

    const handleFlashCardAutoSpeakDone = useCallback(({ side, cardId, cardIndex, manual }) => {
        if (manual) return;
        // Manual (auto-run disabled): if include-zh is on, run
        // back-zh -> (1s) -> back-example sequence as well.
        if (!flashCardAutoRun) {
            if (side === 'back-zh') {
                const card = filteredFlashCards[Number(cardIndex)] || null;
                const hasExamples = !!sanitizeSpeakerText(
                    normalizeJapaneseRubyForSpeech(extractBackExamplesForSpeech(card), trackLanguage)
                );
                const includeZhOrReversed = flashCardReverseSides ? true : flashCardAutoSpeakBackIncludeZh;
                if (flashCardAutoSpeakBack && includeZhOrReversed && hasExamples) {
                    flashCardAutoPendingSpeakRef.current = {
                        session: null,
                        side: 'back-example',
                        cardId,
                        cardIndex
                    };
                    clearFlashCardAutoTimer();
                    flashCardAutoTimerRef.current = setTimeout(() => {
                        const pending = flashCardAutoPendingSpeakRef.current;
                        if (!pending) return;
                        if (pending.side !== 'back-example') return;
                        if (String(pending.cardId || "") !== String(cardId || "")) return;
                        if (Number(pending.cardIndex) !== Number(cardIndex)) return;
                        setFlashCardBackExampleSpeakSignalNonce(v => v + 1);
                    }, 1000);
                } else {
                    flashCardAutoPendingSpeakRef.current = null;
                }
            } else if (side === 'back-example') {
                flashCardAutoPendingSpeakRef.current = null;
            }
            return;
        }

        const pending = flashCardAutoPendingSpeakRef.current;
        if (!pending) return;
        if (pending.session !== flashCardAutoSessionRef.current) return;
        if (pending.side !== side) return;
        if (String(pending.cardId || "") !== String(cardId || "")) return;
        if (Number(pending.cardIndex) !== Number(cardIndex)) return;

        clearFlashCardAutoSpeakWatchdog();
        if (side === 'front') {
            flashCardAutoPendingSpeakRef.current = null;
            scheduleFlashCardAutoAdvance(pending.session, 'front', cardIndex);
            return;
        }
        // Back auto-speak pipeline:
        // back-zh (Chinese explanation, optional) -> wait 1s -> back-example (target examples) -> schedule back delay -> next card.
        if (side === 'back-zh') {
            const card = filteredFlashCards[Number(cardIndex)] || null;
            const hasExamples = !!sanitizeSpeakerText(
                normalizeJapaneseRubyForSpeech(extractBackExamplesForSpeech(card), trackLanguage)
            );
            if (hasExamples) {
                flashCardAutoPendingSpeakRef.current = {
                    session: pending.session,
                    side: 'back-example',
                    cardId,
                    cardIndex
                };
                clearFlashCardAutoSpeakWatchdog();
                flashCardAutoSpeakWatchdogRef.current = setTimeout(() => {
                    const now = flashCardAutoPendingSpeakRef.current;
                    if (!now) return;
                    if (now.session !== flashCardAutoSessionRef.current) return;
                    if (now.side !== 'back-example') return;
                    if (String(now.cardId || "") !== String(cardId || "")) return;
                    if (Number(now.cardIndex) !== Number(cardIndex)) return;
                    flashCardAutoPendingSpeakRef.current = null;
                    scheduleFlashCardAutoAdvance(pending.session, 'back', cardIndex);
                }, 14000);
                clearFlashCardAutoTimer();
                flashCardAutoTimerRef.current = setTimeout(() => {
                    const now = flashCardAutoPendingSpeakRef.current;
                    if (!now) return;
                    if (now.session !== flashCardAutoSessionRef.current) return;
                    if (now.side !== 'back-example') return;
                    if (String(now.cardId || "") !== String(cardId || "")) return;
                    if (Number(now.cardIndex) !== Number(cardIndex)) return;
                    setFlashCardBackExampleSpeakSignalNonce(v => v + 1);
                }, 1000);
                return;
            }
            flashCardAutoPendingSpeakRef.current = null;
            scheduleFlashCardAutoAdvance(pending.session, 'back', cardIndex);
            return;
        }

        if (side === 'back-example') {
            flashCardAutoPendingSpeakRef.current = null;
            scheduleFlashCardAutoAdvance(pending.session, 'back', cardIndex);
            return;
        }

        flashCardAutoPendingSpeakRef.current = null;
        scheduleFlashCardAutoAdvance(pending.session, 'back', cardIndex);
    }, [
        clearFlashCardAutoSpeakWatchdog,
        clearFlashCardAutoTimer,
        filteredFlashCards,
        flashCardAutoRun,
        flashCardAutoSpeakBackIncludeZh,
        flashCardReverseSides,
        trackLanguage,
        scheduleFlashCardAutoAdvance
    ]);

    useEffect(() => {
        if (!flashCardAutoRun) {
            clearFlashCardAutoTimer();
            clearFlashCardAutoSpeakWatchdog();
            flashCardAutoPendingSpeakRef.current = null;
            return;
        }
        if (flashCardAutoPaused) {
            clearFlashCardAutoTimer();
            clearFlashCardAutoSpeakWatchdog();
            flashCardAutoPendingSpeakRef.current = null;
            return;
        }
        if (!showModal || aiMode !== 'flashcards') {
            stopFlashCardAutoRun();
            return;
        }
        if (isFlashCardLoading) return;
        if (!currentFlashCard || filteredFlashCards.length === 0) {
            const session = flashCardAutoSessionRef.current;
            (async () => {
                const switched = await advanceFlashCardAutoFileQueue(session);
                if (switched) return;
                await finishFlashCardAutoRun();
            })();
            return;
        }

        clearFlashCardAutoTimer();
        const session = flashCardAutoSessionRef.current;
        const cardId = currentFlashCard.id;
        const cardIndex = normalizedFlashCardIndex;
        const isFront = !flashCardFlipped;
        const activePending = flashCardAutoPendingSpeakRef.current;

        // Prevent re-entrant auto-speak scheduling for the same card/side pipeline.
        if (
            activePending &&
            activePending.session === session &&
            String(activePending.cardId || "") === String(cardId || "") &&
            Number(activePending.cardIndex) === Number(cardIndex)
        ) {
            if (isFront && activePending.side === 'front') return;
            if (!isFront && (activePending.side === 'back-zh' || activePending.side === 'back-example')) return;
        }

        if (isFront) {
            const shouldAutoSpeak = flashCardAutoSpeakFront && String(flashCardReverseSides ? flashCardReverseFrontSpeakText : flashCardFrontSpeakText || "").trim().length > 0;
            if (shouldAutoSpeak) {
                flashCardAutoPendingSpeakRef.current = { session, side: 'front', cardId, cardIndex };
                clearFlashCardAutoSpeakWatchdog();
                flashCardAutoSpeakWatchdogRef.current = setTimeout(() => {
                    const pending = flashCardAutoPendingSpeakRef.current;
                    if (!pending) return;
                    if (pending.session !== flashCardAutoSessionRef.current) return;
                    if (pending.side !== 'front') return;
                    if (String(pending.cardId || "") !== String(cardId || "")) return;
                    if (Number(pending.cardIndex) !== Number(cardIndex)) return;
                    flashCardAutoPendingSpeakRef.current = null;
                    scheduleFlashCardAutoAdvance(session, 'front', cardIndex);
                }, 9000);
                return;
            }
            clearFlashCardAutoSpeakWatchdog();
            flashCardAutoPendingSpeakRef.current = null;
            scheduleFlashCardAutoAdvance(session, 'front', cardIndex);
            return;
        }

        const shouldAutoSpeakExamples = flashCardAutoSpeakBack && String(flashCardBackExampleSpeakText || "").trim().length > 0;
        const shouldAutoSpeakZh = flashCardAutoSpeakBack && (flashCardReverseSides ? true : flashCardAutoSpeakBackIncludeZh) && !!(flashCardReverseSides ? flashCardFrontSpeakText : flashCardBackZhSpeakText);
        if (shouldAutoSpeakZh) {
            flashCardAutoPendingSpeakRef.current = { session, side: 'back-zh', cardId, cardIndex };
            clearFlashCardAutoSpeakWatchdog();
            flashCardAutoSpeakWatchdogRef.current = setTimeout(() => {
                const pending = flashCardAutoPendingSpeakRef.current;
                if (!pending) return;
                if (pending.session !== flashCardAutoSessionRef.current) return;
                if (pending.side !== 'back-zh') return;
                if (String(pending.cardId || "") !== String(cardId || "")) return;
                if (Number(pending.cardIndex) !== Number(cardIndex)) return;
                flashCardAutoPendingSpeakRef.current = null;
                scheduleFlashCardAutoAdvance(session, 'back', cardIndex);
            }, 9000);
            setFlashCardBackZhSpeakSignalNonce(v => v + 1);
            return;
        }
        if (shouldAutoSpeakExamples) {
            flashCardAutoPendingSpeakRef.current = {
                session,
                side: 'back-example',
                cardId,
                cardIndex
            };
            clearFlashCardAutoSpeakWatchdog();
            flashCardAutoSpeakWatchdogRef.current = setTimeout(() => {
                const pending = flashCardAutoPendingSpeakRef.current;
                if (!pending) return;
                if (pending.session !== flashCardAutoSessionRef.current) return;
                if (pending.side !== 'back-example') return;
                if (String(pending.cardId || "") !== String(cardId || "")) return;
                if (Number(pending.cardIndex) !== Number(cardIndex)) return;
                flashCardAutoPendingSpeakRef.current = null;
                scheduleFlashCardAutoAdvance(session, 'back', cardIndex);
            }, 14000);
            setFlashCardBackExampleSpeakSignalNonce(v => v + 1);
            return;
        }
        clearFlashCardAutoSpeakWatchdog();
        flashCardAutoPendingSpeakRef.current = null;
        scheduleFlashCardAutoAdvance(session, 'back', cardIndex);
    }, [
        aiMode,
        clearFlashCardAutoSpeakWatchdog,
        clearFlashCardAutoTimer,
        currentFlashCard,
        filteredFlashCards.length,
        flashCardAutoPaused,
        flashCardAutoRun,
        flashCardAutoSpeakBack,
        flashCardAutoSpeakBackIncludeZh,
        flashCardAutoSpeakFront,
        flashCardBackExampleSpeakText,
        flashCardBackZhSpeakText,
        flashCardFrontSpeakText,
        flashCardReverseFrontSpeakText,
        flashCardFlipped,
        flashCardReverseSides,
        finishFlashCardAutoRun,
        isFlashCardLoading,
        normalizedFlashCardIndex,
        scheduleFlashCardAutoAdvance,
        showModal,
        stopFlashCardAutoRun,
        advanceFlashCardAutoFileQueue
    ]);

    const handleFlashCardManualFlip = () => {
        if (flashCardAutoRun) {
            if (flashCardAutoPaused) {
                setFlashCardAutoPaused(false);
                setFlashCardSpeakSignalNonce(v => v + 1);
            } else {
                clearFlashCardAutoTimer();
                clearFlashCardAutoSpeakWatchdog();
                flashCardAutoPendingSpeakRef.current = null;
                setFlashCardAutoPaused(true);
            }
            return;
        }
        setFlashCardFlipped(v => !v);
    };
    const jumpFlashCardWhileAutoRunning = useCallback((nextIdx) => {
        clearFlashCardAutoTimer();
        clearFlashCardAutoSpeakWatchdog();
        flashCardAutoPendingSpeakRef.current = null;
        setFlashCardAutoPaused(false);
        setFlashCardIndex(nextIdx);
        setFlashCardFlipped(false);
    }, [clearFlashCardAutoSpeakWatchdog, clearFlashCardAutoTimer]);
    const handleFlashCardPrev = () => {
        if (filteredFlashCards.length < 1) return;
        const prevIdx = (normalizedFlashCardIndex - 1 + filteredFlashCards.length) % filteredFlashCards.length;
        if (flashCardAutoRun) {
            jumpFlashCardWhileAutoRunning(prevIdx);
            return;
        }
        setFlashCardNotice("");
        setFlashCardIndex(prevIdx);
        setFlashCardFlipped(false);
    };
    const handleFlashCardNext = () => {
        if (filteredFlashCards.length < 1) return;
        const nextIdx = (normalizedFlashCardIndex + 1) % filteredFlashCards.length;
        if (flashCardAutoRun) {
            jumpFlashCardWhileAutoRunning(nextIdx);
            return;
        }
        setFlashCardNotice("");
        setFlashCardIndex(nextIdx);
        setFlashCardFlipped(false);
    };
    const handleFlashCardShuffle = () => {
        if (flashCardAutoRun) stopFlashCardAutoRun();
        setFlashCardNotice("");
        setFlashCards(prev => shuffleArray(prev));
        setFlashCardIndex(0);
        setFlashCardFlipped(false);
    };

    const handleFlashCardDiscard = () => {
        if (!currentFlashCard) return;
        if (flashCardAutoRun) stopFlashCardAutoRun();
        const now = new Date().toISOString();
        const cardId = buildFlashCardId(currentFlashCard);
        const normalizedPrev = normalizeFlashCardMasteryData(flashCardMasteryDataRef.current);
        const existing = normalizedPrev.cards[cardId] || {};
        const next = {
            ...normalizedPrev,
            updatedAt: now,
            cards: {
                ...normalizedPrev.cards,
                [cardId]: {
                    ...existing,
                    cardId,
                    head: String(getFlashCardFrontText(currentFlashCard) || existing.head || ""),
                    headNormalized: normalizeFlashCardText(getFlashCardFrontText(currentFlashCard) || existing.head || ""),
                    discardedAt: now
                }
            }
        };
        flashCardMasteryDataRef.current = next;
        setFlashCardMasteryData(() => next);
        scheduleFlashCardMasteryAutoSave(next);
        setFlashCardNotice("已丟到垃圾桶，之後不會再出現。");
        setFlashCardFlipped(false);
        setFlashCardIndex(Math.max(0, Math.min(normalizedFlashCardIndex, filteredFlashCards.length - 2)));
    };

    const writeTextToClipboard = async (text) => {
        const value = String(text || "");
        if (!value) return false;
        if (typeof navigator !== "undefined" && navigator?.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(value);
                return true;
            } catch (_) { }
        }
        try {
            const textarea = document.createElement("textarea");
            textarea.value = value;
            textarea.setAttribute("readonly", "true");
            textarea.style.position = "fixed";
            textarea.style.left = "-9999px";
            textarea.style.top = "0";
            document.body.appendChild(textarea);
            textarea.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(textarea);
            return ok;
        } catch (_) {
            return false;
        }
    };

    const handleFlashCardCopy = async () => {
        if (!currentFlashCard) return;
        const front = cleanQuizDisplayText(String(getFlashCardFrontText(currentFlashCard) || "")).trim();
        const back = cleanQuizDisplayText(String(getFlashCardBackText(currentFlashCard) || "")).trim();
        const text = [`正面：${front}`, "", `背面：${back}`].join("\n");
        const ok = await writeTextToClipboard(text);
        if (ok) {
            setFlashCardNotice("已複製正反面到剪貼簿。");
        } else {
            setFlashCardNotice("");
            alert("複製失敗：瀏覽器沒有開放剪貼簿權限。");
        }
    };

    const handleFlashCardCategoryToggle = (key) => {
        if (flashCardAutoRun) stopFlashCardAutoRun();
        setFlashCardCategories((prev) => {
            const now = Array.isArray(prev) && prev.length > 0 ? [...prev] : ['all'];
            if (key === 'all') return ['all'];
            const base = now.filter((k) => k && k !== 'all');
            const exists = base.includes(key);
            const next = exists ? base.filter((k) => k !== key) : [...base, key];
            return next.length > 0 ? next : ['all'];
        });
    };

    const handleFlashCardTouchLockToggle = useCallback(() => {
        if (flashCardToolbarExpanded) return;
        setFlashCardTouchLockEnabled(prev => !prev);
    }, [flashCardToolbarExpanded]);

    const handleFlashCardToolbarToggle = useCallback(() => {
        const nextExpanded = !flashCardToolbarExpanded;
        setFlashCardToolbarExpanded(nextExpanded);

        if (!nextExpanded) {
            if (flashCardPocketModeEnabled) setFlashCardPocketModeEnabled(false);
            if (flashCardPocketUnlockHolding) setFlashCardPocketUnlockHolding(false);
            clearPocketUnlockTimer();
            if (!flashCardWakeLockEnabled) setFlashCardWakeLockEnabled(true);
            // Use direct user gesture path for better mobile compatibility.
            requestFlashCardWakeLock();
            return;
        }

        if (flashCardTouchLockEnabled) setFlashCardTouchLockEnabled(false);
        if (flashCardWakeLockEnabled) setFlashCardWakeLockEnabled(false);
        releaseFlashCardWakeLock();
    }, [
        clearPocketUnlockTimer,
        flashCardPocketModeEnabled,
        flashCardPocketUnlockHolding,
        flashCardToolbarExpanded,
        flashCardTouchLockEnabled,
        flashCardWakeLockEnabled,
        releaseFlashCardWakeLock,
        requestFlashCardWakeLock
    ]);

    const handleFlashCardAutoRunToggle = useCallback(async () => {
        if (flashCardAutoRun) {
            stopFlashCardAutoRun();
            return;
        }

        clearFlashCardAutoTimer();
        clearFlashCardAutoSpeakWatchdog();
        flashCardAutoSessionRef.current += 1;
        flashCardAutoPendingSpeakRef.current = null;
        setFlashCardAutoPaused(false);
        setFlashCardSpeakSignalNonce(v => v + 1);
        setFlashCardFlipped(false);
        setFlashCardError("");

        if (flashCardAutoRunAllKnowledgeTxt) {
            const folderNames = getKnowledgeTxtFilesFromMap()
                .map((f) => String(f?.name || "").trim())
                .filter(Boolean);
            if (folderNames.length === 0) {
                resetFlashCardAutoFileQueue();
                setFlashCardError("資料夾內找不到可用的知識點 txt。");
                return;
            }

            let startCursor = folderNames.findIndex((n) => n === String(selectedKnowledgeTxtName || "").trim());
            if (startCursor < 0) {
                const sourceName = String(flashCardSourceName || "").trim();
                if (sourceName) {
                    startCursor = folderNames.findIndex((n) => n === sourceName);
                }
            }
            if (startCursor < 0) startCursor = 0;
            const startName = folderNames[startCursor];
            flashCardAutoFileQueueRef.current = folderNames;
            flashCardAutoFileCursorRef.current = startCursor;

            const currentSourceName = String(flashCardSourceName || "").trim();
            const shouldReloadFirstFile =
                filteredFlashCards.length === 0 ||
                !currentSourceName ||
                currentSourceName !== startName;
            if (shouldReloadFirstFile) {
                setIsFlashCardLoading(true);
                try {
                    await loadFlashCardsFromKnowledgeTxtName(startName, {
                        markSelected: true,
                        preserveCategories: true,
                        preserveAutoRun: true
                    });
                } catch (err) {
                    resetFlashCardAutoFileQueue();
                    setFlashCardError(String(err?.message || err || "載入知識點失敗。"));
                    setIsFlashCardLoading(false);
                    return;
                } finally {
                    setIsFlashCardLoading(false);
                }
            }
        } else {
            resetFlashCardAutoFileQueue();
            if (filteredFlashCards.length < 1) return;
        }

        setFlashCardAutoRun(true);
    }, [
        clearFlashCardAutoSpeakWatchdog,
        clearFlashCardAutoTimer,
        filteredFlashCards.length,
        flashCardAutoPaused,
        flashCardAutoRun,
        flashCardAutoRunAllKnowledgeTxt,
        flashCardSourceName,
        getKnowledgeTxtFilesFromMap,
        loadFlashCardsFromKnowledgeTxtName,
        resetFlashCardAutoFileQueue,
        selectedKnowledgeTxtName,
        stopFlashCardAutoRun
    ]);

    const flashBackExampleArmed = (() => {
        if (!(flashCardAutoSpeakBack && flashCardFlipped && currentFlashCard?.id)) return false;
        const expectsFirstSpeech = flashCardReverseSides ? !!flashCardFrontSpeakText : (flashCardAutoSpeakBackIncludeZh && !!flashCardBackZhSpeakText);
        if (!expectsFirstSpeech) return true;
        const pending = flashCardAutoPendingSpeakRef.current;
        if (!pending) return false;
        const sameCard =
            String(pending.cardId || "") === String(currentFlashCard?.id || "") &&
            Number(pending.cardIndex) === Number(normalizedFlashCardIndex);
        if (!sameCard || pending.side !== 'back-example') return false;
        if (!flashCardAutoRun) return true;
        return pending.session === flashCardAutoSessionRef.current;
    })();

    const flashBackZhArmed = (() => {
        const includeZhOrReversed = flashCardReverseSides ? true : flashCardAutoSpeakBackIncludeZh;
        const textExists = flashCardReverseSides ? !!flashCardFrontSpeakText : !!flashCardBackZhSpeakText;
        if (!(flashCardAutoSpeakBack && includeZhOrReversed && flashCardFlipped && currentFlashCard?.id && textExists)) return false;
        // Non-auto-run mode keeps previous behavior (flip to back can auto-speak immediately).
        if (!flashCardAutoRun) return true;
        const pending = flashCardAutoPendingSpeakRef.current;
        return !!(
            pending &&
            pending.session === flashCardAutoSessionRef.current &&
            pending.side === 'back-zh' &&
            String(pending.cardId || "") === String(currentFlashCard?.id || "") &&
            Number(pending.cardIndex) === Number(normalizedFlashCardIndex)
        );
    })();

    const flashFrontAutoPlaySignal = (
        flashCardAutoSpeakFront &&
        !flashCardFlipped &&
        currentFlashCard?.id
    ) ? `${currentFlashCard.id}:${normalizedFlashCardIndex}:${flashCardCategoryKey}:front:${flashCardSpeakSignalNonce}` : "";
    const flashBackAutoPlaySignal = (
        flashBackExampleArmed
    ) ? `${currentFlashCard.id}:${normalizedFlashCardIndex}:${flashCardCategoryKey}:back:${flashCardBackExampleSpeakSignalNonce}` : "";
    const flashBackZhAutoPlaySignal = flashBackZhArmed
        ? `${currentFlashCard.id}:${normalizedFlashCardIndex}:${flashCardCategoryKey}:back-zh:${flashCardBackZhSpeakSignalNonce}`
        : "";

    const trackKnowledgeAvailability = useMemo(() => {
        const result = {};
        const cacheList = Object.values(quizKnowledgeBankMap || {});
        for (let i = 0; i < playlist.length; i++) {
            const track = playlist[i];
            const base = String(getTrackBaseNameForKnowledge(track) || "").trim();
            if (!base) {
                result[i] = false;
                continue;
            }
            const hasTxtInFolder = !!findKnowledgeFileInFolderMap(base);
            const hasGeneratedCache = cacheList.some((kb) => {
                const kbBase = String(kb?.baseName || "").trim().toLowerCase();
                return kbBase === base.toLowerCase() && Array.isArray(kb?.points) && kb.points.length > 0;
            });
            result[i] = hasTxtInFolder || hasGeneratedCache;
        }
        return result;
    }, [playlist, knowledgeTxtOptions, quizKnowledgeBankMap]);
    const currentPlaylistTrack = (currentTrackIndex >= 0 && playlist[currentTrackIndex]) ? playlist[currentTrackIndex] : null;
    const currentKnowledgeTabAnchorName = useMemo(() => {
        return String(
            activeTrackKnowledgeTabName ||
            selectedKnowledgeTxtName ||
            embeddedKnowledgeFileInfo?.filename ||
            quizKnowledgeFileInfo?.filename ||
            ""
        ).trim();
    }, [activeTrackKnowledgeTabName, embeddedKnowledgeFileInfo, quizKnowledgeFileInfo, selectedKnowledgeTxtName]);
    const trackKnowledgeTabEntries = useMemo(() => {
        return getKnowledgeSeriesTabEntries(currentKnowledgeTabAnchorName);
    }, [currentKnowledgeTabAnchorName, knowledgeTxtOptions]);
    useEffect(() => {
        const names = trackKnowledgeTabEntries.map((entry) => entry.name);
        if (names.length === 0) {
            return;
        }
        setActiveTrackKnowledgeTabName((prev) => {
            if (prev && names.includes(prev)) return prev;
            if (selectedKnowledgeTxtName && names.includes(selectedKnowledgeTxtName)) return selectedKnowledgeTxtName;
            if (currentKnowledgeTabAnchorName && names.includes(currentKnowledgeTabAnchorName)) return currentKnowledgeTabAnchorName;
            return names[0];
        });
    }, [currentKnowledgeTabAnchorName, selectedKnowledgeTxtName, trackKnowledgeTabEntries]);
    const currentMediaName = String(currentPlaylistTrack?.mediaFile?.name || currentPlaylistTrack?.name || "").trim();
    const currentMediaLower = currentMediaName.toLowerCase();
    const isAudioOnlyTrack = /\.(mp3|m4a|wav|aac|flac|ogg)$/i.test(currentMediaLower);
    const canShowEmbeddedKnowledgePanel = true;
    const isTopPanelDocumentMode = topPanelMode === 'document';
    const isTopPanelMediaMode = topPanelMode === 'media';
    const effectiveSubtitleFontSize = Math.max(16, subtitleFontSize - 3);

    const loadEmbeddedKnowledgeTxtFile = useCallback(async (file, { markSelected = true } = {}) => {
        if (!file) throw new Error("找不到指定的文字檔。");
        setEmbeddedKnowledgeLoading(true);
        setEmbeddedKnowledgeError("");
        try {
            mergeFilesIntoSelectedFolderMap([file]);
            const rawTxt = String(await readManualDocumentText(file) || "").trim();
            if (!rawTxt) throw new Error("文字檔為空。");
            let knowledgeBank = null;
            try {
                knowledgeBank = await loadKnowledgeBankFromTxtFile(file, {
                    quizTargetLanguage: trackLanguage,
                    trackKey: `${currentTrackIndex >= 0 ? currentTrackIndex : "manual"}:embedded:${String(file?.name || "").toLowerCase()}`
                });
            } catch (_) {}
            setEmbeddedKnowledgeText(rawTxt);
            setEmbeddedKnowledgeFileInfo({
                filename: String(knowledgeBank?.filename || file?.name || "知識點.txt"),
                targetLanguage: String(
                    knowledgeBank?.targetLanguage ||
                    extractKnowledgeTxtDeclaredLanguage(rawTxt, trackLanguage) ||
                    trackLanguage
                ).trim() || trackLanguage
            });
            if (markSelected) {
                setSelectedKnowledgeTxtName(String(file?.name || "知識點.txt"));
                setActiveTrackKnowledgeTabName(String(file?.name || "知識點.txt"));
            }
            if (knowledgeBank) {
                setQuizKnowledgeBankMap(prev => ({ ...prev, [knowledgeBank.trackKey]: knowledgeBank }));
                setQuizKnowledgePointsPool(knowledgeBank.points || []);
                setQuizKnowledgeFileInfo({
                    filename: knowledgeBank.filename,
                    total: Array.isArray(knowledgeBank.points) ? knowledgeBank.points.length : 0,
                    generatedAt: knowledgeBank.generatedAt,
                    targetLanguage: knowledgeBank.targetLanguage || trackLanguage
                });
            } else {
                setQuizKnowledgeFileInfo({
                    filename: String(file?.name || "知識點.txt"),
                    total: 0,
                    generatedAt: Date.now(),
                    targetLanguage: extractKnowledgeTxtDeclaredLanguage(rawTxt, trackLanguage)
                });
            }
            return true;
        } finally {
            setEmbeddedKnowledgeLoading(false);
        }
    }, [currentTrackIndex, loadKnowledgeBankFromTxtFile, mergeFilesIntoSelectedFolderMap, trackLanguage]);

    const openManualKnowledgeTxtPickerForEmbedded = useCallback(() => {
        if (embeddedKnowledgeTxtInputRef.current) {
            embeddedKnowledgeTxtInputRef.current.value = "";
            embeddedKnowledgeTxtInputRef.current.click();
        }
    }, []);

    const handleManualKnowledgeTxtFileForEmbedded = useCallback(async (file) => {
        if (!file) return;
        try {
            const result = await loadEmbeddedKnowledgeTxtFile(file, { markSelected: true });
            setIsVideoMasked(false);
            const startIndex = findLrcStartForKnowledgeText(result?.rawTxt || "", subtitles);
            if (startIndex >= 0) jumpToSubtitle(startIndex);
        } catch (err) {
            setEmbeddedKnowledgeError(String(err?.message || err || "開啟文字檔失敗。"));
        }
    }, [jumpToSubtitle, loadEmbeddedKnowledgeTxtFile, subtitles]);

    const loadEmbeddedKnowledgePanel = useCallback(async () => {
        if (!canShowEmbeddedKnowledgePanel) return false;
        if (embeddedKnowledgeText.trim()) return true;
        setEmbeddedKnowledgeLoading(true);
        setEmbeddedKnowledgeError("");
        try {
            const hit = await probeKnowledgeFileForCurrentTrack({ refreshFromHandle: true, deepScan: true });
            let knowledgeBank = null;
            let rawTxt = "";
            if (hit?.knowledgeBank) {
                knowledgeBank = hit.knowledgeBank;
                rawTxt = String(knowledgeBank?.txt || buildQuizKnowledgeTxt(knowledgeBank) || "").trim();
            } else if (hit?.file) {
                rawTxt = String(await readTextFileRobust(hit.file, { purpose: "knowledge" }) || "").trim();
                if (rawTxt) {
                    try {
                        knowledgeBank = await loadKnowledgeBankFromTxtFile(hit.file, {
                            quizTargetLanguage: trackLanguage,
                            trackKey: `${currentTrackIndex >= 0 ? currentTrackIndex : "manual"}:embedded:${String(hit?.file?.name || "").toLowerCase()}`
                        });
                    } catch (_) {}
                }
            }
            if (!rawTxt) {
                throw new Error("目前媒體找不到可對照的文字檔。");
            }
            setEmbeddedKnowledgeText(rawTxt);
            const resolvedFilename = String(knowledgeBank?.filename || hit?.filename || hit?.file?.name || "知識點.txt");
            setEmbeddedKnowledgeFileInfo({
                filename: resolvedFilename,
                targetLanguage: String(
                    knowledgeBank?.targetLanguage ||
                    extractKnowledgeTxtDeclaredLanguage(rawTxt, trackLanguage) ||
                    trackLanguage
                ).trim() || trackLanguage
            });
            setSelectedKnowledgeTxtName(resolvedFilename);
            setActiveTrackKnowledgeTabName(resolvedFilename);
            return true;
        } catch (err) {
            setEmbeddedKnowledgeError(String(err?.message || err || "載入文字檔失敗。"));
            return false;
        } finally {
            setEmbeddedKnowledgeLoading(false);
        }
    }, [
        buildQuizKnowledgeTxt,
        canShowEmbeddedKnowledgePanel,
        currentTrackIndex,
        embeddedKnowledgeText,
        loadKnowledgeBankFromTxtFile,
        probeKnowledgeFileForCurrentTrack,
        trackLanguage
    ]);

    const openEmbeddedKnowledgeTxtByName = useCallback(async (name) => {
        const targetName = String(name || "").trim();
        if (!targetName) throw new Error("找不到指定的知識點 txt。");
        const file = getKnowledgeTxtFileByName(targetName);
        if (!file) throw new Error(`找不到指定的知識點 txt：${targetName}`);
        return loadEmbeddedKnowledgeTxtFile(file, { markSelected: true });
    }, [getKnowledgeTxtFileByName, loadEmbeddedKnowledgeTxtFile]);

    const handleSelectTrackKnowledgeTab = useCallback(async (name, { target = "modal" } = {}) => {
        const nextName = String(name || "").trim();
        if (!nextName) return;
        setActiveTrackKnowledgeTabName(nextName);
        setSelectedKnowledgeTxtName(nextName);
        if (target === "embedded") {
            try {
                await openEmbeddedKnowledgeTxtByName(nextName);
            } catch (err) {
                setEmbeddedKnowledgeError(String(err?.message || err || "切換知識點失敗。"));
            }
            return;
        }
        try {
            await openKnowledgeTxtInModal(nextName, { markSelected: true });
        } catch (err) {
            setKnowledgeTxtPickerError(String(err?.message || err || "切換知識點失敗。"));
        }
    }, [openEmbeddedKnowledgeTxtByName, openKnowledgeTxtInModal]);
    useEffect(() => {
        const subtitleText = subtitles[currentIndex]?.text || "";
        const searchKey = `${currentIndex}:${activeTrackKnowledgeTabName}:${subtitleText}`;
        if (topPanelMode !== 'document' || embeddedKnowledgeLoading || embeddedKnowledgeSubtitleMatch || trackKnowledgeTabEntries.length < 2 || embeddedKnowledgeTabSearchRef.current === searchKey) return;
        embeddedKnowledgeTabSearchRef.current = searchKey;
        let cancelled = false;
        (async () => {
            for (const entry of trackKnowledgeTabEntries) {
                const name = String(entry?.name || "");
                if (!name || name === activeTrackKnowledgeTabName) continue;
                const file = getKnowledgeTxtFileByName(name);
                if (!file) continue;
                const rawTxt = String(await readManualDocumentText(file) || "").trim();
                if (!rawTxt || !findKnowledgeSubtitleMatch(rawTxt, subtitleText) || cancelled) continue;
                setActiveTrackKnowledgeTabName(name);
                setSelectedKnowledgeTxtName(name);
                await loadEmbeddedKnowledgeTxtFile(file, { markSelected: true });
                break;
            }
        })();
        return () => { cancelled = true; };
    }, [activeTrackKnowledgeTabName, currentIndex, embeddedKnowledgeLoading, embeddedKnowledgeSubtitleMatch, getKnowledgeTxtFileByName, loadEmbeddedKnowledgeTxtFile, subtitles, topPanelMode, trackKnowledgeTabEntries]);
    const renderTrackKnowledgeTabs = (target = "modal") => {
        if (!Array.isArray(trackKnowledgeTabEntries) || trackKnowledgeTabEntries.length <= 1) return null;
        const activeName = String(activeTrackKnowledgeTabName || "").trim();
        return (
            <div className="flex flex-wrap items-center gap-2">
                {trackKnowledgeTabEntries.map((entry) => {
                    const name = String(entry?.name || "");
                    const active = activeName === name;
                    return (
                        <button
                            key={`${target}-${name}`}
                            type="button"
                            onClick={() => handleSelectTrackKnowledgeTab(name, { target })}
                            className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${active ? 'bg-cyan-100 text-cyan-800 border-cyan-300' : 'bg-white text-gray-600 border-gray-200 hover:bg-cyan-50 hover:text-cyan-700 hover:border-cyan-200'}`}
                            title={name}
                        >
                            {String(entry?.label || name)}
                        </button>
                    );
                })}
            </div>
        );
    };

    const handleToggleMediaPanel = useCallback(async () => {
        if (!canShowEmbeddedKnowledgePanel) {
            setIsVideoMasked(prev => !prev);
            return;
        }
        if (isVideoMasked) {
            const nextMode = isAudioOnlyTrack ? 'document' : topPanelMode;
            setTopPanelMode(nextMode);
            if (nextMode === 'document') {
                await loadEmbeddedKnowledgePanel();
            }
            setIsVideoMasked(false);
            return;
        }
        setIsVideoMasked(true);
    }, [canShowEmbeddedKnowledgePanel, isAudioOnlyTrack, isVideoMasked, loadEmbeddedKnowledgePanel, topPanelMode]);

    const showTopPanelMedia = useCallback(() => {
        setTopPanelMode('media');
        setIsVideoMasked(false);
    }, []);

    const showTopPanelDocument = useCallback(async () => {
        // 將舊版執行中仍保留的 45vh 預設值遷移為新預設；只做一次，
        // 之後使用者手動選擇 45vh 仍會被尊重。
        if (!embeddedKnowledgeHeightMigrationRef.current) {
            embeddedKnowledgeHeightMigrationRef.current = true;
            setEmbeddedKnowledgePanelHeight(prev => prev === 45 ? 60 : prev);
        }
        setTopPanelMode('document');
        await loadEmbeddedKnowledgePanel();
        setIsVideoMasked(false);
    }, [loadEmbeddedKnowledgePanel]);

    useEffect(() => {
        if (topPanelMode !== 'document' || embeddedKnowledgeHeightMigrationRef.current) return;
        embeddedKnowledgeHeightMigrationRef.current = true;
        setEmbeddedKnowledgePanelHeight(prev => prev === 45 ? 60 : prev);
    }, [topPanelMode]);

    useEffect(() => {
        setIsVideoMasked(true);
        setTopPanelMode(isAudioOnlyTrack ? 'document' : 'media');
        setEmbeddedKnowledgeText("");
        setEmbeddedKnowledgeFileInfo(null);
        setEmbeddedKnowledgeError("");
        setEmbeddedKnowledgeLoading(false);
    }, [currentTrackIndex, isAudioOnlyTrack]);

    return (
        <AudioCacheContext.Provider value={{ cache: audioCache, addToCache: addToAudioCache, currentKey: currentApiKey, trackLanguage: trackLanguage, preferredVoice: preferredVoice, globalAudioRef }}>
            <div className="bg-gray-50 text-gray-800 flex flex-col font-sans h-screen overflow-hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                {/* [HEADER] */}
                {isHeaderVisible && (
                    <header className="bg-white border-b border-gray-200 shadow-sm z-30 transition-all duration-300">
                        <div className="flex items-center justify-between p-3">
                            <div className="flex items-center gap-2">
                                <div className="bg-black text-white p-1.5 rounded-lg"><span className="text-xl">🎧</span></div>
                                <h1 className="text-lg font-bold text-gray-900 tracking-tight">語伴</h1>
                            </div>
                            <button onClick={() => setIsHeaderExpanded(!isHeaderExpanded)} className="p-2 text-gray-500 hover:bg-gray-100 rounded-full">
                                {isHeaderExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                            </button>
                        </div>

                        {isHeaderExpanded && (
                            <>
                                <div className="flex flex-wrap items-center gap-2 px-3 pb-3 border-t border-gray-100 pt-2 animate-in slide-in-from-top-2 fade-in md:flex-nowrap md:overflow-x-auto md:no-scrollbar md:mask-gradient">
                                    <button ref={settingsButtonRef} onClick={() => setShowSettings(!showSettings)} className="flex items-center gap-1 px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-md shrink-0 border border-gray-200"><Settings size={14} /><span className="text-xs font-medium">設定</span></button>
                                    {playlist.length > 0 && (
                                        <select
                                            value={currentTrackIndex}
                                            onChange={(e) => loadTrack(parseInt(e.target.value))}
                                            className="bg-gray-50 border border-gray-200 text-gray-700 text-xs rounded-md px-2 py-1.5 max-w-[160px] outline-none shrink-0"
                                            title="📘 代表已有對應知識點 TXT"
                                        >
                                            {playlist.map((item, i) => {
                                                const hasKnowledge = !!trackKnowledgeAvailability[i];
                                                const mark = hasKnowledge ? "📘" : "▫️";
                                                return (
                                                    <option key={i} value={i}>
                                                        {`${mark} ${i + 1}. ${item.name}`}
                                                    </option>
                                                );
                                            })}
                                        </select>
                                    )}
                                    <button onClick={handlePickFolder} className="cursor-pointer bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 px-3 py-1.5 rounded-md flex items-center gap-1 transition-colors shadow-sm text-xs font-medium shrink-0"><FolderOpen size={14} /><span className="hidden sm:inline">授權影音資料夾</span></button>
                                    <button onClick={openManualKnowledgeTxtPickerForEmbedded} className="cursor-pointer bg-cyan-50 hover:bg-cyan-100 text-cyan-700 border border-cyan-200 px-3 py-1.5 rounded-md flex items-center gap-1 transition-colors shadow-sm text-xs font-medium shrink-0" title="選擇任意文字檔作為知識文件"><BookOpen size={14} /><span className="hidden sm:inline">知識檔</span></button>
                                    <input type="file" ref={folderInputRef} webkitdirectory="true" directory="true" multiple className="hidden" onChange={handleFolderSelect} />
                                    <input
                                        type="file"
                                        ref={manualKnowledgeTxtInputRef}
                                        accept=".txt,.md,.markdown,.srt,.vtt,.lrc,.csv,.tsv,.json,.html,.htm,.xml,.pdf,.epub,text/*,application/pdf,application/epub+zip"
                                        className="hidden"
                                        onChange={(e) => handleManualKnowledgeTxtFileForModal(e.target.files && e.target.files[0])}
                                    />
                                    <input
                                        type="file"
                                        ref={embeddedKnowledgeTxtInputRef}
                                        accept=".txt,.md,.markdown,.srt,.vtt,.lrc,.csv,.tsv,.json,.html,.htm,.xml,.pdf,.epub,text/*,application/pdf,application/epub+zip"
                                        className="hidden"
                                        onChange={(e) => handleManualKnowledgeTxtFileForEmbedded(e.target.files && e.target.files[0])}
                                    />
                                    <div className="flex items-center gap-1 bg-gray-100 px-2 py-1 rounded-md border border-gray-200 shrink-0" title="Learner level">
                                        <span className="text-[10px] font-bold text-gray-500">LV</span>
                                        <button type="button" onClick={() => setLearnerLevel(Math.max(1, learnerLevel - 1))} className="w-7 h-7 inline-flex items-center justify-center rounded text-gray-600 hover:bg-gray-200 active:bg-gray-300" aria-label="降低學習等級"><Minus size={14} /></button>
                                        <input type="range" min="1" max="10" value={learnerLevel} onChange={e => setLearnerLevel(parseInt(e.target.value, 10))} className="w-14 sm:w-16 h-6 bg-gray-300 rounded-lg accent-blue-600 cursor-pointer" />
                                        <button type="button" onClick={() => setLearnerLevel(Math.min(10, learnerLevel + 1))} className="w-7 h-7 inline-flex items-center justify-center rounded text-gray-600 hover:bg-gray-200 active:bg-gray-300" aria-label="提高學習等級"><Plus size={14} /></button>
                                        <span className="text-xs font-bold w-4 text-center">{learnerLevel}</span>
                                    </div>
                                    {/* Speed Slider */}
                                    <div className="flex items-center gap-1 bg-gray-100 px-2 py-1 rounded-md border border-gray-200 shrink-0" title="Playback Speed">
                                        <Gauge size={14} className="text-gray-500" />
                                        <button type="button" onClick={() => setPlaybackRate(Math.max(0.5, Number((playbackRate - 0.05).toFixed(2))))} className="w-7 h-7 inline-flex items-center justify-center rounded text-gray-600 hover:bg-gray-200 active:bg-gray-300" aria-label="降低播放速度"><Minus size={14} /></button>
                                        <input type="range" min="0.5" max="2.0" step="0.05" value={playbackRate} onChange={(e) => setPlaybackRate(parseFloat(e.target.value))} className="w-16 sm:w-24 h-6 bg-gray-300 rounded-lg accent-green-600 cursor-pointer" />
                                        <button type="button" onClick={() => setPlaybackRate(Math.min(2, Number((playbackRate + 0.05).toFixed(2))))} className="w-7 h-7 inline-flex items-center justify-center rounded text-gray-600 hover:bg-gray-200 active:bg-gray-300" aria-label="提高播放速度"><Plus size={14} /></button>
                                        <span className="text-[10px] font-bold w-8 text-center">{playbackRate.toFixed(2)}x</span>
                                    </div>
                                    {/* Subtitle Font Size Control */}
                                    <div className="flex items-center gap-1 bg-gray-100 px-2 py-1 rounded-md border border-gray-200 shrink-0" title="Subtitle Font Size">
                                        <Type size={14} className="text-gray-500" />
                                        <button type="button" onClick={() => setSubtitleFontSize(Math.max(16, subtitleFontSize - 1))} className="w-7 h-7 inline-flex items-center justify-center rounded text-gray-600 hover:bg-gray-200 active:bg-gray-300" aria-label="縮小字幕與知識文件字體"><Minus size={14} /></button>
                                        <input type="range" min="16" max="40" value={subtitleFontSize} onChange={(e) => setSubtitleFontSize(parseInt(e.target.value, 10))} className="w-14 sm:w-16 h-6 bg-gray-300 rounded-lg accent-gray-600 cursor-pointer" />
                                        <button type="button" onClick={() => setSubtitleFontSize(Math.min(40, subtitleFontSize + 1))} className="w-7 h-7 inline-flex items-center justify-center rounded text-gray-600 hover:bg-gray-200 active:bg-gray-300" aria-label="放大字幕與知識文件字體"><Plus size={14} /></button>
                                        <span className="text-[10px] font-bold w-4 text-center">{subtitleFontSize}</span>
                                    </div>
                                    <button onClick={toggleSmartMode} className={`flex items-center gap-1 px-3 py-1.5 rounded-md border text-xs font-medium shrink-0 transition-colors ${isSmartMode ? 'bg-purple-100 text-purple-700 border-purple-300' : 'bg-gray-50 text-gray-600 border-gray-200'}`}><Puzzle size={14} /><span>智能斷句</span></button>
                                    <button onClick={downloadNotes} className="flex items-center gap-1 px-3 py-1.5 bg-gray-100 text-gray-700 rounded-md border border-gray-200 text-xs font-medium shrink-0"><Download size={14} /><span>筆記</span></button>
                                </div>
                            </>
                        )}
                    </header>
                )}

                {showSettings && (
                    <div ref={settingsPanelRef} className="absolute top-16 right-4 z-[100] bg-white border border-gray-200 shadow-xl rounded-xl p-4 w-80 animate-in fade-in slide-in-from-top-2 max-h-[80vh] overflow-y-auto">
                        <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2"><Key size={16} /> API Key</h3>
                        <input type="password" value={currentApiKey} onChange={(e) => setCurrentApiKey(e.target.value)} placeholder="API Key" className="w-full border border-gray-300 rounded p-2 text-sm mb-3" />

                        {/* VOICE SELECTOR */}
                        <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2 mt-4"><Volume1 size={16} /> TTS Voice</h3>
                        <select
                            value={selectedVoiceURI}
                            onChange={(e) => setSelectedVoiceURI(e.target.value)}
                            className="w-full border border-gray-300 rounded p-2 text-xs mb-3"
                        >
                            {availableVoices.map((v, i) => (
                                <option key={`${v.voiceURI}-${i}`} value={v.voiceURI}>
                                    {v.name} ({v.lang})
                                </option>
                            ))}
                        </select>

                        {/* TIMING CONTROLS */}
                        <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2 mt-4"><Clock size={16} /> Timing Adjustment</h3>
                        <div className="mb-3">
                            <div className="flex justify-between text-xs text-gray-600 mb-1">
                                <span>Start Padding (Pad)</span>
                                <span>{timePadding.toFixed(2)}s</span>
                            </div>
                            <input type="range" min="0" max="2.0" step="0.1" value={timePadding} onChange={(e) => setTimePadding(parseFloat(e.target.value))} className="w-full h-1 bg-gray-300 rounded-lg accent-blue-600" />
                        </div>
                        <div className="mb-3">
                            <div className="flex justify-between text-xs text-gray-600 mb-1">
                                <span>Internal Split Trim</span>
                                <span>{timeBuffer.toFixed(2)}s</span>
                            </div>
                            <input type="range" min="0" max="2.0" step="0.1" value={timeBuffer} onChange={(e) => setTimeBuffer(parseFloat(e.target.value))} className="w-full h-1 bg-gray-300 rounded-lg accent-blue-600" />
                        </div>
                        <div className="mb-3">
                            <div className="flex justify-between text-xs text-gray-600 mb-1">
                                <span>Min Segment Duration</span>
                                <span>{minDuration.toFixed(1)}s</span>
                            </div>
                            <input type="range" min="0.5" max="10.0" step="0.5" value={minDuration} onChange={(e) => setMinDuration(parseFloat(e.target.value))} className="w-full h-1 bg-gray-300 rounded-lg accent-blue-600" />
                        </div>
                        <div className="mb-3">
                            <div className="flex justify-between text-xs text-gray-600 mb-1">
                                <span>Max Merge Lines</span>
                                <span>{maxMergeCount}</span>
                            </div>
                            <input
                                type="range"
                                min="1"
                                max="8"
                                step="1"
                                value={maxMergeCount}
                                onChange={(e) => setMaxMergeCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                                className="w-full h-1 bg-gray-300 rounded-lg accent-blue-600"
                            />
                        </div>

                        <button onClick={() => saveApiKey(currentApiKey)} className="w-full px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">儲存</button>
                    </div>
                )}

                {/* MAIN CONTENT AREA */}
                <div className="flex-1 flex flex-col items-center justify-start p-4 gap-4 overflow-y-auto w-full pb-48">
                    {/* VIDEO AREA */}
                    <div
                        className={`w-full relative rounded-lg overflow-hidden shadow-sm ring-1 ring-gray-100 transition-all duration-300 ease-in-out shrink-0 ${isVideoMasked ? 'h-12 bg-gray-100' : ''} ${!isVideoMasked && isTopPanelDocumentMode ? 'bg-white' : 'bg-black'}`}
                        style={!isVideoMasked ? { height: `${embeddedKnowledgePanelHeight}vh` } : undefined}
                    >
                        {/* [FIX] Removed manual onTimeUpdate, relying on Worker tick */}
                        <video ref={playerRef} src={mediaSrc}
                            className={`w-full h-full object-contain ${!isVideoMasked && isTopPanelMediaMode ? 'block' : 'hidden'}`} controls={false} playsInline onLoadedMetadata={(e) => {
                                setMediaError("");
                                setDuration(e.target.duration);
                                if (autoplayOnLoadRef.current && playerRef.current) {
                                    autoplayOnLoadRef.current = false;
                                    playerRef.current.play().then(() => {
                                        setIsPlaying(true);
                                    }).catch(() => {
                                        setIsPlaying(false);
                                    });
                                }
                            }} onError={(e) => {
                                setIsPlaying(false);
                                setMediaError(buildMediaPlaybackErrorMessage(currentPlaylistTrack?.mediaFile, e?.currentTarget?.error || null));
                            }} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onRateChange={(e) => setPlaybackRate(e.target.playbackRate)} onEnded={() => {
                                // Ensure progress reaches 100% when the media completes
                                markAllSubtitlesWatched();
                                // In sentence-loop drill, never auto-switch track at media end.
                                if (loopModeRef.current === 'single') {
                                    setIsPlaying(false);
                                    return;
                                }
                                if (playlist.length === 0) return;
                                const mode = playlistLoopModeRef.current;
                                const idx = currentTrackIndexRef.current;
                                if (mode === 'single') {
                                    loadTrack(idx, playlist);
                                } else if (mode === 'all') {
                                    const nextIdx = (idx + 1) % playlist.length;
                                    loadTrack(nextIdx, playlist);
                                } else {
                                    setIsPlaying(false);
                                }
                            }} />
                        {isVideoMasked && (
                            <div className="w-full h-full flex items-center justify-center">
                                <button onClick={handleToggleMediaPanel} className="flex items-center gap-2 text-gray-500 hover:text-blue-600 font-medium text-sm w-full h-full justify-center hover:bg-gray-200 transition-colors">
                                    <MonitorPlay size={18} /> {isAudioOnlyTrack ? '📘 顯示文件對照' : '📺 顯示影像 / 文件'}
                                </button>
                            </div>
                        )}
                        {!isVideoMasked && isTopPanelMediaMode && (
                            <div className="absolute top-2 right-2 z-20 flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={showTopPanelDocument}
                                    className="px-3 py-1.5 text-xs rounded-full border border-white/30 bg-black/55 text-white hover:bg-black/70 backdrop-blur-sm"
                                    title="在上區顯示文字檔或文件"
                                >
                                    文件
                                </button>
                                <button onClick={handleToggleMediaPanel} className="p-1.5 bg-black/50 text-white rounded-full hover:bg-black/70 backdrop-blur-sm"><Minimize2 size={16} /></button>
                            </div>
                        )}
                        {!isVideoMasked && isTopPanelDocumentMode && (
                            <div className="w-full h-full flex flex-col bg-white">
                                <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-200 bg-gray-50 shrink-0">
                                    <div className="min-w-0 flex-1">
                                        <div className="text-xs font-bold text-gray-700">文件對照</div>
                                        <div className="text-[11px] text-gray-500 truncate">{embeddedKnowledgeFileInfo?.filename || '文字檔'}</div>
                                    </div>
                                    {!isAudioOnlyTrack && (
                                        <button
                                            type="button"
                                            onClick={showTopPanelMedia}
                                            className="px-2.5 py-1.5 text-xs rounded-full border border-gray-200 bg-white text-gray-700 hover:bg-gray-100 shrink-0"
                                            title="切回影像顯示"
                                        >
                                            影像
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={openManualKnowledgeTxtPickerForEmbedded}
                                        className="px-2.5 py-1.5 text-xs rounded-full border border-cyan-200 bg-cyan-50 text-cyan-700 hover:bg-cyan-100 shrink-0"
                                        title="另選一個文字檔或已轉文字文件"
                                    >
                                        另選文件
                                    </button>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <span className="text-[11px] text-gray-500">高度</span>
                                        <input
                                            type="range"
                                            min="28"
                                            max="72"
                                            value={embeddedKnowledgePanelHeight}
                                            onChange={(e) => setEmbeddedKnowledgePanelHeight(Math.max(28, Math.min(72, parseInt(e.target.value, 10) || 60)))}
                                            className="w-24 h-1 bg-gray-300 rounded-lg accent-blue-600"
                                        />
                                        <span className="text-[11px] text-gray-500 w-10 text-right">{embeddedKnowledgePanelHeight}vh</span>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0" title="知識文件字體大小">
                                        <span className="text-[11px] text-gray-500">字體</span>
                                        <button type="button" onClick={() => setEmbeddedKnowledgeFontSize(Math.max(14, embeddedKnowledgeFontSize - 1))} className="w-7 h-7 inline-flex items-center justify-center rounded text-gray-600 hover:bg-gray-200 active:bg-gray-300" aria-label="縮小知識文件字體"><Minus size={14} /></button>
                                        <span className="text-[11px] font-bold text-gray-700 w-6 text-center">{embeddedKnowledgeFontSize}</span>
                                        <button type="button" onClick={() => setEmbeddedKnowledgeFontSize(Math.min(40, embeddedKnowledgeFontSize + 1))} className="w-7 h-7 inline-flex items-center justify-center rounded text-gray-600 hover:bg-gray-200 active:bg-gray-300" aria-label="放大知識文件字體"><Plus size={14} /></button>
                                    </div>
                                    <button onClick={handleToggleMediaPanel} className="p-1.5 bg-gray-200 text-gray-700 rounded-full hover:bg-gray-300 z-20"><Minimize2 size={16} /></button>
                                </div>
                                {trackKnowledgeTabEntries.length > 1 && (
                                    <div className="px-3 py-2 border-b border-gray-100 bg-white shrink-0 overflow-x-auto no-scrollbar">
                                        {renderTrackKnowledgeTabs("embedded")}
                                    </div>
                                )}
                                <div className="flex-1 flex overflow-hidden">
                                    <div ref={embeddedKnowledgeContentRef} className="flex-1 overflow-y-auto px-4 py-3">
                                        {embeddedKnowledgeLoading ? (
                                            <div className="h-full flex items-center justify-center text-sm text-gray-400">載入文件中...</div>
                                        ) : embeddedKnowledgeError ? (
                                            <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-red-600 text-center">
                                                <div>{embeddedKnowledgeError}</div>
                                                <button
                                                    type="button"
                                                    onClick={openManualKnowledgeTxtPickerForEmbedded}
                                                    className="px-3 py-1.5 text-xs rounded-full border border-cyan-200 bg-cyan-50 text-cyan-700 hover:bg-cyan-100"
                                                >
                                                    選擇文字檔
                                                </button>
                                            </div>
                                        ) : (
                                            <MarkdownView
                                                content={embeddedKnowledgeText || "（文件內容為空）"}
                                                fontSize={embeddedKnowledgeFontSize}
                                                trackLanguage={trackLanguage}
                                                speakerLanguage={String(embeddedKnowledgeFileInfo?.targetLanguage || trackLanguage || "").trim()}
                                                enableKnowledgeTermLinks={true}
                                                knowledgeTermEntries={embeddedKnowledgeTermEntries}
                                                onKnowledgeTermClick={handleKnowledgePreviewTermClick}
                                                activeKnowledgeSourceLine={embeddedKnowledgeSubtitleMatch?.sourceLine ?? -1}
                                            />
                                        )}
                                    </div>
                                    {!showModal && knowledgePreviewPopupMode === 'split' && knowledgePreviewTermPopup && (
                                        <>
                                            <div
                                                className="w-1.5 bg-gray-200 hover:bg-cyan-400 cursor-col-resize shrink-0 transition-colors"
                                                onMouseDown={startKnowledgePreviewSplitDrag}
                                                onTouchStart={startKnowledgePreviewSplitDrag}
                                            />
                                            {renderKnowledgePreviewPopupPanel(true)}
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                    {mediaError && (
                        <div className="w-full rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                            {mediaError}
                        </div>
                    )}

                    <div className={`w-full flex flex-col gap-4 ${!mediaSrc ? 'opacity-50 pointer-events-none' : ''}`}>
                        {/* LARGE SUBTITLE CARD */}
                        <div className="relative group cursor-pointer" onClick={() => setIsSubtitleHidden(!isSubtitleHidden)}>
                            <div className={`w-full rounded-xl p-4 text-center flex flex-col items-center justify-center select-none transition-all duration-300 border ${isSubtitleHidden ? 'bg-gray-50 border-gray-100 text-transparent blur-sm' : 'bg-white border-gray-200 shadow-sm'} ${!isVideoMasked ? 'min-h-[10rem]' : 'min-h-[16rem]'}`}>
                                <p className="font-bold text-gray-900 my-2 leading-snug" style={{ fontSize: `${effectiveSubtitleFontSize}px` }}>{subtitles[currentIndex]?.text || "Load File..."}</p>
                            </div>

                            {/* SHADOWING PROGRESS BAR */}
                            {isWaitingShadow && (
                                <div className="absolute bottom-0 left-0 w-full">
                                    <div className="flex justify-between items-end px-2 pb-1">
                                        <span className="text-[10px] font-bold text-yellow-600 bg-yellow-100 px-1.5 rounded">
                                            第 {currentRepeatRef.current + 1} / {isShadowInfinite ? '∞' : shadowRepeatCount} 次
                                        </span>
                                    </div>
                                    <div className="h-1.5 bg-gray-100 mt-1 rounded-b-xl overflow-hidden w-full">
                                        <div
                                            key={shadowCountdown + isWaitingShadow}
                                            className="h-full bg-yellow-400 shadow-[0_0_10px_rgba(250,204,21,0.5)] origin-left"
                                            style={{ width: '100%', animation: `countDownBar ${shadowCountdown}ms linear forwards` }}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* FIXED BOTTOM TOOLBAR */}
                {isToolbarVisible && (
                    <div className="fixed bottom-0 left-0 w-full bg-white border-t border-gray-200 z-50 pb-safe shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
                        <div className="px-4 pt-3 pb-1">
                            <input type="range" min="0" max={duration || 0} value={currentTime}
                                onInput={handleProgressInput}
                                onChange={handleProgressInput}
                                onMouseUp={() => commitProgressSeek(lastUserSeekValueRef.current)}
                                onTouchEnd={() => commitProgressSeek(lastUserSeekValueRef.current)}
                                onKeyUp={(e) => {
                                    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
                                    if (keys.includes(e.key)) commitProgressSeek(parseFloat(e.currentTarget.value));
                                }}
                                className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
                            <div className="flex justify-between text-[10px] font-mono text-gray-400 mt-1"><span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span></div>
                        </div>

                        <div className="flex flex-col gap-3 px-4 py-3 w-full md:flex-row md:flex-nowrap md:items-center md:overflow-x-auto md:no-scrollbar">
                            <div className="flex flex-wrap items-center gap-3 pr-0 md:shrink-0 md:pr-4 md:border-r md:border-gray-100">
                                <button onClick={() => jumpToSubtitle(currentIndex - 1)} className="flex flex-col items-center gap-0.5 text-gray-600 hover:text-black"><SkipBack size={18} /><span className="text-[9px]">上句</span></button>
                                <button onClick={togglePlay} className="p-2 text-gray-900 hover:scale-110 transition-transform bg-gray-100 rounded-full">{isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}</button>
                                <button onClick={() => jumpToSubtitle(currentIndex + 1)} className="flex flex-col items-center gap-0.5 text-gray-600 hover:text-black"><SkipForward size={18} /><span className="text-[9px]">下句</span></button>
                                <button onClick={() => { const modes = ['single', 'all', 'none']; setLoopMode(modes[(modes.indexOf(loopMode) + 1) % modes.length]); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded transition-colors ${loopMode !== 'none' ? 'text-blue-600 bg-blue-50' : 'text-gray-400'}`}>
                                    {loopMode === 'single' && <><Repeat1 size={16} /><span className="text-[9px]">單句</span></>}
                                    {loopMode === 'all' && <><Repeat size={16} /><span className="text-[9px]">全部</span></>}
                                    {loopMode === 'none' && <><MoveRight size={16} /><span className="text-[9px]">不循</span></>}
                                </button>
                                <button onClick={() => { const modes = ['single', 'all', 'none']; setPlaylistLoopMode(modes[(modes.indexOf(playlistLoopMode) + 1) % modes.length]); }} className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded transition-colors ${playlistLoopMode !== 'none' ? 'text-green-600 bg-green-50' : 'text-gray-400'}`}>
                                    {playlistLoopMode === 'single' && <><Repeat1 size={16} /><span className="text-[9px]">清單單曲</span></>}
                                    {playlistLoopMode === 'all' && <><Repeat size={16} /><span className="text-[9px]">清單全部</span></>}
                                    {playlistLoopMode === 'none' && <><MoveRight size={16} /><span className="text-[9px]">清單不循</span></>}
                                </button>
                            </div>

                            {/* SHADOWING UI */}
                            <div className={`flex flex-wrap items-center gap-1 px-2 py-1.5 rounded-lg border transition-all ${isShadowing ? 'bg-yellow-50 border-yellow-200' : 'bg-transparent border-transparent'}`}>
                                <button onClick={() => { setIsShadowing(!isShadowing); }} className={`flex flex-col items-center gap-0.5 font-bold ${isShadowing ? 'text-yellow-700' : 'text-gray-400'}`}><Mic size={14} /><span className="text-[9px]">跟讀</span></button>

                                {isShadowing && (
                                    <div className="flex items-center gap-1 animate-in fade-in zoom-in ml-1">
                                        {/* Repeat Count */}
                                        <div className="flex items-center bg-white rounded border border-yellow-200 px-1 py-0.5">
                                            <input type="number" min="1" max="99" value={shadowRepeatInput} onChange={(e) => { const val = e.target.value; setShadowRepeatInput(val); if (val === '') return; const num = parseInt(val, 10); if (!Number.isNaN(num)) setShadowRepeatCount(Math.max(1, num)); }} onBlur={() => { if (shadowRepeatInput === '') setShadowRepeatInput(String(shadowRepeatCount)); }} disabled={isShadowInfinite} className={`w-7 text-center text-xs border-none p-0 focus:ring-0 bg-transparent ${isShadowInfinite ? 'text-transparent' : 'text-gray-800'}`} placeholder="3" />
                                            <button onClick={() => setIsShadowInfinite(!isShadowInfinite)} className={`p-0.5 ${isShadowInfinite ? 'text-blue-600' : 'text-gray-300'}`} title="無限"><InfinityIcon size={10} /></button>
                                            <span className="text-[10px] text-gray-500 ml-0.5">次</span>
                                        </div>

                                        {/* Gap Settings */}
                                        <div className="flex items-center bg-white rounded border border-yellow-200 px-1 py-0.5" title="Gap Duration">
                                            <button
                                                onClick={() => {
                                                    const newVal = !isShadowGapOriginal;
                                                    setIsShadowGapOriginal(newVal);
                                                    // If disabling, ensure gap is non-negative
                                                    if (!newVal && shadowGapAdjustment < 0) setShadowGapAdjustment(0);
                                                }}
                                                className={`flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold mr-1 transition-colors ${isShadowGapOriginal ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}
                                            >
                                                <Clock size={10} />原音
                                            </button>

                                            <input
                                                type="number"
                                                step="0.5"
                                                min={isShadowGapOriginal ? -10 : 0}
                                                value={shadowGapInput}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    setShadowGapInput(val);
                                                    if (val === '') return;
                                                    let num = parseFloat(val);
                                                    if (Number.isNaN(num)) return;
                                                    if (!isShadowGapOriginal && num < 0) num = 0;
                                                    setShadowGapAdjustment(num);
                                                }}
                                                onBlur={() => {
                                                    if (shadowGapInput === '') {
                                                        setShadowGapInput(String(shadowGapAdjustment));
                                                    }
                                                }}
                                                className="w-8 text-center text-xs border-none p-0 focus:ring-0 text-gray-800 bg-transparent"
                                            />
                                            <span className="text-[10px] text-gray-400">s</span>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2 w-full md:ml-auto md:w-auto">
                                <button data-ai-control onClick={() => handleAIText('correction')} className="flex items-center gap-1 px-3 py-1.5 rounded-full border border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm"><CheckCircle size={16} className="text-blue-500" /><span className="text-xs font-medium text-gray-700">校正</span></button>
                                <button data-ai-control onClick={() => handleAIText('explain')} className="flex items-center gap-1 px-3 py-1.5 rounded-full border border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm"><BookOpen size={16} className="text-green-500" /><span className="text-xs font-medium text-gray-700">單字</span></button>
                                <button data-ai-control onClick={() => handleAIText('deep')} className="flex items-center gap-1 px-3 py-1.5 rounded-full border border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm"><AlertCircle size={16} className="text-purple-500" /><span className="text-xs font-medium text-gray-700">文法</span></button>
                                <button onClick={handleGenerateKnowledgeBankOnly} className="flex items-center gap-1 px-3 py-1.5 rounded-full border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 hover:border-indigo-300 transition-all shadow-sm"><FilePlus size={16} className="text-indigo-600" /><span className="text-xs font-medium text-indigo-700">知識點</span></button>
                                <button data-ai-control onClick={startSimpleLrcQuizGame} className="flex items-center gap-1 px-3 py-1.5 rounded-full border border-fuchsia-200 bg-fuchsia-50 hover:bg-fuchsia-100 hover:border-fuchsia-300 transition-all shadow-sm"><Wand2 size={16} className="text-fuchsia-600" /><span className="text-xs font-medium text-fuchsia-700">出題</span></button>
                                <button data-ai-control onClick={handlePronounce} className="flex items-center gap-1 px-3 py-1.5 rounded-full border border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm"><Mic size={16} className="text-orange-500" /><span className="text-xs font-medium text-gray-700">發音</span></button>

                                {/* [REVISED] Tutor Button UI: Split Buttons */}
                                <div data-ai-control className="flex flex-col sm:flex-row items-stretch sm:items-center border border-blue-200 rounded-2xl sm:rounded-full bg-blue-50 overflow-visible sm:overflow-hidden pl-2 p-0.5 gap-1 sm:gap-0.5">
                                    <button onClick={handleVoiceTutor} className="flex items-center justify-center gap-1 text-blue-700 font-medium text-xs px-2 py-1 hover:bg-blue-100 rounded-full sm:rounded-l-full whitespace-nowrap">
                                        <Volume2 size={16} /><span>家教</span>
                                    </button>
                                    <div className="hidden sm:block h-4 w-px bg-blue-200 mx-1"></div> {/* Separator */}
                                    <div className="flex bg-white rounded-full border border-blue-100 p-0.5 justify-center">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setTutorLang('target') }}
                                            className={`px-2 py-0.5 text-[10px] font-bold rounded-full transition-all whitespace-nowrap ${tutorLang === 'target' ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-blue-500'}`}
                                        >
                                            原文
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setTutorLang('zh-TW') }}
                                            className={`px-2 py-0.5 text-[10px] font-bold rounded-full transition-all whitespace-nowrap ${tutorLang === 'zh-TW' ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-blue-500'}`}
                                        >
                                            中文
                                        </button>
                                    </div>
                                </div>

                                {/* SURVIVAL MODE BUTTON */}
                                <button
                                    data-ai-control
                                    onClick={startSurvivalMode}
                                    disabled={!isSurvivalUnlocked}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border transition-all shadow-sm ${isSurvivalUnlocked ? 'bg-yellow-50 border-yellow-300 text-yellow-700 hover:bg-yellow-100' : 'bg-gray-50 border-gray-200 text-gray-300 cursor-not-allowed'}`}
                                >
                                    <Trophy size={16} className={isSurvivalUnlocked ? "text-yellow-500" : "text-gray-300"} />
                                    <span className="text-xs font-bold">挑戰</span>
                                    <span className="text-[10px] font-semibold">{isSurvivalUnlocked ? "已解鎖" : "未解鎖"}</span>
                                </button>
                                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm">
                                    <span className="text-xs font-black leading-none">{progressPercent}%</span>
                                    <span className="text-[10px] font-medium text-emerald-800">{watchedCount}/{totalSegments}</span>
                                    <span className="text-[10px] font-medium text-gray-600 whitespace-nowrap">{progressStatusText}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* COLLAPSED MINI PLAYER ROW (keep playback controls visible) */}
                {!isToolbarVisible && (
                    <div className="fixed bottom-0 left-0 w-full bg-white/95 backdrop-blur border-t border-gray-200 z-50 pb-safe shadow-[0_-3px_5px_-1px_rgba(0,0,0,0.06)]">
                        <div className="px-3 py-2 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <button onClick={() => jumpToSubtitle(currentIndex - 1)} className="flex items-center justify-center p-1.5 rounded-full text-gray-600 hover:bg-gray-100 hover:text-black">
                                    <SkipBack size={16} />
                                </button>
                                <button onClick={togglePlay} className="flex items-center justify-center p-2 rounded-full bg-gray-100 text-gray-900 hover:scale-105 transition-transform">
                                    {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
                                </button>
                                <button onClick={() => jumpToSubtitle(currentIndex + 1)} className="flex items-center justify-center p-1.5 rounded-full text-gray-600 hover:bg-gray-100 hover:text-black">
                                    <SkipForward size={16} />
                                </button>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                <button
                                    onClick={() => { const modes = ['single', 'all', 'none']; setLoopMode(modes[(modes.indexOf(loopMode) + 1) % modes.length]); }}
                                    className={`px-2 py-1 rounded-full text-[10px] font-semibold transition-colors ${loopMode !== 'none' ? 'text-blue-600 bg-blue-50' : 'text-gray-400 bg-gray-50'}`}
                                    title="單句循環"
                                >
                                    {loopMode === 'single' ? '單句' : loopMode === 'all' ? '全部' : '不循'}
                                </button>
                                <button
                                    onClick={() => { const modes = ['single', 'all', 'none']; setPlaylistLoopMode(modes[(modes.indexOf(playlistLoopMode) + 1) % modes.length]); }}
                                    className={`px-2 py-1 rounded-full text-[10px] font-semibold transition-colors ${playlistLoopMode !== 'none' ? 'text-green-600 bg-green-50' : 'text-gray-400 bg-gray-50'}`}
                                    title="清單循環"
                                >
                                    {playlistLoopMode === 'single' ? '單曲' : playlistLoopMode === 'all' ? '清單' : '不循'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* FLOATING TOGGLES (MOBILE) */}
                <div className="fixed top-2 right-1 md:top-3 md:right-2 z-[80] flex flex-col gap-1.5 pointer-events-auto">
                    <button onClick={() => setIsHeaderVisible(!isHeaderVisible)} className="p-1.5 bg-black/70 backdrop-blur border border-black/20 text-white rounded-full shadow-lg hover:bg-black/80 transition-colors" title="上方控制列">
                        {isHeaderVisible ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                </div>
                <div className={`fixed ${isToolbarVisible ? 'bottom-24' : 'bottom-16'} right-1 md:right-2 z-[80] flex flex-col gap-1.5 pointer-events-auto`}>
                    <button onClick={() => setIsToolbarVisible(!isToolbarVisible)} className="p-1.5 bg-black/70 backdrop-blur border border-black/20 text-white rounded-full shadow-lg hover:bg-black/80 transition-colors" title="下方控制列">
                        {isToolbarVisible ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                    </button>
                </div>

                {/* FABs */}
                <div className="fixed bottom-36 right-6 z-[60] flex flex-col gap-3 items-end pointer-events-auto">
                    <button onClick={startLiveCall} className="p-3 bg-white border border-gray-300 hover:bg-gray-50 text-gray-600 rounded-full shadow-md transition-all hover:scale-105"><Phone size={20} /></button>
                </div>

                {/* SURVIVAL MODE OVERLAY */}
                {isSurvivalMode && survivalQuestion && (
                    <div className="fixed inset-0 z-[100] bg-gray-900/95 flex flex-col items-center justify-center p-6 text-white animate-in fade-in">
                        <button onClick={stopSurvivalMode} className="absolute top-6 right-6 p-2 bg-white/10 rounded-full hover:bg-white/20"><X size={24} /></button>

                        <div className="flex items-center gap-8 mb-8">
                            <div className="flex gap-1">
                                {[...Array(3)].map((_, i) => (
                                    <span key={i} className={`text-2xl ${i < survivalLives ? 'text-red-500' : 'text-gray-600'}`}>❤</span>
                                ))}
                            </div>
                            <div className="text-2xl font-black text-yellow-400">SCORE: {survivalScore}</div>
                        </div>
                        <div className="mb-6 text-sm text-cyan-200 font-semibold">
                            通關進度：{survivalCorrectCount}/{SURVIVAL_PASS_TARGET}（還差 {Math.max(0, SURVIVAL_PASS_TARGET - survivalCorrectCount)} 題）
                        </div>

                        <div className="text-center mb-10 max-w-2xl">
                            <h2 className="text-3xl font-bold leading-relaxed mb-4">{survivalQuestion.maskedText}</h2>
                            <p className="text-gray-400 text-sm">(Listening Challenge)</p>
                            <p className="text-gray-500 text-xs mt-2">如果遇到靜音，請按下方重播。</p>
                            <button onClick={replaySurvivalQuestionAudio} className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-sm font-medium">
                                <Volume2 size={16} /> 重播題目音檔
                            </button>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-xl">
                            {survivalQuestion.options.map((opt, i) => (
                                <button
                                    key={i}
                                    onClick={() => handleSurvivalAnswer(opt)}
                                    className={`p-4 rounded-xl text-lg font-bold transition-all transform hover:scale-105 active:scale-95 ${survivalFeedback === 'correct' && opt === survivalQuestion.answer ? 'bg-green-500 text-white' : survivalFeedback === 'wrong' && opt !== survivalQuestion.answer ? 'bg-gray-700 text-gray-500' : 'bg-white text-gray-900 hover:bg-blue-50'}`}
                                >
                                    {opt}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* MODAL */}
                {showModal && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 bg-gray-900/50 backdrop-blur-sm" onClick={(e) => {
                        if (e.target !== e.currentTarget) return;
                        setShowModal(false);
                        setShowKnowledgeTxtPicker(false);
                        setKnowledgeTxtPickerError("");
                    }}>
                        <div className="bg-white w-[98%] h-[95%] max-h-[95%] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 relative">
                            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-white shrink-0">
                                <div className="flex items-center gap-3">
                                    {modalHistory.length > 0 && <button onClick={handleBack} className="text-gray-500 hover:text-blue-600 transition-colors"><ChevronLeft size={20} /></button>}
                                    <h3 className="text-lg font-bold text-gray-900">{modalTitle}</h3>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="flex items-center gap-1 bg-gray-100 rounded-md p-0.5 border border-gray-200 mr-2">
                                        <button onClick={() => setGlobalFontSize(Math.max(12, globalFontSize - 2))} className="p-1.5 hover:bg-white rounded text-gray-500 hover:text-gray-900 transition-all"><Minus size={14} /></button>
                                        <Type size={14} className="text-gray-400" />
                                        <button onClick={() => setGlobalFontSize(Math.min(32, globalFontSize + 2))} className="p-1.5 hover:bg-white rounded text-gray-500 hover:text-gray-900 transition-all"><Plus size={14} /></button>
                                    </div>
                                    {aiMode === 'text' && modalTitle.includes("單字用語") && (
                                        <button
                                            onClick={handleFullVocabExplain}
                                            disabled={isFullVocabLoading || isLoadingAI}
                                            className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${isFullVocabLoading ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'}`}
                                            title="逐字分批完整解析"
                                        >
                                            {isFullVocabLoading
                                                ? `全字彙 ${fullVocabProgress.done}/${fullVocabProgress.total}`
                                                : '全字彙'}
                                        </button>
                                    )}
                                    {isKnowledgePreviewTextMode && (
                                        <button
                                            onClick={() => {
                                                setShowKnowledgeTxtPicker(v => !v);
                                                setKnowledgeTxtPickerError("");
                                            }}
                                            className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${showKnowledgeTxtPicker ? 'bg-indigo-100 text-indigo-700 border-indigo-200' : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100'}`}
                                            title="從目前資料夾選擇其他知識點 txt"
                                        >
                                            {showKnowledgeTxtPicker ? '收合TXT' : '選其他TXT'}
                                        </button>
                                    )}
                                    {isKnowledgePreviewTextMode && (
                                        <button
                                            onClick={openManualKnowledgeTxtPickerForModal}
                                            className="px-3 py-1.5 text-xs rounded-full border transition-colors bg-cyan-50 text-cyan-700 border-cyan-200 hover:bg-cyan-100"
                                            title="從本機另選文字檔或已轉文字文件"
                                        >
                                            開啟文字檔
                                        </button>
                                    )}
                                        {isKnowledgePreviewTextMode && (
                                            <button
                                                onClick={openKnowledgeFlashCards}
                                            disabled={isFlashCardLoading}
                                            className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${isFlashCardLoading ? 'bg-cyan-100 text-cyan-700 border-cyan-200' : 'bg-cyan-50 text-cyan-700 border-cyan-200 hover:bg-cyan-100'}`}
                                            title="將目前知識點轉成 flash cards"
                                        >
                                            {isFlashCardLoading ? 'Flash...' : 'Flash Card'}
                                        </button>
                                    )}
                                    {aiMode === 'flashcards' && knowledgePreviewReturnState?.content && (
                                        <button
                                            onClick={returnToKnowledgePreview}
                                            className="px-3 py-1.5 text-xs rounded-full border transition-colors bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100"
                                            title="回到剛才的知識點預覽"
                                        >
                                            回預覽
                                        </button>
                                    )}
                                    <button onClick={() => {
                                        setShowModal(false);
                                        setShowKnowledgeTxtPicker(false);
                                        setKnowledgeTxtPickerError("");
                                    }} className="text-gray-400 hover:text-gray-900 p-1 rounded-full hover:bg-gray-50"><X size={20} /></button>
                                </div>
                            </div>

                            {/* [FIX] Added Ref to Container for Auto-Scroll */}
                            <div className="flex-1 flex overflow-hidden bg-white">
                                <div className="p-6 overflow-y-auto flex-1" ref={modalScrollRef}>
                                {isKnowledgePreviewTextMode && trackKnowledgeTabEntries.length > 1 && (
                                    <div className="mb-4 pb-3 border-b border-gray-100 overflow-x-auto no-scrollbar">
                                        {renderTrackKnowledgeTabs("modal")}
                                    </div>
                                )}
                                {aiMode === 'tutor' ? (
                                    <>
                                        {smartTargetDisplay && (
                                            <div className="mb-6 p-4 bg-blue-50 rounded-xl border border-blue-100 flex gap-3 items-start w-full">
                                                <QuickSpeakBtn text={targetSentenceSpeak} mode="ai" size={24} className="mt-1 text-blue-600 bg-white shadow-sm p-2 hover:bg-blue-600 hover:text-white" />
                                                <div>
                                                    <h4 className="text-xs font-bold text-blue-500 uppercase mb-1">Target Sentence</h4>
                                                    <p className="text-lg font-medium text-gray-900 leading-relaxed" dangerouslySetInnerHTML={{ __html: targetSentenceHtml }} />
                                                    {targetTranslation && (
                                                        <p className="text-sm mt-2 text-gray-600">
                                                            {targetTranslation}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                        <div className="space-y-4 w-full">
                                            {isLoadingAI && chatHistory.length === 0 && (
                                                <div className="flex flex-col items-center justify-center h-40 gap-3 text-gray-400 animate-pulse">
                                                    <Brain size={40} className="text-blue-300" />
                                                    <span className="text-xs font-bold tracking-widest uppercase">AI 正在思考中...</span>
                                                </div>
                                            )}
                                            {chatHistory.map((msg, i) => (
                                                <div key={i} className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                                    <div className={`w-full max-w-none rounded-2xl p-4 ${msg.role === 'user' ? 'bg-gray-100 text-gray-800' : 'bg-blue-50 text-blue-900'}`}>
                                                        {msg.role === 'ai' && (() => {
                                                            const wholeSpeakText = getTutorWholeSpeakText(msg);
                                                            if (!wholeSpeakText) return null;
                                                            return (
                                                                <div className="flex items-center gap-2 mb-2 text-xs text-blue-700">
                                                                    <QuickSpeakBtn text={wholeSpeakText} mode="ai" size={16} className="bg-white border border-blue-200" />
                                                                    <span className="font-semibold">整篇朗讀</span>
                                                                </div>
                                                            );
                                                        })()}
                                                        {msg.type === 'audio' && msg.content ? (
                                                            <div><audio key={msg.content} controls src={msg.content} className="h-8 w-full max-w-full mb-2" autoPlay={msg.role === 'ai'} />{msg.text && <MarkdownView content={msg.text} fontSize={globalFontSize} trackLanguage={trackLanguage} />}</div>
                                                        ) : <MarkdownView content={msg.text || msg.content} fontSize={globalFontSize} trackLanguage={trackLanguage} />}
                                                    </div>
                                                </div>
                                            ))}
                                            {isLoadingAI && chatHistory.length > 0 && (
                                                <div className="flex items-center gap-2 text-gray-400 text-sm mt-2 animate-pulse">
                                                    <Sparkles size={16} className="text-blue-400" />
                                                    <span className="font-medium">AI 正在撰寫回覆...</span>
                                                </div>
                                            )}
                                        </div>
                                    </>
                                ) : aiMode === 'quiz' ? (
                                    <>
                                        <div className="w-full max-w-4xl mx-auto space-y-4">
                                            <div className="rounded-2xl border border-fuchsia-100 bg-gradient-to-r from-fuchsia-50 via-white to-blue-50 p-4 shadow-sm">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="px-2 py-1 rounded-full bg-fuchsia-100 text-fuchsia-700 text-xs font-bold">Batch {quizBatchNo || 1}</span>
                                                    <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">分數 {quizScore}</span>
                                                    <span className="px-2 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-bold">連擊 {quizStreak}</span>
                                                    <span className="px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold">正確率 {quizAccuracy}%</span>
                                                </div>
                                                <div className="mt-3 h-2 w-full bg-white border border-fuchsia-100 rounded-full overflow-hidden">
                                                    <div className="h-full bg-gradient-to-r from-fuchsia-500 to-blue-500 transition-all duration-300" style={{ width: `${quizProgress}%` }} />
                                                </div>
                                                <div className="mt-2 text-[11px] text-gray-500">
                                                    已作答 {quizAnsweredCount} 題（答對 {quizSessionStats.correct} / 答錯 {quizSessionStats.wrong}）
                                                </div>
                                                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                                                    <span className="text-[11px] font-semibold text-gray-500 mr-1">題型加強</span>
                                                    {QUIZ_FOCUS_TYPE_ORDER.map((key) => (
                                                        <button
                                                            key={key}
                                                            onClick={() => toggleQuizFocusType(key)}
                                                            className={`px-2 py-1 rounded-full border text-[11px] font-semibold transition-colors ${quizFocusTypes[key]
                                                                    ? 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200'
                                                                    : 'bg-white text-gray-400 border-gray-200 hover:text-gray-600'
                                                                }`}
                                                        >
                                                            {QUIZ_FOCUS_TYPE_LABELS[key]}
                                                        </button>
                                                    ))}
                                                    {!quizIsGenerating && (
                                                        <button
                                                            onClick={continueLrcQuizGame}
                                                            className="ml-1 px-2 py-1 rounded-full border border-fuchsia-300 bg-white text-fuchsia-700 text-[11px] font-bold hover:bg-fuchsia-50"
                                                        >
                                                            依偏好重出
                                                        </button>
                                                    )}
                                                </div>
                                                <div className="mt-2 text-[11px] text-gray-500">
                                                    知識點池 {quizKnowledgePointsPool.length} 點
                                                    {quizKnowledgeFileInfo?.filename ? ` ｜ ${quizKnowledgeFileInfo.filename}` : ''}
                                                </div>
                                                {quizSelectedKnowledgeBatch.length > 0 && (
                                                    <div className="mt-2 text-[11px] text-gray-500 leading-relaxed">
                                                        本回合抽題：{quizSelectedKnowledgeBatch.map(p => `${p.batchId}:${p.label}`).join('、')}
                                                    </div>
                                                )}
                                            </div>

                                            {quizIsGenerating && !currentQuizQuestion && (
                                                <div className="flex flex-col items-center justify-center h-64 gap-4 text-gray-400 animate-pulse">
                                                    <Brain size={48} className="text-fuchsia-300" />
                                                    <span className="text-sm font-bold tracking-widest uppercase">{quizGenerationStage || "AI 正在生成 10 題遊戲題庫..."}</span>
                                                </div>
                                            )}

                                            {quizIsGenerating && currentQuizQuestion && (
                                                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-700">
                                                    {quizGenerationStage || "已顯示目前題目，AI 正在背景補題..."}
                                                </div>
                                            )}

                                            {!quizIsGenerating && quizError && (
                                                <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
                                                    <p className="text-sm font-semibold text-red-700">{quizError}</p>
                                                    <div className="mt-3 flex gap-2">
                                                        <button onClick={() => generateLrcQuizBatch()} className="px-4 py-2 text-sm rounded-full bg-red-600 text-white hover:bg-red-700">重試出題</button>
                                                        <button onClick={startLrcQuizGame} className="px-4 py-2 text-sm rounded-full border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">重開新局</button>
                                                    </div>
                                                </div>
                                            )}

                                            {!quizIsGenerating && !quizError && isQuizBatchDone && (
                                                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center space-y-4">
                                                    <h4 className="text-2xl font-black text-emerald-700">本回合完成</h4>
                                                    <div className="text-sm text-emerald-900">
                                                        本局得分 {quizScore}，累計答對 {quizSessionStats.correct} 題，答錯 {quizSessionStats.wrong} 題
                                                    </div>
                                                    <div className="flex flex-wrap justify-center gap-2">
                                                        <button onClick={continueLrcQuizGame} className="px-4 py-2 rounded-full bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700">依目前偏好再生 10 題</button>
                                                        <button onClick={startLrcQuizGame} className="px-4 py-2 rounded-full bg-white border border-emerald-300 text-emerald-700 text-sm font-semibold hover:bg-emerald-100">重開新挑戰</button>
                                                    </div>
                                                </div>
                                            )}

                                            {!quizError && !isQuizBatchDone && currentQuizQuestion && (
                                                <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                                                    <div className="flex flex-wrap items-center gap-2 mb-3">
                                                        <div className="flex items-center gap-2">
                                                            <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-700 text-xs font-bold">第 {quizCurrentIndex + 1} / {quizTotalCount} 題</span>
                                                            <span className="px-2 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-bold">{currentQuizQuestion.type}</span>
                                                            <span className="px-2 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">
                                                                來源:AI
                                                            </span>
                                                            {currentQuizQuestion.isReview && (
                                                                <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">複習題</span>
                                                            )}
                                                        </div>
                                                        <QuickSpeakBtn
                                                            text={`${currentQuizQuestion.stem} ${(currentQuizQuestion.options || []).map((opt, idx) => `${String.fromCharCode(65 + idx)}. ${opt}`).join(' ')}`}
                                                            mode="ai"
                                                            size={18}
                                                            className="text-blue-600 bg-blue-50 border border-blue-100"
                                                        />
                                                    </div>

                                                    <h4 className="text-xl font-bold text-gray-900 leading-relaxed">{currentQuizQuestion.stem}</h4>

                                                    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                                                        {currentQuizQuestion.options.map((opt, idx) => {
                                                            const isSelected = quizSelectedOption === idx;
                                                            const isAnswer = currentQuizQuestion.answerIndex === idx;
                                                            const baseCls = "w-full text-left px-4 py-3 rounded-xl border transition-all font-medium";
                                                            let dynamicCls = "bg-white border-gray-200 text-gray-800 hover:border-fuchsia-300 hover:bg-fuchsia-50";
                                                            if (quizAnswerState) {
                                                                if (isAnswer) dynamicCls = "bg-emerald-50 border-emerald-300 text-emerald-800";
                                                                else if (isSelected && !isAnswer) dynamicCls = "bg-red-50 border-red-300 text-red-700";
                                                                else dynamicCls = "bg-gray-50 border-gray-200 text-gray-400";
                                                            }
                                                            return (
                                                                <button
                                                                    key={idx}
                                                                    onClick={() => handleQuizPickOption(idx)}
                                                                    disabled={!!quizAnswerState}
                                                                    className={`${baseCls} ${dynamicCls}`}
                                                                >
                                                                    <span className="text-xs font-black mr-2">{String.fromCharCode(65 + idx)}.</span>
                                                                    {opt}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>

                                                    {quizAnswerState && (
                                                        <div className={`mt-5 rounded-xl border p-4 ${quizAnswerState === 'correct' ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                                                            <div className={`font-bold text-sm ${quizAnswerState === 'correct' ? 'text-emerald-700' : 'text-amber-700'}`}>
                                                                {quizAnswerState === 'correct' ? '答對了！' : `答錯了，正確答案是：${currentQuizQuestion.answerText}`}
                                                            </div>
                                                            {(currentQuizQuestion.knowledgePoint || currentQuizQuestion.knowledgePointLabel) && (
                                                                <p className="mt-2 text-xs font-semibold text-gray-600">
                                                                    知識點：{currentQuizQuestion.knowledgePoint || currentQuizQuestion.knowledgePointLabel}
                                                                </p>
                                                            )}
                                                            {currentQuizQuestion.questionZh && (
                                                                <p className="mt-2 text-sm text-slate-700 bg-white/80 border border-slate-200 rounded-lg px-3 py-2">
                                                                    題目中文：{currentQuizQuestion.questionZh}
                                                                </p>
                                                            )}
                                                            <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap">
                                                                {quizAnswerState === 'correct'
                                                                    ? (currentQuizQuestion.explanation || "觀念正確，繼續保持。")
                                                                    : (currentQuizQuestion.wrongDetail || currentQuizQuestion.explanation || "請留意題目的語境與搭配。")}
                                                            </p>
                                                            <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
                                                                <p className="text-xs font-bold text-gray-500 mb-2">選項解析</p>
                                                                <ul className="space-y-2">
                                                                    {currentQuizQuestion.options.map((opt, idx) => {
                                                                        const isAnswer = idx === currentQuizQuestion.answerIndex;
                                                                        const reason = currentQuizQuestion.optionRationales?.[idx] || (isAnswer ? "此選項符合本題句意與語法。" : "此選項不符合本題句意或語法。");
                                                                        return (
                                                                            <li key={idx} className="text-xs">
                                                                                <div className={`font-semibold ${isAnswer ? 'text-emerald-700' : 'text-red-600'}`}>
                                                                                    {String.fromCharCode(65 + idx)}. {opt}
                                                                                </div>
                                                                                <div className="text-gray-600 mt-0.5">{reason}</div>
                                                                            </li>
                                                                        );
                                                                    })}
                                                                </ul>
                                                            </div>
                                                            {quizAnswerState === 'wrong' && currentQuizQuestion.reviewHint && (
                                                                <p className="mt-2 text-xs font-medium text-amber-700">複習提示：{currentQuizQuestion.reviewHint}</p>
                                                            )}
                                                            <div className="mt-2 flex items-center gap-2">
                                                                <QuickSpeakBtn
                                                                    text={currentQuizQuestion.answerText}
                                                                    mode="ai"
                                                                    size={16}
                                                                    className="text-emerald-700 bg-emerald-100 border border-emerald-200"
                                                                />
                                                                <span className="text-[11px] text-gray-500">朗讀正確答案</span>
                                                            </div>
                                                            <div className="mt-4">
                                                                <button onClick={handleQuizNext} className="px-4 py-2 rounded-full bg-gray-900 text-white text-sm font-semibold hover:bg-gray-700">
                                                                    {quizCurrentIndex + 1 >= quizQuestions.length ? '查看本回合結果' : '下一題'}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}

                                                    <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/50 p-3">
                                                        <p className="text-xs font-bold text-blue-700 mb-2">Deep Dive 題目追問</p>
                                                        <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                                                            {quizDeepDiveHistory.map((item, idx) => (
                                                                <div key={idx} className={`text-xs rounded-lg px-3 py-2 ${item.role === 'user' ? 'bg-white border border-blue-200 text-gray-800' : 'bg-blue-100 border border-blue-200 text-blue-900'}`}>
                                                                    {item.text}
                                                                </div>
                                                            ))}
                                                            {isQuizDeepDiveLoading && (
                                                                <div className="text-xs text-blue-600 flex items-center gap-1">
                                                                    <Loader2 size={12} className="animate-spin" />
                                                                    <span>AI 正在補充解釋...</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="mt-2 flex items-center gap-2">
                                                            <input
                                                                value={quizDeepDiveInput}
                                                                onChange={(e) => setQuizDeepDiveInput(e.target.value)}
                                                                onKeyDown={(e) => e.key === 'Enter' && handleQuizDeepDive()}
                                                                placeholder="問這題：為何其他選項不對？這句中文是什麼？"
                                                                className="flex-1 border border-blue-200 rounded-full px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
                                                            />
                                                            <button
                                                                onClick={handleQuizDeepDive}
                                                                disabled={isQuizDeepDiveLoading}
                                                                className="p-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50"
                                                            >
                                                                {isQuizDeepDiveLoading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </>
                                ) : aiMode === 'flashcards' ? (
                                    <>
                                        <div className="w-full max-w-5xl mx-auto space-y-4">
                                            <div className="rounded-2xl border border-cyan-100 bg-gradient-to-r from-cyan-50 via-white to-sky-50 p-4 shadow-sm relative z-[10010]">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <span className="px-2 py-1 rounded-full bg-cyan-100 text-cyan-700 text-xs font-bold">
                                                        Flash Cards
                                                    </span>
                                                    <span className="px-2 py-1 rounded-full bg-white border border-cyan-200 text-cyan-700 text-xs font-semibold">
                                                        {filteredFlashCards.length} / {flashCards.length}
                                                    </span>
                                                    <span
                                                        className="px-2 py-1 rounded-full bg-white border border-gray-200 text-[11px] font-semibold text-gray-600"
                                                        title={`目前卡組：已複習 ${flashCardMasteryStats.reviewed}，答對過 ${flashCardMasteryStats.remembered}，答錯過 ${flashCardMasteryStats.forgot}，未錯過 ${flashCardMasteryStats.clean}，未看過 ${flashCardMasteryStats.unseen}，已丟棄 ${flashCardMasteryStats.discarded}`}
                                                    >
                                                        學{flashCardMasteryStats.reviewed} 對{flashCardMasteryStats.remembered} 錯{flashCardMasteryStats.forgot} 淨{flashCardMasteryStats.clean} 新{flashCardMasteryStats.unseen} 丟{flashCardMasteryStats.discarded}
                                                    </span>
                                                    {flashCardToolbarExpanded && flashCardSourceName && (
                                                        <span className="text-[11px] text-gray-500">
                                                            來源：{flashCardSourceName}
                                                        </span>
                                                    )}
                                                    <span
                                                        className={`px-2 py-1 rounded-full border text-[11px] font-semibold ${flashCardMasterySyncStatus === 'save_failed'
                                                                ? 'border-red-200 bg-red-50 text-red-700'
                                                                : flashCardMasterySyncStatus === 'saved' || flashCardMasterySyncStatus === 'folder_sync_active'
                                                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                                    : 'border-gray-200 bg-white text-gray-500'
                                                            }`}
                                                        title={flashCardMasteryLastSaveError || flashCardMasterySyncStatusLabel}
                                                    >
                                                        {flashCardMasterySyncStatusLabel}
                                                    </span>
                                                    <button
                                                        onClick={handleFlashCardToolbarToggle}
                                                        className="ml-auto px-2 py-1 rounded-full border border-cyan-200 bg-white text-cyan-700 text-xs font-semibold hover:bg-cyan-50"
                                                    >
                                                        {flashCardToolbarExpanded ? '收合功能' : '展開功能'}
                                                    </button>
                                                    {!flashCardToolbarExpanded && (
                                                        <button
                                                            onClick={handleFlashCardTouchLockToggle}
                                                            className={`px-2 py-1 rounded-full border text-xs font-semibold transition-colors ${flashCardTouchLockEnabled
                                                                    ? 'border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                                                                    : 'border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-200'
                                                                }`}
                                                            title="收合時可切換是否鎖住整個畫面的觸控"
                                                        >
                                                            {flashCardTouchLockEnabled ? '觸控鎖：開' : '觸控鎖：關'}
                                                        </button>
                                                    )}
                                                </div>
                                                {flashCardToolbarExpanded && (
                                                    <div className="mt-3 flex flex-wrap items-start gap-1.5">
                                                        <div className="relative">
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    setFlashCardFilterMenuOpen(v => !v);
                                                                    setFlashCardReviewMenuOpen(false);
                                                                    setFlashCardPlaybackMenuOpen(false);
                                                                }}
                                                                className="px-2.5 py-1 rounded-full border border-orange-200 bg-orange-50 text-[11px] text-orange-700 font-bold hover:bg-orange-100"
                                                            >
                                                                篩選
                                                            </button>
                                                            {flashCardFilterMenuOpen && (
                                                                <div className="absolute left-0 top-full mt-1 z-[10020] w-[min(92vw,360px)] rounded-xl border border-orange-200 bg-white p-3 shadow-lg">
                                                                    <div className="flex flex-wrap gap-1.5">
                                                                        {flashCardCategoryOptions.map((key) => (
                                                                            <button
                                                                                key={key}
                                                                                type="button"
                                                                                onClick={() => {
                                                                                    if (flashCardAutoRun) stopFlashCardAutoRun();
                                                                                    handleFlashCardCategoryToggle(key);
                                                                                }}
                                                                                className={`px-2 py-1 rounded-full border text-[11px] font-semibold transition-colors ${(flashCardCategories.includes('all') ? key === 'all' : flashCardCategories.includes(key))
                                                                                        ? 'bg-cyan-100 text-cyan-700 border-cyan-200'
                                                                                        : 'bg-white text-gray-500 border-gray-200 hover:text-cyan-700'
                                                                                    }`}
                                                                            >
                                                                                {key === 'all' ? '全部' : QUIZ_FOCUS_TYPE_LABELS[key]}
                                                                            </button>
                                                                        ))}
                                                                    </div>
                                                                    <select
                                                                        value={flashCardFilterMode}
                                                                        onChange={(e) => {
                                                                            setFlashCardFilterMode(e.target.value);
                                                                            setFlashCardFilterMenuOpen(false);
                                                                        }}
                                                                        className="mt-2 w-full px-2 py-1.5 rounded-lg border border-orange-200 bg-orange-50 text-[11px] text-orange-700 font-semibold focus:outline-none focus:ring-1 focus:ring-orange-300"
                                                                    >
                                                                        <option value="all">全部顯示</option>
                                                                        <option value="learning">只顯示未熟練 (等級 &lt; 3)</option>
                                                                        <option value="wrong">只顯示答錯過 (錯誤 &gt; 0)</option>
                                                                        <option value="wrong_2">只顯示答錯多次 (錯誤 &ge; 2)</option>
                                                                        <option value="unseen">只顯示從未看過</option>
                                                                    </select>
                                                                    <div className="mt-2 grid grid-cols-3 gap-1.5">
                                                                        <label className="text-[10px] font-semibold text-gray-500">
                                                                            答對 ≥
                                                                            <input
                                                                                type="number"
                                                                                min="0"
                                                                                step="1"
                                                                                value={flashCardRememberedMinInput}
                                                                                onChange={(e) => setFlashCardRememberedMinInput(String(e.target.value || ""))}
                                                                                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-700"
                                                                                placeholder="任意"
                                                                            />
                                                                        </label>
                                                                        <label className="text-[10px] font-semibold text-gray-500">
                                                                            答錯 ≥
                                                                            <input
                                                                                type="number"
                                                                                min="0"
                                                                                step="1"
                                                                                value={flashCardForgotMinInput}
                                                                                onChange={(e) => setFlashCardForgotMinInput(String(e.target.value || ""))}
                                                                                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-700"
                                                                                placeholder="任意"
                                                                            />
                                                                        </label>
                                                                        <label className="text-[10px] font-semibold text-gray-500">
                                                                            複習 ≥
                                                                            <input
                                                                                type="number"
                                                                                min="0"
                                                                                step="1"
                                                                                value={flashCardReviewMinInput}
                                                                                onChange={(e) => setFlashCardReviewMinInput(String(e.target.value || ""))}
                                                                                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-700"
                                                                                placeholder="任意"
                                                                            />
                                                                        </label>
                                                                    </div>
                                                                    <div className="mt-2 flex justify-end">
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => {
                                                                                setFlashCardFilterMode('all');
                                                                                setFlashCardRememberedMinInput("");
                                                                                setFlashCardForgotMinInput("");
                                                                                setFlashCardReviewMinInput("");
                                                                            }}
                                                                            className="px-2 py-1 rounded-lg border border-gray-200 bg-gray-50 text-[11px] font-semibold text-gray-600 hover:bg-gray-100"
                                                                        >
                                                                            清除篩選
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="relative">
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    setFlashCardReviewMenuOpen(v => !v);
                                                                    setFlashCardFilterMenuOpen(false);
                                                                    setFlashCardPlaybackMenuOpen(false);
                                                                }}
                                                                className="px-2.5 py-1 rounded-full border border-slate-200 bg-white text-[11px] text-slate-700 font-bold hover:bg-slate-50"
                                                            >
                                                                匯出/入
                                                            </button>
                                                            {flashCardReviewMenuOpen && (
                                                                <div className="absolute left-0 top-full mt-1 z-[10020] w-40 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => {
                                                                            setFlashCardReviewMenuOpen(false);
                                                                            openFlashCardMasteryImportPicker();
                                                                        }}
                                                                        className="w-full px-2 py-1.5 rounded-lg text-left text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                                                                    >
                                                                        匯入記錄
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => {
                                                                            setFlashCardReviewMenuOpen(false);
                                                                            exportFlashCardMasteryJson();
                                                                        }}
                                                                        className="w-full px-2 py-1.5 rounded-lg text-left text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                                                                    >
                                                                        匯出記錄
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="relative">
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    setFlashCardPlaybackMenuOpen(v => !v);
                                                                    setFlashCardFilterMenuOpen(false);
                                                                    setFlashCardReviewMenuOpen(false);
                                                                }}
                                                                className="px-2.5 py-1 rounded-full border border-cyan-200 bg-white text-[11px] text-cyan-700 font-bold hover:bg-cyan-50"
                                                            >
                                                                播放選項
                                                            </button>
                                                            {flashCardPlaybackMenuOpen && (
                                                                <div className="absolute left-0 top-full mt-1 z-[10020] w-52 rounded-xl border border-cyan-200 bg-white p-2 shadow-lg">
                                                                    <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] font-semibold text-cyan-700 hover:bg-cyan-50">
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={flashCardReverseSides}
                                                                            onChange={(e) => setFlashCardReverseSides(e.target.checked)}
                                                                            className="accent-cyan-600"
                                                                        />
                                                                        正反面互換
                                                                    </label>
                                                                    <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] font-semibold text-cyan-700 hover:bg-cyan-50">
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={flashCardAutoSpeakFront}
                                                                            onChange={(e) => setFlashCardAutoSpeakFront(e.target.checked)}
                                                                            className="accent-cyan-600"
                                                                        />
                                                                        Front 自動發聲
                                                                    </label>
                                                                    <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] font-semibold text-cyan-700 hover:bg-cyan-50">
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={flashCardAutoSpeakBack}
                                                                            onChange={(e) => setFlashCardAutoSpeakBack(e.target.checked)}
                                                                            className="accent-cyan-600"
                                                                        />
                                                                        Back 自動發聲
                                                                    </label>
                                                                    {!flashCardReverseSides && (
                                                                        <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] font-semibold text-cyan-700 hover:bg-cyan-50">
                                                                            <input
                                                                                type="checkbox"
                                                                                checked={flashCardAutoSpeakBackIncludeZh}
                                                                                onChange={(e) => {
                                                                                    const checked = e.target.checked;
                                                                                    setFlashCardAutoSpeakBackIncludeZh(checked);
                                                                                    if (checked) setFlashCardAutoSpeakBack(true);
                                                                                }}
                                                                                className="accent-cyan-600"
                                                                            />
                                                                            含中文解釋
                                                                        </label>
                                                                    )}
                                                                    <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] font-semibold text-cyan-700 hover:bg-cyan-50">
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={flashCardAutoRunAllKnowledgeTxt}
                                                                            onChange={(e) => {
                                                                                if (flashCardAutoRun) stopFlashCardAutoRun();
                                                                                setFlashCardAutoRunAllKnowledgeTxt(e.target.checked);
                                                                            }}
                                                                            className="accent-cyan-600"
                                                                        />
                                                                        資料夾全部知識點
                                                                    </label>
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-cyan-200 bg-white text-[11px] text-cyan-700 font-semibold">
                                                            <span>Front 秒</span>
                                                            <input
                                                                type="number"
                                                                min="0"
                                                                step="0.1"
                                                                value={flashCardFrontPauseInput}
                                                                onChange={(e) => {
                                                                    const raw = String(e.target.value || "");
                                                                    setFlashCardFrontPauseInput(raw);
                                                                    if (raw === "") return;
                                                                    const n = parseFloat(raw);
                                                                    if (!Number.isFinite(n)) return;
                                                                    setFlashCardFrontPauseSec(Math.max(0, Math.min(30, n)));
                                                                }}
                                                                onBlur={() => {
                                                                    const raw = String(flashCardFrontPauseInput || "").trim();
                                                                    if (raw === "") {
                                                                        setFlashCardFrontPauseInput(String(flashCardFrontPauseSec));
                                                                        return;
                                                                    }
                                                                    const n = parseFloat(raw);
                                                                    if (!Number.isFinite(n)) {
                                                                        setFlashCardFrontPauseInput(String(flashCardFrontPauseSec));
                                                                        return;
                                                                    }
                                                                    const clamped = Math.max(0, Math.min(30, n));
                                                                    setFlashCardFrontPauseSec(clamped);
                                                                    setFlashCardFrontPauseInput(String(clamped));
                                                                }}
                                                                className="w-14 rounded border border-cyan-200 px-1 py-0.5 text-[11px] text-gray-700"
                                                            />
                                                        </div>
                                                        <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-cyan-200 bg-white text-[11px] text-cyan-700 font-semibold">
                                                            <span>Back 秒</span>
                                                            <input
                                                                type="number"
                                                                min="0"
                                                                step="0.1"
                                                                value={flashCardBackPauseInput}
                                                                onChange={(e) => {
                                                                    const raw = String(e.target.value || "");
                                                                    setFlashCardBackPauseInput(raw);
                                                                    if (raw === "") return;
                                                                    const n = parseFloat(raw);
                                                                    if (!Number.isFinite(n)) return;
                                                                    setFlashCardBackPauseSec(Math.max(0, Math.min(30, n)));
                                                                }}
                                                                onBlur={() => {
                                                                    const raw = String(flashCardBackPauseInput || "").trim();
                                                                    if (raw === "") {
                                                                        setFlashCardBackPauseInput(String(flashCardBackPauseSec));
                                                                        return;
                                                                    }
                                                                    const n = parseFloat(raw);
                                                                    if (!Number.isFinite(n)) {
                                                                        setFlashCardBackPauseInput(String(flashCardBackPauseSec));
                                                                        return;
                                                                    }
                                                                    const clamped = Math.max(0, Math.min(30, n));
                                                                    setFlashCardBackPauseSec(clamped);
                                                                    setFlashCardBackPauseInput(String(clamped));
                                                                }}
                                                                className="w-14 rounded border border-cyan-200 px-1 py-0.5 text-[11px] text-gray-700"
                                                            />
                                                        </div>
                                                        <button
                                                            onClick={handleFlashCardAutoRunToggle}
                                                            disabled={flashCardAutoRunStartDisabled}
                                                            className={`px-2.5 py-1 rounded-full border text-[11px] font-bold transition-colors ${flashCardAutoRun
                                                                    ? 'bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-200'
                                                                    : 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                                                                } disabled:opacity-40 disabled:cursor-not-allowed`}
                                                        >
                                                            {flashCardAutoRun ? (flashCardAutoPaused ? '停止自動（已暫停）' : '停止自動') : '自動播放'}
                                                        </button>
                                                    </div>
                                                )}
                                                {flashCardNotice && (
                                                    <div className="mt-2 text-[11px] font-semibold text-emerald-700">
                                                        {flashCardNotice}
                                                    </div>
                                                )}
                                            </div>
                                            {!flashCardToolbarExpanded && flashCardTouchLockEnabled && (
                                                <div
                                                    className="fixed inset-0 z-[10000] bg-transparent pointer-events-auto"
                                                    aria-hidden="true"
                                                />
                                            )}
                                            <div className={(!flashCardToolbarExpanded && flashCardTouchLockEnabled) ? 'pointer-events-none select-none touch-none' : ''}>
                                                {isFlashCardLoading && (
                                                    <div className="flex flex-col items-center justify-center h-64 gap-4 text-gray-400 animate-pulse">
                                                        <Brain size={48} className="text-cyan-300" />
                                                        <span className="text-sm font-bold tracking-widest uppercase">正在整理 flash cards...</span>
                                                    </div>
                                                )}

                                                {!isFlashCardLoading && flashCardError && (
                                                    <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
                                                        <p className="text-sm font-semibold text-red-700">{flashCardError}</p>
                                                        <div className="mt-3">
                                                            <button onClick={openKnowledgeFlashCards} className="px-4 py-2 text-sm rounded-full bg-red-600 text-white hover:bg-red-700">
                                                                重新載入
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}

                                                {!isFlashCardLoading && !flashCardError && !currentFlashCard && (
                                                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-700">
                                                        沒有可用卡片。請先確認知識點 txt 內容是否存在且格式可解析。
                                                    </div>
                                                )}

                                                {!isFlashCardLoading && !flashCardError && currentFlashCard && (
                                                    <div className="space-y-4">
                                                        <div
                                                            role="button"
                                                            tabIndex={0}
                                                            onClick={handleFlashCardManualFlip}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter' || e.key === ' ') {
                                                                    e.preventDefault();
                                                                    handleFlashCardManualFlip();
                                                                }
                                                            }}
                                                            className="w-full rounded-2xl border border-cyan-200 bg-white p-6 text-left shadow-sm hover:border-cyan-300 transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-300"
                                                        >
                                                            <div className="flex items-center justify-between mb-3">
                                                                <div className="flex items-center gap-2">
                                                                    <span className="px-2 py-1 rounded-full bg-cyan-50 text-cyan-700 text-xs font-bold">
                                                                        {currentFlashCard.categoryLabel}
                                                                    </span>
                                                                    {(() => {
                                                                        const mastery = getFlashCardMasteryForCard(currentFlashCard);
                                                                        if (!mastery) return null;
                                                                        const forgotCount = Number(mastery.forgotCount || mastery.wrongCount || 0);
                                                                        const rememberedCount = Number(mastery.rememberedCount || mastery.level || 0);
                                                                        return (
                                                                            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500">
                                                                                {forgotCount > 0 && <span className="text-orange-500" title={`Forgot: ${forgotCount}`}>🔥{forgotCount}</span>}
                                                                                {rememberedCount > 0 && <span className="text-emerald-500" title={`Remembered: ${rememberedCount}`}>⭐{rememberedCount}</span>}
                                                                            </span>
                                                                        );
                                                                    })()}
                                                                </div>
                                                                <span className="text-[11px] text-gray-400">
                                                                    {normalizedFlashCardIndex + 1} / {filteredFlashCards.length}
                                                                </span>
                                                            </div>
                                                            {(() => {
                                                                const flashCardFrontJSX = flashCardReverseSides ? (
                                                                    <>
                                                                        <div className="flex items-center justify-between mb-2">
                                                                            <p className="text-[11px] uppercase tracking-wider text-gray-400">Front</p>
                                                                            {flashCardReverseFrontSpeakText && (
                                                                                <QuickSpeakBtn
                                                                                    text={flashCardReverseFrontSpeakText}
                                                                                    mode="native"
                                                                                    forceNativeLang={flashCardReverseFrontSpeakLang}
                                                                                    autoPlaySignal={flashFrontAutoPlaySignal}
                                                                                    onPlaybackDone={(res) => handleFlashCardAutoSpeakDone({
                                                                                        side: 'front',
                                                                                        cardId: currentFlashCard.id,
                                                                                        cardIndex: normalizedFlashCardIndex,
                                                                                        manual: res?.manual
                                                                                    })}
                                                                                    size={16}
                                                                                    className="text-emerald-700 bg-emerald-50 border border-emerald-100"
                                                                                />
                                                                            )}
                                                                        </div>
                                                                        <p className="text-base text-gray-800 whitespace-pre-wrap leading-relaxed">{flashCardBackDisplayData.explanation}</p>
                                                                        {shouldShowFlashCardFrontExamples && (
                                                                            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                                                                                <p className="mb-1 text-[11px] font-bold text-amber-700">例句中譯</p>
                                                                                <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{flashCardFrontExampleZhText}</p>
                                                                            </div>
                                                                        )}
                                                                        <p className="mt-4 text-xs text-cyan-700 font-semibold">點擊看答案</p>
                                                                        {flashCardAutoRun && (
                                                                            <p className="mt-1 text-[11px] text-emerald-700">
                                                                                {flashCardAutoPaused ? '自動播放已暫停（點卡片繼續）' : '自動播放中（點卡片暫停）'}
                                                                            </p>
                                                                        )}
                                                                    </>
                                                                ) : (
                                                                    <>
                                                                        <div className="flex items-center justify-between mb-2">
                                                                            <p className="text-[11px] uppercase tracking-wider text-gray-400">Front</p>
                                                                            {currentFlashCard.front && (
                                                                                <QuickSpeakBtn
                                                                                    text={flashCardFrontSpeakText || currentFlashCard.front}
                                                                                    mode="native"
                                                                                    forceNativeLang={flashCardFrontSpeakLang || flashCardSpeakLang}
                                                                                    autoPlaySignal={flashFrontAutoPlaySignal}
                                                                                    onPlaybackDone={(res) => handleFlashCardAutoSpeakDone({
                                                                                        side: 'front',
                                                                                        cardId: currentFlashCard.id,
                                                                                        cardIndex: normalizedFlashCardIndex,
                                                                                        manual: res?.manual
                                                                                    })}
                                                                                    size={16}
                                                                                    className="text-cyan-700 bg-cyan-50 border border-cyan-100"
                                                                                />
                                                                            )}
                                                                        </div>
                                                                        <p className="text-2xl font-bold text-gray-900 leading-relaxed">{flashCardBackDisplayData.front}</p>
                                                                        {shouldShowFlashCardFrontExamples && (
                                                                            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                                                                                <p className="mb-1 text-[11px] font-bold text-amber-700">例句中譯</p>
                                                                                <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{flashCardFrontExampleZhText}</p>
                                                                            </div>
                                                                        )}
                                                                        <p className="mt-4 text-xs text-cyan-700 font-semibold">點擊看答案</p>
                                                                        {flashCardAutoRun && (
                                                                            <p className="mt-1 text-[11px] text-emerald-700">
                                                                                {flashCardAutoPaused ? '自動播放已暫停（點卡片繼續）' : '自動播放中（點卡片暫停）'}
                                                                            </p>
                                                                        )}
                                                                    </>
                                                                );

                                                                const flashCardBackJSX = flashCardReverseSides ? (
                                                                    <>
                                                                        <div className="flex items-center justify-between mb-2">
                                                                            <p className="text-[11px] uppercase tracking-wider text-gray-400">Back</p>
                                                                            {currentFlashCard.front && (
                                                                                <QuickSpeakBtn
                                                                                    text={flashCardFrontSpeakText || currentFlashCard.front}
                                                                                    mode="native"
                                                                                    forceNativeLang={flashCardFrontSpeakLang || flashCardSpeakLang}
                                                                                    autoPlaySignal={flashBackZhAutoPlaySignal}
                                                                                    onPlaybackDone={(res) => handleFlashCardAutoSpeakDone({
                                                                                        side: 'back-zh',
                                                                                        cardId: currentFlashCard.id,
                                                                                        cardIndex: normalizedFlashCardIndex,
                                                                                        manual: res?.manual
                                                                                    })}
                                                                                    size={16}
                                                                                    className="text-cyan-700 bg-cyan-50 border border-cyan-100"
                                                                                />
                                                                            )}
                                                                            {flashCardBackExampleSpeakText && (
                                                                                <QuickSpeakBtn
                                                                                    text={flashCardBackExampleSpeakText}
                                                                                    mode="native"
                                                                                    forceNativeLang={flashCardSpeakLang}
                                                                                    autoPlaySignal={flashBackAutoPlaySignal}
                                                                                    onPlaybackDone={(res) => handleFlashCardAutoSpeakDone({
                                                                                        side: 'back-example',
                                                                                        cardId: currentFlashCard.id,
                                                                                        cardIndex: normalizedFlashCardIndex,
                                                                                        manual: res?.manual
                                                                                    })}
                                                                                    pauseBetweenLinesMs={1000}
                                                                                    size={16}
                                                                                    className="ml-2 text-cyan-700 bg-cyan-50 border border-cyan-100"
                                                                                />
                                                                            )}
                                                                        </div>
                                                                        <p className="text-2xl font-bold text-gray-900 leading-relaxed">{flashCardBackDisplayData.front}</p>
                                                                        {flashCardBackDisplayData.example && (
                                                                            <p className="mt-4 text-base text-gray-800 whitespace-pre-wrap leading-relaxed">{flashCardBackDisplayData.example}</p>
                                                                        )}
                                                                        <p className="mt-4 text-xs text-cyan-700 font-semibold">點擊回題面</p>
                                                                        {flashCardAutoRun && (
                                                                            <p className="mt-1 text-[11px] text-emerald-700">
                                                                                {flashCardAutoPaused ? '自動播放已暫停（點卡片繼續）' : '自動播放中（點卡片暫停）'}
                                                                            </p>
                                                                        )}
                                                                    </>
                                                                ) : (
                                                                    <>
                                                                        <div className="flex items-center justify-between mb-2">
                                                                            <p className="text-[11px] uppercase tracking-wider text-gray-400">Back</p>
                                                                            {flashCardBackZhSpeakText && (
                                                                                <QuickSpeakBtn
                                                                                    text={flashCardBackZhSpeakText}
                                                                                    mode="native"
                                                                                    forceNativeLang="zh-TW"
                                                                                    autoPlaySignal={flashBackZhAutoPlaySignal}
                                                                                    onPlaybackDone={(res) => handleFlashCardAutoSpeakDone({
                                                                                        side: 'back-zh',
                                                                                        cardId: currentFlashCard.id,
                                                                                        cardIndex: normalizedFlashCardIndex,
                                                                                        manual: res?.manual
                                                                                    })}
                                                                                    size={16}
                                                                                    className="text-emerald-700 bg-emerald-50 border border-emerald-100"
                                                                                />
                                                                            )}
                                                                            {flashCardBackExampleSpeakText && (
                                                                                <QuickSpeakBtn
                                                                                    text={flashCardBackExampleSpeakText}
                                                                                    mode="native"
                                                                                    forceNativeLang={flashCardSpeakLang}
                                                                                    autoPlaySignal={flashBackAutoPlaySignal}
                                                                                    onPlaybackDone={(res) => handleFlashCardAutoSpeakDone({
                                                                                        side: 'back-example',
                                                                                        cardId: currentFlashCard.id,
                                                                                        cardIndex: normalizedFlashCardIndex,
                                                                                        manual: res?.manual
                                                                                    })}
                                                                                    pauseBetweenLinesMs={1000}
                                                                                    size={16}
                                                                                    className="ml-2 text-cyan-700 bg-cyan-50 border border-cyan-100"
                                                                                />
                                                                            )}
                                                                        </div>
                                                                        <p className="text-base text-gray-800 whitespace-pre-wrap leading-relaxed">{flashCardBackDisplayData.full}</p>
                                                                        {currentFlashCard?.category === 'sentence' && flashCardKnowledgeTermEntries.length > 0 && (
                                                                            <p className="mt-2 text-[11px] text-cyan-700">
                                                                                已對同檔「單字 / 用語」自動加底線，點擊可開啟知識點視窗
                                                                            </p>
                                                                        )}
                                                                        {flashCardBackExampleSpeakText && (
                                                                            <p className="mt-2 text-[11px] text-cyan-700">
                                                                                喇叭僅朗讀例句（句間停 1 秒）
                                                                            </p>
                                                                        )}
                                                                        <p className="mt-4 text-xs text-cyan-700 font-semibold">點擊回題面</p>
                                                                        {flashCardAutoRun && (
                                                                            <p className="mt-1 text-[11px] text-emerald-700">
                                                                                {flashCardAutoPaused ? '自動播放已暫停（點卡片繼續）' : '自動播放中（點卡片暫停）'}
                                                                            </p>
                                                                        )}
                                                                    </>
                                                                );

                                                                if (!flashCardFlipped) {
                                                                    return flashCardFrontJSX;
                                                                } else {
                                                                    return (
                                                                        <>
                                                                            {flashCardBackJSX}
                                                                            <div className="mt-6 flex items-center justify-center gap-4">
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={(e) => {
                                                                                        e.stopPropagation();
                                                                                        handleFeedback(false);
                                                                                    }}
                                                                                    className="flex-1 max-w-[160px] px-4 py-3 rounded-xl border-2 border-red-200 bg-red-50 text-red-700 text-sm font-bold shadow-sm hover:bg-red-100 hover:border-red-300 transition-colors focus:ring-2 focus:ring-red-300 focus:outline-none"
                                                                                >
                                                                                    ✘ Forget
                                                                                </button>
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={(e) => {
                                                                                        e.stopPropagation();
                                                                                        handleFeedback(true);
                                                                                    }}
                                                                                    className="flex-1 max-w-[160px] px-4 py-3 rounded-xl border-2 border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-bold shadow-sm hover:bg-emerald-100 hover:border-emerald-300 transition-colors focus:ring-2 focus:ring-emerald-300 focus:outline-none"
                                                                                >
                                                                                    ✔ Recall
                                                                                </button>
                                                                            </div>
                                                                        </>
                                                                    );
                                                                }
                                                            })()}
                                                        </div>

                                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                                            <div className="flex items-center gap-2">
                                                                <button
                                                                    onClick={handleFlashCardPrev}
                                                                    className="px-3 py-1.5 rounded-full border border-gray-200 bg-white text-gray-700 text-xs font-semibold hover:bg-gray-50"
                                                                >
                                                                    上一張
                                                                </button>
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        setFlashCardFlipped(v => !v);
                                                                    }}
                                                                    className="px-3 py-1.5 rounded-full border border-cyan-200 bg-cyan-50 text-cyan-700 text-xs font-semibold hover:bg-cyan-100"
                                                                >
                                                                    {flashCardFlipped ? '看題面' : '看答案'}
                                                                </button>
                                                                <button
                                                                    onClick={handleFlashCardNext}
                                                                    className="px-3 py-1.5 rounded-full border border-gray-200 bg-white text-gray-700 text-xs font-semibold hover:bg-gray-50"
                                                                >
                                                                    下一張
                                                                </button>
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                <button
                                                                    onClick={handleFlashCardCopy}
                                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 text-xs font-semibold hover:bg-emerald-100"
                                                                    title="複製目前卡片正反面"
                                                                >
                                                                    <Copy size={13} />
                                                                    複製
                                                                </button>
                                                                <button
                                                                    onClick={handleFlashCardDiscard}
                                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-rose-200 bg-rose-50 text-rose-700 text-xs font-semibold hover:bg-rose-100"
                                                                    title="丟棄目前卡片，之後不再顯示"
                                                                >
                                                                    <Trash2 size={13} />
                                                                    垃圾桶
                                                                </button>
                                                                <button
                                                                    onClick={handleFlashCardShuffle}
                                                                    className="px-3 py-1.5 rounded-full border border-slate-200 bg-slate-50 text-slate-700 text-xs font-semibold hover:bg-slate-100"
                                                                >
                                                                    洗牌
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        {shouldShowTargetSentencePanel && (
                                            <div className="mb-6 p-4 bg-blue-50 rounded-xl border border-blue-100 flex gap-3 items-start w-full">
                                                <QuickSpeakBtn text={targetSentenceSpeak} mode="ai" size={24} className="mt-1 text-blue-600 bg-white shadow-sm p-2 hover:bg-blue-600 hover:text-white" />
                                                <div>
                                                    <h4 className="text-xs font-bold text-blue-500 uppercase mb-1">Target Sentence</h4>
                                                    <p className="text-lg font-medium text-gray-900 leading-relaxed" dangerouslySetInnerHTML={{ __html: targetSentenceHtml }} />
                                                    {targetTranslation && (
                                                        <p className="text-sm mt-2 text-gray-600">
                                                            {targetTranslation}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {/* [FIXED] PRONUNCIATION UI AREA */}
                                        {aiMode === 'pronounce' && (
                                            <div className="flex flex-col items-center gap-6 py-4">
                                                {/* 1. Recorder UI */}
                                                <div className="relative">
                                                    <div className={`absolute inset-0 rounded-full bg-red-400/10 transition-all ${pronunciationState === 'recording' ? 'scale-110 opacity-60' : 'scale-100 opacity-20'}`}></div>
                                                    <button
                                                        onMouseDown={startPronunciationRecord}
                                                        onMouseUp={stopPronunciationRecord}
                                                        onTouchStart={startPronunciationRecord}
                                                        onTouchEnd={stopPronunciationRecord}
                                                        className={`relative z-10 w-16 h-16 rounded-full flex flex-col items-center justify-center border-2 transition-all transform active:scale-95 ${pronunciationState === 'recording' ? 'bg-white border-red-500 text-red-600 shadow-md' : 'bg-white border-red-400 text-red-500 shadow-sm hover:border-red-500'}`}
                                                    >
                                                        {pronunciationState === 'recording' ? <StopCircle size={28} className="text-red-600" /> : <Mic size={28} className="text-red-500" />}
                                                    </button>
                                                </div>

                                                <p className="text-xs text-gray-500 font-medium h-6">
                                                    {pronunciationState === 'idle' && "準備好後，按住麥克風開始朗讀"}
                                                    {pronunciationState === 'preparing' && "啟動麥克風中..."}
                                                    {pronunciationState === 'recording' && <span className="text-red-600 animate-pulse font-bold">● 錄音中...</span>}
                                                    {pronunciationState === 'processing' && "AI 分析中..."}
                                                    {pronunciationState === 'done' && "分析完成"}
                                                </p>

                                                {/* 2. Audio Playback (User) */}
                                                {userAudioUrl && (
                                                    <div className="bg-gray-100 rounded-full px-4 py-2 flex items-center gap-2 animate-in fade-in">
                                                        <span className="text-xs font-bold text-gray-500">你的錄音</span>
                                                        <audio src={userAudioUrl} controls className="h-6 w-48" />
                                                    </div>
                                                )}

                                                {/* 3. Results Display (JSON Rendering) */}
                                                {pronunciationState === 'done' && pronunciationResult && (
                                                    <div className="w-full max-w-2xl space-y-6 animate-in slide-in-from-bottom-4 bg-white p-1 rounded-xl">
                                                        {/* Score Badge */}
                                                        <div className="flex flex-col items-center justify-center">
                                                            <div className={`w-32 h-32 rounded-full border-8 flex items-center justify-center ${pronunciationResult.overall_score >= 80 ? 'border-green-100 text-green-600 bg-green-50' : pronunciationResult.overall_score >= 60 ? 'border-yellow-100 text-yellow-600 bg-yellow-50' : 'border-red-100 text-red-600 bg-red-50'}`}>
                                                                <span className="text-4xl font-black">{pronunciationResult.overall_score}</span>
                                                            </div>
                                                            <p className="mt-4 text-center text-gray-700 font-medium text-lg">{pronunciationResult.general_comment}</p>
                                                        </div>

                                                        {/* Word Analysis */}
                                                        <div>
                                                            <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 text-center">單字分析</h4>
                                                            <div className="flex flex-wrap justify-center gap-2">
                                                                {pronunciationResult.words.map((w, i) => (
                                                                    <div key={i} className={`flex flex-col items-center px-3 py-2 rounded-lg border transition-all ${w.score >= 80 ? 'bg-green-50 border-green-200' : w.score >= 60 ? 'bg-yellow-50 border-yellow-200' : 'bg-red-50 border-red-200'}`}>
                                                                        <span className="text-base font-bold text-gray-800">{w.word}</span>
                                                                        <span className={`text-xs font-bold mt-1 ${w.score >= 80 ? 'text-green-600' : w.score >= 60 ? 'text-yellow-600' : 'text-red-600'}`}>{w.score}</span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>

                                                        {/* Detailed Advice */}
                                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                            <div className="bg-gray-50 rounded-xl p-4">
                                                                <h4 className="flex items-center gap-2 text-sm font-bold text-gray-700 mb-2"><Activity size={16} className="text-blue-500" /> 流暢度建議</h4>
                                                                <p className="text-sm text-gray-600 leading-relaxed">{pronunciationResult.fluency_advice || "無特別建議"}</p>
                                                            </div>
                                                            <div className="bg-gray-50 rounded-xl p-4">
                                                                <h4 className="flex items-center gap-2 text-sm font-bold text-gray-700 mb-2"><Zap size={16} className="text-yellow-500" /> 語調建議</h4>
                                                                <p className="text-sm text-gray-600 leading-relaxed">{pronunciationResult.intonation_advice || "無特別建議"}</p>
                                                            </div>
                                                        </div>

                                                        {/* Specific Word Advice */}
                                                        {pronunciationResult.words.some(w => w.advice) && (
                                                            <div className="bg-orange-50 rounded-xl p-4 border border-orange-100">
                                                                <h4 className="flex items-center gap-2 text-sm font-bold text-orange-800 mb-3"><Ear size={16} /> 發音修正細節</h4>
                                                                <ul className="space-y-2">
                                                                    {pronunciationResult.words.filter(w => w.advice).map((w, i) => (
                                                                        <li key={i} className="text-sm text-gray-700 flex gap-2">
                                                                            <span className="font-bold text-orange-600 shrink-0">{w.word}:</span>
                                                                            <span>{w.advice}</span>
                                                                        </li>
                                                                    ))}
                                                                </ul>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* [FIX] Modified Loading State to Allow Reading Old Content */}
                                        {aiMode !== 'pronounce' && (
                                            <>
                                                {isKnowledgePreviewTextMode && showKnowledgeTxtPicker && (
                                                    <div ref={knowledgeTxtPickerPanelRef} className="sticky top-0 z-20 mb-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <button
                                                                onClick={() => {
                                                                    setSelectedKnowledgeTxtName("");
                                                                    setKnowledgeTxtPickerError("");
                                                                    setShowKnowledgeTxtPicker(false);
                                                                }}
                                                                className="px-3 py-1.5 text-xs rounded-full border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                                                            >
                                                                改回自動（目前音檔）
                                                            </button>
                                                            <div className="ml-auto flex flex-wrap items-center gap-2">
                                                                <span className="text-[11px] font-semibold text-indigo-700">排序</span>
                                                                <select
                                                                    value={knowledgeTxtPickerSortKey}
                                                                    onChange={(e) => setKnowledgeTxtPickerSortKey(String(e.target.value || "modified"))}
                                                                    className="px-2 py-1 text-xs rounded-lg border border-indigo-200 bg-white text-indigo-700"
                                                                >
                                                                    <option value="modified">修改時間</option>
                                                                    <option value="name">檔名</option>
                                                                </select>
                                                                <button
                                                                    onClick={() => setKnowledgeTxtPickerSortDir((prev) => prev === 'asc' ? 'desc' : 'asc')}
                                                                    className="px-2.5 py-1 text-xs rounded-lg border border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-100"
                                                                    title="切換升冪 / 降冪"
                                                                >
                                                                    {knowledgeTxtPickerSortDir === 'asc' ? '升冪' : '降冪'}
                                                                </button>
                                                            </div>
                                                        </div>
                                                        {knowledgeTxtOptions.length === 0 ? (
                                                            <p className="mt-3 text-xs text-gray-600">目前資料夾找不到檔名含「知識點」的 txt。請先按上方「授權資料夾」。</p>
                                                        ) : (
                                                            <div className="mt-3 overflow-hidden rounded-xl border border-indigo-200 bg-white">
                                                                <div className="grid grid-cols-[minmax(0,1fr)_140px_88px] gap-3 px-3 py-2 text-[11px] font-bold text-indigo-700 bg-indigo-50 border-b border-indigo-100">
                                                                    <div>檔名</div>
                                                                    <div>修改時間</div>
                                                                    <div>大小</div>
                                                                </div>
                                                                <div className="max-h-72 overflow-y-auto divide-y divide-indigo-50">
                                                                    {knowledgeTxtPickerEntries.map((entry) => {
                                                                        const name = String(entry?.name || "");
                                                                        const active = selectedKnowledgeTxtName === name;
                                                                        return (
                                                                            <button
                                                                                key={name}
                                                                                onClick={() => handlePickKnowledgeTxtInModal(name)}
                                                                                className={`w-full grid grid-cols-[minmax(0,1fr)_140px_88px] gap-3 px-3 py-2 text-left text-xs transition-colors ${active ? 'bg-indigo-100 text-indigo-800' : 'bg-white text-gray-700 hover:bg-indigo-50'}`}
                                                                                title={name}
                                                                            >
                                                                                <div className="min-w-0 truncate font-medium">{name}</div>
                                                                                <div className="text-[11px] text-gray-500">{formatKnowledgeTxtPickerTime(entry?.lastModified)}</div>
                                                                                <div className="text-[11px] text-gray-500">{formatKnowledgeTxtPickerSize(entry?.size)}</div>
                                                                            </button>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        )}
                                                        {knowledgeTxtPickerError && (
                                                            <p className="mt-3 text-xs text-red-600">{knowledgeTxtPickerError}</p>
                                                        )}
                                                    </div>
                                                )}

                                                {(isLoadingAI && !modalContent) ? (
                                                    <div className="flex flex-col items-center justify-center h-64 gap-4 text-gray-400 animate-pulse">
                                                        <Brain size={48} className="text-blue-300" />
                                                        <span className="text-sm font-bold tracking-widest uppercase">AI 正在思考中...</span>
                                                    </div>
                                                ) : (
                                                    <>
                                                        <MarkdownView
                                                            content={modalContent}
                                                            fontSize={globalFontSize}
                                                            trackLanguage={trackLanguage}
                                                            speakerLanguage={isKnowledgePreviewTextMode ? String(quizKnowledgeFileInfo?.targetLanguage || trackLanguage || "").trim() : ""}
                                                            enableKnowledgeTermLinks={isKnowledgePreviewTextMode}
                                                            knowledgeTermEntries={knowledgePreviewTermEntries}
                                                            onKnowledgeTermClick={handleKnowledgePreviewTermClick}
                                                        />
                                                        {isLoadingAI && (
                                                            <div className="flex items-center gap-2 text-gray-400 text-sm mt-4 animate-pulse">
                                                                <Sparkles size={16} className="text-blue-400" />
                                                                <span className="font-medium">AI 正在撰寫回覆...</span>
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </>
                                        )}
                                    </>
                                )}
                                </div>
                                {knowledgePreviewPopupMode === 'split' && knowledgePreviewTermPopup && (
                                    <>
                                        <div
                                            className="w-1.5 bg-gray-200 hover:bg-cyan-400 cursor-col-resize shrink-0 transition-colors"
                                            onMouseDown={startKnowledgePreviewSplitDrag}
                                            onTouchStart={startKnowledgePreviewSplitDrag}
                                        />
                                        {renderKnowledgePreviewPopupPanel(true)}
                                    </>
                                )}
                            </div>

                            {/* [RESTORED] Deep Dive Input for Text Modes */}
                            {aiMode !== 'tutor' && aiMode !== 'pronounce' && aiMode !== 'quiz' && aiMode !== 'flashcards' && (
                                <div className="p-4 border-t border-gray-100 bg-gray-50 flex items-center gap-2">
                                    <input
                                        value={deepDiveInput}
                                        onChange={(e) => setDeepDiveInput(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && handleDeepDiveFollowUp()}
                                        placeholder="對這個解釋有疑問？請輸入問題..."
                                        className="flex-1 border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                    <button onClick={handleDeepDiveFollowUp} className="p-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-colors">
                                        {isLoadingAI ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                                    </button>
                                </div>
                            )}

                            {aiMode === 'tutor' && (
                                <div className="p-4 border-t border-gray-100 bg-gray-50 flex items-center gap-2">
                                    <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleTutorReply()} className="flex-1 border border-gray-300 rounded-full px-4 py-2 text-sm" />
                                    <button onClick={handleTutorReply} className="p-2 bg-blue-600 text-white rounded-full"><Send size={18} /></button>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {renderKnowledgePreviewPopupPanel()}

                {showLiveCall && (
                    <div className="fixed bottom-20 left-6 z-[70] bg-white border shadow-xl rounded-2xl p-4 w-72">
                        <div className="flex justify-between mb-4"><span className="font-bold text-sm flex items-center gap-2"><span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" /> Gemini Live</span><button onClick={endLiveCall}><X size={16} /></button></div>
                        <div className="h-24 bg-gray-50 rounded flex items-center justify-center mb-4"><Loader2 size={32} className={`text-blue-500 ${liveCallStatus === 'processing' ? 'animate-spin' : ''}`} /></div>
                        <p className="text-center text-xs text-gray-500">{liveCallStatus}</p>
                        <audio ref={liveAudioRef} className="hidden" />
                    </div>
                )}

                <style>{`@keyframes countDownBar { from { width: 100%; } to { width: 0%; } } .mask-gradient { mask-image: linear-gradient(to right, black 90%, transparent 100%); } .no-scrollbar::-webkit-scrollbar { display: none; } .inline-code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; background: #f3f4f6; border: 1px solid #e5e7eb; padding: 0 4px; border-radius: 4px; font-size: 0.9em; } .ai-subhead { margin: 8px 0 4px; padding-left: 16px; font-weight: 700; color: #0f172a; } .ai-subtext { padding-left: 16px; color: #334155; } .question-box { margin: 16px 0; padding: 16px; background: #ecfdf5; color: #064e3b; border: 1px solid #d1fae5; border-radius: 12px; } .question-label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #059669; margin-bottom: 6px; } .question-text { font-weight: 600; } .ai-h2 { margin: 18px 0 10px; padding: 10px 14px; background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%); border: 1px solid #e5e7eb; border-left: 4px solid #2563eb; border-radius: 12px; font-size: 18px; font-weight: 800; color: #111827; } .ai-h3 { margin: 14px 0 8px; padding: 8px 12px; background: #f8fafc; border: 1px solid #e5e7eb; border-left: 3px solid #10b981; border-radius: 10px; font-size: 16px; font-weight: 700; color: #1f2937; } .ai-h4 { margin: 10px 0 6px; padding-left: 10px; border-left: 2px solid #cbd5e1; font-size: 14px; font-weight: 700; color: #374151; }`}</style>
            </div>
        </AudioCacheContext.Provider>
    );
}
