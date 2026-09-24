/**
 * 現在地（ブラウザの Geolocation API）。
 *
 * - 利用者がボタンを押したときだけ 1 回取得する（watchPosition は使わない・自動では取得しない）。
 * - 得た座標はこの端末のメモリ上だけで使う。サーバーへ送らない（逆ジオコーダーにも渡さない）・保存もしない。
 * - エラーは日本語の説明に置き換える。
 *
 * 通信・DOM に依存しない関数は単体テストできる（requestPosition も geolocation を差し替えられる）。
 */
import type { UserLocation } from '../core/types';
import { distanceToDomain, isInsideBounds } from './geoSearch';

/** 現在地についての約束（現在地を使う画面に必ず出す） */
export const GEO_PRIVACY_TEXT = '現在地はこの端末内でのみ使用し、外部には送信しません。';

/** getCurrentPosition のオプション: 高精度・15 秒で打ち切り・古い位置は使わない */
export const GEO_OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 };

/** 精度がこれより悪い（誤差の半径が大きい）と注意を出す [m] */
export const LOW_ACCURACY_M = 500;

export type GeoErrorKind = 'denied' | 'unavailable' | 'timeout' | 'insecure' | 'unsupported';

/** GeolocationPositionError.code → 種別（1: PERMISSION_DENIED, 2: POSITION_UNAVAILABLE, 3: TIMEOUT） */
export function geoErrorKind(code: number): GeoErrorKind {
  if (code === 1) return 'denied';
  if (code === 3) return 'timeout';
  return 'unavailable';
}

/** エラーの説明（見出しと、どうすればよいか） */
export function geoErrorMessage(kind: GeoErrorKind): { title: string; detail: string } {
  switch (kind) {
    case 'denied':
      return {
        title: '位置情報の利用が許可されていません',
        detail: 'ブラウザや端末の設定で、このサイトの位置情報の利用を許可してから、もう一度お試しください。',
      };
    case 'timeout':
      return {
        title: '現在地の取得に時間がかかりすぎました',
        detail: '電波の届きやすい場所（屋外や窓の近く）で、もう一度お試しください。',
      };
    case 'insecure':
      return {
        title: 'このページでは現在地を使えません',
        detail: '位置情報は、安全な接続（https）で開いたページでのみ使えます。',
      };
    case 'unsupported':
      return {
        title: 'このブラウザは位置情報の取得に対応していません',
        detail: '地名・住所の検索か、地図をクリックして場所を選んでください。',
      };
    default:
      return {
        title: '現在地を特定できませんでした',
        detail: '端末の位置情報サービスがオンになっているか確かめて、もう一度お試しください。',
      };
  }
}

/** 精度（誤差の半径）の説明 */
export function describeAccuracy(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '誤差は不明';
  if (m < 100) return `誤差 約 ${Math.max(1, Math.round(m))} m`;
  if (m < 1000) return `誤差 約 ${Math.round(m / 10) * 10} m`;
  return `誤差 約 ${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

/** 位置の精度が低いか */
export function isLowAccuracy(m: number): boolean {
  return !Number.isFinite(m) || m > LOW_ACCURACY_M;
}

/** 取得した位置 → UserLocation（計算範囲の内外を判定） */
export function toUserLocation(coords: { longitude: number; latitude: number; accuracy: number }, timestamp: number): UserLocation {
  const lon = coords.longitude;
  const lat = coords.latitude;
  return {
    lon,
    lat,
    accuracyM: Number.isFinite(coords.accuracy) ? Math.max(0, coords.accuracy) : NaN,
    timestamp,
    insideDomain: isInsideBounds(lon, lat),
  };
}

/** 計算範囲までの距離 [m]（内側は 0） */
export function locationDistanceToDomain(loc: Pick<UserLocation, 'lon' | 'lat'>): number {
  return distanceToDomain(loc.lon, loc.lat);
}

export class GeoError extends Error {
  constructor(readonly kind: GeoErrorKind) {
    super(geoErrorMessage(kind).title);
    this.name = 'GeoError';
  }
}

/**
 * 現在地を 1 回だけ取得する。失敗は GeoError（kind で種別）。
 * geolocation・isSecureContext は差し替え可能（テスト用）。
 */
export function requestPosition(env: { geolocation?: Geolocation | null; secure?: boolean; now?: () => number } = {}): Promise<UserLocation> {
  const secure = env.secure ?? (typeof window === 'undefined' ? true : window.isSecureContext !== false);
  if (!secure) return Promise.reject(new GeoError('insecure'));
  const geo = env.geolocation !== undefined ? env.geolocation : typeof navigator !== 'undefined' ? navigator.geolocation : null;
  if (!geo || typeof geo.getCurrentPosition !== 'function') return Promise.reject(new GeoError('unsupported'));
  const now = env.now ?? (() => Date.now());
  return new Promise<UserLocation>((resolve, reject) => {
    try {
      geo.getCurrentPosition(
        (pos) => {
          const loc = toUserLocation(pos.coords, now());
          if (!Number.isFinite(loc.lon) || !Number.isFinite(loc.lat)) reject(new GeoError('unavailable'));
          else resolve(loc);
        },
        (err) => reject(new GeoError(geoErrorKind(err?.code ?? 2))),
        GEO_OPTIONS,
      );
    } catch {
      reject(new GeoError('unavailable'));
    }
  });
}
