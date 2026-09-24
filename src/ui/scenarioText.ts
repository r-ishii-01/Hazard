/**
 * シナリオの到達時間の表記（「想定」か「設定」か）。
 *
 * 「最大波の到達（想定）」「最大波の想定時刻」と書けるのは、到達時間が公的資料の「最大津波到達時間」
 * （最大の波が来る時刻）そのものの場合だけ（data/scenarios.ts の arrivalIsOfficialMax）。
 * 次の場合は、このサイトが決めた値なので「設定」と書く:
 * - 南海トラフ: 内閣府は最大波の時刻を公表していないため、「津波高+3m」の到達時刻（34分）を代わりに使っている
 * - 説明用の例（公的な想定ではない）
 * - 利用者が「条件を調整する」で到達時間を変えた場合
 *
 * なお、レイヤー・凡例の「津波到達時間」は、計算で各地点が最初に浸水した時刻（別の量）。
 */
import type { QuakeScenario } from '../core/types';
import { arrivalIsOfficialMax, getScenario } from '../data/scenarios';
import { formatMinutes } from './format';

type ArrivalScenario = Pick<QuakeScenario, 'id' | 'arrivalMin' | 'isOfficial'> & { arrivalOfficialMax?: boolean };

/** 到達時間が公的な値（'想定'）か、このサイトの設定値（'設定'）か */
export function arrivalKind(sc: ArrivalScenario): '想定' | '設定' {
  const base = getScenario(sc.id);
  const official = arrivalIsOfficialMax({ isOfficial: sc.isOfficial, arrivalOfficialMax: sc.arrivalOfficialMax ?? base?.arrivalOfficialMax });
  if (!official) return '設定';
  // 到達時間を変更した場合は、公的な値ではない
  if (!base || base.arrivalMin !== sc.arrivalMin) return '設定';
  return '想定';
}

/** 「最大波の到達（想定） 約8分」「最大波の到達（設定） 約34分」 */
export function arrivalFactLabel(sc: ArrivalScenario): string {
  return `最大波の到達（${arrivalKind(sc)}） 約${formatMinutes(sc.arrivalMin)}`;
}

/** タイムラインの目印: 「最大波の想定時刻」「最大波の設定時刻」 */
export function arrivalMarkerLabel(sc: ArrivalScenario): string {
  return `最大波の${arrivalKind(sc)}時刻`;
}

/** シナリオの説明の見出し（レイヤーの「津波到達時間」＝最初に浸水した時刻と区別する） */
export const ARRIVAL_BASIS_LABEL = '最大波の到達時間の根拠';
