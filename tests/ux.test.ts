/**
 * 画面の使いやすさ・正確な表記に関わる純粋な処理:
 * - 地図の上の時刻の短い表記（狭い画面で 1 時間を過ぎても幅が変わらない）
 * - 「クリック」「タップ」の書き分け
 * - ボトムシートのドラッグの判定
 * - グラフのしきい値のラベルの置き場所（データの線と重ならない側）
 * - 到達時間の「想定」「設定」の書き分け（南海トラフ・説明用の例・変更した値は「設定」）
 * - 計算が終わったときの読み上げ文
 * - 現在地の扱いの説明（座標は送らないが、地図の画像の読み込みで大まかな場所は配信元に伝わる）
 */
import { describe, expect, it } from 'vitest';
import { formatElapsed, formatElapsedMinutes } from '../src/core/format';
import { getScenario, defaultParams } from '../src/data/scenarios';
import { placingDoneLabel, placingPrompt, tapVerb } from '../src/ui/pointer';
import { SHEET_DRAG_THRESHOLD_PX, sheetDragOffset, sheetDragOutcome } from '../src/ui/gestures';
import { chooseLabelSide, estimateTextWidth } from '../src/ui/series';
import { ARRIVAL_BASIS_LABEL, arrivalFactLabel, arrivalKind, arrivalMarkerLabel } from '../src/ui/scenarioText';
import { completionAnnouncement } from '../src/ui/panels/quake';
import { GEO_PRIVACY_TEXT, GEO_TILE_NOTE } from '../src/ui/geolocate';

describe('地図の上の時刻（狭い画面）', () => {
  it('counts minutes past one hour, like the timeline (80:30)', () => {
    expect(formatElapsedMinutes(0)).toBe('0秒');
    expect(formatElapsedMinutes(45.9)).toBe('45秒');
    expect(formatElapsedMinutes(605)).toBe('10分05秒');
    expect(formatElapsedMinutes(3599)).toBe('59分59秒');
    expect(formatElapsedMinutes(3600)).toBe('60分00秒');
    expect(formatElapsedMinutes(80 * 60 + 30)).toBe('80分30秒');
    expect(formatElapsedMinutes(-1)).toBe('0秒');
    expect(formatElapsedMinutes(NaN)).toBe('—');
    // 1 時間の前後で文字数が変わらない（「1時間00分00秒」は 3 文字長い）
    expect(formatElapsedMinutes(3600).length).toBe(formatElapsedMinutes(3599).length);
    expect(formatElapsed(3600).length).toBeGreaterThan(formatElapsed(3599).length);
  });
});

describe('クリック・タップの書き分け', () => {
  it('says タップ and omits Esc on touch devices', () => {
    expect(tapVerb(true)).toBe('タップ');
    expect(tapVerb(false)).toBe('クリック');
    expect(placingPrompt('走って避難', true)).toBe('地図をタップして「走って避難」を配置');
    expect(placingPrompt('大人', false)).toBe('地図をクリックして「大人」を配置');
    expect(placingDoneLabel(true)).toBe('終了');
    expect(placingDoneLabel(false)).toBe('終了（Esc）');
  });
});

describe('ボトムシートのドラッグ', () => {
  const H = 480;
  it('ignores taps and small drags', () => {
    expect(sheetDragOutcome(0, 0, false, H)).toBe('none');
    expect(sheetDragOutcome(5, 0, false, H)).toBe('none');
    expect(sheetDragOutcome(-(SHEET_DRAG_THRESHOLD_PX - 10), 0.1, false, H)).toBe('none');
  });
  it('expands when dragged or flicked up', () => {
    expect(sheetDragOutcome(-120, -0.2, false, H)).toBe('expand');
    expect(sheetDragOutcome(-20, -0.9, false, H)).toBe('expand');
    expect(sheetDragOutcome(-200, -1, true, H)).toBe('none');
  });
  it('shrinks an expanded sheet, or closes it when dragged far down', () => {
    expect(sheetDragOutcome(80, 0.1, true, H)).toBe('shrink');
    expect(sheetDragOutcome(20, 1.2, true, H)).toBe('shrink');
    expect(sheetDragOutcome(H * 0.6, 0.3, true, H)).toBe('close');
    expect(sheetDragOutcome(80, 0.1, false, H)).toBe('close');
    // 下へ動かしてから上へ払った: 動かした向きと速さの向きが違えばフリックとみなさない
    expect(sheetDragOutcome(20, -1, false, H)).toBe('none');
  });
  it('follows the finger down and resists upward', () => {
    expect(sheetDragOffset(100)).toBe(100);
    expect(sheetDragOffset(-40)).toBe(-10);
    expect(sheetDragOffset(-400)).toBe(-24);
    expect(sheetDragOffset(NaN)).toBe(0);
  });
});

describe('グラフのしきい値のラベル', () => {
  it('estimates the width of mixed Japanese text', () => {
    const w = estimateTextWidth('1.0 m〜 生命の危険', 10);
    expect(w).toBeGreaterThan(80);
    expect(w).toBeLessThan(120);
  });
  it('moves the label to the left when the data line runs through the right end', () => {
    const box = { left: 36, right: 310, top: 30, bottom: 42, width: 90 };
    // 後半（右端）で線がラベルの高さを通る
    const xs = [36, 100, 200, 250, 310];
    const ys = [120, 120, 60, 36, 38];
    expect(chooseLabelSide(xs, ys, xs.length, box)).toBe('start');
    // 右端で線が離れていれば右のまま
    expect(chooseLabelSide(xs, [120, 120, 100, 90, 90], xs.length, box)).toBe('end');
    // 両側とも重なる場合は右（既定）
    expect(chooseLabelSide([36, 310], [36, 36], 2, box)).toBe('end');
  });
});

describe('到達時間の「想定」「設定」', () => {
  const west = getScenario('sagami-west')!;
  const nankai = getScenario('nankai')!;
  const example = getScenario('example-advisory')!;

  it('uses 想定 only for the official 最大津波到達時間', () => {
    expect(arrivalKind(west)).toBe('想定');
    expect(arrivalFactLabel(west)).toBe('最大波の到達（想定） 約8分');
    expect(arrivalMarkerLabel(west)).toBe('最大波の想定時刻');
  });

  it('uses 設定 for 南海トラフ (内閣府 publishes no max-wave time) and examples', () => {
    expect(nankai.isOfficial).toBe(true);
    expect(arrivalKind(nankai)).toBe('設定');
    expect(arrivalFactLabel(nankai)).toBe('最大波の到達（設定） 約34分');
    expect(arrivalMarkerLabel(nankai)).toBe('最大波の設定時刻');
    expect(arrivalMarkerLabel(example)).toBe('最大波の設定時刻');
  });

  it('uses 設定 once the arrival time has been changed, and for the run copy of the scenario', () => {
    const run = defaultParams(west).scenario;
    expect(arrivalMarkerLabel(run)).toBe('最大波の想定時刻');
    expect(arrivalMarkerLabel({ ...run, arrivalMin: 12 })).toBe('最大波の設定時刻');
  });

  it('names the basis as the basis of the max-wave time (not the 津波到達時間 layer)', () => {
    expect(ARRIVAL_BASIS_LABEL).toBe('最大波の到達時間の根拠');
  });
});

describe('計算が終わったときの読み上げ', () => {
  it('summarizes the result in one sentence with labels', () => {
    const text = completionAnnouncement({ firstArrival: 101, maxDepth: 5.12, areaM2: 1_220_000 }, 5400);
    expect(text).toBe('計算が完了しました。陸域で最初に浸水したのは地震発生から1分41秒、最大浸水深は5.1 m、浸水した範囲は約1.22 km²です（このサイトの簡易計算）。');
  });
  it('does not claim safety when nothing flooded', () => {
    const text = completionAnnouncement({ firstArrival: Infinity, maxDepth: 0, areaM2: 0 }, 5400);
    expect(text).toContain('計算した1時間30分00秒の間に、陸域の浸水はありませんでした');
    expect(text).toContain('安全という意味ではありません');
  });
  it('falls back to a short message without a summary', () => {
    expect(completionAnnouncement(null, 5400)).toBe('計算が完了しました');
  });
});

describe('現在地の扱いの説明', () => {
  it('does not claim that nothing about the location leaves the device', () => {
    expect(GEO_PRIVACY_TEXT).not.toContain('外部には送信しません');
    expect(GEO_PRIVACY_TEXT).toContain('座標');
    expect(GEO_TILE_NOTE).toContain('おおよその場所');
    expect(GEO_TILE_NOTE).toContain('配信元');
  });
});
