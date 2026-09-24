/**
 * 人物（避難者）のモデル。［スタブ: people 担当が実装］
 *
 * 契約:
 * - PERSON_PROFILES: 種別ごとの表示名・既定の歩行速度・既定の避難開始時間
 * - planEvacuation(person, grid, shelters, output, params): 避難経路と到着時刻
 * - personStateAt(person, plan, grid, output, t): 時刻 t の位置・浸水深・状態
 */
import type { EvacPlan, Person, PersonKind, PersonState, Shelter, SimOutput, SimParams, TerrainGrid } from '../core/types';

export interface PersonProfile {
  kind: PersonKind;
  label: string;
  /** 既定の歩行速度 [m/s] */
  speedMps: number;
  /** 既定の避難開始時間 [分] */
  defaultStartDelayMin: number;
  /** 表示色 */
  color: string;
  description: string;
}

export const PERSON_PROFILES: Record<PersonKind, PersonProfile> = {
  adult: { kind: 'adult', label: '大人', speedMps: 1.0, defaultStartDelayMin: 5, color: '#2563eb', description: '' },
  child: { kind: 'child', label: '子ども', speedMps: 1.0, defaultStartDelayMin: 5, color: '#16a34a', description: '' },
  elderly: { kind: 'elderly', label: '高齢者', speedMps: 0.5, defaultStartDelayMin: 5, color: '#9333ea', description: '' },
  wheelchair: { kind: 'wheelchair', label: '車いす', speedMps: 0.5, defaultStartDelayMin: 5, color: '#ea580c', description: '' },
  runner: { kind: 'runner', label: '走って避難', speedMps: 2.0, defaultStartDelayMin: 5, color: '#0891b2', description: '' },
};

export function planEvacuation(
  person: Person,
  _grid: TerrainGrid,
  _shelters: Shelter[],
  _output: SimOutput | null,
  _params: SimParams,
): EvacPlan {
  return { personId: person.id, path: [{ lon: person.lon, lat: person.lat, t: 0 }], target: null, arriveAt: null, distanceM: 0 };
}

export function personStateAt(
  person: Person,
  _plan: EvacPlan | undefined,
  _grid: TerrainGrid | null,
  _output: SimOutput | null,
  _t: number,
): PersonState {
  return { lon: person.lon, lat: person.lat, ground: 0, depth: 0, status: 'waiting', message: '' };
}
