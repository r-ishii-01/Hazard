import { describe, expect, it } from 'vitest';
import {
  cellCenter,
  createGridSpec,
  distanceMeters,
  gridCornerCoordinates,
  gridTileRange,
  lonLatToCell,
  lonLatToLocalMeters,
  lonLatToPixel,
  localMetersToLonLat,
  metersPerPixel,
  pixelToLonLat,
} from '../src/core/geo';

describe('web mercator', () => {
  it('round-trips lon/lat through pixels', () => {
    const p = lonLatToPixel(139.4705, 35.3135, 15);
    const ll = pixelToLonLat(p.x, p.y, 15);
    expect(ll.lon).toBeCloseTo(139.4705, 9);
    expect(ll.lat).toBeCloseTo(35.3135, 9);
  });
  it('matches the known tile of Kugenuma at z15', () => {
    const p = lonLatToPixel(139.4705, 35.3135, 15);
    expect(Math.floor(p.x / 256)).toBe(29078);
    expect(Math.floor(p.y / 256)).toBe(12944);
  });
  it('meters per pixel at z15 near 35.3N is ~3.9 m', () => {
    expect(metersPerPixel(35.3, 15)).toBeGreaterThan(3.85);
    expect(metersPerPixel(35.3, 15)).toBeLessThan(3.95);
  });
});

describe('grid spec', () => {
  const spec = createGridSpec('standard');
  it('has ~15.6 m cells and covers ~5.5 x 6 km', () => {
    expect(spec.dx).toBeGreaterThan(15.4);
    expect(spec.dx).toBeLessThan(15.8);
    expect(spec.nx * spec.dx).toBeGreaterThan(5400);
    expect(spec.ny * spec.dx).toBeGreaterThan(6000);
  });
  it('all resolutions share the same origin and extent', () => {
    const c = createGridSpec('coarse');
    const f = createGridSpec('fine');
    expect(c.originPx).toBe(spec.originPx);
    expect(f.originPy).toBe(spec.originPy);
    expect(c.nx * c.cellPx).toBe(spec.nx * spec.cellPx);
    expect(f.ny * f.cellPx).toBe(spec.ny * spec.cellPx);
  });
  it('cell lookup is consistent with cell centers', () => {
    const c = cellCenter(spec, 10, 20);
    const cell = lonLatToCell(spec, c.lon, c.lat)!;
    expect(cell.i).toBe(10);
    expect(cell.j).toBe(20);
    expect(cell.k).toBe(20 * spec.nx + 10);
    expect(lonLatToCell(spec, 139.0, 35.0)).toBeNull();
  });
  it('corner coordinates are ordered TL, TR, BR, BL', () => {
    const [tl, tr, br, bl] = gridCornerCoordinates(spec);
    expect(tr[0]).toBeGreaterThan(tl[0]);
    expect(bl[1]).toBeLessThan(tl[1]);
    expect(br[0]).toBeCloseTo(tr[0], 9);
    expect(br[1]).toBeCloseTo(bl[1], 9);
  });
  it('tile range covers the grid', () => {
    const r = gridTileRange(spec);
    expect(r.x0 * 256).toBeLessThanOrEqual(spec.originPx);
    expect((r.x1 + 1) * 256).toBeGreaterThanOrEqual(spec.originPx + spec.nx * spec.cellPx);
    const r14 = gridTileRange(spec, 14);
    expect(r14.x1 - r14.x0).toBeLessThanOrEqual(r.x1 - r.x0);
  });
  it('local meters are consistent with geodesic distance', () => {
    const a = { lon: 139.46, lat: 35.31 };
    const b = { lon: 139.48, lat: 35.32 };
    const la = lonLatToLocalMeters(spec, a.lon, a.lat);
    const lb = lonLatToLocalMeters(spec, b.lon, b.lat);
    const d = Math.hypot(lb.x - la.x, lb.z - la.z);
    expect(Math.abs(d - distanceMeters(a, b)) / distanceMeters(a, b)).toBeLessThan(0.003);
    const back = localMetersToLonLat(spec, la.x, la.z);
    expect(back.lon).toBeCloseTo(a.lon, 9);
    expect(back.lat).toBeCloseTo(a.lat, 9);
  });
});
