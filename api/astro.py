# api/astro.py — 西洋占星本命盤計算端點（Vercel Python serverless）。
#
# 鐵律：所有星體、宮位、軸線、相位一律由 Swiss Ephemeris 實算，AI 只做詮釋。
# 固定系統：熱帶黃道 / Placidus 宮制 / True Node / Mean Black Moon Lilith / 地心盤。
#
# 輸入（POST JSON）：
#   { date:'YYYY-MM-DD', time:'HH:MM'|null, timeUnknown:bool, city:str, country?:str }
# 輸出：{ ok:true, chart:{...} } 或 { ok:false, error:str }
#
# 出生時間不確定時：以當地正午計算行星星座位置，並明確標示
# 上升/天頂/宮位/福點/Vertex/月亮精確度數不可靠（不輸出宮位資料）。
#
# 地點解析：Open-Meteo 免費 geocoding（回傳經緯度與 IANA 時區）；
# 歷史日光節約時間由 zoneinfo 的 IANA 資料庫處理。出生資料僅用於計算，不儲存。

from http.server import BaseHTTPRequestHandler
import json
import math
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

import swisseph as swe

# 星曆檔目錄：多候選解析（部署環境的打包根目錄不一定等於 repo 根目錄）。
# 以 seas_18.se1（主小行星檔：凱龍/穀神/智神/婚神/灶神）驗證是否真的找得到——
# 行星在檔案缺失時會退回內建 Moshier 理論、不會報錯，小行星則會整批計算失敗。
_HERE = os.path.dirname(os.path.abspath(__file__))
_EPHE_CANDIDATES = [
    os.path.join(_HERE, 'ephe'),           # api/ephe（隨函式打包，部署主路徑）
    os.path.join(_HERE, '..', 'ephe'),     # repo 根目錄 ephe/（本地/舊佈局）
    os.path.join(os.getcwd(), 'api', 'ephe'),
    os.path.join(os.getcwd(), 'ephe'),
]
EPHE_PATH = next(
    (p for p in _EPHE_CANDIDATES if os.path.isfile(os.path.join(p, 'seas_18.se1'))),
    _EPHE_CANDIDATES[0],
)
EPHE_OK = os.path.isfile(os.path.join(EPHE_PATH, 'seas_18.se1'))
swe.set_ephe_path(EPHE_PATH)

SIGNS = ['牡羊座', '金牛座', '雙子座', '巨蟹座', '獅子座', '處女座',
         '天秤座', '天蠍座', '射手座', '摩羯座', '水瓶座', '雙魚座']
ELEMENTS = ['火', '土', '風', '水']            # sign_idx % 4
MODES = ['基本', '固定', '變動']               # sign_idx % 3
TRAD_RULERS = ['火星', '金星', '水星', '月亮', '太陽', '水星',
               '金星', '火星', '木星', '土星', '土星', '木星']
MODERN_CO = {7: '冥王星', 10: '天王星', 11: '海王星'}  # 天蠍/水瓶/雙魚

PLANET_IDS = [
    (swe.SUN, '太陽'), (swe.MOON, '月亮'), (swe.MERCURY, '水星'),
    (swe.VENUS, '金星'), (swe.MARS, '火星'), (swe.JUPITER, '木星'),
    (swe.SATURN, '土星'), (swe.URANUS, '天王星'), (swe.NEPTUNE, '海王星'),
    (swe.PLUTO, '冥王星'),
]
EXTRA_IDS = [
    (swe.TRUE_NODE, '北交點'), (swe.CHIRON, '凱龍星'), (swe.MEAN_APOG, '黑月莉莉絲'),
    (swe.CERES, '穀神星'), (swe.PALLAS, '智神星'), (swe.JUNO, '婚神星'), (swe.VESTA, '灶神星'),
]
TEN = [n for _, n in PLANET_IDS]
LUMINARIES = {'太陽', '月亮'}
ANGLE_NAMES = {'上升點', '下降點', '天頂', '天底'}
MINOR_BODIES = {'凱龍星', '黑月莉莉絲', '穀神星', '智神星', '婚神星', '灶神星', '北交點', '南交點', '福點', 'Vertex'}

MAJOR_ASPECTS = [(0, '合相'), (60, '六分相'), (90, '四分相'), (120, '三分相'), (180, '對分相')]
MINOR_ASPECTS = [(30, '半六分相'), (45, '半四分相'), (72, '五分相'),
                 (135, '補八分相'), (144, '雙五分相'), (150, '梅花相')]

# 入廟/擢升（傳統，供強弱判斷參考）
DIGNITY = {
    '太陽': {'domicile': [4], 'exalt': [0], 'detriment': [10], 'fall': [6]},
    '月亮': {'domicile': [3], 'exalt': [1], 'detriment': [9], 'fall': [7]},
    '水星': {'domicile': [2, 5], 'exalt': [5], 'detriment': [8, 11], 'fall': [11]},
    '金星': {'domicile': [1, 6], 'exalt': [11], 'detriment': [7, 0], 'fall': [5]},
    '火星': {'domicile': [0, 7], 'exalt': [9], 'detriment': [6, 1], 'fall': [3]},
    '木星': {'domicile': [8, 11], 'exalt': [3], 'detriment': [2, 5], 'fall': [9]},
    '土星': {'domicile': [9, 10], 'exalt': [6], 'detriment': [3, 4], 'fall': [0]},
}


def norm(x):
    return x % 360.0


def angdiff(a, b):
    """兩黃經的最小夾角 0–180"""
    d = abs(norm(a) - norm(b)) % 360.0
    return d if d <= 180 else 360 - d


def fmt_pos(lon):
    lon = norm(lon)
    sign_idx = int(lon // 30)
    within = lon - sign_idx * 30
    d = int(within)
    m_f = (within - d) * 60
    m = int(m_f)
    s = int(round((m_f - m) * 60))
    if s == 60:
        s = 0
        m += 1
    if m == 60:
        m = 0
        d += 1
    return sign_idx, f"{SIGNS[sign_idx]} {d}°{m:02d}′{s:02d}″"


# 一級行政區／主要城市對照表（顯示名一律繁體中文；日韓保留當地文字並附漢字別名）。
# 為什麼需要這張表：上游 geocoder（Open-Meteo／GeoNames）的中文索引對臺灣等地並不完整，
# 且以簡體中文回傳。本表讓所有支援語系的縣市級地名都查得到、且顯示為繁體，並可離線運作。
# 欄位：(顯示名, [別名], 英文名, 國碼, 國名, 緯度, 經度, IANA 時區)
PLACES = [
    ('臺北市', ['台北市', '臺北', '台北'], 'Taipei', 'TW', '臺灣', 25.033, 121.5654, 'Asia/Taipei'),
    ('新北市', ['新北', '板橋', '板橋區'], 'New Taipei', 'TW', '臺灣', 25.0143, 121.4672, 'Asia/Taipei'),
    ('基隆市', ['基隆'], 'Keelung', 'TW', '臺灣', 25.1276, 121.7392, 'Asia/Taipei'),
    ('桃園市', ['桃園', '桃園區', '桃園縣'], 'Taoyuan', 'TW', '臺灣', 24.9937, 121.3009, 'Asia/Taipei'),
    ('新竹市', ['新竹'], 'Hsinchu', 'TW', '臺灣', 24.8138, 120.9675, 'Asia/Taipei'),
    ('新竹縣', ['竹北', '竹北市'], 'Hsinchu County', 'TW', '臺灣', 24.8387, 121.0177, 'Asia/Taipei'),
    ('苗栗縣', ['苗栗', '苗栗市'], 'Miaoli', 'TW', '臺灣', 24.5602, 120.8214, 'Asia/Taipei'),
    ('臺中市', ['台中市', '臺中', '台中'], 'Taichung', 'TW', '臺灣', 24.1477, 120.6736, 'Asia/Taipei'),
    ('彰化縣', ['彰化', '彰化市'], 'Changhua', 'TW', '臺灣', 24.0518, 120.5161, 'Asia/Taipei'),
    ('南投縣', ['南投', '南投市'], 'Nantou', 'TW', '臺灣', 23.9609, 120.9719, 'Asia/Taipei'),
    ('雲林縣', ['雲林', '斗六', '斗六市'], 'Yunlin', 'TW', '臺灣', 23.7092, 120.543, 'Asia/Taipei'),
    ('嘉義市', ['嘉義'], 'Chiayi', 'TW', '臺灣', 23.4801, 120.4491, 'Asia/Taipei'),
    ('嘉義縣', ['太保', '太保市'], 'Chiayi County', 'TW', '臺灣', 23.4595, 120.3325, 'Asia/Taipei'),
    ('臺南市', ['台南市', '臺南', '台南'], 'Tainan', 'TW', '臺灣', 22.9999, 120.2269, 'Asia/Taipei'),
    ('高雄市', ['高雄'], 'Kaohsiung', 'TW', '臺灣', 22.6273, 120.3014, 'Asia/Taipei'),
    ('屏東縣', ['屏東', '屏東市'], 'Pingtung', 'TW', '臺灣', 22.5519, 120.5487, 'Asia/Taipei'),
    ('宜蘭縣', ['宜蘭', '宜蘭市'], 'Yilan', 'TW', '臺灣', 24.7021, 121.7378, 'Asia/Taipei'),
    ('花蓮縣', ['花蓮', '花蓮市'], 'Hualien', 'TW', '臺灣', 23.9871, 121.6015, 'Asia/Taipei'),
    ('臺東縣', ['台東縣', '臺東', '台東', '臺東市'], 'Taitung', 'TW', '臺灣', 22.7583, 121.1444, 'Asia/Taipei'),
    ('澎湖縣', ['澎湖', '馬公', '馬公市'], 'Penghu', 'TW', '臺灣', 23.5712, 119.5793, 'Asia/Taipei'),
    ('金門縣', ['金門', '金城', '金城鎮'], 'Kinmen', 'TW', '臺灣', 24.4321, 118.3171, 'Asia/Taipei'),
    ('連江縣', ['連江', '馬祖', '南竿', '南竿鄉'], 'Lienchiang', 'TW', '臺灣', 26.1608, 119.9509, 'Asia/Taipei'),
    ('三重', ['三重區'], 'Sanchong', 'TW', '臺灣', 25.0614, 121.4877, 'Asia/Taipei'),
    ('中和', ['中和區'], 'Zhonghe', 'TW', '臺灣', 24.9993, 121.4989, 'Asia/Taipei'),
    ('永和', ['永和區'], 'Yonghe', 'TW', '臺灣', 25.0078, 121.5158, 'Asia/Taipei'),
    ('新莊', ['新莊區'], 'Xinzhuang', 'TW', '臺灣', 25.0359, 121.4324, 'Asia/Taipei'),
    ('新店', ['新店區'], 'Xindian', 'TW', '臺灣', 24.9678, 121.5417, 'Asia/Taipei'),
    ('淡水', ['淡水區'], 'Tamsui', 'TW', '臺灣', 25.1677, 121.4406, 'Asia/Taipei'),
    ('中壢', ['中壢區'], 'Zhongli', 'TW', '臺灣', 24.9537, 121.2255, 'Asia/Taipei'),
    ('鳳山', ['鳳山區'], 'Fengshan', 'TW', '臺灣', 22.6272, 120.362, 'Asia/Taipei'),
    ('豐原', ['豐原區'], 'Fengyuan', 'TW', '臺灣', 24.2521, 120.7183, 'Asia/Taipei'),
    ('北海道', ['札幌', '札幌市', 'ほっかいどう'], 'Hokkaido', 'JP', '日本', 43.0642, 141.3469, 'Asia/Tokyo'),
    ('青森県', ['青森', '青森市'], 'Aomori', 'JP', '日本', 40.8244, 140.74, 'Asia/Tokyo'),
    ('岩手県', ['岩手', '盛岡', '盛岡市'], 'Iwate', 'JP', '日本', 39.7036, 141.1527, 'Asia/Tokyo'),
    ('宮城県', ['宮城', '仙台', '仙台市'], 'Miyagi', 'JP', '日本', 38.2688, 140.8721, 'Asia/Tokyo'),
    ('秋田県', ['秋田', '秋田市'], 'Akita', 'JP', '日本', 39.7186, 140.1024, 'Asia/Tokyo'),
    ('山形県', ['山形', '山形市'], 'Yamagata', 'JP', '日本', 38.2404, 140.3633, 'Asia/Tokyo'),
    ('福島県', ['福島', '福島市'], 'Fukushima', 'JP', '日本', 37.7503, 140.4676, 'Asia/Tokyo'),
    ('茨城県', ['茨城', '水戸', '水戸市'], 'Ibaraki', 'JP', '日本', 36.3418, 140.4468, 'Asia/Tokyo'),
    ('栃木県', ['栃木', '宇都宮', '宇都宮市'], 'Tochigi', 'JP', '日本', 36.5657, 139.8836, 'Asia/Tokyo'),
    ('群馬県', ['群馬', '前橋', '前橋市'], 'Gunma', 'JP', '日本', 36.3907, 139.0604, 'Asia/Tokyo'),
    ('埼玉県', ['埼玉', 'さいたま', 'さいたま市'], 'Saitama', 'JP', '日本', 35.857, 139.6489, 'Asia/Tokyo'),
    ('千葉県', ['千葉', '千葉市'], 'Chiba', 'JP', '日本', 35.6051, 140.1233, 'Asia/Tokyo'),
    ('東京都', ['東京', 'とうきょう'], 'Tokyo', 'JP', '日本', 35.6895, 139.6917, 'Asia/Tokyo'),
    ('神奈川県', ['神奈川', '横浜', '横浜市', '川崎'], 'Kanagawa', 'JP', '日本', 35.4478, 139.6425, 'Asia/Tokyo'),
    ('新潟県', ['新潟', '新潟市'], 'Niigata', 'JP', '日本', 37.9026, 139.0233, 'Asia/Tokyo'),
    ('富山県', ['富山', '富山市'], 'Toyama', 'JP', '日本', 36.6953, 137.2113, 'Asia/Tokyo'),
    ('石川県', ['石川', '金沢', '金沢市'], 'Ishikawa', 'JP', '日本', 36.5947, 136.6256, 'Asia/Tokyo'),
    ('福井県', ['福井', '福井市'], 'Fukui', 'JP', '日本', 36.0652, 136.2216, 'Asia/Tokyo'),
    ('山梨県', ['山梨', '甲府', '甲府市'], 'Yamanashi', 'JP', '日本', 35.6642, 138.5684, 'Asia/Tokyo'),
    ('長野県', ['長野', '長野市'], 'Nagano', 'JP', '日本', 36.6513, 138.181, 'Asia/Tokyo'),
    ('岐阜県', ['岐阜', '岐阜市'], 'Gifu', 'JP', '日本', 35.3912, 136.7223, 'Asia/Tokyo'),
    ('静岡県', ['静岡', '静岡市'], 'Shizuoka', 'JP', '日本', 34.9769, 138.3831, 'Asia/Tokyo'),
    ('愛知県', ['愛知', '名古屋', '名古屋市'], 'Aichi', 'JP', '日本', 35.1802, 136.9066, 'Asia/Tokyo'),
    ('三重県', ['三重', '津市'], 'Mie', 'JP', '日本', 34.7303, 136.5086, 'Asia/Tokyo'),
    ('滋賀県', ['滋賀', '大津', '大津市'], 'Shiga', 'JP', '日本', 35.0045, 135.8686, 'Asia/Tokyo'),
    ('京都府', ['京都', '京都市'], 'Kyoto', 'JP', '日本', 35.0116, 135.7681, 'Asia/Tokyo'),
    ('大阪府', ['大阪', '大阪市'], 'Osaka', 'JP', '日本', 34.6937, 135.5023, 'Asia/Tokyo'),
    ('兵庫県', ['兵庫', '神戸', '神戸市'], 'Hyogo', 'JP', '日本', 34.6913, 135.183, 'Asia/Tokyo'),
    ('奈良県', ['奈良', '奈良市'], 'Nara', 'JP', '日本', 34.6851, 135.8048, 'Asia/Tokyo'),
    ('和歌山県', ['和歌山', '和歌山市'], 'Wakayama', 'JP', '日本', 34.226, 135.1675, 'Asia/Tokyo'),
    ('鳥取県', ['鳥取', '鳥取市'], 'Tottori', 'JP', '日本', 35.5039, 134.238, 'Asia/Tokyo'),
    ('島根県', ['島根', '松江', '松江市'], 'Shimane', 'JP', '日本', 35.4723, 133.0505, 'Asia/Tokyo'),
    ('岡山県', ['岡山', '岡山市'], 'Okayama', 'JP', '日本', 34.6618, 133.935, 'Asia/Tokyo'),
    ('広島県', ['広島', '広島市', '廣島'], 'Hiroshima', 'JP', '日本', 34.3853, 132.4553, 'Asia/Tokyo'),
    ('山口県', ['山口', '山口市'], 'Yamaguchi', 'JP', '日本', 34.1859, 131.4714, 'Asia/Tokyo'),
    ('徳島県', ['徳島', '徳島市'], 'Tokushima', 'JP', '日本', 34.0658, 134.5593, 'Asia/Tokyo'),
    ('香川県', ['香川', '高松', '高松市'], 'Kagawa', 'JP', '日本', 34.3401, 134.0434, 'Asia/Tokyo'),
    ('愛媛県', ['愛媛', '松山', '松山市'], 'Ehime', 'JP', '日本', 33.8416, 132.7657, 'Asia/Tokyo'),
    ('高知県', ['高知', '高知市'], 'Kochi', 'JP', '日本', 33.5597, 133.5311, 'Asia/Tokyo'),
    ('福岡県', ['福岡', '福岡市'], 'Fukuoka', 'JP', '日本', 33.5904, 130.4017, 'Asia/Tokyo'),
    ('佐賀県', ['佐賀', '佐賀市'], 'Saga', 'JP', '日本', 33.2494, 130.2988, 'Asia/Tokyo'),
    ('長崎県', ['長崎', '長崎市'], 'Nagasaki', 'JP', '日本', 32.7448, 129.8737, 'Asia/Tokyo'),
    ('熊本県', ['熊本', '熊本市'], 'Kumamoto', 'JP', '日本', 32.8032, 130.7079, 'Asia/Tokyo'),
    ('大分県', ['大分', '大分市'], 'Oita', 'JP', '日本', 33.2382, 131.6126, 'Asia/Tokyo'),
    ('宮崎県', ['宮崎', '宮崎市'], 'Miyazaki', 'JP', '日本', 31.9077, 131.4202, 'Asia/Tokyo'),
    ('鹿児島県', ['鹿児島', '鹿児島市', '鹿兒島'], 'Kagoshima', 'JP', '日本', 31.5602, 130.5581, 'Asia/Tokyo'),
    ('沖縄県', ['沖縄', '那覇', '那覇市', '沖繩'], 'Okinawa', 'JP', '日本', 26.2124, 127.6809, 'Asia/Tokyo'),
    ('서울특별시', ['서울', '首爾', '서울시'], 'Seoul', 'KR', '韓國', 37.5665, 126.978, 'Asia/Seoul'),
    ('부산광역시', ['부산', '釜山'], 'Busan', 'KR', '韓國', 35.1796, 129.0756, 'Asia/Seoul'),
    ('대구광역시', ['대구', '大邱'], 'Daegu', 'KR', '韓國', 35.8714, 128.6014, 'Asia/Seoul'),
    ('인천광역시', ['인천', '仁川'], 'Incheon', 'KR', '韓國', 37.4563, 126.7052, 'Asia/Seoul'),
    ('광주광역시', ['광주', '光州'], 'Gwangju', 'KR', '韓國', 35.1595, 126.8526, 'Asia/Seoul'),
    ('대전광역시', ['대전', '大田'], 'Daejeon', 'KR', '韓國', 36.3504, 127.3845, 'Asia/Seoul'),
    ('울산광역시', ['울산', '蔚山'], 'Ulsan', 'KR', '韓國', 35.5384, 129.3114, 'Asia/Seoul'),
    ('세종특별자치시', ['세종', '世宗'], 'Sejong', 'KR', '韓國', 36.48, 127.289, 'Asia/Seoul'),
    ('경기도', ['경기', '수원', '水原', '京畿道'], 'Gyeonggi', 'KR', '韓國', 37.2636, 127.0286, 'Asia/Seoul'),
    ('강원특별자치도', ['강원', '춘천', '江原道'], 'Gangwon', 'KR', '韓國', 37.8813, 127.73, 'Asia/Seoul'),
    ('충청북도', ['충북', '청주', '忠清北道'], 'Chungbuk', 'KR', '韓國', 36.6424, 127.489, 'Asia/Seoul'),
    ('충청남도', ['충남', '홍성', '忠清南道'], 'Chungnam', 'KR', '韓國', 36.6009, 126.665, 'Asia/Seoul'),
    ('전북특별자치도', ['전북', '전주', '全州', '全羅北道'], 'Jeonbuk', 'KR', '韓國', 35.8242, 127.148, 'Asia/Seoul'),
    ('전라남도', ['전남', '무안', '全羅南道'], 'Jeonnam', 'KR', '韓國', 34.99, 126.481, 'Asia/Seoul'),
    ('경상북도', ['경북', '안동', '慶尚北道'], 'Gyeongbuk', 'KR', '韓國', 36.5684, 128.7294, 'Asia/Seoul'),
    ('경상남도', ['경남', '창원', '昌原', '慶尚南道'], 'Gyeongnam', 'KR', '韓國', 35.228, 128.6811, 'Asia/Seoul'),
    ('제주특별자치도', ['제주', '제주도', '濟州'], 'Jeju', 'KR', '韓國', 33.4996, 126.5312, 'Asia/Seoul'),
    ('阿拉巴馬州', ['Alabama', '蒙哥馬利', 'Montgomery'], 'Alabama', 'US', '美國', 32.3668, -86.3, 'America/Chicago'),
    ('阿拉斯加州', ['Alaska', '朱諾', 'Juneau', '安克拉治', 'Anchorage'], 'Alaska', 'US', '美國', 61.2181, -149.9003, 'America/Anchorage'),
    ('亞利桑那州', ['Arizona', '鳳凰城', 'Phoenix'], 'Arizona', 'US', '美國', 33.4484, -112.074, 'America/Phoenix'),
    ('阿肯色州', ['Arkansas', '小岩城', 'Little Rock'], 'Arkansas', 'US', '美國', 34.7465, -92.2896, 'America/Chicago'),
    ('加州', ['加利福尼亞州', 'California', '洛杉磯', 'Los Angeles'], 'California', 'US', '美國', 34.0522, -118.2437, 'America/Los_Angeles'),
    ('舊金山', ['San Francisco', '三藩市'], 'San Francisco', 'US', '美國', 37.7749, -122.4194, 'America/Los_Angeles'),
    ('聖地牙哥', ['San Diego'], 'San Diego', 'US', '美國', 32.7157, -117.1611, 'America/Los_Angeles'),
    ('聖荷西', ['San Jose'], 'San Jose', 'US', '美國', 37.3382, -121.8863, 'America/Los_Angeles'),
    ('科羅拉多州', ['Colorado', '丹佛', 'Denver'], 'Colorado', 'US', '美國', 39.7392, -104.9903, 'America/Denver'),
    ('康乃狄克州', ['Connecticut', '哈特福', 'Hartford'], 'Connecticut', 'US', '美國', 41.7658, -72.6734, 'America/New_York'),
    ('德拉瓦州', ['Delaware', '多佛', 'Dover'], 'Delaware', 'US', '美國', 39.1582, -75.5244, 'America/New_York'),
    ('佛羅里達州', ['Florida', '邁阿密', 'Miami', '奧蘭多', 'Orlando'], 'Florida', 'US', '美國', 25.7617, -80.1918, 'America/New_York'),
    ('喬治亞州', ['Georgia', '亞特蘭大', 'Atlanta'], 'Georgia', 'US', '美國', 33.749, -84.388, 'America/New_York'),
    ('夏威夷州', ['Hawaii', '檀香山', 'Honolulu'], 'Hawaii', 'US', '美國', 21.3069, -157.8583, 'Pacific/Honolulu'),
    ('愛達荷州', ['Idaho', '波夕', 'Boise'], 'Idaho', 'US', '美國', 43.615, -116.2023, 'America/Boise'),
    ('伊利諾州', ['Illinois', '芝加哥', 'Chicago'], 'Illinois', 'US', '美國', 41.8781, -87.6298, 'America/Chicago'),
    ('印第安納州', ['Indiana', '印第安納波利斯', 'Indianapolis'], 'Indiana', 'US', '美國', 39.7684, -86.1581, 'America/Indiana/Indianapolis'),
    ('愛荷華州', ['Iowa', '德梅因', 'Des Moines'], 'Iowa', 'US', '美國', 41.5868, -93.625, 'America/Chicago'),
    ('堪薩斯州', ['Kansas', '托皮卡', 'Topeka'], 'Kansas', 'US', '美國', 39.0473, -95.6752, 'America/Chicago'),
    ('肯塔基州', ['Kentucky', '法蘭克福', 'Frankfort', '路易維爾', 'Louisville'], 'Kentucky', 'US', '美國', 38.2527, -85.7585, 'America/Kentucky/Louisville'),
    ('路易斯安那州', ['Louisiana', '紐奧良', 'New Orleans'], 'Louisiana', 'US', '美國', 29.9511, -90.0715, 'America/Chicago'),
    ('緬因州', ['Maine', '奧古斯塔', 'Augusta', '波特蘭'], 'Maine', 'US', '美國', 43.6591, -70.2568, 'America/New_York'),
    ('馬里蘭州', ['Maryland', '巴爾的摩', 'Baltimore', '安納波利斯'], 'Maryland', 'US', '美國', 39.2904, -76.6122, 'America/New_York'),
    ('麻州', ['麻薩諸塞州', 'Massachusetts', '波士頓', 'Boston'], 'Massachusetts', 'US', '美國', 42.3601, -71.0589, 'America/New_York'),
    ('密西根州', ['Michigan', '底特律', 'Detroit'], 'Michigan', 'US', '美國', 42.3314, -83.0458, 'America/Detroit'),
    ('明尼蘇達州', ['Minnesota', '明尼亞波利斯', 'Minneapolis', '聖保羅'], 'Minnesota', 'US', '美國', 44.9778, -93.265, 'America/Chicago'),
    ('密西西比州', ['Mississippi', '傑克森', 'Jackson'], 'Mississippi', 'US', '美國', 32.2988, -90.1848, 'America/Chicago'),
    ('密蘇里州', ['Missouri', '聖路易', 'St. Louis', '堪薩斯城'], 'Missouri', 'US', '美國', 38.627, -90.1994, 'America/Chicago'),
    ('蒙大拿州', ['Montana', '海倫娜', 'Helena'], 'Montana', 'US', '美國', 46.5891, -112.0391, 'America/Denver'),
    ('內布拉斯加州', ['Nebraska', '林肯', 'Lincoln', '奧馬哈'], 'Nebraska', 'US', '美國', 41.2565, -95.9345, 'America/Chicago'),
    ('內華達州', ['Nevada', '拉斯維加斯', 'Las Vegas'], 'Nevada', 'US', '美國', 36.1699, -115.1398, 'America/Los_Angeles'),
    ('新罕布夏州', ['New Hampshire', '康科德', 'Concord'], 'New Hampshire', 'US', '美國', 43.2081, -71.5376, 'America/New_York'),
    ('紐澤西州', ['New Jersey', '紐華克', 'Newark', '特倫頓'], 'New Jersey', 'US', '美國', 40.7357, -74.1724, 'America/New_York'),
    ('新墨西哥州', ['New Mexico', '阿布奎基', 'Albuquerque', '聖塔菲'], 'New Mexico', 'US', '美國', 35.0844, -106.6504, 'America/Denver'),
    ('紐約', ['紐約州', 'New York', 'New York City', '紐約市', '曼哈頓'], 'New York', 'US', '美國', 40.7128, -74.006, 'America/New_York'),
    ('北卡羅來納州', ['North Carolina', '夏洛特', 'Charlotte', '羅利'], 'North Carolina', 'US', '美國', 35.2271, -80.8431, 'America/New_York'),
    ('北達科他州', ['North Dakota', '俾斯麥', 'Bismarck'], 'North Dakota', 'US', '美國', 46.8083, -100.7837, 'America/Chicago'),
    ('俄亥俄州', ['Ohio', '哥倫布', 'Columbus', '克里夫蘭'], 'Ohio', 'US', '美國', 39.9612, -82.9988, 'America/New_York'),
    ('奧克拉荷馬州', ['Oklahoma', '奧克拉荷馬市', 'Oklahoma City'], 'Oklahoma', 'US', '美國', 35.4676, -97.5164, 'America/Chicago'),
    ('奧勒岡州', ['Oregon', '波特蘭', 'Portland', '塞勒姆'], 'Oregon', 'US', '美國', 45.5152, -122.6784, 'America/Los_Angeles'),
    ('賓州', ['賓夕法尼亞州', 'Pennsylvania', '費城', 'Philadelphia', '匹茲堡'], 'Pennsylvania', 'US', '美國', 39.9526, -75.1652, 'America/New_York'),
    ('羅德島州', ['Rhode Island', '普羅維登斯', 'Providence'], 'Rhode Island', 'US', '美國', 41.824, -71.4128, 'America/New_York'),
    ('南卡羅來納州', ['South Carolina', '哥倫比亞', 'Columbia'], 'South Carolina', 'US', '美國', 34.0007, -81.0348, 'America/New_York'),
    ('南達科他州', ['South Dakota', '皮爾', 'Pierre', '蘇瀑'], 'South Dakota', 'US', '美國', 43.546, -96.7313, 'America/Chicago'),
    ('田納西州', ['Tennessee', '納許維爾', 'Nashville', '曼菲斯'], 'Tennessee', 'US', '美國', 36.1627, -86.7816, 'America/Chicago'),
    ('德州', ['德克薩斯州', 'Texas', '休士頓', 'Houston', '達拉斯', 'Dallas', '奧斯汀', 'Austin'], 'Texas', 'US', '美國', 29.7604, -95.3698, 'America/Chicago'),
    ('猶他州', ['Utah', '鹽湖城', 'Salt Lake City'], 'Utah', 'US', '美國', 40.7608, -111.891, 'America/Denver'),
    ('佛蒙特州', ['Vermont', '蒙彼利埃', 'Montpelier'], 'Vermont', 'US', '美國', 44.2601, -72.5754, 'America/New_York'),
    ('維吉尼亞州', ['Virginia', '里奇蒙', 'Richmond', '維吉尼亞海灘'], 'Virginia', 'US', '美國', 37.5407, -77.436, 'America/New_York'),
    ('華盛頓州', ['Washington', '西雅圖', 'Seattle', '奧林匹亞'], 'Washington', 'US', '美國', 47.6062, -122.3321, 'America/Los_Angeles'),
    ('西維吉尼亞州', ['West Virginia', '查爾斯頓', 'Charleston'], 'West Virginia', 'US', '美國', 38.3498, -81.6326, 'America/New_York'),
    ('威斯康辛州', ['Wisconsin', '密爾瓦基', 'Milwaukee', '麥迪遜'], 'Wisconsin', 'US', '美國', 43.0389, -87.9065, 'America/Chicago'),
    ('懷俄明州', ['Wyoming', '夏安', 'Cheyenne'], 'Wyoming', 'US', '美國', 41.14, -104.8202, 'America/Denver'),
    ('華盛頓特區', ['Washington DC', 'Washington, D.C.', 'DC', '華府'], 'Washington, D.C.', 'US', '美國', 38.9072, -77.0369, 'America/New_York'),
    ('英格蘭', ['England'], 'England', 'GB', '英國', 52.3555, -1.1743, 'Europe/London'),
    ('蘇格蘭', ['Scotland'], 'Scotland', 'GB', '英國', 56.4907, -4.2026, 'Europe/London'),
    ('威爾斯', ['Wales'], 'Wales', 'GB', '英國', 52.1307, -3.7837, 'Europe/London'),
    ('北愛爾蘭', ['Northern Ireland'], 'Northern Ireland', 'GB', '英國', 54.7877, -6.4923, 'Europe/London'),
    ('倫敦', ['London'], 'London', 'GB', '英國', 51.5074, -0.1278, 'Europe/London'),
    ('曼徹斯特', ['Manchester'], 'Manchester', 'GB', '英國', 53.4808, -2.2426, 'Europe/London'),
    ('伯明罕', ['Birmingham'], 'Birmingham', 'GB', '英國', 52.4862, -1.8904, 'Europe/London'),
    ('利物浦', ['Liverpool'], 'Liverpool', 'GB', '英國', 53.4084, -2.9916, 'Europe/London'),
    ('里茲', ['Leeds'], 'Leeds', 'GB', '英國', 53.8008, -1.5491, 'Europe/London'),
    ('雪菲爾', ['Sheffield'], 'Sheffield', 'GB', '英國', 53.3811, -1.4701, 'Europe/London'),
    ('布里斯托', ['Bristol'], 'Bristol', 'GB', '英國', 51.4545, -2.5879, 'Europe/London'),
    ('紐卡索', ['Newcastle'], 'Newcastle upon Tyne', 'GB', '英國', 54.9783, -1.6178, 'Europe/London'),
    ('格拉斯哥', ['Glasgow'], 'Glasgow', 'GB', '英國', 55.8642, -4.2518, 'Europe/London'),
    ('愛丁堡', ['Edinburgh'], 'Edinburgh', 'GB', '英國', 55.9533, -3.1883, 'Europe/London'),
    ('卡地夫', ['Cardiff'], 'Cardiff', 'GB', '英國', 51.4816, -3.1791, 'Europe/London'),
    ('貝爾法斯特', ['Belfast'], 'Belfast', 'GB', '英國', 54.5973, -5.9301, 'Europe/London'),
    ('牛津', ['Oxford'], 'Oxford', 'GB', '英國', 51.752, -1.2577, 'Europe/London'),
    ('劍橋', ['Cambridge'], 'Cambridge', 'GB', '英國', 52.2053, 0.1218, 'Europe/London'),
    ('安大略省', ['Ontario', '多倫多', 'Toronto', '渥太華', 'Ottawa'], 'Ontario', 'CA', '加拿大', 43.6532, -79.3832, 'America/Toronto'),
    ('魁北克省', ['Quebec', '蒙特婁', 'Montreal', '魁北克市'], 'Quebec', 'CA', '加拿大', 45.5019, -73.5674, 'America/Montreal'),
    ('英屬哥倫比亞省', ['British Columbia', '溫哥華', 'Vancouver', '維多利亞'], 'British Columbia', 'CA', '加拿大', 49.2827, -123.1207, 'America/Vancouver'),
    ('亞伯達省', ['Alberta', '卡加利', 'Calgary', '愛德蒙頓', 'Edmonton'], 'Alberta', 'CA', '加拿大', 51.0447, -114.0719, 'America/Edmonton'),
    ('曼尼托巴省', ['Manitoba', '溫尼伯', 'Winnipeg'], 'Manitoba', 'CA', '加拿大', 49.8951, -97.1384, 'America/Winnipeg'),
    ('薩克其萬省', ['Saskatchewan', '里賈納', 'Regina', '薩斯卡通'], 'Saskatchewan', 'CA', '加拿大', 50.4452, -104.6189, 'America/Regina'),
    ('新斯科細亞省', ['Nova Scotia', '哈利法克斯', 'Halifax'], 'Nova Scotia', 'CA', '加拿大', 44.6488, -63.5752, 'America/Halifax'),
    ('新伯倫瑞克省', ['New Brunswick', '弗雷德里克頓', 'Fredericton'], 'New Brunswick', 'CA', '加拿大', 45.9636, -66.6431, 'America/Moncton'),
    ('紐芬蘭與拉布拉多省', ['Newfoundland', '聖約翰斯', "St. John's"], 'Newfoundland and Labrador', 'CA', '加拿大', 47.5615, -52.7126, 'America/St_Johns'),
    ('愛德華王子島省', ['Prince Edward Island', '夏洛特敦', 'Charlottetown'], 'Prince Edward Island', 'CA', '加拿大', 46.2382, -63.1311, 'America/Halifax'),
    ('育空', ['Yukon', '白馬市', 'Whitehorse'], 'Yukon', 'CA', '加拿大', 60.7212, -135.0568, 'America/Whitehorse'),
    ('西北地區', ['Northwest Territories', '黃刀鎮', 'Yellowknife'], 'Northwest Territories', 'CA', '加拿大', 62.454, -114.3718, 'America/Yellowknife'),
    ('努納福特', ['Nunavut', '伊魁特', 'Iqaluit'], 'Nunavut', 'CA', '加拿大', 63.7467, -68.517, 'America/Iqaluit'),
    ('新南威爾斯州', ['New South Wales', 'NSW', '雪梨', 'Sydney'], 'New South Wales', 'AU', '澳洲', -33.8688, 151.2093, 'Australia/Sydney'),
    ('維多利亞州', ['Victoria', '墨爾本', 'Melbourne'], 'Victoria', 'AU', '澳洲', -37.8136, 144.9631, 'Australia/Melbourne'),
    ('昆士蘭州', ['Queensland', '布里斯本', 'Brisbane', '黃金海岸'], 'Queensland', 'AU', '澳洲', -27.4698, 153.0251, 'Australia/Brisbane'),
    ('西澳州', ['Western Australia', '伯斯', 'Perth'], 'Western Australia', 'AU', '澳洲', -31.9523, 115.8613, 'Australia/Perth'),
    ('南澳州', ['South Australia', '阿德萊德', 'Adelaide'], 'South Australia', 'AU', '澳洲', -34.9285, 138.6007, 'Australia/Adelaide'),
    ('塔斯馬尼亞州', ['Tasmania', '荷巴特', 'Hobart'], 'Tasmania', 'AU', '澳洲', -42.8821, 147.3272, 'Australia/Hobart'),
    ('首都特區', ['Australian Capital Territory', 'ACT', '坎培拉', 'Canberra'], 'Australian Capital Territory', 'AU', '澳洲', -35.2809, 149.13, 'Australia/Sydney'),
    ('北領地', ['Northern Territory', '達爾文', 'Darwin'], 'Northern Territory', 'AU', '澳洲', -12.4634, 130.8456, 'Australia/Darwin'),
    ('奧克蘭', ['Auckland'], 'Auckland', 'NZ', '紐西蘭', -36.8485, 174.7633, 'Pacific/Auckland'),
    ('威靈頓', ['Wellington'], 'Wellington', 'NZ', '紐西蘭', -41.2866, 174.7756, 'Pacific/Auckland'),
    ('基督城', ['Christchurch', '坎特伯雷', 'Canterbury'], 'Christchurch', 'NZ', '紐西蘭', -43.5321, 172.6362, 'Pacific/Auckland'),
    ('漢密爾頓', ['Hamilton', '懷卡托', 'Waikato'], 'Hamilton', 'NZ', '紐西蘭', -37.787, 175.2793, 'Pacific/Auckland'),
    ('但尼丁', ['Dunedin', '奧塔哥', 'Otago'], 'Dunedin', 'NZ', '紐西蘭', -45.8788, 170.5028, 'Pacific/Auckland'),
    ('陶朗加', ['Tauranga'], 'Tauranga', 'NZ', '紐西蘭', -37.6878, 176.1651, 'Pacific/Auckland'),
    ('皇后鎮', ['Queenstown'], 'Queenstown', 'NZ', '紐西蘭', -45.0312, 168.6626, 'Pacific/Auckland'),
    ('都柏林', ['Dublin'], 'Dublin', 'IE', '愛爾蘭', 53.3498, -6.2603, 'Europe/Dublin'),
    ('科克', ['Cork'], 'Cork', 'IE', '愛爾蘭', 51.8985, -8.4756, 'Europe/Dublin'),
    ('高威', ['Galway'], 'Galway', 'IE', '愛爾蘭', 53.2707, -9.0568, 'Europe/Dublin'),
    ('利默里克', ['Limerick'], 'Limerick', 'IE', '愛爾蘭', 52.6638, -8.6267, 'Europe/Dublin'),
    ('新加坡', ['Singapore'], 'Singapore', 'SG', '新加坡', 1.3521, 103.8198, 'Asia/Singapore'),
    ('香港', ['Hong Kong', '九龍', 'Kowloon'], 'Hong Kong', 'HK', '香港', 22.3193, 114.1694, 'Asia/Hong_Kong'),
    ('澳門', ['Macau', 'Macao'], 'Macau', 'MO', '澳門', 22.1987, 113.5439, 'Asia/Macau'),
    # 英語圈主要城市（使用者常直接輸入城市而非州省，故獨立列出，優先於州省顯示）
    ('雪梨', ['Sydney'], 'Sydney', 'AU', '澳洲', -33.8688, 151.2093, 'Australia/Sydney'),
    ('墨爾本', ['Melbourne'], 'Melbourne', 'AU', '澳洲', -37.8136, 144.9631, 'Australia/Melbourne'),
    ('布里斯本', ['Brisbane'], 'Brisbane', 'AU', '澳洲', -27.4698, 153.0251, 'Australia/Brisbane'),
    ('伯斯', ['Perth'], 'Perth', 'AU', '澳洲', -31.9523, 115.8613, 'Australia/Perth'),
    ('多倫多', ['Toronto'], 'Toronto', 'CA', '加拿大', 43.6532, -79.3832, 'America/Toronto'),
    ('溫哥華', ['Vancouver'], 'Vancouver', 'CA', '加拿大', 49.2827, -123.1207, 'America/Vancouver'),
    ('蒙特婁', ['Montreal'], 'Montreal', 'CA', '加拿大', 45.5019, -73.5674, 'America/Montreal'),
    ('洛杉磯', ['Los Angeles'], 'Los Angeles', 'US', '美國', 34.0522, -118.2437, 'America/Los_Angeles'),
    ('芝加哥', ['Chicago'], 'Chicago', 'US', '美國', 41.8781, -87.6298, 'America/Chicago'),
    ('休士頓', ['Houston'], 'Houston', 'US', '美國', 29.7604, -95.3698, 'America/Chicago'),
    ('波士頓', ['Boston'], 'Boston', 'US', '美國', 42.3601, -71.0589, 'America/New_York'),
    ('西雅圖', ['Seattle'], 'Seattle', 'US', '美國', 47.6062, -122.3321, 'America/Los_Angeles'),
    ('邁阿密', ['Miami'], 'Miami', 'US', '美國', 25.7617, -80.1918, 'America/New_York'),
    ('亞特蘭大', ['Atlanta'], 'Atlanta', 'US', '美國', 33.7490, -84.3880, 'America/New_York'),
    ('費城', ['Philadelphia'], 'Philadelphia', 'US', '美國', 39.9526, -75.1652, 'America/New_York'),
]


# 上游 geocoder 以「簡體中文」回傳地名，站內一律顯示繁體 → 逐字轉換。
# 只收錄地名／行政區常用字，足以覆蓋中文圈城市名稱。
_S2T = {
    '湾': '灣', '台': '臺', '园': '園', '云': '雲', '义': '義', '东': '東', '华': '華',
    '兰': '蘭', '龙': '龍', '凤': '鳳', '马': '馬', '鸟': '鳥', '鱼': '魚', '树': '樹',
    '门': '門', '连': '連', '阳': '陽', '阴': '陰', '国': '國', '韩': '韓', '汉': '漢',
    '广': '廣', '庆': '慶', '贵': '貴', '州': '州', '宁': '寧', '辽': '遼', '滨': '濱',
    '沟': '溝', '济': '濟', '泽': '澤', '浦': '浦', '渖': '瀋', '沈': '瀋', '陕': '陝',
    '晋': '晉', '苏': '蘇', '浙': '浙', '皖': '皖', '赣': '贛', '闽': '閩', '湘': '湘',
    '鄂': '鄂', '桂': '桂', '琼': '瓊', '藏': '藏', '疆': '疆', '蒙': '蒙', '吉': '吉',
    '黑': '黑', '龟': '龜', '岛': '島', '县': '縣', '区': '區', '乡': '鄉', '镇': '鎮',
    '庄': '莊', '厂': '廠', '坝': '壩', '塘': '塘', '渡': '渡', '桥': '橋', '关': '關',
    '铁': '鐵', '银': '銀', '钢': '鋼', '锦': '錦', '镜': '鏡', '长': '長', '兴': '興',
    '丰': '豐', '农': '農', '业': '業', '产': '產', '开': '開', '发': '發', '达': '達',
    '边': '邊', '远': '遠', '进': '進', '还': '還', '这': '這', '万': '萬', '与': '與',
    '亚': '亞', '仑': '崙', '仓': '倉', '众': '眾', '优': '優', '会': '會', '伟': '偉',
    '传': '傳', '价': '價', '侨': '僑', '俭': '儉', '儿': '兒', '党': '黨', '内': '內',
    '军': '軍', '农': '農', '冲': '沖', '决': '決', '净': '淨', '凉': '涼', '刘': '劉',
    '则': '則', '刚': '剛', '创': '創', '别': '別', '劲': '勁', '动': '動', '劳': '勞',
    '势': '勢', '医': '醫', '压': '壓', '厅': '廳', '历': '歷', '双': '雙', '变': '變',
    '叶': '葉', '号': '號', '吗': '嗎', '员': '員', '响': '響', '咏': '詠', '哑': '啞',
    '唤': '喚', '喷': '噴', '园': '園', '围': '圍', '图': '圖', '团': '團', '圣': '聖',
    '场': '場', '坟': '墳', '坚': '堅', '坛': '壇', '垒': '壘', '执': '執', '声': '聲',
    '壳': '殼', '备': '備', '复': '復', '够': '夠', '头': '頭', '夹': '夾', '夺': '奪',
    '奖': '獎', '妇': '婦', '学': '學', '宝': '寶', '实': '實', '宪': '憲', '审': '審',
    '层': '層', '岁': '歲', '岗': '崗', '峡': '峽', '币': '幣', '师': '師', '帮': '幫',
    '带': '帶', '张': '張', '归': '歸', '当': '當', '录': '錄', '态': '態', '总': '總',
    '恒': '恆', '恳': '懇', '战': '戰', '户': '戶', '扑': '撲', '扩': '擴', '扫': '掃',
    '扬': '揚', '担': '擔', '拟': '擬', '择': '擇', '挂': '掛', '挥': '揮', '损': '損',
    '换': '換', '据': '據', '摆': '擺', '摄': '攝', '数': '數', '断': '斷', '旧': '舊',
    '术': '術', '机': '機', '杂': '雜', '权': '權', '条': '條', '来': '來', '杨': '楊',
    '极': '極', '构': '構', '枪': '槍', '标': '標', '栋': '棟', '样': '樣', '桦': '樺',
    '梦': '夢', '检': '檢', '楼': '樓', '横': '橫', '欢': '歡', '欧': '歐', '毕': '畢',
    '气': '氣', '汇': '匯', '汤': '湯', '汹': '洶', '沪': '滬', '泾': '涇', '洁': '潔',
    '洒': '灑', '浇': '澆', '测': '測', '浑': '渾', '涛': '濤', '润': '潤', '涨': '漲',
    '渊': '淵', '渐': '漸', '温': '溫', '滞': '滯', '满': '滿', '滤': '濾', '滨': '濱',
    '灯': '燈', '灭': '滅', '灵': '靈', '灾': '災', '炉': '爐', '点': '點', '烂': '爛',
    '烦': '煩', '热': '熱', '爱': '愛', '牵': '牽', '状': '狀', '独': '獨', '狮': '獅',
    '环': '環', '现': '現', '玛': '瑪', '珑': '瓏', '琐': '瑣', '瑶': '瑤', '璃': '璃',
    '电': '電', '疗': '療', '盘': '盤', '监': '監', '盖': '蓋', '码': '碼', '砖': '磚',
    '础': '礎', '硕': '碩', '确': '確', '碍': '礙', '礼': '禮', '祸': '禍', '离': '離',
    '种': '種', '积': '積', '称': '稱', '穷': '窮', '窜': '竄', '竞': '競', '笔': '筆',
    '笼': '籠', '筑': '築', '筹': '籌', '签': '簽', '简': '簡', '篮': '籃', '类': '類',
    '粮': '糧', '紧': '緊', '纠': '糾', '红': '紅', '级': '級', '纪': '紀', '纯': '純',
    '纲': '綱', '纳': '納', '纵': '縱', '纸': '紙', '线': '線', '练': '練', '组': '組',
    '细': '細', '织': '織', '终': '終', '绍': '紹', '经': '經', '结': '結', '绕': '繞',
    '给': '給', '络': '絡', '绝': '絕', '统': '統', '继': '繼', '绩': '績', '绪': '緒',
    '续': '續', '绳': '繩', '维': '維', '绵': '綿', '综': '綜', '绿': '綠', '缓': '緩',
    '编': '編', '缘': '緣', '缩': '縮', '网': '網', '罗': '羅', '罚': '罰', '习': '習',
    '职': '職', '联': '聯', '肃': '肅', '肠': '腸', '肤': '膚', '脏': '臟', '脑': '腦',
    '腊': '臘', '舆': '輿', '舰': '艦', '艰': '艱', '艺': '藝', '节': '節', '芦': '蘆',
    '苹': '蘋', '范': '範', '茧': '繭', '荐': '薦', '荡': '蕩', '荣': '榮', '药': '藥',
    '莱': '萊', '莲': '蓮', '获': '獲', '萝': '蘿', '营': '營', '萧': '蕭', '蓝': '藍',
    '虏': '虜', '虾': '蝦', '蚁': '蟻', '蜡': '蠟', '补': '補', '装': '裝', '见': '見',
    '观': '觀', '规': '規', '视': '視', '览': '覽', '觉': '覺', '誉': '譽', '认': '認',
    '让': '讓', '训': '訓', '议': '議', '记': '記', '讲': '講', '许': '許', '论': '論',
    '设': '設', '访': '訪', '证': '證', '识': '識', '诉': '訴', '词': '詞', '译': '譯',
    '试': '試', '诗': '詩', '话': '話', '该': '該', '详': '詳', '语': '語', '误': '誤',
    '说': '說', '请': '請', '读': '讀', '课': '課', '调': '調', '谈': '談', '谢': '謝',
    '谷': '谷', '买': '買', '贝': '貝', '负': '負', '贡': '貢', '财': '財', '责': '責',
    '贤': '賢', '货': '貨', '质': '質', '贫': '貧', '贴': '貼', '费': '費', '贺': '賀',
    '资': '資', '赛': '賽', '赞': '贊', '赵': '趙', '车': '車', '轨': '軌', '轮': '輪',
    '软': '軟', '轻': '輕', '载': '載', '较': '較', '辉': '輝', '输': '輸', '辑': '輯',
    '边': '邊', '迁': '遷', '运': '運', '违': '違', '迟': '遲', '适': '適', '选': '選',
    '递': '遞', '邓': '鄧', '邮': '郵', '郑': '鄭', '酿': '釀', '释': '釋', '锁': '鎖',
    '锋': '鋒', '错': '錯', '键': '鍵', '镇': '鎮', '闪': '閃', '闭': '閉', '问': '問',
    '闲': '閒', '间': '間', '闻': '聞', '阁': '閣', '阔': '闊', '队': '隊', '阶': '階',
    '陆': '陸', '陈': '陳', '险': '險', '随': '隨', '隐': '隱', '难': '難', '韦': '韋',
    '页': '頁', '顶': '頂', '项': '項', '顺': '順', '须': '須', '顾': '顧', '预': '預',
    '领': '領', '颗': '顆', '题': '題', '颜': '顏', '额': '額', '风': '風', '飞': '飛',
    '饭': '飯', '馆': '館', '驾': '駕', '验': '驗', '骂': '罵', '骄': '驕', '鸡': '雞',
    '鸣': '鳴', '鹅': '鵝', '鹤': '鶴', '黄': '黃', '齐': '齊', '齿': '齒', '龄': '齡',
}


def to_traditional(text):
    """把上游回傳的簡體地名逐字轉為繁體（站內一律顯示繁體中文）。"""
    if not text:
        return text
    return ''.join(_S2T.get(ch, ch) for ch in str(text))


# ── 各語系的顯示名 ──
# 站內顯示的地名要跟著使用者的語言走：中文→繁體、英文→英文、日文→日本語、韓文→한국어。
# 表中 disp 欄本身已是「該地當地語言」（臺灣＝繁中、日本＝日本語、韓國＝한국어），
# 因此只需補上跨語系的對照；缺漏時依「所求語言 → 英文 → 原顯示名」退回。

# 日本新字體 → 繁體中文（產生日本地名的中文寫法：神奈川県→神奈川縣）
_JP2ZH = {
    '県': '縣', '静': '靜', '広': '廣', '児': '兒', '縄': '繩', '徳': '德',
    '沢': '澤', '崎': '崎', '阪': '阪', '茨': '茨', '栃': '栃', '梨': '梨',
}


def _jp_to_zh(name):
    return ''.join(_JP2ZH.get(ch, ch) for ch in name)


# 韓國行政區的中文與日文寫法
_KR_NAMES = {
    'Seoul': ('首爾', 'ソウル'), 'Busan': ('釜山', '釜山'), 'Daegu': ('大邱', '大邱'),
    'Incheon': ('仁川', '仁川'), 'Gwangju': ('光州', '光州'), 'Daejeon': ('大田', '大田'),
    'Ulsan': ('蔚山', '蔚山'), 'Sejong': ('世宗', 'セジョン'),
    'Gyeonggi': ('京畿道', '京畿道'), 'Gangwon': ('江原道', '江原道'),
    'Chungbuk': ('忠清北道', '忠清北道'), 'Chungnam': ('忠清南道', '忠清南道'),
    'Jeonbuk': ('全羅北道', '全羅北道'), 'Jeonnam': ('全羅南道', '全羅南道'),
    'Gyeongbuk': ('慶尚北道', '慶尚北道'), 'Gyeongnam': ('慶尚南道', '慶尚南道'),
    'Jeju': ('濟州', '済州'),
}

# 國名（本表 12 個國家／地區）——依語系顯示
COUNTRY_NAMES = {
    'TW': {'zh-Hant': '臺灣', 'en': 'Taiwan', 'ja': '台湾', 'ko': '대만'},
    'JP': {'zh-Hant': '日本', 'en': 'Japan', 'ja': '日本', 'ko': '일본'},
    'KR': {'zh-Hant': '韓國', 'en': 'South Korea', 'ja': '韓国', 'ko': '대한민국'},
    'US': {'zh-Hant': '美國', 'en': 'United States', 'ja': 'アメリカ', 'ko': '미국'},
    'GB': {'zh-Hant': '英國', 'en': 'United Kingdom', 'ja': 'イギリス', 'ko': '영국'},
    'CA': {'zh-Hant': '加拿大', 'en': 'Canada', 'ja': 'カナダ', 'ko': '캐나다'},
    'AU': {'zh-Hant': '澳洲', 'en': 'Australia', 'ja': 'オーストラリア', 'ko': '호주'},
    'NZ': {'zh-Hant': '紐西蘭', 'en': 'New Zealand', 'ja': 'ニュージーランド', 'ko': '뉴질랜드'},
    'IE': {'zh-Hant': '愛爾蘭', 'en': 'Ireland', 'ja': 'アイルランド', 'ko': '아일랜드'},
    'SG': {'zh-Hant': '新加坡', 'en': 'Singapore', 'ja': 'シンガポール', 'ko': '싱가포르'},
    'HK': {'zh-Hant': '香港', 'en': 'Hong Kong', 'ja': '香港', 'ko': '홍콩'},
    'MO': {'zh-Hant': '澳門', 'en': 'Macau', 'ja': 'マカオ', 'ko': '마카오'},
}

# 上游 geocoder 的語言代碼
_UPSTREAM_LANG = {'zh-Hant': 'zh', 'en': 'en', 'ja': 'ja', 'ko': 'ko'}


def _display_name(disp, en, cc, lang):
    """依語系挑選地名顯示字樣。"""
    if lang == 'en':
        return en or disp
    if cc == 'JP':
        if lang == 'ja':
            return disp                      # 表中已是日本語
        if lang == 'zh-Hant':
            return _jp_to_zh(disp)           # 神奈川県 → 神奈川縣
        return en or disp                    # 韓文無對照 → 英文
    if cc == 'KR':
        if lang == 'ko':
            return disp                      # 表中已是한국어
        zh, ja = _KR_NAMES.get(en, (None, None))
        if lang == 'zh-Hant' and zh:
            return zh
        if lang == 'ja' and ja:
            return ja
        return en or disp
    # 其餘（臺灣／英語系／港澳新）：disp 為繁中
    if lang == 'zh-Hant':
        return disp
    return en or disp                        # 日／韓無逐筆對照 → 英文（當地慣例可接受）


def _country_name(cc, cname, lang):
    return (COUNTRY_NAMES.get(cc) or {}).get(lang) or cname


def _norm(s):
    """比對用正規化：統一異體字、去空白、轉小寫。"""
    return str(s or '').strip().lower().replace('臺', '台')


def local_search(query, lang='zh-Hant'):
    """先查本地對照表（不需連外、不受上游索引缺漏影響）。
    顯示字樣依語系挑選；完全相符優先，其次前綴相符（打「桃」也能帶出桃園市）。"""
    q = _norm(query)
    if not q:
        return []
    hits = []
    for disp, aliases, en, cc, cname, lat, lon, tz in PLACES:
        # 排序優先度：顯示名／英文名完全相符 → 別名完全相符 → 前綴相符。
        # 這樣「洛杉磯」會命中專屬的洛杉磯條目，而不是把它列為別名的加州。
        primary = [_norm(disp), _norm(en)]
        alias_norm = [_norm(a) for a in aliases]
        if q in primary:
            rank = 0
        elif q in alias_norm:
            rank = 1
        elif any(n.startswith(q) for n in primary + alias_norm):
            rank = 2
        else:
            continue
        hits.append((rank, {
            'id': f'loc:{cc}:{en}',
            'name': _display_name(disp, en, cc, lang),
            'admin1': None,
            'country': _country_name(cc, cname, lang),
            'country_code': cc,
            'latitude': lat,
            'longitude': lon,
            'timezone': tz,
        }))
    hits.sort(key=lambda x: (x[0], len(x[1]['name'])))
    return [h[1] for h in hits]


def _exact_local(query):
    """本地表是否有「完全相符」的地名（命中即不必再問上游）。"""
    q = _norm(query)
    for disp, aliases, en, *_r in PLACES:
        if q in [_norm(n) for n in [disp, en] + list(aliases)]:
            return True
    return False


def _fetch_geo(name, count, timeout=8, language='zh'):
    """回傳 (results, ok)。ok=False 代表這次呼叫失敗（超時／服務異常），
    與「查得到但沒有結果」必須分開，否則使用者會誤以為地名不合法。"""
    q = urllib.parse.urlencode({
        'name': name, 'count': count, 'language': language, 'format': 'json',
    })
    url = f'https://geocoding-api.open-meteo.com/v1/search?{q}'
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            data = json.loads(r.read().decode('utf-8'))
        results = data.get('results') or []
        if language == 'zh':
            # 上游中文索引以簡體回傳；僅中文語系需要轉成繁體
            for item in results:
                for key in ('name', 'admin1', 'admin2', 'country'):
                    if item.get(key):
                        item[key] = to_traditional(item[key])
        return results, True
    except Exception:
        return [], False


# 常見行政區尾綴：搜尋時同時嘗試「去掉」與「加上」，
# 因為上游有時只收錄「桃園區」而收不到「桃園」，反之亦然。
_SUFFIXES = ['市', '縣', '區', '鄉', '鎮', '村', '里']


def _query_variants(query):
    """產生查詢變體：臺↔台、去尾綴、加尾綴。順序＝優先度。"""
    base = [query]
    if '臺' in query:
        base.append(query.replace('臺', '台'))
    elif '台' in query:
        base.append(query.replace('台', '臺'))

    out = []
    for b in base:
        if b not in out:
            out.append(b)
        # 去尾綴（桃園市 → 桃園）
        for sfx in _SUFFIXES:
            if b.endswith(sfx) and len(b) > len(sfx):
                stripped = b[: -len(sfx)]
                if stripped not in out:
                    out.append(stripped)
        # 加尾綴（桃園 → 桃園市／桃園區）
        if not any(b.endswith(s) for s in _SUFFIXES):
            for sfx in ('市', '區', '縣'):
                cand = b + sfx
                if cand not in out:
                    out.append(cand)
    return out


def geo_search(query, count=8, lang='zh-Hant'):
    """城市搜尋。回傳 (results, upstream_ok)。
    本地臺灣對照表優先（權威、即時、不需連外）；命中完全相符時直接回傳，
    不再等上游，避免多次外部查詢把回應時間拖到十幾秒而看起來像「沒反應」。"""
    query = str(query or '').strip()
    if not query:
        return [], True

    seen = set()
    merged = []

    def add(items):
        for item in items:
            key = item.get('id') or (item.get('name'), item.get('admin1'), item.get('country_code'))
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)

    add(local_search(query, lang))

    # 本地已有「完全相符」的地名 → 立刻回傳，不打上游
    if _exact_local(query):
        return merged[:count], True

    # 否則向上游查詢：最多 2 個變體、每次 5 秒，控制總等待時間
    upstream_any_ok = False
    upstream_tried = False
    for v in _query_variants(query)[:2]:
        if len(merged) >= count:
            break
        upstream_tried = True
        items, ok = _fetch_geo(v, count, timeout=5, language=_UPSTREAM_LANG.get(lang, 'zh'))
        upstream_any_ok = upstream_any_ok or ok
        add(items)

    # 中文查不到、但本地表認得這個地名 → 用英文名再問一次
    if not merged:
        q = _norm(query)
        for disp, aliases, en, *_r in PLACES:
            if q in [_norm(n) for n in [disp] + list(aliases)]:
                upstream_tried = True
                items, ok = _fetch_geo(en, count, timeout=5, language='en')
                upstream_any_ok = upstream_any_ok or ok
                add(items)
                break

    upstream_ok = upstream_any_ok or not upstream_tried
    return merged[:count], upstream_ok


def geocode(city, country):
    results, _ok = geo_search(city, count=8)
    if not results:
        return None
    if country:
        c = str(country).strip().lower()
        for item in results:
            if c in str(item.get('country', '')).lower() or c == str(item.get('country_code', '')).lower():
                return item
    return results[0]


def house_of(lon, cusps):
    """cusps: 12 個宮頭黃經（第 1 宮起）。回傳 1..12。"""
    for i in range(12):
        a = cusps[i]
        b = cusps[(i + 1) % 12]
        span = norm(b - a)
        if norm(lon - a) < span:
            return i + 1
    return 12


def body_orb_class(name):
    if name in LUMINARIES or name in ANGLE_NAMES:
        return (8.0, 2.5)
    if name in MINOR_BODIES:
        return (3.0, 1.5)
    return (6.0, 2.0)


def make_point(name, lon, speed, cusps, is_axis=False):
    sign_idx, pos_str = fmt_pos(lon)
    p = {
        'name': name,
        'lon': round(norm(lon), 4),
        'sign': SIGNS[sign_idx],
        'position': pos_str,
        'speed': round(speed, 5),
    }
    if not is_axis:
        p['retrograde'] = speed < 0
    if cusps:
        h = house_of(lon, cusps)
        p['house'] = h
        p['distToCuspDeg'] = round(norm(lon - cusps[h - 1]), 2)
        p['distToNextCuspDeg'] = round(norm(cusps[h % 12] - lon), 2)
    return p


def compute_chart(date_str, time_str, time_unknown, city, country, place=None):
    warnings = []
    # 計時：分開記「查地點（對外連線）」與「星曆計算」，兩者的優化方式完全不同
    t_enter = time.perf_counter()
    geocode_ms = None  # 前端已選定地點時不會查，保持 None 才不會把統計拉低
    if not EPHE_OK:
        warnings.append('星曆檔目錄未找到（seas_18.se1 不在任何候選路徑）——小行星與凱龍將無法計算，行星退回內建理論精度。')

    # 前端若已從搜尋清單選定城市（帶經緯度與時區），直接採用、不再 geocode
    if not (place and place.get('latitude') is not None
            and place.get('longitude') is not None and place.get('timezone')):
        t_geo = time.perf_counter()
        place = geocode(city, country)
        geocode_ms = (time.perf_counter() - t_geo) * 1000
    if not place:
        return None, 'geocode_failed'
    lat, lon_geo = float(place['latitude']), float(place['longitude'])
    tzname = place.get('timezone') or 'UTC'
    if ZoneInfo is None:
        return None, 'tz_unavailable'

    y, mo, d = [int(x) for x in date_str.split('-')]
    if not (1800 <= y <= 2399):
        return None, 'date_out_of_range'

    if time_unknown or not time_str:
        hh, mi = 12, 0
        time_unknown = True
        warnings.append('出生時間不確定：以當地正午計算。上升點、下降點、天頂、天底、十二宮位、Vertex、福點不可靠（未輸出）；月亮精確度數誤差可達 ±7°，星座若在交界亦可能不同。')
    else:
        hh, mi = [int(x) for x in time_str.split(':')]

    try:
        tz = ZoneInfo(tzname)
    except Exception:
        return None, 'tz_unavailable'
    local_dt = datetime(y, mo, d, hh, mi, tzinfo=tz)
    ut = local_dt.astimezone(timezone.utc)
    utc_offset = local_dt.utcoffset().total_seconds() / 3600.0
    dst = bool(local_dt.dst() and local_dt.dst().total_seconds() != 0)

    jd = swe.julday(ut.year, ut.month, ut.day, ut.hour + ut.minute / 60.0 + ut.second / 3600.0)
    iflag = swe.FLG_SWIEPH | swe.FLG_SPEED

    # ---- 宮位與軸線（Placidus）----
    cusps = None
    axes = []
    fortune = None
    vertex = None
    if not time_unknown:
        hcusps, ascmc = swe.houses(jd, lat, lon_geo, b'P')
        cusps = [norm(c) for c in hcusps[:12]]
        asc, mc = norm(ascmc[0]), norm(ascmc[1])
        vx = norm(ascmc[3])
        axes = [
            make_point('上升點', asc, 0.0, cusps, is_axis=True),
            make_point('下降點', asc + 180, 0.0, cusps, is_axis=True),
            make_point('天頂', mc, 0.0, cusps, is_axis=True),
            make_point('天底', mc + 180, 0.0, cusps, is_axis=True),
        ]

    # ---- 行星與點位 ----
    points = []
    for pid, name in PLANET_IDS + EXTRA_IDS:
        try:
            res, _ = swe.calc_ut(jd, pid, iflag)
            points.append(make_point(name, res[0], res[3], cusps))
        except Exception:
            warnings.append(f'{name} 計算失敗（星曆檔缺漏），未輸出，不以概略位置代替。')

    by_name = {p['name']: p for p in points}

    # 南交點：由北交點精確對宮推導
    if '北交點' in by_name:
        nn = by_name['北交點']
        sn = make_point('南交點', nn['lon'] + 180, nn['speed'], cusps)
        sn['retrograde'] = nn.get('retrograde', True)
        points.append(sn)
        by_name['南交點'] = sn

    # 福點（有精確時間才可靠）：日盤 ASC+月-日；夜盤 ASC-月+日
    if cusps and '太陽' in by_name and '月亮' in by_name:
        sun, moon = by_name['太陽'], by_name['月亮']
        asc_lon = axes[0]['lon']
        is_day = sun.get('house', 1) >= 7
        pof = asc_lon + moon['lon'] - sun['lon'] if is_day else asc_lon - moon['lon'] + sun['lon']
        fortune = make_point('福點', pof, 0.0, cusps, is_axis=True)
        fortune['dayChart'] = is_day
        vertex = make_point('Vertex', vx, 0.0, cusps, is_axis=True)

    all_points = points + axes + ([fortune] if fortune else []) + ([vertex] if vertex else [])

    # ---- 十二宮宮頭與宮主星 ----
    houses = []
    if cusps:
        for i in range(12):
            sign_idx, pos_str = fmt_pos(cusps[i])
            ruler = TRAD_RULERS[sign_idx]
            h = {
                'house': i + 1,
                'cuspPosition': pos_str,
                # 宮頭的絕對黃經。原本只輸出排版好的字串（cuspPosition），
                # 前端要畫星盤輪就得反解字串——這裡直接給數值。
                'cuspLon': round(norm(cusps[i]), 4),
                'cuspSign': SIGNS[sign_idx],
                'rulerTraditional': ruler,
                'rulerModernCo': MODERN_CO.get(sign_idx),
                'occupants': [p['name'] for p in all_points
                              if p.get('house') == i + 1 and p['name'] not in ANGLE_NAMES],
            }
            rp = by_name.get(ruler)
            if rp:
                h['rulerSign'] = rp['sign']
                h['rulerHouse'] = rp.get('house')
            houses.append(h)

        # 攔截星座與重複宮頭
        cusp_signs = [int(c // 30) for c in cusps]
        intercepted = [SIGNS[s] for s in range(12) if s not in cusp_signs]
        dup = [SIGNS[s] for s in set(cusp_signs) if cusp_signs.count(s) > 1]
    else:
        intercepted, dup = [], []

    # ---- 相位（一致的容許度政策，於報告中交代）----
    aspects = []
    aspect_bodies = [p for p in all_points if p['name'] not in {'下降點', '天底', '南交點'}]
    for i in range(len(aspect_bodies)):
        for j in range(i + 1, len(aspect_bodies)):
            a, b = aspect_bodies[i], aspect_bodies[j]
            sep = angdiff(a['lon'], b['lon'])
            for aspect_list, is_major in [(MAJOR_ASPECTS, True), (MINOR_ASPECTS, False)]:
                for angle, aname in aspect_list:
                    ca, cb = body_orb_class(a['name']), body_orb_class(b['name'])
                    allowed = (ca[0] + cb[0]) / 2 if is_major else (ca[1] + cb[1]) / 2
                    orb = abs(sep - angle)
                    if orb <= allowed:
                        # 入相/出相：依實際運行速度（含逆行）微分判斷；軸線視為靜止
                        ds = 0.001
                        sep2 = angdiff(a['lon'] + a['speed'] * ds, b['lon'] + b['speed'] * ds)
                        applying = abs(sep2 - angle) < abs(sep - angle)
                        om = int(orb)
                        os_ = int(round((orb - om) * 60))
                        aspects.append({
                            'a': a['name'], 'b': b['name'], 'type': aname,
                            'angle': angle, 'actual': round(sep, 2),
                            'orb': f"{om}°{os_:02d}′", 'orbDeg': round(orb, 2),
                            'major': is_major,
                            'state': '入相' if applying else '出相',
                        })
                        break
                else:
                    continue
                break
    aspects.sort(key=lambda x: x['orbDeg'])

    # ---- 整體結構 ----
    dist = {'elements': {}, 'modes': {}, 'polarity': {'陽': 0, '陰': 0}}
    for name in TEN:
        p = by_name.get(name)
        if not p:
            continue
        si = SIGNS.index(p['sign'])
        dist['elements'][ELEMENTS[si % 4]] = dist['elements'].get(ELEMENTS[si % 4], 0) + 1
        dist['modes'][MODES[si % 3]] = dist['modes'].get(MODES[si % 3], 0) + 1
        dist['polarity']['陽' if si % 2 == 0 else '陰'] += 1

    hemis = None
    if cusps:
        hemis = {'上半球': 0, '下半球': 0, '東半球': 0, '西半球': 0,
                 '第一象限': 0, '第二象限': 0, '第三象限': 0, '第四象限': 0}
        for name in TEN:
            h = by_name[name].get('house')
            if not h:
                continue
            hemis['上半球' if 7 <= h <= 12 else '下半球'] += 1
            hemis['東半球' if h in (10, 11, 12, 1, 2, 3) else '西半球'] += 1
            hemis[['第一象限', '第二象限', '第三象限', '第四象限'][(h - 1) // 3]] += 1

    # 尊貴（入廟/擢升/失勢/落陷）
    dignities = {}
    for name, dg in DIGNITY.items():
        p = by_name.get(name)
        if not p:
            continue
        si = SIGNS.index(p['sign'])
        if si in dg['domicile']:
            dignities[name] = '入廟'
        elif si in dg['exalt']:
            dignities[name] = '擢升'
        elif si in dg['detriment']:
            dignities[name] = '失勢'
        elif si in dg['fall']:
            dignities[name] = '落陷'

    # ---- 飛星（傳統定位星鏈）、互容、最終定位星 ----
    disp = {}
    for name in TEN:
        p = by_name.get(name)
        if p:
            disp[name] = TRAD_RULERS[SIGNS.index(p['sign'])]
    finals, loops = [], []
    for name in TEN:
        seen = [name]
        cur = name
        while True:
            nxt = disp.get(cur)
            if nxt == cur:
                if cur not in finals:
                    finals.append(cur)
                break
            if nxt in seen:
                loop = seen[seen.index(nxt):]
                key = sorted(loop)
                if key not in [sorted(l) for l in loops]:
                    loops.append(loop)
                break
            seen.append(nxt)
            cur = nxt
    mutual = []
    for i, a in enumerate(TEN):
        for b in TEN[i + 1:]:
            if disp.get(a) == b and disp.get(b) == a and a != b:
                mutual.append([a, b])

    # ---- 特殊格局（以主相位偵測）----
    def has_asp(x, y, angle, pool):
        return any(t for t in pool if {t['a'], t['b']} == {x, y} and t['angle'] == angle)

    majors = [t for t in aspects if t['major'] and t['a'] in TEN and t['b'] in TEN]
    patterns = []
    import itertools
    for trio in itertools.combinations(TEN, 3):
        a, b, c = trio
        if has_asp(a, b, 120, majors) and has_asp(b, c, 120, majors) and has_asp(a, c, 120, majors):
            patterns.append({'type': '大三角', 'bodies': list(trio)})
        if has_asp(a, b, 180, majors) and has_asp(a, c, 90, majors) and has_asp(b, c, 90, majors):
            patterns.append({'type': 'T三角', 'bodies': list(trio), 'apex': c})
        if has_asp(a, b, 60, majors) and \
           any(t for t in aspects if {t['a'], t['b']} == {a, c} and t['angle'] == 150) and \
           any(t for t in aspects if {t['a'], t['b']} == {b, c} and t['angle'] == 150):
            patterns.append({'type': '上帝之指', 'bodies': list(trio), 'apex': c})
    for quad in itertools.combinations(TEN, 4):
        a, b, c, d = quad
        opps = [(x, y) for x, y in itertools.combinations(quad, 2) if has_asp(x, y, 180, majors)]
        sqs = [(x, y) for x, y in itertools.combinations(quad, 2) if has_asp(x, y, 90, majors)]
        if len(opps) == 2 and len(sqs) == 4:
            patterns.append({'type': '大十字', 'bodies': list(quad)})

    # 群星：≥3 顆（十大行星）同星座，並附同宮/彼此距離/內行星參與
    stelliums = []
    for s in SIGNS:
        grp = [n for n in TEN if by_name.get(n, {}).get('sign') == s]
        if len(grp) >= 3:
            lons = [by_name[n]['lon'] for n in grp]
            spread_deg = max(angdiff(x, y) for x in lons for y in lons)
            stelliums.append({
                'type': '群星', 'sign': s, 'bodies': grp,
                'sameHouse': (len({by_name[n].get('house') for n in grp}) == 1) if cusps else None,
                'maxSpreadDeg': round(spread_deg, 1),
                'personalInvolved': any(n in ('太陽', '月亮', '水星', '金星', '火星') for n in grp),
            })
    patterns.extend(stelliums)

    # 無主相位行星
    unaspected = []
    for name in TEN:
        has_major = any(t for t in majors if name in (t['a'], t['b']))
        if not has_major:
            has_minor = any(t for t in aspects if not t['major'] and name in (t['a'], t['b']))
            unaspected.append({'body': name, 'minorOnly': has_minor})

    retro_planets = [n for n in TEN if by_name.get(n, {}).get('retrograde')]

    chart_ruler = None
    if cusps:
        asc_sign_idx = SIGNS.index(axes[0]['sign'])
        cr = TRAD_RULERS[asc_sign_idx]
        crp = by_name.get(cr)
        chart_ruler = {
            'name': cr, 'modernCo': MODERN_CO.get(asc_sign_idx),
            'sign': crp['sign'] if crp else None,
            'house': crp.get('house') if crp else None,
        }

    chart = {
        'meta': {
            'input': {'date': date_str, 'time': None if time_unknown else time_str,
                      'timeUnknown': time_unknown, 'city': city, 'country': country or None},
            'place': {'resolved': f"{place.get('name')}, {place.get('country', '')}",
                      'lat': lat, 'lon': lon_geo},
            'timezone': {'iana': tzname, 'utcOffsetHours': utc_offset, 'dstActive': dst},
            'utc': ut.strftime('%Y-%m-%d %H:%M'),
            'systems': '西洋占星｜熱帶黃道 Tropical｜Placidus 宮制｜True Node 真北交點｜Mean Black Moon Lilith｜地心盤 Geocentric｜Swiss Ephemeris',
            'orbPolicy': '主相位：日月與四軸 8°、行星 6°、小行星/交點/莉莉絲/福點 3°（取兩者平均）；次要相位：依序 2.5°/2°/1.5°。入相出相依實際速度與逆行狀態計算。',
            'warnings': warnings,
            # 處理時間（毫秒）：geocode＝對外查地點；ephemeris＝Swiss Ephemeris 實算
            'timing': {
                'geocodeMs': None if geocode_ms is None else round(geocode_ms, 1),
                'ephemerisMs': round((time.perf_counter() - t_enter) * 1000 - (geocode_ms or 0.0), 1),
            },
        },
        'points': all_points,
        'houses': houses,
        'intercepted': intercepted,
        'duplicatedCuspSigns': dup,
        'aspects': aspects,
        'structure': {
            'distributions': dist,
            'hemispheres': hemis,
            'dignities': dignities,
            'chartRuler': chart_ruler,
            'retrogradePlanets': retro_planets,
        },
        'dispositors': {
            'chain': disp,
            'finalDispositors': finals,
            'loops': loops,
            'mutualReceptions': mutual,
        },
        'patterns': patterns,
        'unaspected': unaspected,
    }
    return chart, None


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # 城市即時搜尋：GET /api/astro?q=臺北 → 合法城市清單（含臺↔台變體合併）
        try:
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            query = (params.get('q') or [''])[0].strip()[:80]
            lang = (params.get('lang') or ['zh-Hant'])[0].strip()[:10]
            if lang not in _UPSTREAM_LANG:
                lang = 'zh-Hant'
        except Exception:
            query = ''
            lang = 'zh-Hant'
        if not query:
            self._send(400, {'ok': False, 'error': 'missing_query'})
            return
        results, upstream_ok = geo_search(query, count=10, lang=lang)
        self._send(200, {'ok': True, 'searchOk': upstream_ok, 'results': [{
            'name': item.get('name'),
            'admin1': item.get('admin1'),
            'country': item.get('country'),
            'countryCode': item.get('country_code'),
            'latitude': item.get('latitude'),
            'longitude': item.get('longitude'),
            'timezone': item.get('timezone'),
        } for item in results]})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            data = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
        except Exception:
            self._send(400, {'ok': False, 'error': 'bad_request'})
            return
        date_str = str(data.get('date', ''))
        time_str = data.get('time')
        time_unknown = bool(data.get('timeUnknown'))
        city = str(data.get('city', '')).strip()[:80]
        country = str(data.get('country', '')).strip()[:40]

        # 前端搜尋清單選定的城市（含經緯度/時區）：直接使用
        place = None
        p = data.get('place')
        if isinstance(p, dict):
            try:
                place = {
                    'name': str(p.get('name', ''))[:80] or city,
                    'country': str(p.get('country', ''))[:60],
                    'latitude': float(p['latitude']),
                    'longitude': float(p['longitude']),
                    'timezone': str(p.get('timezone', ''))[:60],
                }
                if not place['timezone'] or not (-90 <= place['latitude'] <= 90) \
                        or not (-180 <= place['longitude'] <= 180):
                    place = None
            except (KeyError, TypeError, ValueError):
                place = None

        if not date_str or not (city or place):
            self._send(400, {'ok': False, 'error': 'missing_fields'})
            return
        t_req = time.perf_counter()
        try:
            chart, err = compute_chart(date_str, time_str, time_unknown,
                                       city or (place or {}).get('name', ''), country, place)
        except Exception:
            self._send(200, {'ok': False, 'error': 'calc_failed'})
            return
        if err:
            self._send(200, {'ok': False, 'error': err})
            return
        try:
            chart['meta']['timing']['serverMs'] = round((time.perf_counter() - t_req) * 1000, 1)
        except (KeyError, TypeError):
            pass
        self._send(200, {'ok': True, 'chart': chart})
