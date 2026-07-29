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
  // 鬥神星（Eris）的占星字符 U+2BF0 在 2016 年才進 Unicode，支援度比 ⚳–⚶ 更差，
  // 幾乎一定會退回縮寫——留著字符是為了字型追上的那天。
  鬥神星: { glyph: '⯰', abbr: 'Er' },
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

// 十顆主星。盤面上這十顆的相位線畫得比較實，其餘點位的線畫細畫淡，
// 這樣一眼看到的是主結構，放大之後才去讀細節。
export const MAIN_TEN = ['太陽', '月亮', '水星', '金星', '火星', '木星', '土星', '天王星', '海王星', '冥王星'];

// 四軸裡只有上升點與天頂參與相位：下降點與天底永遠是它們的 180° 對點，
// 畫出來會是同一條線疊兩次（後端的 aspect_bodies 也是同樣的理由排除它們）。
export const ASPECT_AXES = ['上升點', '天頂'];

// 相位對照表。鍵是精確角度（與 api/astro.py 的 MAJOR_ASPECTS／MINOR_ASPECTS 一致），
// 用角度當鍵而不是用後端回傳的中文名，這樣四語系可以各自翻譯而不必比對字串。
//
// tone：warm＝金（和諧向），cool＝藍灰（張力向），key＝合相（最強，單獨一色）。
// dash：線型。不只靠顏色區分——顏色相近的兩種相位（三分／六分）另外用虛實分開，
// 色弱的人與黑白列印都還讀得出來。
// glyph 缺字時退回 abbr，判斷方式與點位符號共用同一套點陣偵測。
export const ASPECT_META = {
  0: { glyph: '☌', abbr: 'Cnj', major: true, tone: 'key', dash: '' },
  60: { glyph: '⚹', abbr: 'Sxt', major: true, tone: 'warm', dash: '5 3' },
  90: { glyph: '□', abbr: 'Sqr', major: true, tone: 'cool', dash: '' },
  120: { glyph: '△', abbr: 'Tri', major: true, tone: 'warm', dash: '' },
  180: { glyph: '☍', abbr: 'Opp', major: true, tone: 'cool', dash: '' },
  30: { glyph: '⚺', abbr: 'SSx', major: false, tone: 'warm', dash: '1 3' },
  45: { glyph: '∠', abbr: 'SSq', major: false, tone: 'cool', dash: '1 3' },
  // 五分相與雙五分相沒有通行的 Unicode 碼位，直接用縮寫
  72: { glyph: '', abbr: 'Qui', major: false, tone: 'warm', dash: '1 3' },
  135: { glyph: '⚼', abbr: 'Ssq', major: false, tone: 'cool', dash: '1 3' },
  144: { glyph: '', abbr: 'bQu', major: false, tone: 'warm', dash: '1 3' },
  150: { glyph: '⚻', abbr: 'Qcx', major: false, tone: 'cool', dash: '1 3' },
};

// 相位圖例與說明的排列順序（主相位由強到弱，再接次要相位）
export const ASPECT_ORDER = [0, 180, 90, 120, 60, 30, 45, 135, 150, 72, 144];
