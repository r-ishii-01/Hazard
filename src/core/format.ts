/**
 * 画面の複数の場所（UI・人物のモデルの説明文）で共通に使う書式。
 * 同じ値が場所によって違って見えないよう（例: 到着 27分02秒 と 27分03秒）、書式はここに一本化する。
 * DOM に依存しない純粋関数。
 */

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/**
 * 経過時間（秒）→ 「12分30秒」「45秒」「1時間05分00秒」。
 * 秒未満は切り捨てる（「まだその時刻になっていない」側に丸める）。
 */
export function formatElapsed(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  const total = Math.max(0, Math.floor(sec + 1e-6));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}時間${pad2(m)}分${pad2(s)}秒`;
  if (m > 0) return `${m}分${pad2(s)}秒`;
  return `${s}秒`;
}

/**
 * 経過時間（秒）→ 1 時間を超えても分で数える表記: 「80分30秒」「9分05秒」「45秒」。
 * 狭い画面の地図の上の時刻表示用（「1時間20分30秒」より短く、1 時間の前後で幅が変わらない）。
 * タイムラインの「80:30」と同じ数え方。秒未満は切り捨てる（formatElapsed と同じ）。
 */
export function formatElapsedMinutes(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  const total = Math.max(0, Math.floor(sec + 1e-6));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}分${pad2(s)}秒` : `${s}秒`;
}

/**
 * 経過時間（秒）の短い表記。秒が 0 なら省く: 「9分」「9分20秒」「1時間」「1時間05分」「40秒」。
 * 計算済みの範囲（「0〜9分20秒のみ計算」）などに使う。
 */
export function formatSpan(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  const total = Math.max(0, Math.floor(sec + 1e-6));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    if (s > 0) return `${h}時間${pad2(m)}分${pad2(s)}秒`;
    return m > 0 ? `${h}時間${pad2(m)}分` : `${h}時間`;
  }
  if (m > 0) return s > 0 ? `${m}分${pad2(s)}秒` : `${m}分`;
  return `${s}秒`;
}

/** 浸水深 [m] → 「0.35 m」「2.4 m」（1 m 未満は cm 単位の精度） */
export function formatDepth(m: number): string {
  if (!Number.isFinite(m)) return '—';
  const v = Math.max(0, m);
  return `${v < 1 ? v.toFixed(2) : v.toFixed(1)} m`;
}
