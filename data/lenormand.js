// lenormand.js — 雷諾曼 36 張牌的內部詮釋資料。
// 僅供整合引擎（AI 或離線模板）內部參考；牌名與任何占卜術語絕不顯示給使用者。
//
// 欄位說明：
//   id       傳統編號 1–36
//   name     牌名（內部用）
//   keys     核心關鍵字（內部用，也供離線模板拼接語意）
//   meaning  一到兩句的內部詮釋（不含吉凶斷語，聚焦「模式」而非「預言」）
//   cluster  主題群集，供離線降級時統計收斂主題：
//            movement 變動與啟程 / stability 穩定與根基 / connection 關係與歸屬
//            communication 溝通與訊息 / challenge 阻礙與壓力 / ending 結束與釋放
//            renewal 轉化與新生 / emotion 情感與渴望 / effort 努力與經營 / insight 洞察與釐清

export const LENORMAND = [
  { id: 1,  name: '騎士', keys: ['消息', '行動', '到來'],       cluster: 'movement',      meaning: '某件事正在朝當事人移動——新的訊息、機會或人。重點不在等待，而在是否準備好接住正在靠近的東西。' },
  { id: 2,  name: '三葉草', keys: ['小確幸', '轉機', '輕盈'],   cluster: 'renewal',       meaning: '短暫而輕巧的好轉。提醒當事人：改變不一定以巨大事件出現，小的鬆動也值得被看見。' },
  { id: 3,  name: '船', keys: ['遠行', '探索', '離開熟悉'],     cluster: 'movement',      meaning: '朝未知移動的渴望或必要。與「留下或出發」的內在拉扯有關，也指向透過距離獲得的視野。' },
  { id: 4,  name: '房屋', keys: ['家', '安全感', '基地'],       cluster: 'stability',     meaning: '安全感的來源與邊界。當事人與「家」（實體或心理上的）之間的關係——是庇護，還是圍牆。' },
  { id: 5,  name: '樹', keys: ['健康', '緩慢生長', '根'],       cluster: 'stability',     meaning: '需要時間的事物：健康、深層習慣、家族根源。提醒以年為單位思考，而非以天。' },
  { id: 6,  name: '雲', keys: ['混沌', '不確定', '看不清'],     cluster: 'challenge',     meaning: '思緒或處境的迷霧。困住當事人的往往不是事實，而是尚未釐清的認知；霧會散，但需要停下來等視線恢復。' },
  { id: 7,  name: '蛇', keys: ['迂迴', '慾望', '潛藏的複雜'],   cluster: 'challenge',     meaning: '事情比表面更迂迴——可能是他人的動機，也可能是當事人自己不願直視的慾望或嫉妒。' },
  { id: 8,  name: '棺材', keys: ['結束', '放下', '告一段落'],   cluster: 'ending',        meaning: '某件事已經完結，只是當事人可能還握著不放。哀悼是必要的，但棺材的本質是「讓結束真正結束」。' },
  { id: 9,  name: '花束', keys: ['禮物', '被欣賞', '美好'],     cluster: 'emotion',       meaning: '被給予、被欣賞的經驗。也問：當事人允不允許自己接受好意，而不急著回報或懷疑。' },
  { id: 10, name: '鐮刀', keys: ['切斷', '果決', '突然'],       cluster: 'ending',        meaning: '需要一刀兩斷的時刻。拖延的切割會鈍化成長期消耗；這張牌問的是「你在等誰替你動手」。' },
  { id: 11, name: '鞭子', keys: ['重複', '衝突', '自我鞭策'],   cluster: 'challenge',     meaning: '反覆發生的摩擦或自我苛責的迴圈。指向「同樣的爭執、同樣的自責為何一再重演」。' },
  { id: 12, name: '鳥', keys: ['焦慮', '碎語', '過度討論'],     cluster: 'communication', meaning: '心裡的嘈雜：反覆盤算、與人議論、停不下來的內在對話。聲音很多，但未必有一句來自安靜的自己。' },
  { id: 13, name: '孩子', keys: ['新開始', '天真', '稚嫩'],     cluster: 'renewal',       meaning: '某個剛萌芽、還很小的東西——新的嘗試、新的自我。需要的是保護與耐心，而不是立刻證明價值。' },
  { id: 14, name: '狐狸', keys: ['警覺', '生存策略', '不信任'], cluster: 'challenge',     meaning: '聰明的自保。當事人可能正用高度警覺在應對環境——有效，但也孤立；問題是這份警覺還適不適用。' },
  { id: 15, name: '熊', keys: ['力量', '資源', '權威'],         cluster: 'effort',        meaning: '力量與資源的課題：財務、上司、或自己內在的權威。是被力量保護，還是被力量壓住。' },
  { id: 16, name: '星星', keys: ['方向', '希望', '長期願景'],   cluster: 'insight',       meaning: '遠方的定向點。當事人也許看不清腳下，但仍有可辨認的北極星——價值感、願景、真正在乎的事。' },
  { id: 17, name: '鸛鳥', keys: ['遷移', '改變', '週期'],       cluster: 'movement',      meaning: '正在發生的遷移與改變，往往是漸進而非戲劇性的。舊巢已不合身，新巢正在成形。' },
  { id: 18, name: '狗', keys: ['忠誠', '朋友', '可靠'],         cluster: 'connection',    meaning: '可以信任的關係與支持。也問：當事人是否允許別人幫忙，還是習慣獨自扛。' },
  { id: 19, name: '塔', keys: ['孤高', '體制', '距離感'],       cluster: 'challenge',     meaning: '結構、體制、或自我隔離的高處。看得遠但碰不到人；與「用距離換安全」的慣性有關。' },
  { id: 20, name: '花園', keys: ['人群', '社交', '公開'],       cluster: 'connection',    meaning: '公共領域與人際網絡。當事人如何在群體中現身——渴望被看見，或害怕被看見。' },
  { id: 21, name: '山', keys: ['阻礙', '延遲', '沉重'],         cluster: 'challenge',     meaning: '巨大而不可繞過的阻礙。山不會移動，能移動的是路線與節奏；硬撞只會耗損。' },
  { id: 22, name: '道路', keys: ['選擇', '岔路', '自主'],       cluster: 'insight',       meaning: '站在岔路口。重點通常不是哪條路「正確」，而是當事人是否承認自己其實有選擇。' },
  { id: 23, name: '老鼠', keys: ['消耗', '侵蝕', '流失'],       cluster: 'challenge',     meaning: '緩慢的損耗：精力、存款、耐心被一點點啃掉。單一事件不致命，累積起來卻掏空人。' },
  { id: 24, name: '心', keys: ['情感', '愛', '柔軟'],           cluster: 'emotion',       meaning: '情感的核心。當事人真正的感受可能比他敘述的更柔軟、更受傷、也更渴望。' },
  { id: 25, name: '戒指', keys: ['承諾', '約定', '循環'],       cluster: 'connection',    meaning: '承諾與約定——對人、對組織、對自己。戒指也是循環：同一份約定，是連結還是套牢。' },
  { id: 26, name: '書', keys: ['未知', '學習', '尚未揭露'],     cluster: 'insight',       meaning: '還沒被打開的知識或真相。有些答案不是想出來的，是學來的、或等時間翻頁才看得到。' },
  { id: 27, name: '信', keys: ['訊息', '表達', '文字'],         cluster: 'communication', meaning: '需要被說出口或寫下來的東西。未表達的訊息在心裡發酵；表達本身就是移動。' },
  { id: 28, name: '男人', keys: ['行動者', '陽性能量', '主動'], cluster: 'emotion',       meaning: '主動、決斷、向外的能量面向——可能是當事人自己，也可能是身邊重要的人。' },
  { id: 29, name: '女人', keys: ['涵容者', '陰性能量', '接納'], cluster: 'emotion',       meaning: '接納、涵容、向內的能量面向——可能是當事人自己，也可能是身邊重要的人。' },
  { id: 30, name: '百合', keys: ['平靜', '成熟', '餘裕'],       cluster: 'stability',     meaning: '成熟後的安靜與餘裕。不是激情的反面，而是經過時間沉澱的清明；也指向長輩或資深者的智慧。' },
  { id: 31, name: '太陽', keys: ['生命力', '清晰', '成功'],     cluster: 'renewal',       meaning: '能量回升、事情變得清楚。太陽不解決問題，它只是讓一切被看見——包括原本就存在的資源。' },
  { id: 32, name: '月亮', keys: ['情緒潮汐', '直覺', '被認可'], cluster: 'emotion',       meaning: '情緒的潮汐與直覺的語言。也與「渴望被認可」有關：月光是反射的光，總在意別人怎麼看。' },
  { id: 33, name: '鑰匙', keys: ['解方', '確定', '打開'],       cluster: 'insight',       meaning: '解方已經存在，而且通常比想像中近。鑰匙的暗示是：門是鎖著的，不是不存在的。' },
  { id: 34, name: '魚', keys: ['流動', '豐盛', '多線並行'],     cluster: 'effort',        meaning: '資源與機會的流動。豐盛的前提是允許流動——抓太緊的手，接不住新的東西。' },
  { id: 35, name: '錨', keys: ['扎根', '堅持', '停泊'],         cluster: 'stability',     meaning: '穩定下來的力量：長期的工作、堅持的習慣。但錨也會變成不敢起航的藉口——穩定與擱淺一線之隔。' },
  { id: 36, name: '十字', keys: ['重擔', '信念考驗', '意義'],   cluster: 'ending',        meaning: '沉重但帶著意義的負荷。當事人扛著的東西也許不必扛一輩子；受苦若無意義，就只是習慣。' },
];

// 主題群集的中文語意（供離線模板將統計結果轉成自然語句）
export const CLUSTER_MEANING = {
  movement:      { label: '變動與啟程', sentence: '有些事正在移動——不論你是否準備好，停留原地的成本正在升高' },
  stability:     { label: '穩定與根基', sentence: '你在尋找（或守護）一份可以扎根的穩定，而它需要時間，不是意志力' },
  connection:    { label: '關係與歸屬', sentence: '這件事的核心繞著人與歸屬打轉——誰在你身邊、你允許誰靠近' },
  communication: { label: '溝通與訊息', sentence: '有話還沒說出口，或者心裡的聲音太多、太吵，蓋過了你自己的' },
  challenge:     { label: '阻礙與消耗', sentence: '你正在面對真實的阻力，其中一部分來自外界，另一部分來自你應對它的慣性' },
  ending:        { label: '結束與釋放', sentence: '有些東西已經完結，等著被承認、被放下——結束不是失敗，是騰出位置' },
  renewal:       { label: '轉化與新生', sentence: '有個還很小的新東西正在萌芽，它需要保護與耐心，而不是立刻證明自己' },
  emotion:       { label: '情感與渴望', sentence: '在所有理性的分析底下，這件事真正的引擎是感受——被愛、被看見、被認可的渴望' },
  effort:        { label: '努力與資源', sentence: '這是一個關於力量與資源怎麼配置的課題——你的力氣值得花在能生長的地方' },
  insight:       { label: '洞察與釐清', sentence: '你需要的不是更多努力，而是更清楚的看見——看清之後，選擇會自己浮現' },
};

// 九宮格位置語義（3×3）：
// 欄 = 時間軸（左：成因與過去 / 中：現在 / 右：走向與趨勢）
// 列 = 意識層（上：想法與意識 / 中：現實與核心 / 下：潛意識與根基）
// 正中央（idx 4）= 全局核心影響
export const GRID_POSITIONS = [
  { idx: 0, time: 'past',    layer: 'mind',   label: '過去的想法／舊有認知' },
  { idx: 1, time: 'present', layer: 'mind',   label: '現在的想法／意識焦點' },
  { idx: 2, time: 'future',  layer: 'mind',   label: '思緒的走向／醞釀中的認知' },
  { idx: 3, time: 'past',    layer: 'core',   label: '事情的成因／帶來的經驗' },
  { idx: 4, time: 'present', layer: 'core',   label: '全局核心／此刻的中心影響' },
  { idx: 5, time: 'future',  layer: 'core',   label: '現實的趨勢／正在成形的發展' },
  { idx: 6, time: 'past',    layer: 'root',   label: '底層的舊習慣／未察覺的基礎' },
  { idx: 7, time: 'present', layer: 'root',   label: '潛意識的暗流／未說出口的感受' },
  { idx: 8, time: 'future',  layer: 'root',   label: '深層的醞釀／即將浮上來的東西' },
];
