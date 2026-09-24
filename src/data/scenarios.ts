/**
 * 地震・津波シナリオと震度別プリセット。［スタブ: 調査結果に基づき data 担当が実装］
 */
import type { QuakeScenario, ShindoLevel, SimParams } from '../core/types';

export const SCENARIOS: QuakeScenario[] = [
  {
    id: 'placeholder',
    name: '（仮）シナリオ',
    shortName: '仮',
    magnitude: null,
    shindo: '7',
    coastHeight: 10,
    arrivalMin: 12,
    periodMin: 15,
    firstMotion: 'rise',
    waves: 3,
    shakingSec: 120,
    warning: 'major',
    description: '',
    isOfficial: false,
  },
];

export const SHINDO_PRESETS: Record<ShindoLevel, { scenarioId: string; note: string }> = {
  '0': { scenarioId: 'placeholder', note: '' },
  '1': { scenarioId: 'placeholder', note: '' },
  '2': { scenarioId: 'placeholder', note: '' },
  '3': { scenarioId: 'placeholder', note: '' },
  '4': { scenarioId: 'placeholder', note: '' },
  '5-': { scenarioId: 'placeholder', note: '' },
  '5+': { scenarioId: 'placeholder', note: '' },
  '6-': { scenarioId: 'placeholder', note: '' },
  '6+': { scenarioId: 'placeholder', note: '' },
  '7': { scenarioId: 'placeholder', note: '' },
};

export function getScenario(id: string): QuakeScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function defaultParams(scenario: QuakeScenario): SimParams {
  return { scenario: { ...scenario }, tideTP: 0, durationMin: 60, resolution: 'standard', landManning: 0.06 };
}
