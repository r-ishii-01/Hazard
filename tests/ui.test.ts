import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  formatArea,
  formatClock,
  formatDepth,
  formatDistance,
  formatElapsed,
  formatMinutes,
  formatPercent,
  formatSigned,
  formatTP,
  isSafeColor,
  parseHex,
  readableTextColor,
  relativeLuminance,
} from '../src/ui/format';
import { interpolateSeries, linePath, niceStep, niceTicks, normalizeThresholds, seriesExtent, summarizeArrays, timeTickStep } from '../src/ui/series';
import { shakeEnvelope } from '../src/ui/shake';

describe('format', () => {
  it('formats elapsed time in Japanese', () => {
    expect(formatElapsed(0)).toBe('0秒');
    expect(formatElapsed(45.9)).toBe('45秒');
    expect(formatElapsed(750)).toBe('12分30秒');
    expect(formatElapsed(605)).toBe('10分05秒');
    expect(formatElapsed(3905)).toBe('1時間05分05秒');
    expect(formatElapsed(-3)).toBe('0秒');
    expect(formatElapsed(Infinity)).toBe('—');
  });

  it('formats clock time', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(750)).toBe('12:30');
    expect(formatClock(7200)).toBe('120:00');
    expect(formatClock(NaN)).toBe('--:--');
  });

  it('formats minutes', () => {
    expect(formatMinutes(12)).toBe('12分');
    expect(formatMinutes(60)).toBe('1時間');
    expect(formatMinutes(90)).toBe('1時間30分');
  });

  it('formats signed values with a true minus sign and no negative zero', () => {
    expect(formatSigned(1.234)).toBe('+1.2');
    expect(formatSigned(-0.44)).toBe('−0.4');
    expect(formatSigned(-0.04)).toBe('+0.0');
    expect(formatTP(3.25)).toBe('T.P.+3.3 m');
    expect(formatTP(-1.5)).toBe('T.P.−1.5 m');
    expect(formatTP(NaN)).toBe('—');
  });

  it('formats depth, distance, area and percent', () => {
    expect(formatDepth(0.354)).toBe('0.35 m');
    expect(formatDepth(2.46)).toBe('2.5 m');
    expect(formatDepth(-1)).toBe('0.00 m');
    expect(formatDistance(847)).toBe('850 m');
    expect(formatDistance(1234)).toBe('1.2 km');
    expect(formatArea(1_234_567)).toBe('約1.23 km²');
    expect(formatArea(4520)).toBe('約4,500 m²');
    expect(formatArea(0)).toBe('0 m²');
    expect(formatPercent(0.424)).toBe('42%');
    expect(formatPercent(2)).toBe('100%');
  });
});

describe('colour helpers', () => {
  it('parses hex colours', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#0b1f3a')).toEqual([11, 31, 58]);
    expect(parseHex('red')).toBeNull();
  });

  it('picks a readable ink for intensity colours', () => {
    expect(readableTextColor('#f2f2f2')).toBe('#0b1220');
    expect(readableTextColor('#fff27a')).toBe('#0b1220');
    expect(readableTextColor('#a3143d')).toBe('#ffffff');
    expect(readableTextColor('#7e22ce')).toBe('#ffffff');
    // 選んだ文字色は 2 候補のうちコントラストが高い方で、大きな太字（震度ボタン）の基準 3:1 を満たす
    for (const bg of ['#e0f0ff', '#ffd24d', '#ff6633', '#e62e2e', '#7f1d1d', '#facc15']) {
      const lbg = relativeLuminance(parseHex(bg)!);
      const ink = readableTextColor(bg);
      const other = ink === '#ffffff' ? '#0b1220' : '#ffffff';
      const ratio = contrastRatio(lbg, relativeLuminance(parseHex(ink)!));
      expect(ratio).toBeGreaterThanOrEqual(3);
      expect(ratio).toBeGreaterThanOrEqual(contrastRatio(lbg, relativeLuminance(parseHex(other)!)));
    }
  });

  it('accepts only simple colour syntaxes for inline styles', () => {
    expect(isSafeColor('#abc')).toBe(true);
    expect(isSafeColor('rgba(1, 2, 3, 0.5)')).toBe(true);
    expect(isSafeColor('url(javascript:alert(1))')).toBe(false);
    expect(isSafeColor('red; background: x')).toBe(false);
    expect(isSafeColor(undefined)).toBe(false);
  });
});

describe('series', () => {
  const ts = new Float32Array([0, 10, 20, 30, 0]);
  const vs = new Float32Array([0, 1, NaN, 3, 99]);

  it('interpolates linearly within the ready range', () => {
    expect(interpolateSeries(ts, vs, 4, 5)).toBeCloseTo(0.5);
    expect(interpolateSeries(ts, vs, 4, -1)).toBe(0);
    expect(interpolateSeries(ts, vs, 4, 30)).toBe(3);
  });

  it('returns NaN beyond the computed samples and handles gaps', () => {
    expect(interpolateSeries(ts, vs, 4, 31)).toBeNaN();
    expect(interpolateSeries(ts, vs, 0, 5)).toBeNaN();
    expect(interpolateSeries(ts, vs, 4, 12)).toBe(1); // 近い方（NaN でない側）
    expect(interpolateSeries(ts, vs, 4, 18)).toBeNaN();
  });

  it('computes extents ignoring NaN', () => {
    expect(seriesExtent(vs, 4)).toEqual({ min: 0, max: 3 });
    expect(seriesExtent(new Float32Array([NaN]), 1)).toBeNull();
  });

  it('builds line paths that break at NaN and keep peaks when decimating', () => {
    const d = linePath(ts, vs, 4, { t0: 0, t1: 30, yMin: 0, yMax: 3, width: 300, height: 30 });
    expect(d).toBe('M0.0 30.0L100.0 20.0M300.0 0.0');
    const n = 10_000;
    const t = new Float32Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i;
      v[i] = i === 5_123 ? 10 : Math.sin(i / 50);
    }
    const path = linePath(t, v, n, { t0: 0, t1: n, yMin: -1, yMax: 10, width: 1000, height: 100, maxPoints: 200 });
    const points = path.match(/[ML]/g)!.length;
    expect(points).toBeLessThanOrEqual(200);
    expect(path).toContain(' 0.0'); // 最大値 10 → y=0 が残る
  });

  it('chooses nice ticks', () => {
    expect(niceStep(1, 4)).toBe(0.5);
    expect(niceStep(7, 4)).toBe(2);
    expect(niceTicks(1.3, 4)).toEqual([0, 0.5, 1, 1.5]);
    expect(timeTickStep(3600, 6)).toBe(600);
    expect(timeTickStep(1800, 6)).toBe(300);
    expect(timeTickStep(7200, 6)).toBe(1200);
  });

  it('summarizes arrival and max depth arrays', () => {
    const arrival = new Float32Array([Infinity, 700, 650, Infinity]);
    const maxDepth = new Float32Array([0, 1.5, 0.005, NaN]);
    expect(summarizeArrays(arrival, maxDepth)).toEqual({ firstArrival: 650, maxDepth: 1.5, floodedCells: 1 });
    expect(summarizeArrays(new Float32Array(0), new Float32Array(0)).firstArrival).toBe(Infinity);
  });

  it('normalizes threshold exports of various shapes', () => {
    expect(normalizeThresholds([1, 0.3])).toEqual([0.3, 1]);
    expect(normalizeThresholds({ walk: 0.3, swept: 1.0 })).toEqual([0.3, 1]);
    expect(normalizeThresholds([{ depth: 0.5 }, { min: 2 }])).toEqual([0.5, 2]);
    expect(normalizeThresholds(undefined)).toEqual([]);
    expect(normalizeThresholds(['x', -1, NaN])).toEqual([]);
  });
});

describe('shake envelope', () => {
  it('rises, holds and eases out to zero', () => {
    expect(shakeEnvelope(0)).toBe(0);
    expect(shakeEnvelope(0.3)).toBe(1);
    expect(shakeEnvelope(0.9)).toBeGreaterThan(0);
    expect(shakeEnvelope(0.9)).toBeLessThan(0.3);
    expect(shakeEnvelope(1)).toBe(0);
    expect(shakeEnvelope(-0.1)).toBe(0);
    expect(shakeEnvelope(NaN)).toBe(0);
  });
});
