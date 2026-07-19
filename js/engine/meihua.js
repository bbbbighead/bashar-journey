// meihua.js — 梅花易數引擎：起卦、本互變卦、體用生剋、動態摘要。
// 純前端、確定性演算（同一提問＋同一時刻必得同一卦）。輸出僅供內部整合使用。
//
// 起卦法：時間＋字數起卦（傳統梅花的簡化版——傳統用農曆與地支時辰，
// 此處以國曆數值＋地支時辰數計算；因結果只作為內部視角之一，不影響體驗一致性）。
//   上卦 =（年 + 月 + 日 + 問題字數）% 8（0 作 8）
//   下卦 =（年 + 月 + 日 + 時辰數 + 問題字數）% 8（0 作 8）
//   動爻 =（上卦和 + 下卦和）% 6（0 作 6）

import {
  TRIGRAMS, TRIGRAM_LINES, HEXAGRAMS, STAGE_MEANING, GENERATES, OVERCOMES,
} from '../../data/hexagrams.js';

// 地支時辰數：子1 丑2 … 亥12（23:00–00:59 為子時）
function shichen(hour) {
  return Math.floor(((hour + 1) % 24) / 2) + 1;
}

// 由六爻（由下而上）取上下卦先天數
function linesToTrigram(lines3) {
  const key = lines3.join('');
  for (const [num, l] of Object.entries(TRIGRAM_LINES)) {
    if (l.join('') === key) return Number(num);
  }
  return 8;
}

function hexFromTrigrams(upper, lower) {
  const key = `${upper}-${lower}`;
  return { key, upper, lower, ...HEXAGRAMS[key] };
}

// 起卦主函式
export function castHexagrams(question, when = new Date()) {
  const y = when.getFullYear(), m = when.getMonth() + 1, d = when.getDate();
  const sc = shichen(when.getHours());
  const qLen = Array.from(String(question || '')).length;

  const upperSum = y + m + d + qLen;
  const lowerSum = y + m + d + sc + qLen;
  const upper = upperSum % 8 || 8;
  const lower = lowerSum % 8 || 8;
  const moving = (upperSum + lowerSum) % 6 || 6; // 1–6，由下而上

  // 本卦六爻（由下而上）
  const benLines = [...TRIGRAM_LINES[lower], ...TRIGRAM_LINES[upper]];

  // 變卦：動爻陰陽互換
  const bianLines = benLines.slice();
  bianLines[moving - 1] = benLines[moving - 1] ? 0 : 1;

  // 互卦：2,3,4 爻為下卦、3,4,5 爻為上卦
  const huLower = linesToTrigram(benLines.slice(1, 4));
  const huUpper = linesToTrigram(benLines.slice(2, 5));

  const ben = hexFromTrigrams(upper, lower);
  const hu = hexFromTrigrams(huUpper, huLower);
  const bian = hexFromTrigrams(linesToTrigram(bianLines.slice(3, 6)), linesToTrigram(bianLines.slice(0, 3)));

  // 體用：動爻所在之卦為「用」（事），另一卦為「體」（己）
  const movingInLower = moving <= 3;
  const ti = movingInLower ? upper : lower;
  const yong = movingInLower ? lower : upper;
  const relation = tiYongRelation(TRIGRAMS[ti].element, TRIGRAMS[yong].element);

  return { ben, hu, bian, moving, ti, yong, relation };
}

// 體用五行生剋 → 動能關係
function tiYongRelation(tiEl, yongEl) {
  if (tiEl === yongEl) return 'harmony';                 // 比和：內外同氣
  if (GENERATES[yongEl] === tiEl) return 'support';      // 用生體：局勢滋養
  if (GENERATES[tiEl] === yongEl) return 'drain';        // 體生用：付出消耗
  if (OVERCOMES[tiEl] === yongEl) return 'control';      // 體剋用：費力可成
  return 'pressure';                                     // 用剋體：外壓當道
}

export const RELATION_MEANING = {
  support:  { label: '局勢滋養', sentence: '整體局勢對你是滋養的——外在條件正在暗暗幫你，你可以少一點防備、多一點接收' },
  harmony:  { label: '內外同氣', sentence: '你和這件事的頻率是合的——內外沒有根本的對抗，卡住的地方多半在細節與節奏，不在方向' },
  control:  { label: '費力可成', sentence: '這件事你是有掌握力的，但每一步都要花力氣——可行，只是要把力氣當作有限資源來配置' },
  drain:    { label: '付出偏多', sentence: '目前的形態是你在單向輸出——投入未必錯，但值得檢查：這樣的付出方式還能持續多久' },
  pressure: { label: '外壓當道', sentence: '此刻外在的壓力大於你的施力點——先求站穩、保全自己，等壓力的週期過去再圖進取' },
};

// 產出給 AI 的內部敘述
export function meihuaForAI(cast) {
  return {
    present: `${cast.ben.name}（${STAGE_MEANING[cast.ben.stage].label}）：${cast.ben.dyn}`,
    process: `${cast.hu.name}：${cast.hu.dyn}`,
    direction: `${cast.bian.name}（${STAGE_MEANING[cast.bian.stage].label}）：${cast.bian.dyn}`,
    dynamics: `體用關係「${RELATION_MEANING[cast.relation].label}」——${RELATION_MEANING[cast.relation].sentence}`,
    movingLine: cast.moving,
  };
}

// 離線降級：把卦象讀成「時機與節奏」的自然語句（不含卦名與術語）
export function offlineDynamics(cast) {
  const out = [];
  out.push(STAGE_MEANING[cast.ben.stage].sentence + '。');
  out.push(RELATION_MEANING[cast.relation].sentence + '。');
  if (cast.bian.stage !== cast.ben.stage) {
    out.push(`往前看，整體的節奏正在從「${STAGE_MEANING[cast.ben.stage].label}」轉向「${STAGE_MEANING[cast.bian.stage].label}」——${STAGE_MEANING[cast.bian.stage].sentence}。`);
  }
  return out;
}
