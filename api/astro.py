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
import urllib.parse
import urllib.request
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

import swisseph as swe

EPHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ephe')
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


def geocode(city, country):
    q = urllib.parse.urlencode({
        'name': city, 'count': 5, 'language': 'zh', 'format': 'json',
    })
    url = f'https://geocoding-api.open-meteo.com/v1/search?{q}'
    with urllib.request.urlopen(url, timeout=8) as r:
        data = json.loads(r.read().decode('utf-8'))
    results = data.get('results') or []
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


def compute_chart(date_str, time_str, time_unknown, city, country):
    warnings = []

    place = geocode(city, country)
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
        if not date_str or not city:
            self._send(400, {'ok': False, 'error': 'missing_fields'})
            return
        try:
            chart, err = compute_chart(date_str, time_str, time_unknown, city, country)
        except Exception:
            self._send(200, {'ok': False, 'error': 'calc_failed'})
            return
        if err:
            self._send(200, {'ok': False, 'error': err})
            return
        self._send(200, {'ok': True, 'chart': chart})
