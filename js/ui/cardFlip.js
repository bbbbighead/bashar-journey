// cardFlip.js — v2：重用 3D 翻牌動畫呈現「沿路拾得」的訊息卡。
// 去識別卡面：正面只有三角光紋（無 BASHAR 字樣），翻面置中顯示卡名——不顯示原文、不標來源。

const TRI = '<div class="tri"><div class="glow"></div><div class="dark"></div><div class="spark"></div></div>';
const TRI_SM = '<div class="tri sm"><div class="glow"></div><div class="dark"></div><div class="spark"></div></div>';

// 在 container 內建立一張拾得卡並翻面。回傳翻牌完成的 Promise。
export function renderCollectCard(container, card) {
  container.innerHTML = `
    <div class="card-scene collect-scene" style="display:block;margin:0 auto">
      <div class="card">
        <div class="face front">
          <div class="bb lg">${TRI}</div>
        </div>
        <div class="face back collect-back">
          <div class="card-num">${TRI_SM}</div>
          <div class="collect-title"></div>
          <div class="sign">✦</div>
        </div>
      </div>
    </div>`;
  const cardEl = container.querySelector('.card');
  container.querySelector('.collect-title').textContent = card.title;

  return new Promise((resolve) => {
    setTimeout(() => cardEl.classList.add('flipped'), 140);
    setTimeout(resolve, 1100);
  });
}
