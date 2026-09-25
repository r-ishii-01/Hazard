/**
 * 地図上のマーカーに使う SVG ピクトグラム（人物・状態バッジ・避難場所）。
 * すべて currentColor で塗るので、色は CSS 側で指定する。
 */
import type { PersonKind, PersonStatus, ShelterKind } from '../core/types';
import { PERSON_STATUS_INFO } from '../people';

const svg = (viewBox: string, body: string) =>
  `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${body}</svg>`;

/** 人物の種別ごとのピクトグラム（24×24） */
const PERSON_BODY: Record<PersonKind, string> = {
  // 大人: 直立した人
  adult:
    '<circle cx="12" cy="3.7" r="2.5" fill="currentColor"/>' +
    '<path d="M9.9 7.1h4.2a2.2 2.2 0 0 1 2.2 2.2v5.2h-8.6V9.3a2.2 2.2 0 0 1 2.2-2.2z" fill="currentColor"/>' +
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.3">' +
    '<path d="M7.7 8.6 6.6 14M16.3 8.6l1.1 5.4"/><path d="M10.4 14v7.6M13.6 14v7.6"/></g>',
  // 子ども: 頭が大きく背が低い。片手を上げている
  child:
    '<circle cx="12" cy="7.2" r="3" fill="currentColor"/>' +
    '<path d="M10.2 11h3.6a2 2 0 0 1 2 2v4h-7.6v-4a2 2 0 0 1 2-2z" fill="currentColor"/>' +
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.2">' +
    '<path d="M8.6 12.2 6.8 16.4M15.4 12.1l2.3-4.6"/><path d="M10.6 16.5v5.2M13.4 16.5v5.2"/></g>',
  // 高齢者: 前かがみで杖をつく（右向き）
  elderly:
    '<circle cx="12.4" cy="4.3" r="2.4" fill="currentColor"/>' +
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10.9 8.2 8.7 14.4" stroke-width="3.8"/>' +
    '<path d="M11 9.2l2.6 3.2 2.4.1" stroke-width="2.2"/>' +
    '<path d="M8.6 14.6 7.1 21.6M8.9 14.8l2.3 3-.4 3.8" stroke-width="2.4"/>' +
    '<path d="M16.3 12.6 17.3 21.8M16.3 12.6c-.1-1.3.9-2 1.9-1.6" stroke-width="1.7"/></g>',
  // 車いす
  wheelchair:
    '<circle cx="9.2" cy="3.6" r="2.3" fill="currentColor"/>' +
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8.6 7.4 9.3 12.6h5.3l2.4 5.8 2.1-.8" stroke-width="2.5"/>' +
    '<path d="M9 9.8h4.2" stroke-width="2.1"/>' +
    '<path d="M6.7 10.4a5.6 5.6 0 1 0 8.2 6.4" stroke-width="2"/></g>',
  // 走って避難
  runner:
    '<circle cx="15.6" cy="3.6" r="2.4" fill="currentColor"/>' +
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M13.9 7.6 11.6 13.4" stroke-width="3.4"/>' +
    '<path d="M13.4 8.3 9.6 9.4 7.8 12.2M13.8 8.6l2.6 2.7 3.1-.2" stroke-width="2.1"/>' +
    '<path d="M11.6 13.4l3.4 2.8-1 5.2M11.4 13.8 9.2 17.6l-4.5.6" stroke-width="2.3"/></g>',
};

export function personIconSvg(kind: PersonKind): string {
  return svg('0 0 24 24', PERSON_BODY[kind] ?? PERSON_BODY.adult);
}

/** 状態バッジ（16×16。線の色は currentColor: 状態の色の上で読みやすい白または濃紺。STATUS_STYLE の ink） */
const STATUS_BADGE: Record<PersonStatus, string> = {
  // 避難開始前: 時計
  waiting: '<circle cx="8" cy="8" r="4.6" stroke-width="1.6"/><path d="M8 5.4V8l1.8 1.2" stroke-width="1.6"/>',
  // 避難中: 矢印
  evacuating: '<path d="M3.8 8h7.6M8.4 4.8 11.6 8l-3.2 3.2" stroke-width="2"/>',
  // 避難完了: チェック
  safe: '<path d="m3.9 8.3 2.6 2.6 5.6-5.8" stroke-width="2.1"/>',
  // 浸水（注意）: 波
  caution: '<path d="M2.8 6.8c1.3-1.3 2.6-1.3 3.9 0s2.6 1.3 3.9 0 2-1 2.6-.6M2.8 10.4c1.3-1.3 2.6-1.3 3.9 0s2.6 1.3 3.9 0 2-1 2.6-.6" stroke-width="1.6"/>',
  // 歩行困難（危険）: ！
  danger: '<path d="M8 3.6v5.4" stroke-width="2.2"/><circle cx="8" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  // 生命の危険: ×
  critical: '<path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8" stroke-width="2.2"/>',
};

export function statusBadgeSvg(status: PersonStatus): string {
  return svg('0 0 16 16', `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${STATUS_BADGE[status]}</g>`);
}

/**
 * 「その場にとどまる」人（浸水していない間）のバッジ: 位置のピン。
 * 状態は 'waiting' だが、「避難開始前」の時計にすると、これから避難を始めるように読めるため（「人物」タブの一覧と同じ印）。
 */
export function stayBadgeSvg(): string {
  return svg(
    '0 0 16 16',
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"><path d="M8 14s-4.2-3.9-4.2-7.2a4.2 4.2 0 0 1 8.4 0C12.2 10.1 8 14 8 14z"/><circle cx="8" cy="6.8" r="1.4"/></g>',
  );
}

/** 状態の並び（凡例と同じ順） */
const STATUS_KEYS: PersonStatus[] = ['waiting', 'evacuating', 'safe', 'caution', 'danger', 'critical'];

/** 状態の色が読み取れないときの色（people の定義が無い・不正な場合） */
const FALLBACK_STATUS_COLOR = '#64748b';

/** sRGB の相対輝度（WCAG 2.x） */
function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

const INK_DARK = '#0f172a';
const INK_LIGHT = '#ffffff';

/** 背景色 bg の上で読みやすい文字・線の色（白と濃紺のうちコントラスト比が高い方） */
export function inkOn(bg: string): string {
  const l = luminance(bg);
  if (l === null) return INK_LIGHT;
  const dark = luminance(INK_DARK)!;
  const onDark = (l + 0.05) / (dark + 0.05);
  const onLight = 1.05 / (l + 0.05);
  return onDark > onLight ? INK_DARK : INK_LIGHT;
}

/**
 * 状態ごとの表示名・色（白い円の縁取り・バッジ・浸水深の札に使う）と、その色の上の文字・線の色。
 * 表示名と色は people モジュールの PERSON_STATUS_INFO（「人物」タブの凡例・一覧・3D 表示と同じ）から作る。
 * 色だけに頼らないよう、バッジの形とラベル文字でも区別する。
 */
export const STATUS_STYLE: Record<PersonStatus, { color: string; label: string; ink: string }> = Object.fromEntries(
  STATUS_KEYS.map((st) => {
    const info = PERSON_STATUS_INFO[st];
    const color = info && /^#[0-9a-f]{6}$/i.test(info.color) ? info.color : FALLBACK_STATUS_COLOR;
    return [st, { color, label: info?.label ?? st, ink: inkOn(color) }];
  }),
) as Record<PersonStatus, { color: string; label: string; ink: string }>;

/** 避難場所の種別ごとのアイコン（16×16）と色・名称 */
export const SHELTER_STYLE: Record<ShelterKind, { color: string; label: string; icon: string }> = {
  'evac-site': {
    color: '#15803d',
    label: '指定緊急避難場所',
    // 人が走って逃げる（避難場所）を簡略化: 丸と矢印
    icon: svg(
      '0 0 16 16',
      '<circle cx="9.6" cy="3.2" r="1.7" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"><path d="M8.8 5.6 7.2 9.4l2.8 1.4.6 3.4M7.4 9.2l-1.6 3.4-2.6.4M8.6 6l2.8 1.8 2 -.4"/></g>',
    ),
  },
  'tsunami-building': {
    color: '#1d4ed8',
    label: '津波避難ビル',
    // 建物（窓つき）と上向き矢印
    icon: svg(
      '0 0 16 16',
      '<path d="M1.8 15V5.2c0-.4.3-.7.7-.7h6.2c.4 0 .7.3.7.7V15z" fill="currentColor"/>' +
        '<path d="M3.6 6.6h1.4v1.4H3.6zM6.2 6.6h1.4v1.4H6.2zM3.6 9.4h1.4v1.4H3.6zM6.2 9.4h1.4v1.4H6.2z" fill="#1d4ed8"/>' +
        '<path d="M12.8 14.6V2.6M10.4 5l2.4-2.4L15.2 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    ),
  },
  highground: {
    color: '#92400e',
    label: '高台',
    // 山
    icon: svg(
      '0 0 16 16',
      '<path d="M1.6 13.6 6.2 5l2.6 4.4 1.6-2.4 4 6.6z" fill="currentColor"/><path d="M6.2 5l1.1 1.9-1.1 1-1.1-.9z" fill="#fff" opacity=".7"/>',
    ),
  },
};

/** 経路の目標地点に使う小さな旗（16×16） */
export const FLAG_SVG = svg(
  '0 0 16 16',
  '<path d="M4 14.6V2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4.6 2.4h8.2l-2 3 2 3H4.6z" fill="currentColor"/>',
);
