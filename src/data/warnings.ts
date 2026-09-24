/**
 * 気象庁の津波警報・注意報の区分。［スタブ: 調査結果に基づき data 担当が実装］
 */
import type { WarningLevel } from '../core/types';

export interface WarningInfo {
  level: WarningLevel;
  /** 例: 「大津波警報」 */
  label: string;
  /** 予想される津波の高さの区分（例: 「3mを超える」） */
  heightRange: string;
  /** 発表される数値（例: 「10m超, 10m, 5m」） */
  announced: string;
  /** 想定される被害 */
  damage: string;
  /** とるべき行動 */
  action: string;
  color: string;
  textColor: string;
}

export const WARNING_INFO: Record<WarningLevel, WarningInfo> = {
  none: { level: 'none', label: '津波の心配なし', heightRange: '', announced: '', damage: '', action: '', color: '#e5e7eb', textColor: '#111827' },
  forecast: { level: 'forecast', label: '津波予報（若干の海面変動）', heightRange: '', announced: '', damage: '', action: '', color: '#dbeafe', textColor: '#1e3a8a' },
  advisory: { level: 'advisory', label: '津波注意報', heightRange: '', announced: '', damage: '', action: '', color: '#facc15', textColor: '#111827' },
  warning: { level: 'warning', label: '津波警報', heightRange: '', announced: '', damage: '', action: '', color: '#dc2626', textColor: '#ffffff' },
  major: { level: 'major', label: '大津波警報', heightRange: '', announced: '', damage: '', action: '', color: '#7e22ce', textColor: '#ffffff' },
};

/** 予想される津波の高さ [m] から区分を返す */
export function warningForHeight(heightM: number): WarningLevel {
  if (heightM > 3) return 'major';
  if (heightM > 1) return 'warning';
  if (heightM >= 0.2) return 'advisory';
  if (heightM > 0) return 'forecast';
  return 'none';
}
