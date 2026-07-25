// profile.js — 把使用者的出生資料記在瀏覽器，下次占星時自動帶入。
//
// 為什麼用 localStorage 而不是 cookie：出生資料不需要、也不應該隨每個 HTTP
// 請求送到伺服器；localStorage 純留在使用者自己的裝置上，換裝置或清除瀏覽
// 資料就沒有，符合「只是省去重複輸入」的目的。
//
// 存的內容＝重現表單所需的最小集合：日期、時間、時間是否不確定、城市與國家
// 的輸入字樣，以及使用者從清單選定的地點（含經緯度與時區，讓下次可直接計算）。

const KEY = 'inquiry_birth_v1';

export function loadBirthProfile() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || p.version !== 1 || !p.date) return null;
    return p;
  } catch {
    return null;
  }
}

export function saveBirthProfile({ date, time, timeUnknown, city, country, place }) {
  if (!date) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      date: String(date),
      time: timeUnknown ? '' : String(time || ''),
      timeUnknown: !!timeUnknown,
      city: String(city || ''),
      country: String(country || ''),
      // 只留計算需要的欄位，不整包塞進來
      place: place ? {
        name: place.name || '',
        country: place.country || '',
        countryCode: place.countryCode || '',
        admin1: place.admin1 || '',
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: place.timezone,
      } : null,
    }));
  } catch { /* 配額或隱私模式：略過即可，不影響流程 */ }
}

export function clearBirthProfile() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
