/**
 * 表示用の書式・色計算（純粋関数。DOM に依存しないので単体テストできる）。
 */

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 経過時間（秒）→ 「12分30秒」「45秒」「1時間05分00秒」 */
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

/** 経過時間（秒）→ 「12:30」（分は60以上もそのまま） */
export function formatClock(sec: number): string {
  if (!Number.isFinite(sec)) return '--:--';
  const total = Math.max(0, Math.floor(sec + 1e-6));
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

/** 分 → 「12分」「1時間30分」 */
export function formatMinutes(min: number): string {
  if (!Number.isFinite(min)) return '—';
  const m = Math.round(min);
  if (m >= 60 && m % 60 === 0) return `${m / 60}時間`;
  if (m >= 60) return `${Math.floor(m / 60)}時間${m % 60}分`;
  return `${m}分`;
}

const MINUS = '−';

/** 符号付きの数値（マイナスは U+2212） */
export function formatSigned(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—';
  const r = Number(v.toFixed(digits));
  const abs = Math.abs(r).toFixed(digits);
  return r < 0 ? `${MINUS}${abs}` : `+${abs}`;
}

/** 標高・水位 [m, T.P.] → 「T.P.+1.2 m」 */
export function formatTP(m: number, digits = 1): string {
  if (!Number.isFinite(m)) return '—';
  return `T.P.${formatSigned(m, digits)} m`;
}

/** 浸水深 [m] → 「0.35 m」「2.4 m」 */
export function formatDepth(m: number): string {
  if (!Number.isFinite(m)) return '—';
  const v = Math.max(0, m);
  return `${v < 1 ? v.toFixed(2) : v.toFixed(1)} m`;
}

/** 距離 [m] → 「850 m」「1.2 km」 */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** 速度 [m/s] → 「1.0 m/s（時速3.6 km）」 */
export function formatSpeed(mps: number, withKmh = true): string {
  if (!Number.isFinite(mps)) return '—';
  const base = `${mps.toFixed(1)} m/s`;
  return withKmh ? `${base}（時速${(mps * 3.6).toFixed(1)} km）` : base;
}

/** 面積 [m²] → 「約1.23 km²」「約4,500 m²」 */
export function formatArea(m2: number): string {
  if (!Number.isFinite(m2) || m2 <= 0) return '0 m²';
  if (m2 >= 100_000) return `約${(m2 / 1e6).toFixed(2)} km²`;
  return `約${(Math.round(m2 / 100) * 100).toLocaleString('ja-JP')} m²`;
}

/** 割合 0..1 → 「42%」 */
export function formatPercent(p: number): string {
  if (!Number.isFinite(p)) return '0%';
  return `${Math.round(clamp(p, 0, 1) * 100)}%`;
}

// ---------------------------------------------------------------------------
// 色
// ---------------------------------------------------------------------------

/** '#rgb' / '#rrggbb' → [r, g, b]（0..255）。不正なら null */
export function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG の相対輝度 */
export function relativeLuminance(rgb: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

export const INK_DARK = '#0b1220';
export const INK_LIGHT = '#ffffff';

/** 背景色の上で読みやすい文字色（濃紺か白）を返す */
export function readableTextColor(bg: string): string {
  const rgb = parseHex(bg);
  if (!rgb) return INK_DARK;
  const l = relativeLuminance(rgb);
  const dark = relativeLuminance(parseHex(INK_DARK)!);
  return contrastRatio(l, dark) >= contrastRatio(l, 1) ? INK_DARK : INK_LIGHT;
}

/** CSS の色として使える安全な文字列か（データ由来の色を style に入れる前の検査） */
export function isSafeColor(c: unknown): c is string {
  return typeof c === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(c.trim());
}
