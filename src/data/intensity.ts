/**
 * 気象庁 震度階級関連解説表の要約。［スタブ: 調査結果に基づき data 担当が実装］
 */
import type { ShindoLevel } from '../core/types';

export interface IntensityInfo {
  shindo: ShindoLevel;
  /** 表示名（例: 「震度5弱」） */
  label: string;
  /** 人の体感・行動 */
  person: string;
  /** 屋内の状況 */
  indoor: string;
  /** 屋外の状況 */
  outdoor: string;
  /** 揺れアニメーションの強さ（0〜1） */
  shake: number;
  /** 表示色 */
  color: string;
}

const stub = (shindo: ShindoLevel, shake: number, color: string): IntensityInfo => ({
  shindo,
  label: `震度${shindo}`,
  person: '',
  indoor: '',
  outdoor: '',
  shake,
  color,
});

export const INTENSITY_INFO: Record<ShindoLevel, IntensityInfo> = {
  '0': stub('0', 0, '#f2f2f2'),
  '1': stub('1', 0.02, '#e0f0ff'),
  '2': stub('2', 0.05, '#b3dcff'),
  '3': stub('3', 0.1, '#7fc4ff'),
  '4': stub('4', 0.2, '#fff27a'),
  '5-': stub('5-', 0.35, '#ffd24d'),
  '5+': stub('5+', 0.45, '#ffa640'),
  '6-': stub('6-', 0.6, '#ff6633'),
  '6+': stub('6+', 0.8, '#e62e2e'),
  '7': stub('7', 1, '#a3143d'),
};
