/**
 * 主な地点（ランドマーク）。
 *
 * 座標の決め方（2026年9月24日に確認）:
 * - 駅: OpenStreetMap の駅ノード（railway=station）の位置。Nominatim（https://nominatim.openstreetmap.org/ ）で
 *   運営会社（operator）と名前を確認し、国土地理院 地名検索 API
 *   （https://msearch.gsi.go.jp/address-search/AddressSearch?q=駅名 ）の結果、地理院タイル（標準地図 z17）の駅の位置と照合した。
 *   地理院の地名検索が返すのは地図上の注記（文字）の位置で、駅そのものから数百m離れることがある
 *   （例: 片瀬江ノ島駅・湘南海岸公園駅は注記が約400〜450m西）ため、駅には使っていない。
 * - 施設・公園: 地名検索 API の施設の位置（dataSource=3）または OSM の位置を、標準地図・写真（z17）で確認。
 * - 河口: 地理院地図（標準地図 z16〜17）で川が海に出る地点（導流堤の先端の間）を読み取った。
 * - 標高 elevationTP: 国土地理院 標高 API（https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php
 *   ?lon=..&lat=..&outtype=JSON、仕様 https://maps.gsi.go.jp/development/elevation_s.html ）の値 [m]。
 *   すべて hsrc=「1m（レーザ）」（航空レーザ測量の 1m DEM、0.1m 単位）。標高は東京湾平均海面（T.P.）基準。
 *   DEM は建物・高架を除いた地面の高さなので、高架の駅ホームや橋の上の高さではない。
 *   水面・橋の地点（河口・大橋）は地面の標高として意味がないので入れていない。
 * すべて計算範囲（DOMAIN_BOUNDS: 東経139.44〜139.50°、北緯35.29〜35.345°）の内側にある。
 */
export interface Poi {
  id: string;
  name: string;
  lon: number;
  lat: number;
  kind: 'station' | 'landmark' | 'river' | 'park';
  source?: string;
  /** 地面の標高 [m, T.P.]（国土地理院 標高 API の値） */
  elevationTP?: number;
  /** 路線・補足（画面表示用） */
  detail?: string;
}

/** 標高 API の出典表記 */
const ELEV = '標高: 国土地理院 標高API（1mメッシュ・航空レーザ測量）';

/**
 * 地点の位置・標高の出典表記（HTML）。位置の一部は OpenStreetMap のデータ（ODbL）なので、
 * 地点を表示するときは「© OpenStreetMap contributors」を表示する（https://www.openstreetmap.org/copyright ）。
 */
export const POI_ATTRIBUTION =
  '地点の位置: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>・国土地理院 地名検索、標高: 国土地理院 標高API';

export const POIS: Poi[] = [
  // ---- 駅 ------------------------------------------------------------------
  {
    id: 'st-kugenuma-kaigan',
    name: '鵠沼海岸駅',
    // OSM node 10108140339（operator=小田急電鉄）。地理院の注記 (139.47135, 35.32086) と約18m
    lon: 139.47127,
    lat: 35.32071,
    kind: 'station',
    detail: '小田急江ノ島線',
    elevationTP: 4.2,
    source: `位置: OpenStreetMap（国土地理院 地名検索・標準地図と照合） / ${ELEV}`,
  },
  {
    id: 'st-katase-enoshima',
    name: '片瀬江ノ島駅',
    // OSM node 264240233（operator=小田急電鉄）。標準地図 z17 で小田急線の終端（駅舎）に一致
    lon: 139.4835,
    lat: 35.30887,
    kind: 'station',
    detail: '小田急江ノ島線',
    elevationTP: 4.1,
    source: `位置: OpenStreetMap（国土地理院 標準地図と照合） / ${ELEV}`,
  },
  {
    id: 'st-enoden-kugenuma',
    name: '鵠沼駅',
    // OSM node 8062865734（operator=江ノ島電鉄）。地理院の注記 (139.48271, 35.32118) と約29m
    lon: 139.4826,
    lat: 35.32142,
    kind: 'station',
    detail: '江ノ島電鉄',
    elevationTP: 5.9,
    source: `位置: OpenStreetMap（国土地理院 地名検索と照合） / ${ELEV}`,
  },
  {
    id: 'st-enoden-enoshima',
    name: '江ノ島駅',
    // OSM node 8062865735（operator=江ノ島電鉄）。地理院の注記 (139.48805, 35.31100) と約47m
    lon: 139.48754,
    lat: 35.31105,
    kind: 'station',
    detail: '江ノ島電鉄',
    elevationTP: 4.4,
    source: `位置: OpenStreetMap（国土地理院 地名検索と照合） / ${ELEV}`,
  },
  {
    id: 'st-shonan-kaigan-koen',
    name: '湘南海岸公園駅',
    // OSM node 8063967424（operator=江ノ島電鉄）。標準地図 z17 で江ノ電の線路上
    lon: 139.48364,
    lat: 35.31495,
    kind: 'station',
    detail: '江ノ島電鉄',
    elevationTP: 4.0,
    source: `位置: OpenStreetMap（国土地理院 標準地図と照合） / ${ELEV}`,
  },
  {
    id: 'st-fujisawa',
    name: '藤沢駅',
    // OSM node 4011607028（JR 東日本の駅ノード）。地理院の注記 (139.48639, 35.33848) と約84m。
    // OSM の小田急の駅ノードは約40m南東、江ノ電の駅ノードは約180m南にある
    lon: 139.48721,
    lat: 35.33882,
    kind: 'station',
    detail: 'JR東海道線・小田急江ノ島線・江ノ島電鉄',
    elevationTP: 13.0,
    source: `位置: OpenStreetMap（国土地理院 地名検索・標準地図と照合） / ${ELEV}`,
  },

  // ---- 江の島・片瀬 --------------------------------------------------------------
  {
    id: 'lm-hetsunomiya',
    name: '江島神社 辺津宮',
    // OSM way 191660159（amenity=place_of_worship「江島神社 辺津宮」）の中心
    lon: 139.47954,
    lat: 35.30049,
    kind: 'landmark',
    detail: '江の島',
    elevationTP: 46.0,
    source: `位置: OpenStreetMap / ${ELEV}`,
  },
  {
    id: 'lm-enoshima-ohashi-north',
    name: '江の島大橋（北詰）',
    // OSM の橋（way 335334813「江ノ島大橋」、国土地理院の注記は「江ノ島大橋」(139.48329, 35.30523)）の北端。
    // 片瀬の砂浜の上から橋になっている（写真 z17 で確認）。標高は橋の下の砂浜の値になるので入れない
    lon: 139.4828,
    lat: 35.3056,
    kind: 'landmark',
    detail: '片瀬海岸と江の島を結ぶ橋（北端）',
    source: '位置: OpenStreetMap（国土地理院 地名検索・写真と照合）',
  },
  {
    id: 'lm-enoshima-aquarium',
    name: '新江ノ島水族館',
    // 地名検索（施設）(139.47946, 35.30993)、OSM way 727347470 の中心 (139.47944, 35.31008)
    lon: 139.47944,
    lat: 35.31008,
    kind: 'landmark',
    detail: '片瀬海岸二丁目',
    elevationTP: 6.0,
    source: `位置: OpenStreetMap・国土地理院 地名検索 / ${ELEV}`,
  },

  // ---- 公園 ------------------------------------------------------------------
  {
    id: 'pk-kugenuma-kaihin',
    name: '鵠沼海浜公園',
    // 地名検索（施設）の位置。所在地は藤沢市鵠沼海岸四丁目4番1号、愛称 HUG-RIDE PARK、面積約1.6ha
    // （藤沢市「鵠沼海浜公園（HUG-RIDE PARK）の紹介」
    //  https://www.city.fujisawa.kanagawa.jp/kouen/kyoiku/leisure/koen/fujisawashi/skatepark/hugridepark_20240517.html ）。
    // 引地川の西、国道134号の海側。国土地理院の逆ジオコーダーでも「鵠沼海岸四丁目」。
    // OSM のスケートパーク（way 1450872533「Hug-Ride Park」、東経139.46486〜139.46633）と
    // その東の駐車場（way 1450872534、139.46621〜139.46737）の境目付近で、両者を合わせた範囲の中心から約37m南。
    // 写真 z17 でも公園の施設（スケートパーク・駐車場・店舗棟）の範囲内
    lon: 139.46619,
    lat: 35.31617,
    kind: 'park',
    detail: '鵠沼海岸四丁目（愛称 HUG-RIDE PARK。スケートパーク等）',
    elevationTP: 3.8,
    source: `位置: 国土地理院 地名検索（写真で確認） / ${ELEV}`,
  },
  {
    id: 'pk-tsujido-kaihin',
    name: '辻堂海浜公園',
    // OSM way 164139709（leisure=park）の中心。地名検索（施設）(139.44804, 35.32099) と約34m。
    // 「神奈川県立 辻堂海浜公園」、所在地 藤沢市辻堂西海岸3-2（公式サイト https://www.kanagawa-park.or.jp/tujidou/ ）
    lon: 139.44817,
    lat: 35.32128,
    kind: 'park',
    detail: '神奈川県立',
    elevationTP: 6.7,
    source: `位置: OpenStreetMap・国土地理院 地名検索 / ${ELEV}`,
  },

  // ---- 河口 ------------------------------------------------------------------
  {
    id: 'rv-hikichi-mouth',
    name: '引地川河口',
    // 標準地図 z17 で両岸の導流堤の先端の間（国土地理院の自然地名「引地川」(139.46829, 35.31507) の約20m南）
    lon: 139.4684,
    lat: 35.3149,
    kind: 'river',
    detail: '鵠沼海岸（鵠沼橋の下流）',
    source: '位置: 国土地理院 標準地図から読み取り',
  },
  {
    id: 'rv-sakai-mouth',
    name: '境川河口',
    // 国土地理院の自然地名「境川」の位置。標準地図 z17 で片瀬漁港の東、江の島大橋の西の河口部の水面上
    lon: 139.48123,
    lat: 35.30537,
    kind: 'river',
    detail: '片瀬（片瀬漁港の東）',
    source: '位置: 国土地理院 地名検索（標準地図で確認）',
  },

  // ---- 公共施設 ---------------------------------------------------------------
  {
    id: 'lm-fujisawa-city-hall',
    name: '藤沢市役所',
    // 地名検索（施設）(139.49125, 35.33888)、OSM node 1420832774 (139.49112, 35.33887)
    lon: 139.49112,
    lat: 35.33887,
    kind: 'landmark',
    detail: '朝日町1番地の1（市ウェブサイトの所在地表記）',
    elevationTP: 12.8,
    source: `位置: OpenStreetMap・国土地理院 地名検索 / ${ELEV}`,
  },
];
