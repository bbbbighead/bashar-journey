// crisis.js — 危機關鍵字攔截。
// 偵測到自我傷害等訊號時不進入對談，由 UI 顯示固定的關懷資源頁。
// 寧可誤攔（false positive 顯示關懷頁）也不漏接。

const CRISIS_PATTERNS = [
  /自[殺杀]/, /輕生/, /尋短/, /想死/, /去死/, /不想活/, /活不下去/, /活著沒有?意義/,
  /結束(自己的)?生命/, /了結(自己|一切)/, /自我傷害/, /自[殘残]/, /傷害(我)?自己/,
  /割腕/, /上吊/, /跳樓/, /燒炭/, /吞(安眠)?藥/,
  /suicide/i, /kill\s*myself/i, /end\s*my\s*life/i, /self[-\s]?harm/i,
  /hurt\s*myself/i, /want\s*to\s*die/i, /better\s*off\s*dead/i,
];

export function detectCrisis(text) {
  const t = String(text || '');
  return CRISIS_PATTERNS.some((re) => re.test(t));
}
