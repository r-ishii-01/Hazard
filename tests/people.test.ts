import { describe, expect, it } from 'vitest';
import { cellCenter, createGridSpec, lonLatToGridXY, type GridSpec } from '../src/core/geo';
import {
  CELL_LAND,
  CELL_SEA,
  type EvacPlan,
  type Person,
  type PersonKind,
  type QuakeScenario,
  type Shelter,
  type SimOutput,
  type SimParams,
  type TerrainGrid,
} from '../src/core/types';
import {
  DEPTH_THRESHOLDS,
  PERSON_PROFILES,
  classifyDepth,
  personStateAt,
  personTimeline,
  planEvacuation,
} from '../src/people';
import { PASS_BLOCKED, PASS_LAND, PASS_WATER_CROSS, computePassability, getGridContext, type GridContext } from '../src/people/gridctx';
import {
  NEIGHBOR_DI,
  NEIGHBOR_DJ,
  WALK_COST,
  WHEELCHAIR_COST,
  reconstruct,
  searchPath,
  stepCost,
  type CostModel,
} from '../src/people/pathfind';
import { personSpeed } from '../src/people/plan';
import { CELL_INLAND_WATER } from '../src/core/types';

// ---------------------------------------------------------------------------
// テスト用の地形・計算結果
// ---------------------------------------------------------------------------

function smallSpec(nx: number, ny: number): GridSpec {
  return { ...createGridSpec('standard'), nx, ny };
}

function makeGrid(spec: GridSpec, fn: (i: number, j: number) => { z: number; kind?: number }): TerrainGrid {
  const n = spec.nx * spec.ny;
  const z = new Float32Array(n);
  const kind = new Uint8Array(n);
  for (let j = 0; j < spec.ny; j++) {
    for (let i = 0; i < spec.nx; i++) {
      const c = fn(i, j);
      z[j * spec.nx + i] = c.z;
      kind[j * spec.nx + i] = c.kind ?? CELL_LAND;
    }
  }
  return {
    spec,
    z,
    kind,
    manning: new Float32Array(n).fill(0.025),
    source: 'synthetic',
    sourceLabel: 'test',
    isApproximate: true,
    notes: [],
  };
}

const SCENARIO: QuakeScenario = {
  id: 'test',
  name: 'テスト',
  shortName: 'テスト',
  magnitude: 8,
  shindo: '7',
  coastHeight: 5,
  arrivalMin: 10,
  periodMin: 15,
  firstMotion: 'rise',
  waves: 3,
  shakingSec: 60,
  warning: 'major',
  description: '',
  isOfficial: false,
};

function paramsWith(coastHeight = 5): SimParams {
  return { scenario: { ...SCENARIO, coastHeight }, tideTP: 0, durationMin: 60, resolution: 'standard', landManning: 0.06 };
}

let seq = 0;
function personAt(spec: GridSpec, i: number, j: number, patch: Partial<Person> = {}): Person {
  const c = cellCenter(spec, i, j);
  seq++;
  return { id: `p${seq}`, name: `人${seq}`, kind: 'adult', lon: c.lon, lat: c.lat, evacMode: 'shelter', startDelayMin: 5, ...patch };
}

function shelterAt(spec: GridSpec, i: number, j: number, name = '避難場所A'): Shelter {
  const c = cellCenter(spec, i, j);
  return { id: `s-${name}`, name, lon: c.lon, lat: c.lat, kind: 'evac-site', source: 'test' };
}

interface FakeOutputOptions {
  depth: (t: number, k: number) => number;
  maxDepth?: Float32Array;
  arrival?: Float32Array;
  durationSec?: number;
  frameInterval?: number;
  /** 受信済み時刻（関数なら呼ぶたびに評価） */
  ready?: number | (() => number);
}

function fakeOutput(spec: GridSpec, o: FakeOutputOptions): SimOutput {
  const n = spec.nx * spec.ny;
  const durationSec = o.durationSec ?? 3600;
  const frameInterval = o.frameInterval ?? 10;
  const ready = () => (typeof o.ready === 'function' ? o.ready() : (o.ready ?? durationSec));
  return {
    spec,
    frameInterval,
    durationSec,
    framesReady: () => Math.floor(ready() / frameInterval) + 1,
    timeReady: () => ready(),
    depthAt: (t, k) => o.depth(Math.min(t, ready()), k),
    etaAt: () => NaN,
    fillDepth: () => {},
    maxDepth: o.maxDepth ?? new Float32Array(n),
    maxEta: new Float32Array(n),
    arrival: o.arrival ?? new Float32Array(n).fill(Infinity),
    gauge: { t: new Float32Array(0), eta: new Float32Array(0), lon: 0, lat: 0, count: () => 0 },
    achievedCoastMax: () => 0,
    calibration: { targetCoastHeight: 0, boundaryAmplitude: 0 },
  };
}

function cellOfPoint(spec: GridSpec, lon: number, lat: number): { i: number; j: number } {
  const { gx, gy } = lonLatToGridXY(spec, lon, lat);
  return { i: Math.floor(gx), j: Math.floor(gy) };
}

/** 経路の各線分を細かくたどり、通過するセルを列挙する */
function cellsAlongPath(spec: GridSpec, plan: EvacPlan): { i: number; j: number }[] {
  const out: { i: number; j: number }[] = [];
  for (let s = 1; s < plan.path.length; s++) {
    const a = lonLatToGridXY(spec, plan.path[s - 1].lon, plan.path[s - 1].lat);
    const b = lonLatToGridXY(spec, plan.path[s].lon, plan.path[s].lat);
    const steps = Math.ceil(Math.hypot(b.gx - a.gx, b.gy - a.gy) * 8) + 1;
    for (let q = 0; q <= steps; q++) {
      const f = q / steps;
      out.push({ i: Math.floor(a.gx + (b.gx - a.gx) * f), j: Math.floor(a.gy + (b.gy - a.gy) * f) });
    }
  }
  return out;
}

function pathLengthM(spec: GridSpec, plan: EvacPlan): number {
  let d = 0;
  for (let s = 1; s < plan.path.length; s++) {
    const a = lonLatToGridXY(spec, plan.path[s - 1].lon, plan.path[s - 1].lat);
    const b = lonLatToGridXY(spec, plan.path[s].lon, plan.path[s].lat);
    d += Math.hypot(b.gx - a.gx, b.gy - a.gy) * spec.dx;
  }
  return d;
}

// ---------------------------------------------------------------------------

describe('PERSON_PROFILES / DEPTH_THRESHOLDS', () => {
  it('uses the official guideline speeds (1.0 m/s, 0.5 m/s for people with walking difficulty)', () => {
    expect(PERSON_PROFILES.adult.speedMps).toBe(1.0);
    expect(PERSON_PROFILES.elderly.speedMps).toBe(0.5);
    expect(PERSON_PROFILES.wheelchair.speedMps).toBe(0.5);
    expect(PERSON_PROFILES.runner.speedIsAssumption).toBe(true);
    // 消防庁指針の 0.5m/s は「歩行困難者・身体障がい者・乳幼児・重病人等」。高齢者一般への当てはめは仮定
    expect(PERSON_PROFILES.elderly.speedIsAssumption).toBe(true);
    expect(PERSON_PROFILES.adult.speedIsAssumption).toBe(false);
    for (const kind of Object.keys(PERSON_PROFILES) as PersonKind[]) {
      const p = PERSON_PROFILES[kind];
      expect(p.kind).toBe(kind);
      expect(p.defaultStartDelayMin).toBe(5);
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('classifies depth into caution / danger / critical with sources', () => {
    expect(DEPTH_THRESHOLDS.map((d) => d.status)).toEqual(['caution', 'danger', 'critical']);
    expect(DEPTH_THRESHOLDS.map((d) => d.minDepth)).toEqual([0.01, 0.3, 1.0]);
    for (const th of DEPTH_THRESHOLDS) expect(th.sourceUrl).toMatch(/^https:\/\//);
    expect(classifyDepth(0)).toBeNull();
    expect(classifyDepth(0.005)).toBeNull();
    expect(classifyDepth(0.2)?.status).toBe('caution');
    expect(classifyDepth(0.3)?.status).toBe('danger');
    expect(classifyDepth(0.99)?.status).toBe('danger');
    expect(classifyDepth(1.0)?.status).toBe('critical');
  });
});

describe('passability (narrow water crossings)', () => {
  it('marks narrow rivers crossable and wide sea blocked', () => {
    const spec = smallSpec(40, 20);
    // i=10..11: 川（幅2セル≒31m）, i=25..34: 広い水域（幅10セル≒156m）
    const grid = makeGrid(spec, (i) => ({
      z: 5,
      kind: (i >= 10 && i <= 11) || (i >= 25 && i <= 34) ? CELL_SEA : CELL_LAND,
    }));
    const pass = computePassability(grid);
    expect(pass[5 * 40 + 10]).toBe(PASS_WATER_CROSS);
    expect(pass[5 * 40 + 11]).toBe(PASS_WATER_CROSS);
    expect(pass[5 * 40 + 30]).toBe(PASS_BLOCKED);
    expect(pass[5 * 40 + 5]).toBe(PASS_LAND);
  });

  it('does not treat open sea reaching the grid edge as crossable', () => {
    const spec = smallSpec(30, 30);
    // 南側 2 行だけが海（グリッド端に接する）
    const grid = makeGrid(spec, (_i, j) => ({ z: j >= 28 ? -5 : 3, kind: j >= 28 ? CELL_SEA : CELL_LAND }));
    const pass = computePassability(grid);
    expect(pass[29 * 30 + 15]).toBe(PASS_BLOCKED);
  });
});

describe('planEvacuation', () => {
  it('stay mode does not move', () => {
    const spec = smallSpec(20, 20);
    const grid = makeGrid(spec, () => ({ z: 2 }));
    const person = personAt(spec, 5, 5, { evacMode: 'stay' });
    const plan = planEvacuation(person, grid, [shelterAt(spec, 15, 15)], null, paramsWith());
    expect(plan.path).toHaveLength(1);
    expect(plan.path[0]).toMatchObject({ lon: person.lon, lat: person.lat });
    expect(plan.target).toBeNull();
    expect(plan.arriveAt).toBeNull();
    expect(plan.distanceM).toBe(0);
    const st = personStateAt(person, plan, grid, null, 1800);
    expect(st.status).toBe('waiting');
    expect(st.lon).toBeCloseTo(person.lon, 10);
    expect(st.message).toContain('とどまって');
  });

  it('walks around an obstacle and never crosses wide water', () => {
    const spec = smallSpec(40, 30);
    // i=20..27, j=0..24 は広い水域（北端に接する）。南側 j>=25 だけが通れる
    const isWall = (i: number, j: number) => i >= 20 && i <= 27 && j <= 24;
    const grid = makeGrid(spec, (i, j) => ({ z: isWall(i, j) ? -3 : 2, kind: isWall(i, j) ? CELL_SEA : CELL_LAND }));
    const person = personAt(spec, 5, 10);
    const shelter = shelterAt(spec, 35, 10);
    const plan = planEvacuation(person, grid, [shelter], null, paramsWith());
    expect(plan.target?.name).toBe('避難場所A');
    expect(plan.target?.kind).toBe('evac-site');
    for (const c of cellsAlongPath(spec, plan)) expect(isWall(c.i, c.j)).toBe(false);
    expect(plan.path.some((p) => cellOfPoint(spec, p.lon, p.lat).j >= 25)).toBe(true);
    const straight = 30 * spec.dx;
    expect(plan.distanceM).toBeGreaterThan(straight * 1.4);
    expect(plan.distanceM).toBeCloseTo(pathLengthM(spec, plan), 3);
    // 平滑化で点数が少ない（セルごとの点列ではない）
    expect(plan.path.length).toBeLessThan(10);
    // 終点は避難場所の正確な位置
    const last = plan.path[plan.path.length - 1];
    expect(last.lon).toBeCloseTo(shelter.lon, 9);
    expect(last.lat).toBeCloseTo(shelter.lat, 9);
  });

  it('cannot cross a wide channel; falls back to the highest nearby point', () => {
    const spec = smallSpec(40, 20);
    const channel = (i: number) => i >= 15 && i <= 24; // 幅10セル≒156m、南北に貫通
    const grid = makeGrid(spec, (i, j) => ({
      z: channel(i) ? -4 : i < 15 ? 1 + (j === 3 && i === 4 ? 1 : 0) : 10,
      kind: channel(i) ? CELL_SEA : CELL_LAND,
    }));
    const person = personAt(spec, 8, 10);
    const plan = planEvacuation(person, grid, [shelterAt(spec, 32, 10)], null, paramsWith(5));
    expect(plan.target).not.toBeNull();
    expect(plan.target!.kind).toBe('highground');
    expect(plan.target!.name).toContain('近くで最も高い地点');
    for (const c of cellsAlongPath(spec, plan)) expect(channel(c.i)).toBe(false);
    const end = cellOfPoint(spec, plan.target!.lon, plan.target!.lat);
    expect(end).toEqual({ i: 4, j: 3 });
  });

  it('crosses a narrow river, preferring a nearby bridge because of the crossing penalty', () => {
    const spec = smallSpec(40, 30);
    const river = (i: number, j: number, bridgeJ: number) => (i === 20 || i === 21) && j !== bridgeJ;
    const run = (bridgeJ: number) => {
      const grid = makeGrid(spec, (i, j) => ({ z: river(i, j, bridgeJ) ? -1 : 2, kind: river(i, j, bridgeJ) ? CELL_SEA : CELL_LAND }));
      const person = personAt(spec, 10, 10);
      const plan = planEvacuation(person, grid, [shelterAt(spec, 30, 10)], null, paramsWith());
      return { plan, cells: cellsAlongPath(spec, plan) };
    };
    // 2セル先に陸の橋がある → 川を直接渡らず橋を使う
    const near = run(12);
    expect(near.plan.target?.name).toBe('避難場所A');
    const crossNear = near.cells.filter((c) => c.i === 20 || c.i === 21);
    expect(crossNear.length).toBeGreaterThan(0);
    for (const c of crossNear) expect(c.j).toBe(12);
    // 橋が遠い（端） → ペナルティ付きで川を渡る
    const far = run(29);
    expect(far.plan.target?.name).toBe('避難場所A');
    const crossFar = far.cells.filter((c) => c.i === 20 || c.i === 21);
    expect(crossFar.some((c) => c.j !== 29)).toBe(true);
    expect(far.plan.distanceM).toBeLessThan(25 * spec.dx);
  });

  it('applies departure delay and walking speed', () => {
    const spec = smallSpec(40, 10);
    const grid = makeGrid(spec, () => ({ z: 2 }));
    const shelters = [shelterAt(spec, 35, 5)];
    const params = paramsWith();
    const adult = personAt(spec, 5, 5, { startDelayMin: 5 });
    const pa = planEvacuation(adult, grid, shelters, null, params);
    expect(pa.path[0].t).toBe(300);
    expect(pa.distanceM).toBeCloseTo(30 * spec.dx, 1);
    expect(pa.arriveAt).toBeCloseTo(300 + pa.distanceM / 1.0, 6);
    const elderly = personAt(spec, 5, 5, { kind: 'elderly', startDelayMin: 10 });
    const pe = planEvacuation(elderly, grid, shelters, null, params);
    expect(pe.path[0].t).toBe(600);
    expect(pe.arriveAt).toBeCloseTo(600 + pe.distanceM / 0.5, 6);
    const custom = personAt(spec, 5, 5, { speedMps: 2.5, startDelayMin: 0 });
    const pc = planEvacuation(custom, grid, shelters, null, params);
    expect(pc.arriveAt).toBeCloseTo(pc.distanceM / 2.5, 6);
    // 時刻は単調増加で、区間長 / 速度 に一致
    for (let s = 1; s < pa.path.length; s++) expect(pa.path[s].t).toBeGreaterThanOrEqual(pa.path[s - 1].t);
  });

  it('highground without sim output: nearest land at least coastHeight + 1 m', () => {
    const spec = smallSpec(30, 40);
    // 北ほど高い: z = 20 - 0.5 j（j=0 で 20m、j=39 で 0.5m）
    const grid = makeGrid(spec, (_i, j) => ({ z: 20 - 0.5 * j }));
    const person = personAt(spec, 15, 35, { evacMode: 'highground' });
    const plan = planEvacuation(person, grid, [], null, paramsWith(5));
    expect(plan.target?.kind).toBe('highground');
    expect(plan.target?.name).toContain('想定津波高');
    const end = cellOfPoint(spec, plan.target!.lon, plan.target!.lat);
    const zEnd = 20 - 0.5 * end.j;
    expect(zEnd).toBeGreaterThanOrEqual(6);
    expect(zEnd).toBeLessThan(7); // 最寄り（必要以上に登らない）
    // 高い想定では、より北へ
    const plan2 = planEvacuation(person, grid, [], null, paramsWith(12));
    const end2 = cellOfPoint(spec, plan2.target!.lon, plan2.target!.lat);
    expect(20 - 0.5 * end2.j).toBeGreaterThanOrEqual(13);
  });

  it('highground with a complete sim output: never-inundated cells with a buffer', () => {
    const spec = smallSpec(30, 40);
    const n = 30 * 40;
    const grid = makeGrid(spec, (_i, j) => ({ z: 2 + 0.02 * (39 - j) })); // 標高条件だけなら安全な場所はない
    const maxDepth = new Float32Array(n);
    const arrival = new Float32Array(n).fill(Infinity);
    for (let j = 10; j < 40; j++) {
      for (let i = 0; i < 30; i++) {
        maxDepth[j * 30 + i] = 1;
        arrival[j * 30 + i] = 900;
      }
    }
    const out = fakeOutput(spec, { depth: () => 0, maxDepth, arrival });
    const person = personAt(spec, 15, 30, { evacMode: 'highground' });
    const plan = planEvacuation(person, grid, [], out, paramsWith(5));
    expect(plan.target?.name).toContain('浸水しなかった');
    const end = cellOfPoint(spec, plan.target!.lon, plan.target!.lat);
    // 浸水域（j>=10）から 2 セル（30m / 15.6m → 2）以上離れる
    expect(end.j).toBeLessThanOrEqual(7);
    expect(end.j).toBeGreaterThanOrEqual(6);

    // 計算途中の結果では標高条件も必要 → この地形では安全な場所がない
    const partial = fakeOutput(spec, { depth: () => 0, maxDepth, arrival, ready: 600 });
    const plan2 = planEvacuation(person, grid, [], partial, paramsWith(5));
    expect(plan2.target?.name).toContain('近くで最も高い地点');
  });

  it('shelter mode without shelters falls back to highground and says so', () => {
    const spec = smallSpec(30, 40);
    const grid = makeGrid(spec, (_i, j) => ({ z: 20 - 0.5 * j }));
    const person = personAt(spec, 15, 35);
    const plan = planEvacuation(person, grid, [], null, paramsWith(5));
    expect(plan.target?.kind).toBe('highground');
    expect(plan.target?.name).toContain('避難場所データがないため');
  });

  it('starts from the nearest land cell when placed in the sea', () => {
    const spec = smallSpec(30, 30);
    const grid = makeGrid(spec, (_i, j) => ({ z: j >= 20 ? -5 : 2, kind: j >= 20 ? CELL_SEA : CELL_LAND }));
    const person = personAt(spec, 15, 25);
    const plan = planEvacuation(person, grid, [shelterAt(spec, 15, 5)], null, paramsWith());
    expect(plan.target?.name).toBe('避難場所A');
    expect(plan.path[0].lon).toBeCloseTo(person.lon, 10);
    const second = cellOfPoint(spec, plan.path[1].lon, plan.path[1].lat);
    expect(second.j).toBeLessThanOrEqual(19);
  });

  it('wheelchair avoids a steep slope that a walker climbs', () => {
    const spec = smallSpec(40, 40);
    // 中央に東西の尾根（i=10..29, j=15..24、中心が高い急斜面）。西端 i<10 は平坦な迂回路
    const ridge = (i: number, j: number) => (i >= 10 && i <= 29 && j >= 15 && j <= 24 ? 12 - Math.abs(j - 19.5) * 2.4 : 0);
    const grid = makeGrid(spec, (i, j) => ({ z: 1 + ridge(i, j) }));
    const shelters = [shelterAt(spec, 20, 35)];
    const walker = planEvacuation(personAt(spec, 20, 5), grid, shelters, null, paramsWith());
    const wheel = planEvacuation(personAt(spec, 20, 5, { kind: 'wheelchair' }), grid, shelters, null, paramsWith());
    const crossesRidge = (plan: EvacPlan) => cellsAlongPath(spec, plan).some((c) => c.i >= 12 && c.i <= 27 && c.j === 19);
    expect(crossesRidge(walker)).toBe(true);
    expect(crossesRidge(wheel)).toBe(false);
    expect(wheel.distanceM).toBeGreaterThan(walker.distanceM);
  });
});

describe('personStateAt', () => {
  const spec = smallSpec(40, 10);
  const grid = makeGrid(spec, () => ({ z: 2 }));

  it('waiting → evacuating → safe without sim output', () => {
    const person = personAt(spec, 5, 5, { startDelayMin: 5 });
    const plan = planEvacuation(person, grid, [shelterAt(spec, 35, 5)], null, paramsWith());
    const s0 = personStateAt(person, plan, grid, null, 0);
    expect(s0.status).toBe('waiting');
    expect(s0.lon).toBeCloseTo(person.lon, 10);
    expect(s0.ground).toBeCloseTo(2, 5);
    expect(s0.message).toContain('5分00秒');
    const mid = (plan.path[0].t + plan.arriveAt!) / 2;
    const s1 = personStateAt(person, plan, grid, null, mid);
    expect(s1.status).toBe('evacuating');
    expect(s1.lon).toBeGreaterThan(person.lon);
    expect(s1.message).toContain('避難場所A');
    const s2 = personStateAt(person, plan, grid, null, plan.arriveAt! + 1);
    expect(s2.status).toBe('safe');
    expect(s2.message).toContain('避難完了');
    expect(s2.depth).toBe(0);
  });

  it('handles null grid and output', () => {
    const person = personAt(spec, 5, 5);
    const s = personStateAt(person, undefined, null, null, 100);
    expect(s.lon).toBe(person.lon);
    expect(s.lat).toBe(person.lat);
    expect(Number.isNaN(s.ground)).toBe(true);
    expect(s.depth).toBe(0);
    expect(s.status).toBe('waiting');
  });

  // 陸は一様に: 600s から浸水が始まり 800s で 1.0m、1200s 以降は引いて 1500s で 0
  const flood = (t: number) => {
    if (t <= 600) return 0;
    if (t <= 1200) return Math.min(1.5, ((t - 600) / 200) * 1.0);
    return Math.max(0, 1.5 - ((t - 1200) / 300) * 1.5);
  };

  it('caution → danger → sticky critical', () => {
    const out = fakeOutput(spec, { depth: (t) => flood(t) });
    const person = personAt(spec, 5, 5, { evacMode: 'stay' });
    const plan = planEvacuation(person, grid, [], out, paramsWith());
    expect(personStateAt(person, plan, grid, out, 500).status).toBe('waiting');
    const c = personStateAt(person, plan, grid, out, 640); // 0.2m
    expect(c.status).toBe('caution');
    expect(c.depth).toBeCloseTo(0.2, 5);
    const d = personStateAt(person, plan, grid, out, 720); // 0.6m
    expect(d.status).toBe('danger');
    expect(d.message).toContain('30cm以上で死者が発生し始める');
    const k = personStateAt(person, plan, grid, out, 900);
    expect(k.status).toBe('critical');
    expect(k.message).toMatch(/^生命の危険：地震発生から \d+分\d{2}秒 に、浸水深 1\.0 m 以上の津波に巻き込まれました（計算上）$/);
    expect(k.message).toContain('13分20秒'); // 800s で 1.0m に達する
    // 水が引いた後も critical のまま
    const later = personStateAt(person, plan, grid, out, 2000);
    expect(later.status).toBe('critical');
    expect(later.depth).toBe(0);
    expect(later.message).toBe(k.message);
  });

  it('critical freezes the position where it happened', () => {
    const out = fakeOutput(spec, { depth: (t) => flood(t) });
    const person = personAt(spec, 2, 5, { startDelayMin: 10, kind: 'elderly' }); // 600s に出発、0.5m/s
    const far = [shelterAt(spec, 38, 5)];
    const plan = planEvacuation(person, grid, far, out, paramsWith());
    expect(plan.arriveAt!).toBeGreaterThan(1200);
    const at = personStateAt(person, plan, grid, out, 1000);
    expect(at.status).toBe('critical');
    const at2 = personStateAt(person, plan, grid, out, 1100);
    expect(at2.lon).toBe(at.lon);
    expect(at2.lat).toBe(at.lat);
    // 800s までに 100m 歩いた位置で止まっている
    const moved = (at.lon - person.lon) / (plan.target!.lon - person.lon);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(0.5);
  });

  it('arriving at a shelter before the flood counts as safe (vertical evacuation)', () => {
    const out = fakeOutput(spec, { depth: (t) => flood(t) });
    const person = personAt(spec, 5, 5, { startDelayMin: 2 });
    const plan = planEvacuation(person, grid, [shelterAt(spec, 10, 5)], out, paramsWith());
    expect(plan.arriveAt!).toBeLessThan(600);
    const s = personStateAt(person, plan, grid, out, 900);
    expect(s.status).toBe('safe');
    expect(s.depth).toBeGreaterThan(1);
    expect(s.message).toContain('上階');
  });

  it('re-evaluates when more frames arrive', () => {
    let ready = 500;
    const out = fakeOutput(spec, { depth: (t) => flood(t), ready: () => ready });
    const person = personAt(spec, 5, 5, { evacMode: 'stay' });
    const plan = planEvacuation(person, grid, [], null, paramsWith());
    expect(personStateAt(person, plan, grid, out, 900).status).toBe('waiting');
    ready = 3600;
    expect(personStateAt(person, plan, grid, out, 900).status).toBe('critical');
  });

  it('personTimeline gives chart-ready samples with sticky critical', () => {
    const out = fakeOutput(spec, { depth: (t) => flood(t) });
    const person = personAt(spec, 5, 5, { evacMode: 'stay' });
    const plan = planEvacuation(person, grid, [], out, paramsWith());
    const tl = personTimeline(person, plan, grid, out, 60);
    expect(tl[0]).toEqual({ t: 0, depth: 0, status: 'waiting' });
    expect(tl[tl.length - 1].t).toBe(3600);
    expect(tl).toHaveLength(61);
    const firstCritical = tl.findIndex((p) => p.status === 'critical');
    expect(tl[firstCritical].t).toBe(840);
    expect(tl.slice(firstCritical).every((p) => p.status === 'critical')).toBe(true);
    expect(tl.some((p) => p.status === 'danger')).toBe(true);
    // 計算結果なし: 到着 + 5分まで
    const p2 = personAt(spec, 5, 5);
    const plan2 = planEvacuation(p2, grid, [shelterAt(spec, 30, 5)], null, paramsWith());
    const tl2 = personTimeline(p2, plan2, grid, null, 20);
    expect(tl2[tl2.length - 1].t).toBeCloseTo(plan2.arriveAt! + 300, 6);
    expect(tl2[tl2.length - 1].status).toBe('safe');
  });
});

describe('performance on the standard grid', () => {
  it('plans in well under ~30 ms per person (352×394)', () => {
    const spec = createGridSpec('standard');
    expect(spec.nx).toBe(352);
    expect(spec.ny).toBe(394);
    const coastJ = 300;
    // 南に海、北ほど高い。川（幅3セル）と起伏
    const grid = makeGrid(spec, (i, j) => {
      if (j >= coastJ + Math.round(5 * Math.sin(i / 17))) return { z: -5 - (j - coastJ) * 0.1, kind: CELL_SEA };
      if (i >= 150 && i <= 152 && j > 40) return { z: -1, kind: CELL_SEA };
      const z = 2 + (coastJ - j) * 0.05 + 3 * Math.sin(i / 11) * Math.cos(j / 13);
      return { z };
    });
    const shelters = [shelterAt(spec, 60, 250, 'S1'), shelterAt(spec, 200, 180, 'S2'), shelterAt(spec, 320, 100, 'S3')];
    const params = paramsWith(10);
    const starts: [number, number][] = [
      [20, 290],
      [100, 280],
      [175, 295],
      [250, 285],
      [340, 290],
      [151, 200],
      [5, 5],
      [345, 250],
    ];
    const modes: Person['evacMode'][] = ['shelter', 'highground'];
    // ウォームアップ（JIT とキャッシュ）
    planEvacuation(personAt(spec, 100, 280), grid, shelters, null, params);
    const times: number[] = [];
    for (const mode of modes) {
      for (const [i, j] of starts) {
        for (const kind of ['adult', 'wheelchair'] as PersonKind[]) {
          const p = personAt(spec, i, j, { evacMode: mode, kind });
          const t0 = performance.now();
          const plan = planEvacuation(p, grid, shelters, null, params);
          times.push(performance.now() - t0);
          expect(plan.path.length).toBeGreaterThanOrEqual(1);
        }
      }
    }
    // 安全な場所がどこにもない場合（到達可能性の判定 → 近くで最も高い地点を探す）。同じ条件で3回測り中央値を見る
    const worstTimes: number[] = [];
    let worst: EvacPlan | null = null;
    for (let r = 0; r < 3; r++) {
      const p = personAt(spec, 100, 280, { evacMode: 'highground' });
      const t0 = performance.now();
      worst = planEvacuation(p, grid, [], null, paramsWith(100));
      worstTimes.push(performance.now() - t0);
    }
    expect(worst!.target?.name).toContain('近くで最も高い地点');
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.info(
      `[perf] planEvacuation avg ${avg.toFixed(2)} ms, median ${median(times).toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms, ` +
        `no-safe-cell median ${median(worstTimes).toFixed(2)} ms (n=${times.length})`,
    );
    // 共有マシンでの負荷による外れ値を考慮し、平均・中央値で判定する
    expect(median(times)).toBeLessThan(15);
    expect(avg).toBeLessThan(30);
    // 安全な場所がない場合は、経路コスト 1.5km 以内を漏れなく調べる（半径約96セル・約3万セルのダイクストラ法）。
    // 負荷の低い環境で 10ms 台。混雑した共有マシンでも破綻しないことだけを時間で確かめ、
    // 探索量（負荷に左右されない）は下で確かめる
    expect(median(worstTimes)).toBeLessThan(100);
    const ctx = getGridContext(grid);
    const startK = 280 * spec.nx + 100;
    const r = searchPath(ctx, WALK_COST, startK, { highestWithin: 1500 });
    const radius = 1500 / spec.dx;
    expect(r.expanded).toBeGreaterThan(0.5 * Math.PI * radius * radius * 0.5); // 海の分を除いても半円以上
    expect(r.expanded).toBeLessThan(Math.PI * radius * radius * 1.1);
  });

  it('personStateAt is cheap per frame', () => {
    const spec = createGridSpec('standard');
    const grid = makeGrid(spec, (_i, j) => ({ z: 30 - j * 0.08 }));
    const out = fakeOutput(spec, { depth: (t, k) => (k % 7 === 0 ? 0 : Math.max(0, (t - 900) / 600)), frameInterval: 10 });
    const people = Array.from({ length: 30 }, (_, q) => personAt(spec, 20 + q * 10, 350, { evacMode: 'highground' }));
    const plans = people.map((p) => planEvacuation(p, grid, [], out, paramsWith(10)));
    // 時刻を進めながら（再生を模擬）全員の状態を求める
    const t0 = performance.now();
    let frames = 0;
    for (let t = 0; t <= 3600; t += 6) {
      for (let q = 0; q < people.length; q++) personStateAt(people[q], plans[q], grid, out, t);
      frames++;
    }
    const perFrame = (performance.now() - t0) / frames;
    console.info(`[perf] personStateAt ×30: ${perFrame.toFixed(3)} ms / frame`);
    expect(perFrame).toBeLessThan(4);
  });
});

// ---------------------------------------------------------------------------
// レビューで見つかった不具合の回帰テスト
// ---------------------------------------------------------------------------

describe('review regressions', () => {
  it('fallback "highest point" search is a true Dijkstra (not biased toward the NW corner)', () => {
    const spec = smallSpec(200, 200);
    // 平坦（1m）。出発点の南東 10 セルに 8m の小山、北西 10 セルに 3m の小山
    const grid = makeGrid(spec, (i, j) => ({ z: i === 160 && j === 160 ? 8 : i === 140 && j === 140 ? 3 : 1 }));
    const person = personAt(spec, 150, 150, { evacMode: 'highground' });
    const plan = planEvacuation(person, grid, [], null, paramsWith(100)); // 安全な高台はどこにもない
    expect(plan.target?.name).toContain('近くで最も高い地点');
    expect(cellOfPoint(spec, plan.target!.lon, plan.target!.lat)).toEqual({ i: 160, j: 160 });
  });

  it('does not squeeze diagonally between two water cells of a 1-cell diagonal river for free', () => {
    const spec = smallSpec(40, 40);
    // i + j = 30 の斜めの細い川（幅1セル）。(17, 13) だけ陸の橋。
    // 川のセルの角の間をすり抜ける斜め移動（例 (15,14)→(16,15)）が無償なら直進の余分は約 0.6 セル、
    // 横断のペナルティ（×3）がかかれば約 3.4 セル。橋経由の余分は約 2.3 セルなので、正しくは橋を使う
    const isRiver = (i: number, j: number) => i + j === 30 && !(i === 17 && j === 13);
    const grid = makeGrid(spec, (i, j) => ({ z: isRiver(i, j) ? -1 : 2, kind: isRiver(i, j) ? CELL_SEA : CELL_LAND }));
    const person = personAt(spec, 10, 10);
    const shelter = shelterAt(spec, 25, 25);
    const plan = planEvacuation(person, grid, [shelter], null, paramsWith());
    expect(plan.target?.name).toBe('避難場所A');
    // 橋セルの中心の近くを通る（川のセルの角をすり抜けてまっすぐ渡らない）
    const bridge = { gx: 17.5, gy: 13.5 };
    let best = Infinity;
    for (let s = 1; s < plan.path.length; s++) {
      const a = lonLatToGridXY(spec, plan.path[s - 1].lon, plan.path[s - 1].lat);
      const b = lonLatToGridXY(spec, plan.path[s].lon, plan.path[s].lat);
      const vx = b.gx - a.gx;
      const vy = b.gy - a.gy;
      const L2 = vx * vx + vy * vy || 1;
      const f = Math.max(0, Math.min(1, ((bridge.gx - a.gx) * vx + (bridge.gy - a.gy) * vy) / L2));
      best = Math.min(best, Math.hypot(a.gx + vx * f - bridge.gx, a.gy + vy * f - bridge.gy));
    }
    expect(best).toBeLessThan(1);
  });

  it('a person placed far out at sea is not "critical" at t=0 because of the sea water column', () => {
    const spec = smallSpec(30, 60);
    const seaJ = 20;
    const grid = makeGrid(spec, (_i, j) => ({ z: j >= seaJ ? -5 : 3, kind: j >= seaJ ? CELL_SEA : CELL_LAND }));
    const n = 30 * 60;
    // 海は水深 5m の水柱、陸は 900s まで乾いている
    const out = fakeOutput(spec, {
      depth: (t, k) => (Math.floor(k / 30) >= seaJ ? 5 : t < 900 ? 0 : 2),
      arrival: new Float32Array(n).map((_, k) => (Math.floor(k / 30) >= seaJ ? -Infinity : 900)),
    });
    const person = personAt(spec, 15, 50, { startDelayMin: 0 }); // 岸から 30 セル（約470m）沖
    const plan = planEvacuation(person, grid, [shelterAt(spec, 15, 2)], out, paramsWith());
    const s0 = personStateAt(person, plan, grid, out, 0);
    expect(s0.status).not.toBe('critical');
    expect(s0.depth).toBe(0);
  });

  it('critical stays sticky even when the threshold is crossed between samples', () => {
    const spec10 = smallSpec(40, 10);
    const grid10 = makeGrid(spec10, () => ({ z: 2 }));
    // 801〜804 秒だけ 2m（サンプル間隔 5 秒の間に収まる短い山。判定ロジックの確認用）
    const out = fakeOutput(spec10, { depth: (t) => (t > 801 && t < 804 ? 2 : 0) });
    const person = personAt(spec10, 5, 5, { evacMode: 'stay' });
    const plan = planEvacuation(person, grid10, [], out, paramsWith());
    const a = personStateAt(person, plan, grid10, out, 803);
    expect(a.status).toBe('critical');
    const b = personStateAt(person, plan, grid10, out, 806);
    expect(b.status).toBe('critical');
    expect(b.message).toBe(a.message);
  });
});


// ---------------------------------------------------------------------------
// 経路探索の最適性（素朴なダイクストラ法との比較）
// ---------------------------------------------------------------------------

/** 決定的な疑似乱数 */
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** O(n²) の素朴なダイクストラ法（stepCost の規則そのもの）。到達できないセルは Infinity */
function referenceCosts(ctx: GridContext, model: CostModel, start: number): Float64Array {
  const dist = new Float64Array(ctx.n).fill(Infinity);
  const done = new Uint8Array(ctx.n);
  dist[start] = 0;
  for (;;) {
    let c = -1;
    for (let k = 0; k < ctx.n; k++) if (!done[k] && dist[k] < Infinity && (c < 0 || dist[k] < dist[c])) c = k;
    if (c < 0) break;
    done[c] = 1;
    for (let d = 0; d < 8; d++) {
      const w = stepCost(ctx, model, c, d);
      if (w === Infinity) continue;
      const nk = c + NEIGHBOR_DJ[d] * ctx.nx + NEIGHBOR_DI[d];
      if (dist[c] + w < dist[nk]) dist[nk] = dist[c] + w;
    }
  }
  return dist;
}

/** セル列の経路のコスト（stepCost の和） */
function cellPathCost(ctx: GridContext, model: CostModel, cells: number[]): number {
  let cost = 0;
  for (let q = 1; q < cells.length; q++) {
    const a = cells[q - 1];
    const b = cells[q];
    const di = (b % ctx.nx) - (a % ctx.nx);
    const dj = Math.floor(b / ctx.nx) - Math.floor(a / ctx.nx);
    const d = NEIGHBOR_DI.findIndex((x, t) => x === di && NEIGHBOR_DJ[t] === dj);
    expect(d).toBeGreaterThanOrEqual(0);
    cost += stepCost(ctx, model, a, d);
  }
  return cost;
}

describe('searchPath optimality', () => {
  it('agrees with a reference Dijkstra (single target, target mask, highest-within-budget, reachability)', () => {
    const rnd = prng(20260924);
    const nx = 26;
    const ny = 22;
    const spec = smallSpec(nx, ny);
    for (let trial = 0; trial < 10; trial++) {
      const p1 = rnd() * 6;
      const p2 = rnd() * 6;
      const riverI = 6 + Math.floor(rnd() * 14);
      const riverW = 1 + Math.floor(rnd() * 3);
      const diag = rnd() < 0.5;
      const seaRows = 3 + Math.floor(rnd() * 3);
      const grid = makeGrid(spec, (i, j) => {
        if (j >= ny - seaRows) return { z: -3, kind: CELL_SEA }; // 外海（グリッド端に接する）
        const inRiver = diag ? i + j >= riverI + 8 && i + j < riverI + 8 + riverW : i >= riverI && i < riverI + riverW;
        if (inRiver && j >= 2) return { z: -1, kind: CELL_SEA }; // 細い川（北端 j<2 は陸の橋）
        if (rnd() < 0.04) return { z: 1, kind: CELL_INLAND_WATER }; // 池
        return { z: 3 + 4 * Math.sin(i / 3 + p1) * Math.cos(j / 4 + p2) + rnd() * 0.8 };
      });
      const ctx = getGridContext(grid);
      const passable: number[] = [];
      for (let k = 0; k < ctx.n; k++) if (ctx.pass[k] !== PASS_BLOCKED) passable.push(k);
      for (const model of [WALK_COST, WHEELCHAIR_COST]) {
        const start = passable[Math.floor(rnd() * passable.length)];
        const ref = referenceCosts(ctx, model, start);
        // 1点の目標
        for (let q = 0; q < 8; q++) {
          const t = Math.floor(rnd() * ctx.n);
          const res = searchPath(ctx, model, start, { cell: t });
          const reachable = ref[t] < Infinity;
          // 連結成分（探索前の到達判定）と実際の到達可否が一致する
          expect(ctx.comp[start] >= 0 && ctx.comp[start] === ctx.comp[t]).toBe(reachable);
          if (!reachable) {
            expect(res.target).toBe(-1);
            continue;
          }
          expect(res.target).toBe(t);
          const cells = reconstruct(res.parent, t);
          expect(cells[0]).toBe(start);
          expect(cellPathCost(ctx, model, cells)).toBeCloseTo(ref[t], 6);
        }
        // 目標マスク（ヒューリスティック付き）: 最小コストの目標に着く
        const mask = new Uint8Array(ctx.n);
        const land = passable.filter((k) => ctx.pass[k] === PASS_LAND);
        for (let q = 0; q < 5; q++) mask[land[Math.floor(rnd() * land.length)]] = 1;
        let best = Infinity;
        for (let k = 0; k < ctx.n; k++) if (mask[k] && ref[k] < best) best = ref[k];
        const h = new Float32Array(ctx.n); // 0 は許容的（ダイクストラ法と同じ）
        const resM = searchPath(ctx, model, start, { mask, h });
        if (best === Infinity) expect(resM.target).toBe(-1);
        else {
          expect(mask[resM.target]).toBe(1);
          expect(cellPathCost(ctx, model, reconstruct(resM.parent, resM.target))).toBeCloseTo(best, 6);
        }
        // コスト上限内で最も高い陸
        const budget = 6 * spec.dx;
        let zBest = -Infinity;
        for (let k = 0; k < ctx.n; k++) if (ctx.pass[k] === PASS_LAND && ref[k] <= budget && grid.z[k] > zBest) zBest = grid.z[k];
        const resH = searchPath(ctx, model, start, { highestWithin: budget });
        if (zBest === -Infinity) expect(resH.target).toBe(-1);
        else expect(grid.z[resH.target]).toBe(zBest);
      }
    }
  });
});

describe('review regressions (2)', () => {
  const spec = smallSpec(40, 10);
  const grid = makeGrid(spec, () => ({ z: 2 }));

  it('a very small custom speed is clamped, not replaced by the default', () => {
    const base = personAt(spec, 5, 5);
    expect(personSpeed({ ...base, speedMps: 0.01 })).toBe(0.05);
    expect(personSpeed({ ...base, speedMps: 0.3 })).toBe(0.3);
    expect(personSpeed({ ...base, speedMps: 0 })).toBe(1.0);
    expect(personSpeed({ ...base, speedMps: Number.NaN })).toBe(1.0);
    expect(personSpeed({ ...base, kind: 'elderly', speedMps: undefined })).toBe(0.5);
  });

  it('returns a stay plan instead of throwing when the grid is missing', () => {
    const person = personAt(spec, 5, 5);
    const plan = planEvacuation(person, null as unknown as TerrainGrid, [], null, paramsWith());
    expect(plan.target).toBeNull();
    expect(plan.path).toHaveLength(1);
  });

  it('does not trust "never inundated" when the simulation ends before the main wave', () => {
    const spec2 = smallSpec(30, 40);
    const grid2 = makeGrid(spec2, (_i, j) => ({ z: 2 + 0.02 * (39 - j) })); // 標高条件では安全な所はない
    const out = fakeOutput(spec2, { depth: () => 0, durationSec: 1800 }); // 30分で完了、どこも浸水しない
    const person = personAt(spec2, 15, 30, { evacMode: 'highground' });
    // 到達 10分 + 周期 15分 ≤ 30分 → 計算結果を信頼
    const ok = planEvacuation(person, grid2, [], out, paramsWith(5));
    expect(ok.target?.name).toContain('浸水しなかった');
    // 到達 60分のシナリオを 30分だけ計算 → 標高条件も課す（この地形では安全な所がない）
    const late = { ...paramsWith(5), scenario: { ...SCENARIO, coastHeight: 5, arrivalMin: 60 } };
    const plan = planEvacuation(person, grid2, [], out, late);
    expect(plan.target?.name).toContain('近くで最も高い地点');
  });

  it('a person at sea is brought ashore on the mainland, not onto an isolated rock', () => {
    const spec2 = smallSpec(30, 40);
    // j>=20 は海。沖の (15, 27) に 1 セルの岩（孤立した陸）
    const rock = (i: number, j: number) => i === 15 && j === 27;
    const grid2 = makeGrid(spec2, (i, j) => (j >= 20 && !rock(i, j) ? { z: -5, kind: CELL_SEA } : { z: rock(i, j) ? 4 : 3 }));
    const person = personAt(spec2, 15, 29);
    const plan = planEvacuation(person, grid2, [shelterAt(spec2, 15, 5)], null, paramsWith());
    expect(plan.target?.name).toBe('避難場所A');
    const second = cellOfPoint(spec2, plan.path[1].lon, plan.path[1].lat);
    expect(second.j).toBeLessThanOrEqual(19);
  });

  it('pins the critical time precisely while waiting, even when queried only far apart', () => {
    const flood = (t: number) => (t <= 600 ? 0 : Math.min(1.5, ((t - 600) / 200) * 1.0)); // 800s で 1.0m
    const out = fakeOutput(spec, { depth: (t) => flood(t) });
    const person = personAt(spec, 5, 5, { startDelayMin: 20 }); // 1200s まで出発しない
    const plan = planEvacuation(person, grid, [shelterAt(spec, 35, 5)], out, paramsWith());
    expect(personStateAt(person, plan, grid, out, 0).status).toBe('waiting');
    const s = personStateAt(person, plan, grid, out, 3600);
    expect(s.status).toBe('critical');
    expect(s.message).toContain('13分20秒');
    expect(s.lon).toBeCloseTo(person.lon, 10);
  });

  it('checks for a critical depth right up to the moment of arrival at a shelter', () => {
    const person = personAt(spec, 5, 5, { startDelayMin: 0 });
    const plan = planEvacuation(person, grid, [shelterAt(spec, 25, 5)], null, paramsWith());
    const A = plan.arriveAt!;
    // 到着の 2 秒前から全域が 2m（サンプル間隔 5 秒の間に入るよう、A-2 がサンプル時刻にならない場合を確認）
    const out = fakeOutput(spec, { depth: (t) => (t > A - 2 ? 2 : 0) });
    const s = personStateAt(person, plan, grid, out, A + 60);
    expect(s.status).toBe('critical');
    expect(s.message).toContain('生命の危険');
    // 到着後に浸水しても（垂直避難の想定で）safe のまま
    const out2 = fakeOutput(spec, { depth: (t) => (t > A + 1 ? 2 : 0) });
    expect(personStateAt(person, plan, grid, out2, A + 60).status).toBe('safe');
  });
});
