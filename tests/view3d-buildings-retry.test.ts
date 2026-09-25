/**
 * 3D 建物（src/view3d/buildings.ts）の取得の失敗:
 * - TileJSON・タイルの取得に時間の上限があり、応答が無いまま「読み込み中」で止まらない
 * - 取得できなかった後に「建物（3D）」を入れ直すと、もう一度読み込む
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGridSpec } from '../src/core/geo';
import { CELL_LAND, type TerrainGrid } from '../src/core/types';
import { BuildingLayer, TILEJSON_TIMEOUT_MS } from '../src/view3d/buildings';
import { HeightSampler } from '../src/view3d/sampler';

function flatGrid(): TerrainGrid {
  const spec = createGridSpec('coarse');
  const n = spec.nx * spec.ny;
  return {
    spec,
    z: new Float32Array(n).fill(3),
    kind: new Uint8Array(n).fill(CELL_LAND),
    manning: new Float32Array(n).fill(0.025),
    source: 'synthetic',
    sourceLabel: 'test',
    isApproximate: true,
    notes: [],
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe('3D 建物の取得の失敗', () => {
  it('取得できなかった後に入れ直すと、もう一度読み込む', async () => {
    const fetchMock = vi.fn(async (_input: unknown): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const layer = new BuildingLayer(() => {});
    layer.setGrid(new HeightSampler(flatGrid()));
    layer.setEnabled(true);
    await vi.waitFor(() => expect(layer.status).toBe('failed'));
    const first = fetchMock.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    // 入れたままでは読み直さない（地形が変わっても）
    layer.setEnabled(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock.mock.calls.length).toBe(first);

    // 切って入れ直すと読み直す。今度は取得できる（TileJSON と空のタイル）
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('tiles.openfreemap.org/planet') && !url.endsWith('.pbf')) {
        return new Response(JSON.stringify({ tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    layer.setEnabled(false);
    layer.setEnabled(true);
    expect(layer.status).toBe('loading');
    await vi.waitFor(() => expect(layer.status).not.toBe('loading'));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(first + 1);
    layer.dispose();
  });

  it('TileJSON の応答が無いままなら、時間の上限で「取得できない」にする', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const layer = new BuildingLayer(() => {});
    layer.setGrid(new HeightSampler(flatGrid()));
    layer.setEnabled(true);
    expect(layer.status).toBe('loading');
    await vi.advanceTimersByTimeAsync(TILEJSON_TIMEOUT_MS - 100);
    expect(layer.status).toBe('loading');
    await vi.advanceTimersByTimeAsync(200);
    expect(layer.status).toBe('failed');
    // 打ち切った要求は中止されている
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
    layer.dispose();
  });
});
