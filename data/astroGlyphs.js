// astroGlyphs.js — 星盤符號對照表。
//
// 星盤上的點位由 api/astro.py 以中文名回傳（太陽、凱龍星…），這裡把它們
// 對到 Unicode 字符。字符不是每台裝置都畫得出來：☉☽☿♀♂♃♄ 落在支援度好的
// Miscellaneous Symbols，但 ⚳⚴⚵⚶⚷⚸ 這些小行星與莉莉絲常常缺字，會變成豆腐框。
// 所以每個點都同時給一組拉丁縮寫，由 js/chartWheel.js 在執行時偵測缺字後替換。
//
// 縮寫刻意用拉丁字母而非漢字（日月水金火土…）：漢字縮寫在中日文可讀，
// 但英韓文讀者看不懂，而縮寫只在缺字時出現，四語系共用一套才不會有落差。

// 十二星座：♈–♓（U+2648–2653），支援度普遍良好。
// 順序有意義（黃經 0° 起算），所以用陣列而不是靠物件的鍵順序。
export const SIGN_NAMES = [
  '牡羊座', '金牛座', '雙子座', '巨蟹座', '獅子座', '處女座',
  '天秤座', '天蠍座', '射手座', '摩羯座', '水瓶座', '雙魚座',
];
export const SIGN_GLYPH = {
  牡羊座: '♈', 金牛座: '♉', 雙子座: '♊', 巨蟹座: '♋',
  獅子座: '♌', 處女座: '♍', 天秤座: '♎', 天蠍座: '♏',
  射手座: '♐', 摩羯座: '♑', 水瓶座: '♒', 雙魚座: '♓',
};

// 點位：glyph＝Unicode 字符，abbr＝缺字時的替代，axis＝四軸（畫法不同）
export const POINT_GLYPH = {
  太陽: { glyph: '☉', abbr: 'Su' },
  月亮: { glyph: '☽', abbr: 'Mo' },
  水星: { glyph: '☿', abbr: 'Me' },
  金星: { glyph: '♀', abbr: 'Ve' },
  火星: { glyph: '♂', abbr: 'Ma' },
  木星: { glyph: '♃', abbr: 'Ju' },
  土星: { glyph: '♄', abbr: 'Sa' },
  天王星: { glyph: '♅', abbr: 'Ur' },
  海王星: { glyph: '♆', abbr: 'Ne' },
  冥王星: { glyph: '♇', abbr: 'Pl' },
  北交點: { glyph: '☊', abbr: 'NN' },
  南交點: { glyph: '☋', abbr: 'SN' },
  凱龍星: { glyph: '⚷', abbr: 'Ch' },
  黑月莉莉絲: { glyph: '⚸', abbr: 'Li' },
  穀神星: { glyph: '⚳', abbr: 'Ce' },
  智神星: { glyph: '⚴', abbr: 'Pa' },
  婚神星: { glyph: '⚵', abbr: 'Jn' },
  灶神星: { glyph: '⚶', abbr: 'Vs' },
  // 福點沒有專屬碼位，⊗ 是占星界通用的替代寫法
  福點: { glyph: '⊗', abbr: 'Fo' },
  // Vertex 沒有通行字符，直接用縮寫
  Vertex: { glyph: '', abbr: 'Vx' },
  // 四軸傳統上就以文字標示，不用字符
  上升點: { glyph: '', abbr: 'ASC', axis: true },
  下降點: { glyph: '', abbr: 'DSC', axis: true },
  天頂: { glyph: '', abbr: 'MC', axis: true },
  天底: { glyph: '', abbr: 'IC', axis: true },
};

// 畫在盤面上的十顆主星（相位線只取這些之間的主相位，否則線會多到看不清）
export const MAIN_TEN = ['太陽', '月亮', '水星', '金星', '火星', '木星', '土星', '天王星', '海王星', '冥王星'];
