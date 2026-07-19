// orchestrator.js — v2 串接每一站：先試 AI（代理），失敗即降級到靜態主題包。
// 對 UI 而言介面一致：不管 AI 有沒有成功，回傳的形狀都一樣。
// 所有 state 變更（記錄回答、萃取訊號、合併參數、追加 beat、記錄拾得）都集中在這裡完成。
//
// 流程：genesis → (getReflect → submitResponse → getCollect) ×3 → getFinale

import { callAI, AI_CONFIG } from '../ai/client.js';
import { getTheme } from '../content/themes.js';
import { classifyIntent } from '../content/intentMap.js';
import { generateBoard, BOARD_LENGTH } from './board.js';
import {
  mergeParamDelta, appendBeat, buildContextBlock,
  weightedCardPick, topKeywords, energyBalance, toneArc,
  extractSignalsFromText, buildVocab,
} from './params.js';
import { logAiCall } from './journeyState.js';
import { cards } from '../../data/cards.js';

const PALETTE_OPTIONS = ['warm', 'cool', 'verdant', 'cosmic'];
const ALLOWED_THEMES = ['pet', 'relationship', 'career', 'health', 'purpose', 'generic'];

// 是否嘗試 AI（全域開關 + 本局 aiAvailable）
function aiOn(state) {
  return AI_CONFIG.enabled && state.aiAvailable;
}

async function tryAI(state, action, payload) {
  const t0 = Date.now();
  try {
    const data = await callAI(action, payload);
    logAiCall(state, { action, ms: Date.now() - t0, ok: true, fallbackUsed: false });
    return data;
  } catch (e) {
    logAiCall(state, { action, ms: Date.now() - t0, ok: false, fallbackUsed: true });
    return null;
  }
}

// ---- 1. 世界生成（genesis） ----
export async function genesis(state) {
  let applied = false;
  if (aiOn(state)) {
    const data = await tryAI(state, 'genesis', {
      question: state.question.raw,
      boardLength: BOARD_LENGTH,
      allowedThemeIds: ALLOWED_THEMES,
      paletteOptions: PALETTE_OPTIONS,
    });
    if (data && data.world) {
      state.question.normalized = ALLOWED_THEMES.includes(data.themeId) ? data.themeId : 'generic';
      state.question.entities = Array.isArray(data.entities) ? data.entities.slice(0, 6) : [];
      if (data.lang) state.question.lang = data.lang;
      const w = data.world;
      state.world = {
        themeId: state.question.normalized,
        title: String(w.title || '').slice(0, 40) || getTheme(state.question.normalized).world.title,
        setting: String(w.setting || '').slice(0, 120),
        palette: PALETTE_OPTIONS.includes(w.palette) ? w.palette : 'cosmic',
        motifs: Array.isArray(w.motifs) ? w.motifs.slice(0, 4) : [],
        tileThemeWords: normalizeThemeWords(w.tileThemeWords, state.question.normalized),
      };
      applied = true;
    }
  }

  if (!applied) {
    // 降級：關鍵字分類 → 靜態主題包
    const themeId = classifyIntent(state.question.raw);
    const theme = getTheme(themeId);
    state.question.normalized = themeId;
    state.world = {
      themeId,
      title: theme.world.title,
      setting: theme.world.setting,
      palette: theme.world.palette,
      motifs: theme.world.motifs.slice(),
      tileThemeWords: theme.world.tileThemeWords.slice(),
    };
  }

  state.board = generateBoard(state.world.tileThemeWords);
  state.status = 'playing';
  return state.world;
}

function normalizeThemeWords(words, themeId) {
  const fallback = getTheme(themeId).world.tileThemeWords;
  const out = Array.isArray(words) ? words.filter((w) => typeof w === 'string' && w.trim()).slice(0, BOARD_LENGTH) : [];
  for (let i = out.length; i < BOARD_LENGTH; i++) out.push(fallback[i] || '當下');
  return out;
}

// ---- 2. 開放提問（reflect） ----
export async function getReflect(state, tile) {
  const askedCount = state.responses.length; // 第幾個提問（0-based）
  if (aiOn(state)) {
    const data = await tryAI(state, 'reflect', {
      journeyContext: buildContextBlock(state),
      tile: { idx: tile.idx, themeWord: tile.themeWord },
      questionIndex: askedCount + 1, // 1..3，供深度遞進
      totalQuestions: 3,
    });
    if (data && data.question) {
      return { scene: String(data.scene || ''), question: String(data.question), _ai: true };
    }
  }
  return pickStaticReflect(state);
}

function pickStaticReflect(state) {
  const theme = getTheme(state.world.themeId);
  // 依序取用（深度遞進：現況 → 卡點 → 渴望），全用過才輪回
  let pool = theme.reflections.filter((r) => !state.usedReflectIds.includes(r.id));
  if (!pool.length) { state.usedReflectIds = []; pool = theme.reflections.slice(); }
  const r = pool[0];
  state.usedReflectIds.push(r.id);
  return { scene: r.scene, question: r.question, _ai: false };
}

// ---- 3. 收下玩家的回答（純本地，不呼叫 AI） ----
// answer 為 null 表示玩家選擇「靜靜走過」。
export function submitResponse(state, tile, question, answer) {
  const clean = answer == null ? null : String(answer).trim().slice(0, 500);
  state.responses.push({ stepIdx: tile.idx, question, answer: clean });

  let tone;
  if (clean) {
    // 從玩家的文字萃取關鍵字與情緒（離線也生效，讓拾得的卡回應玩家打的字）
    const vocab = buildVocab(cards, state.world.tileThemeWords);
    const sig = extractSignalsFromText(clean, vocab);
    if (sig) {
      mergeParamDelta(state.params, { keywords: sig.keywords, tone: sig.tone, energy: sig.energy });
      tone = sig.tone;
    }
  }
  appendBeat(state, {
    tileIdx: tile.idx,
    summary: clean ? `你說：「${clean.slice(0, 18)}${clean.length > 18 ? '…' : ''}」` : '你選擇靜靜走過這一問',
    tone,
  });
}

// ---- 4. 沿路拾得（collect）：以巴夏卡為原型的個人化訊息 ----

// 去識別：v2 不明說訊息來源。卡名含「巴夏」的卡不入選；
// 離線降級直接用內建解讀時，抹去「巴夏」「這張牌」等字眼。
let _basharTitleIdx = null;
function basharTitleIndices() {
  if (!_basharTitleIdx) {
    _basharTitleIdx = cards.reduce((acc, c, i) => {
      if ((c.title || '').includes('巴夏')) acc.push(i);
      return acc;
    }, []);
  }
  return _basharTitleIdx;
}

function sanitizeReading(text) {
  return String(text || '')
    .replace(/抽到這張牌/g, '拾起這段訊息')
    .replace(/這張牌/g, '這段訊息')
    .replace(/這張卡/g, '這段訊息')
    .replace(/巴夏/g, '這段訊息');
}

export async function getCollect(state, tile) {
  const usedIdx = state.collectedCards.map((c) => c.cardIndex).concat(basharTitleIndices());
  const cardIndex = weightedCardPick(cards, state.params, usedIdx);
  const card = cards[cardIndex];
  const latest = state.responses[state.responses.length - 1] || null;

  // 最強降級：主題拾得框架 + 卡片內建解讀（去識別處理，不含原文）
  let pickup = pickStaticPickup(state);
  let reading = sanitizeReading(card.read);
  let paramDelta = { keywords: (card.keys || []).slice(0, 2) };

  if (aiOn(state)) {
    const data = await tryAI(state, 'collect', {
      journeyContext: buildContextBlock(state),
      latestAnswer: latest && latest.answer ? latest.answer : null,
      card: { title: card.title, en: card.en, zh: card.zh, read: card.read, keys: card.keys },
    });
    if (data && data.reading) {
      pickup = String(data.pickup || pickup);
      reading = String(data.reading);
      if (data.paramDelta) paramDelta = data.paramDelta;
    }
  }

  mergeParamDelta(state.params, paramDelta);
  const entry = { cardIndex, tileIdx: tile.idx, title: card.title, pickup, reading };
  state.collectedCards.push(entry);
  appendBeat(state, { tileIdx: tile.idx, summary: `拾得「${card.title}」`, tone: undefined });
  return { card, cardIndex, pickup, reading };
}

function pickStaticPickup(state) {
  const theme = getTheme(state.world.themeId);
  let pool = theme.pickups.filter((_, i) => !state.usedPickupIds.includes(i));
  if (!pool.length) { state.usedPickupIds = []; pool = theme.pickups.slice(); }
  const idx = theme.pickups.indexOf(pool[0]);
  state.usedPickupIds.push(idx);
  return theme.pickups[idx];
}

// ---- 5. 結局：直指核心的答案 ----
export async function getFinale(state) {
  let finale = null;

  if (aiOn(state)) {
    const data = await tryAI(state, 'finale', {
      question: state.question.raw,
      world: { title: state.world.title, setting: state.world.setting, motifs: state.world.motifs },
      responses: state.responses.map((r) => ({ question: r.question, answer: r.answer })),
      collectedCards: state.collectedCards.map((c) => c.title),
      topKeywords: topKeywords(state.params, 5),
      toneArc: toneArc(state),
      energyBalance: energyBalance(state.params),
    });
    if (data && data.coreAnswer) {
      const collectedTitles = state.collectedCards.map((c) => c.title);
      finale = {
        title: String(data.title || '給你的回應'),
        coreAnswer: String(data.coreAnswer),
        recap: String(data.recap || ''),
        keyCards: Array.isArray(data.keyCards)
          ? data.keyCards.filter((t) => collectedTitles.includes(t)).slice(0, 3)
          : collectedTitles.slice(0, 3),
        suggestedPractice: String(data.suggestedPractice || ''),
        closingBlessing: String(data.closingBlessing || ''),
      };
    }
  }

  if (!finale) {
    finale = assembleStaticFinale(state);
  }

  state.finale = finale;
  state.status = 'done';
  return finale;
}

function assembleStaticFinale(state) {
  const theme = getTheme(state.world.themeId);
  const cardTitles = state.collectedCards.map((c) => c.title);
  const top = topKeywords(state.params, 3);
  const balance = energyBalance(state.params);

  // 找一句玩家自己的話來回扣（優先取最長的一則回答）
  const answered = state.responses.filter((r) => r.answer);
  answered.sort((a, b) => b.answer.length - a.answer.length);
  const quote = answered.length ? answered[0].answer.slice(0, 40) : null;

  const parts = [
    `回到你最初帶來的問題——「${state.question.raw}」。`,
  ];
  if (quote) {
    parts.push(`一路聽下來，最讓我停留的是你說的：「${quote}${answered[0].answer.length > 40 ? '…' : ''}」。這句話裡，已經藏著你自己的方向。`);
  } else {
    parts.push('這一路你選擇安靜地走，而安靜本身也是一種回答——有些答案需要的不是更多思考，而是被允許浮現的空間。');
  }
  if (top.length) parts.push(`貫穿你這趟旅程的，是「${top.join('、')}」——它們不是巧合，是你此刻生命裡正在敲門的主題。`);
  parts.push(theme.answerSeed);
  parts.push(`此刻你的能量${balance}。與其急著找到「正確答案」，不如先問：哪一個方向，讓你感覺更像自己、更有生命力？那就是你的羅盤。`);

  const recapBits = state.narrative.beats.map((b) => b.summary).filter(Boolean).slice(0, 6);
  const recap = `${theme.finaleIntro}${recapBits.length ? ` 這一路，${recapBits.join('；')}。` : ''}`;

  const practice = theme.practices[Math.floor(Math.random() * theme.practices.length)];
  const blessing = theme.blessings[Math.floor(Math.random() * theme.blessings.length)];

  return {
    title: `${state.world.title}·給你的回應`,
    coreAnswer: parts.join('\n\n'),
    recap,
    keyCards: cardTitles.slice(0, 3),
    suggestedPractice: practice,
    closingBlessing: blessing,
  };
}
