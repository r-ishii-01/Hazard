/**
 * 2D 地図の人物表示（map2d/icons.ts・map2d/people.ts）:
 * 状態の表示名・色が「人物」タブの凡例（people の PERSON_STATUS_INFO）と同じであること、
 * 状態の色の上の文字・印が読みやすいこと、再生中に避難先のソースを更新し直さないこと。
 */
import { describe, expect, it } from 'vitest';
import type { AppActions } from '../src/core/controller';
import type { EvacPlan, Person, PersonStatus } from '../src/core/types';
import { PERSON_STATUS_INFO } from '../src/people';
import { STATUS_STYLE, inkOn } from '../src/map2d/icons';
import { PeopleLayer, type PeopleContext } from '../src/map2d/people';
import { IDS } from '../src/map2d/style';

const STATUSES: PersonStatus[] = ['waiting', 'evacuating', 'safe', 'caution', 'danger', 'critical'];

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('状態の表示（2D 地図）', () => {
  it('表示名・色は「人物」タブの凡例（PERSON_STATUS_INFO）と同じ', () => {
    for (const st of STATUSES) {
      expect(STATUS_STYLE[st].label).toBe(PERSON_STATUS_INFO[st].label);
      expect(STATUS_STYLE[st].color.toLowerCase()).toBe(PERSON_STATUS_INFO[st].color.toLowerCase());
    }
  });

  it('状態の色の上の文字（浸水深の札・バッジ）はコントラスト比 4.5 以上', () => {
    for (const st of STATUSES) {
      const s = STATUS_STYLE[st];
      expect(contrast(s.color, s.ink)).toBeGreaterThanOrEqual(4.5);
    }
    expect(inkOn('#ffffff')).toBe('#0f172a');
    expect(inkOn('#0f172a')).toBe('#ffffff');
  });
});

describe('経路・避難先の更新（2D 地図）', () => {
  function fakeMap() {
    const calls: Record<string, number> = {};
    const sources = new Map<string, { setData: (d: unknown) => Promise<void> }>();
    for (const id of [IDS.routeSource, IDS.targetSource]) {
      calls[id] = 0;
      sources.set(id, {
        setData: () => {
          calls[id]++;
          return Promise.resolve();
        },
      });
    }
    return { map: { getSource: (id: string) => sources.get(id) }, calls };
  }

  const person: Person = { id: 'p1', name: '大人 1', kind: 'adult', lon: 139.47, lat: 35.32, evacMode: 'shelter', startDelayMin: 5 };
  const plan: EvacPlan = {
    personId: 'p1',
    path: [
      { lon: 139.47, lat: 35.32, t: 300 },
      { lon: 139.471, lat: 35.321, t: 400 },
      { lon: 139.472, lat: 35.323, t: 600 },
    ],
    target: { lon: 139.472, lat: 35.323, name: '避難場所', kind: 'evac-site' },
    arriveAt: 600,
    distanceM: 300,
  };
  const ctx = (t: number, selectedId: string | null = null): PeopleContext => ({
    people: [person],
    plans: { p1: plan },
    selectedId,
    grid: null,
    output: null,
    t,
    playing: true,
  });

  it('歩いている間、経路は更新するが、変わらない避難先は更新し直さない', () => {
    const { map, calls } = fakeMap();
    const layer = new PeopleLayer(map as never, {} as AppActions, () => null, () => undefined);
    for (let t = 300; t <= 500; t += 5) layer.updateRoutes(ctx(t));
    expect(calls[IDS.routeSource]).toBeGreaterThan(30);
    expect(calls[IDS.targetSource]).toBe(1);
    expect(layer.setDataCount).toEqual({ routes: calls[IDS.routeSource], targets: 1 });
    // 同じ時刻・同じ内容なら何もしない
    layer.updateRoutes(ctx(500));
    expect(calls[IDS.routeSource]).toBe(layer.setDataCount.routes);
  });

  it('計算結果への参照を手放せる（新しい計算が始まったとき）', () => {
    const { map } = fakeMap();
    const layer = new PeopleLayer(map as never, {} as AppActions, () => null, () => undefined);
    const out = { spec: {} } as never;
    layer.update({ ...ctx(0), people: [], output: out });
    layer.dropOutput(null);
    expect((layer as unknown as { lastCtx: PeopleContext }).lastCtx.output).toBeNull();
    // 今の結果は手放さない
    layer.update({ ...ctx(0), people: [], output: out });
    layer.dropOutput(out);
    expect((layer as unknown as { lastCtx: PeopleContext }).lastCtx.output).toBe(out);
  });
});
