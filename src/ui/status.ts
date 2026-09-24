/**
 * 人物の状態（PersonStatus）の表示名・色・説明。
 * people モジュールが公開する PERSON_STATUS_INFO（表示名・色）と DEPTH_THRESHOLDS（浸水深の区分・説明・出典）を
 * 優先して使い、地図上の表示と揃える。形式が変わっても壊れないよう防御的に読む。
 */
import type { Person, PersonStatus } from '../core/types';
import * as peopleModule from '../people';
import { STAY_STATUS_LABEL } from '../people';
import { formatDepth, isSafeColor } from './format';
import { normalizeThresholds } from './series';
import type { IconName } from './icons';

export const STATUS_ORDER: PersonStatus[] = ['waiting', 'evacuating', 'safe', 'caution', 'danger', 'critical'];

interface StatusMeta {
  label: string;
  color: string;
  icon: IconName;
}

const BASE: Record<PersonStatus, StatusMeta> = {
  waiting: { label: '避難開始前', color: '#64748b', icon: 'clock' },
  evacuating: { label: '避難中', color: '#2563eb', icon: 'user' },
  safe: { label: '避難完了', color: '#16a34a', icon: 'check' },
  caution: { label: '浸水（注意）', color: '#ca8a04', icon: 'drop' },
  danger: { label: '歩行困難（危険）', color: '#ea580c', icon: 'alert' },
  critical: { label: '生命の危険', color: '#b91c1c', icon: 'alert' },
};

/** people モジュールの任意のエクスポートを読む（存在しなければ undefined） */
function peopleExport(name: string): unknown {
  return Reflect.get(peopleModule as object, name);
}

export interface ThresholdInfo {
  status: 'caution' | 'danger' | 'critical';
  /** この深さ以上 [m] */
  minDepth: number;
  description?: string;
  source?: string;
  sourceUrl?: string;
}

const DEPTH_STATUSES = ['caution', 'danger', 'critical'] as const;

/**
 * 浸水深の区分（浅い順）。people の DEPTH_THRESHOLDS を読み、
 * status 付きのオブジェクト配列ならそのまま、数値だけなら個数から区分を割り当てる。
 */
export function thresholdInfos(raw: unknown = peopleExport('DEPTH_THRESHOLDS')): ThresholdInfo[] {
  const out: ThresholdInfo[] = [];
  if (Array.isArray(raw) && raw.some((r) => r && typeof r === 'object' && 'status' in r)) {
    for (const r of raw as Record<string, unknown>[]) {
      const status = r?.status;
      const minDepth = typeof r?.minDepth === 'number' ? r.minDepth : normalizeThresholds([r])[0];
      if (!DEPTH_STATUSES.includes(status as never) || !(typeof minDepth === 'number' && Number.isFinite(minDepth))) continue;
      out.push({
        status: status as ThresholdInfo['status'],
        minDepth,
        description: typeof r.description === 'string' ? r.description : undefined,
        source: typeof r.source === 'string' ? r.source : undefined,
        sourceUrl: typeof r.sourceUrl === 'string' && /^https?:\/\//.test(r.sourceUrl) ? r.sourceUrl : undefined,
      });
    }
  } else {
    const nums = normalizeThresholds(raw);
    // 2 個なら「危険」「生命の危険」、3 個なら「注意」から
    const statuses = nums.length >= 3 ? DEPTH_STATUSES : (['danger', 'critical'] as const);
    nums.slice(0, statuses.length).forEach((v, i) => out.push({ status: statuses[i], minDepth: v }));
  }
  return out.sort((a, b) => a.minDepth - b.minDepth);
}

/** 状態ごとの閾値 [m]（無ければ undefined） */
export function thresholdFor(status: ThresholdInfo['status']): ThresholdInfo | undefined {
  return thresholdInfos().find((t) => t.status === status);
}

export function statusMeta(status: PersonStatus): StatusMeta {
  const base = BASE[status] ?? BASE.waiting;
  const info = peopleExport('PERSON_STATUS_INFO') as Record<string, { label?: unknown; color?: unknown }> | undefined;
  const entry = info && typeof info === 'object' ? info[status] : undefined;
  const color = entry && isSafeColor(entry.color) ? entry.color : base.color;
  const label = entry && typeof entry.label === 'string' && entry.label ? entry.label : base.label;
  return { ...base, color, label };
}

/**
 * 人物ごとの状態の見た目。「その場にとどまる」人で浸水していない間は、「避難開始前」ではなく
 * 「とどまっている」と示す（people の personStatusLabel と同じ）。
 */
export function personStatusMeta(status: PersonStatus, person?: Pick<Person, 'evacMode'> | null): StatusMeta {
  const meta = statusMeta(status);
  if (status === 'waiting' && person?.evacMode === 'stay') return { ...meta, label: STAY_STATUS_LABEL, icon: 'pin' };
  return meta;
}

/** 状態の説明文（凡例用）。浸水の区分は people の説明文を優先する */
export function statusDescription(status: PersonStatus): string {
  const caution = thresholdFor('caution');
  const danger = thresholdFor('danger');
  const critical = thresholdFor('critical');
  const range = (lo?: number, hi?: number) =>
    lo !== undefined && hi !== undefined ? `浸水 ${formatDepth(lo)}〜${formatDepth(hi)}未満。` : lo !== undefined ? `浸水 ${formatDepth(lo)}以上。` : '';
  switch (status) {
    case 'waiting':
      return '揺れがおさまるのを待つ・身支度など、避難を始める前';
    case 'evacuating':
      return '避難先へ移動中（現在地は浸水していない）';
    case 'safe':
      return '避難先（避難場所・高台）に到着';
    case 'caution':
      return range(caution?.minDepth, danger?.minDepth) + (caution?.description ?? '足元が浸水し始めている状態');
    case 'danger':
      return range(danger?.minDepth, critical?.minDepth) + (danger?.description ?? '歩いて移動するのが難しい深さの浸水');
    case 'critical':
      return range(critical?.minDepth) + (critical?.description ?? '流されるなど生命に危険が及ぶ深さの浸水');
  }
}

/** 状態の重さ（大きいほど危険） */
export function statusSeverity(status: PersonStatus): number {
  return { waiting: 0, evacuating: 0, safe: 0, caution: 1, danger: 2, critical: 3 }[status] ?? 0;
}
