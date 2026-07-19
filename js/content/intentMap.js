// intentMap.js — 關鍵字 → themeId 對應（genesis 降級用，也可作為 AI 分類的提示）
// 依命中數計分，平手時以 THEME_PRIORITY 順序決勝（例：「幫狗做手術」→ pet 勝 health）。
// v2：加入前端危機關鍵字攔截——命中時不進遊戲，由 UI 顯示模板固定的關懷訊息。

const CRISIS_KEYWORDS = ['自殺', '自我傷害', '自殘', '想死', '不想活', '結束生命', '活不下去', '傷害自己', '輕生'];

export function detectCrisis(rawText) {
  const text = String(rawText || '');
  return CRISIS_KEYWORDS.some((w) => text.includes(w));
}

const THEME_KEYWORDS = {
  pet: ['寵物', '狗', '貓', '毛孩', '毛小孩', '動物', '汪', '喵', '牠', '飼養', '領養', '離世', '安樂'],
  relationship: ['關係', '伴侶', '感情', '愛情', '男友', '女友', '老公', '老婆', '先生', '太太', '婚姻', '家人', '父母', '爸', '媽', '孩子', '朋友', '曖昧', '分手', '復合', '相處', '溝通', '吵架'],
  career: ['工作', '職涯', '事業', '升遷', '轉職', '離職', '創業', '老闆', '同事', '面試', '薪水', '收入', '財務', '金錢', '豐盛', '賺錢', '副業', '生意'],
  health: ['健康', '身體', '生病', '疾病', '手術', '開刀', '治療', '康復', '睡眠', '失眠', '壓力', '焦慮', '憂鬱', '情緒', '心理', '疼痛', '體重'],
  purpose: ['意義', '人生', '方向', '使命', '天命', '天賦', '熱情', '志向', '目標', '迷惘', '迷茫', '價值', '成長', '自我', '存在', '靈魂', '為什麼'],
};

// 平手時的優先順序：情感相關的主題優先於較「功能性」的健康
const THEME_PRIORITY = ['pet', 'relationship', 'purpose', 'career', 'health', 'generic'];

export function classifyIntent(rawQuestion) {
  const text = String(rawQuestion || '');
  const scores = {};
  for (const [theme, words] of Object.entries(THEME_KEYWORDS)) {
    let s = 0;
    for (const w of words) if (text.includes(w)) s += 1;
    if (s > 0) scores[theme] = s;
  }
  const themes = Object.keys(scores);
  if (!themes.length) return 'generic';

  themes.sort((a, b) => {
    if (scores[b] !== scores[a]) return scores[b] - scores[a];
    return THEME_PRIORITY.indexOf(a) - THEME_PRIORITY.indexOf(b);
  });
  return themes[0];
}
