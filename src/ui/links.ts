/**
 * UI に表示する公的情報へのリンク（URL は各機関の公開ページ）。
 */
import * as warningsModule from '../data/warnings';

/** 藤沢市 津波ハザードマップ */
export const FUJISAWA_TSUNAMI_HAZARDMAP_URL = 'https://www.city.fujisawa.kanagawa.jp/bousai/bosai/bosai/hazardmap/tsunami/h25hazardmap.html';

/** 神奈川県 津波浸水想定 */
export const KANAGAWA_TSUNAMI_SHINSUI_URL = 'http://www.pref.kanagawa.jp/docs/f4i/cnt/f532320/index.html';

/** 気象庁 震度階級関連解説表 */
export const JMA_SHINDO_TABLE_URL = 'https://www.jma.go.jp/jma/kishou/know/shindo/kaisetsu.html';

/**
 * 気象庁「津波警報・注意報、津波情報、津波予報について」
 * （「地震が発生してから約3分を目標に大津波警報、津波警報または津波注意報を発表」）
 * data/warnings.ts が出典 URL を公開していればそれに揃える。
 */
const JMA_TSUNAMI_FROM_DATA = Reflect.get(warningsModule as object, 'JMA_TSUNAMI_INFO_URL');
export const JMA_TSUNAMI_WARNING_URL =
  typeof JMA_TSUNAMI_FROM_DATA === 'string' && /^https?:\/\//.test(JMA_TSUNAMI_FROM_DATA)
    ? JMA_TSUNAMI_FROM_DATA
    : 'https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunamiinfo.html';

/** 国土地理院 標高タイル */
export const GSI_DEM_TILE_URL = 'https://maps.gsi.go.jp/development/demtile.html';

/** ハザードマップポータルサイト */
export const DISAPORTAL_URL = 'https://disaportal.gsi.go.jp/';

/** 国土地理院 指定緊急避難場所データ */
export const GSI_SHELTER_DATA_URL = 'https://www.gsi.go.jp/bousaichiri/hinanbasho.html';
