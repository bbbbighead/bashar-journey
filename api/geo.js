// api/geo.js — 回報請求來源的國家代碼，供語系偵測在「瀏覽器語言無法判斷」時補救。
// 只回傳兩字母國碼，不記錄、不儲存任何內容（IP 本身不寫入任何地方）。
export default function handler(req, res) {
  const country = req.headers['x-vercel-ip-country']
    || req.headers['cf-ipcountry']
    || '';
  res.setHeader('cache-control', 'no-store');
  res.status(200).json({ country: String(country).toUpperCase().slice(0, 2) });
}
