/**
 * 3D 建物の頂点データ（view3d/buildingMesh.ts）: 小さな型の頂点データ・高さ・海の上の建物を省くこと・
 * 区切って進められること（Worker を使えないときに画面の処理を止めない）と、GPU へ送った後に配列を手放すこと。
 */
import { PbfWriter } from 'pbf';
import { describe, expect, it } from 'vitest';
import { createGridSpec, gridTileRange } from '../src/core/geo';
import { CELL_LAND, CELL_SEA } from '../src/core/types';
import { BUILDING_ZOOM, buildTileArrays, buildTileSteps, type BuildingGrid } from '../src/view3d/buildingMesh';
import { geometryFromTile } from '../src/view3d/buildings';
import { HeightSampler } from '../src/view3d/sampler';

const zigzag = (n: number) => (n << 1) ^ (n >> 31);

/** 正方形の建物（タイル座標 [x0, x0+size]²）を並べたベクタータイル（building レイヤー） */
function encodeTile(squares: { x0: number; y0: number; size: number; height?: number }[]): Uint8Array {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    3,
    (_: unknown, p: PbfWriter) => {
      p.writeVarintField(15, 2);
      p.writeStringField(1, 'building');
      squares.forEach((sq, idx) => {
        p.writeMessage(
          2,
          (_f: unknown, q: PbfWriter) => {
            q.writeVarintField(1, idx + 1);
            if (sq.height !== undefined) q.writePackedVarint(2, [0, idx]);
            q.writeVarintField(3, 3);
            const { x0, y0, size } = sq;
            // MoveTo(1) → LineTo(3) → ClosePath
            q.writePackedVarint(4, [9, zigzag(x0), zigzag(y0), 26, zigzag(size), 0, 0, zigzag(size), zigzag(-size), 0, 15]);
          },
          null,
        );
      });
      p.writeStringField(3, 'render_height');
      for (const sq of squares) p.writeMessage(4, (_v: unknown, q: PbfWriter) => q.writeDoubleField(3, sq.height ?? 0), null);
      p.writeVarintField(5, 4096);
    },
    null,
  );
  return pbf.finish();
}

function flatGrid(ground: number): BuildingGrid {
  const spec = createGridSpec('coarse');
  const n = spec.nx * spec.ny;
  return { spec, z: new Float32Array(n).fill(ground), kind: new Uint8Array(n).fill(CELL_LAND) };
}

describe('建物の頂点データ', () => {
  const grid = flatGrid(3);
  const r = gridTileRange(grid.spec, BUILDING_ZOOM);
  const tx = Math.floor((r.x0 + r.x1) / 2);
  const ty = Math.floor((r.y0 + r.y1) / 2);

  it('角柱（壁 4 面・屋根）を小さな型の配列で作る', () => {
    const t = buildTileArrays(encodeTile([{ x0: 1000, y0: 1000, size: 100, height: 12 }]), tx, ty, grid)!;
    expect(t).not.toBeNull();
    expect(t.count).toBe(1);
    expect(t.position).toBeInstanceOf(Float32Array);
    expect(t.normal).toBeInstanceOf(Int8Array);
    expect(t.color).toBeInstanceOf(Uint8Array);
    expect(t.index).toBeInstanceOf(Uint16Array);
    // 壁 4 面 × 4 頂点 + 屋根 4 頂点
    expect(t.position.length / 3).toBe(20);
    expect(t.index.length).toBe(4 * 6 + 2 * 3);
    // 高さ: 下端は地盤 − 0.3 m、上端は地盤 + render_height
    const ys = new Set<number>();
    for (let i = 1; i < t.position.length; i += 3) ys.add(Math.round(t.position[i] * 100) / 100);
    expect([...ys].sort((a, b) => a - b)).toEqual([2.7, 15]);
    // 法線は単位ベクトル（×127）。屋根は上向き
    // 8 bit の属性は 1 頂点 4 成分（4 バイト境界にそろえる）
    expect(t.normal.length).toBe(20 * 4);
    expect(t.color.length).toBe(20 * 4);
    for (let v = 0; v < 20; v++) {
      const len = Math.hypot(t.normal[v * 4], t.normal[v * 4 + 1], t.normal[v * 4 + 2]) / 127;
      expect(len).toBeCloseTo(1, 1);
      expect(t.normal[v * 4 + 3]).toBe(0);
      expect(t.color[v * 4 + 3]).toBe(255);
    }
    expect([t.normal[16 * 4], t.normal[16 * 4 + 1], t.normal[16 * 4 + 2]]).toEqual([0, 127, 0]);
    // 包む球はすべての頂点を含む
    const [cx, cy, cz, rad] = t.sphere;
    for (let v = 0; v < 20; v++) {
      const d = Math.hypot(t.position[v * 3] - cx, t.position[v * 3 + 1] - cy, t.position[v * 3 + 2] - cz);
      expect(d).toBeLessThanOrEqual(rad + 1e-3);
    }
  });

  it('高さの無い建物は 6 m、海（河川）の上の建物は省く', () => {
    const t = buildTileArrays(encodeTile([{ x0: 500, y0: 500, size: 80 }]), tx, ty, grid)!;
    let top = -Infinity;
    for (let i = 1; i < t.position.length; i += 3) top = Math.max(top, t.position[i]);
    expect(top).toBeCloseTo(3 + 6, 4);

    const sea = flatGrid(-2);
    sea.kind.fill(CELL_SEA);
    expect(buildTileArrays(encodeTile([{ x0: 500, y0: 500, size: 80, height: 10 }]), tx, ty, sea)).toBeNull();
  });

  it('建物ごとに区切って進められる（画面の処理の中で作るとき、時間で区切る）', () => {
    const tile = encodeTile([
      { x0: 100, y0: 100, size: 50, height: 8 },
      { x0: 300, y0: 100, size: 50, height: 8 },
      { x0: 500, y0: 100, size: 50, height: 8 },
    ]);
    const it = buildTileSteps(tile, tx, ty, grid, new HeightSampler(grid as never));
    let steps = 0;
    let res = it.next();
    while (!res.done) {
      steps++;
      res = it.next();
    }
    expect(steps).toBe(2);
    expect(res.value!.count).toBe(3);
  });

  it('GPU へ送った後に頂点データを手放す（法線・色は正規化して使う）', () => {
    const t = buildTileArrays(encodeTile([{ x0: 1000, y0: 1000, size: 100, height: 12 }]), tx, ty, grid)!;
    const geo = geometryFromTile(t, true);
    expect(geo.getAttribute('normal').normalized).toBe(true);
    expect(geo.getAttribute('color').normalized).toBe(true);
    expect(geo.boundingSphere!.radius).toBeCloseTo(t.sphere[3], 5);
    const pos = geo.getAttribute('position');
    const count = pos.count;
    // three.js は転送の直後に onUploadCallback を呼ぶ
    (pos as unknown as { onUploadCallback: () => void }).onUploadCallback();
    (geo.index as unknown as { onUploadCallback: () => void }).onUploadCallback();
    expect((pos as unknown as { array: unknown }).array).toBeNull();
    expect((geo.index as unknown as { array: unknown }).array).toBeNull();
    // 描画に使う頂点数は残る
    expect(pos.count).toBe(count);
    // 手放さない指定なら残す
    const keep = geometryFromTile(buildTileArrays(encodeTile([{ x0: 1000, y0: 1000, size: 100, height: 12 }]), tx, ty, grid)!, false);
    (keep.getAttribute('position') as unknown as { onUploadCallback: () => void }).onUploadCallback();
    expect(keep.getAttribute('position').array).not.toBeNull();
  });
});
