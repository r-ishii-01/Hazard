import { describe, expect, it } from 'vitest';
import { cellCenter, createGridSpec, gridXYToLonLat } from '../src/core/geo';
import { CELL_LAND, type TerrainGrid } from '../src/core/types';
import { sampleGround } from '../src/terrain';

function planeGrid(): TerrainGrid {
  const spec = createGridSpec('coarse');
  const { nx, ny } = spec;
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = 2 + 0.5 * i - 0.25 * j;
  return {
    spec,
    z,
    kind: new Uint8Array(nx * ny).fill(CELL_LAND),
    manning: new Float32Array(nx * ny).fill(0.06),
    source: 'synthetic',
    sourceLabel: 'test',
    isApproximate: true,
    notes: [],
  };
}

describe('sampleGround', () => {
  const g = planeGrid();
  const { spec } = g;

  it('returns the cell value at cell centers', () => {
    const c = cellCenter(spec, 10, 20);
    expect(sampleGround(g, c.lon, c.lat)).toBeCloseTo(2 + 5 - 5, 3);
  });

  it('interpolates bilinearly between cell centers (exact for a plane)', () => {
    for (const [gx, gy] of [
      [10.75, 20.5],
      [33.2, 41.9],
      [100.5, 150.25],
    ]) {
      const ll = gridXYToLonLat(spec, gx, gy);
      const expected = 2 + 0.5 * (gx - 0.5) - 0.25 * (gy - 0.5);
      expect(sampleGround(g, ll.lon, ll.lat)!).toBeCloseTo(expected, 3);
    }
  });

  it('clamps to edge cells within the outer half cell', () => {
    const ll = gridXYToLonLat(spec, 0.1, 0.2);
    expect(sampleGround(g, ll.lon, ll.lat)).toBeCloseTo(2, 3);
  });

  it('returns null outside the grid or for invalid input', () => {
    expect(sampleGround(g, 139.0, 35.0)).toBeNull();
    const out = gridXYToLonLat(spec, spec.nx + 0.5, 3);
    expect(sampleGround(g, out.lon, out.lat)).toBeNull();
    expect(sampleGround(g, Number.NaN, 35.3)).toBeNull();
  });
});
