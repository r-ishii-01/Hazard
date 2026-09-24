/**
 * 地名検索で選んだ場所の目印（一時的なピン）と、現在地（点と精度の円）。
 *
 * - ピン: store.focus に label があるときだけ出す（地名検索の結果）。× で消せる（actions.clearFocus）。
 * - 現在地: store.userLocation の点（HTML マーカー）と、精度（誤差の半径）の円（GeoJSON の塗り）。
 *   座標はこの端末の中だけで使う（地図に描くだけで、どこにも送らない）。
 *
 * 外部から来た文字列（検索結果の名称）は textContent で入れる。
 */
import { Marker, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { MapFocus, UserLocation } from '../core/types';
import { circleRing } from './geo2d';
import { IDS, emptyFC, type GeoFeatureCollection } from './style';

const PIN_SVG =
  '<svg viewBox="0 0 32 42" width="32" height="42" aria-hidden="true" focusable="false">' +
  '<path d="M16 41s13-14.6 13-24.6A13 13 0 0 0 3 16.4C3 26.4 16 41 16 41z" fill="#dc2626" stroke="#fff" stroke-width="2.4"/>' +
  '<circle cx="16" cy="16.4" r="5" fill="#fff"/></svg>';

export class LocationLayer {
  private pin: Marker | null = null;
  private pinSeq = -1;
  private dot: Marker | null = null;
  private dotEl: HTMLElement | null = null;
  private loc: UserLocation | null = null;
  private circleKey = '';

  constructor(
    private readonly map: MapLibreMap,
    /** ピンの × が押された */
    private readonly onClosePin: () => void,
  ) {}

  /** 検索地点のピン（label のある focus のときだけ） */
  setFocus(f: MapFocus | null): void {
    if (!f || !f.label || !Number.isFinite(f.lon) || !Number.isFinite(f.lat)) {
      this.removePin();
      return;
    }
    if (this.pin && this.pinSeq === f.seq) return;
    this.removePin();
    this.pinSeq = f.seq;
    const el = document.createElement('div');
    el.className = 'm2d-search';
    const label = document.createElement('div');
    label.className = 'm2d-search__label';
    const text = document.createElement('span');
    text.className = 'm2d-search__text';
    text.textContent = f.label;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'm2d-search__close';
    close.setAttribute('aria-label', '目印を消す');
    close.title = '目印を消す';
    close.textContent = '×';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onClosePin();
    });
    label.append(text, close);
    const pin = document.createElement('div');
    pin.className = 'm2d-search__pin';
    pin.innerHTML = PIN_SVG; // 定数の SVG のみ
    el.append(label, pin);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `検索した場所: ${f.label}`);
    this.pin = new Marker({ element: el, anchor: 'bottom' }).setLngLat([f.lon, f.lat]).addTo(this.map);
  }

  private removePin(): void {
    this.pin?.remove();
    this.pin = null;
    this.pinSeq = -1;
  }

  /** 現在地（null で消す） */
  setUserLocation(loc: UserLocation | null): void {
    this.loc = loc && Number.isFinite(loc.lon) && Number.isFinite(loc.lat) ? loc : null;
    if (!this.loc) {
      this.dot?.remove();
      this.dot = null;
      this.dotEl = null;
    } else {
      if (!this.dot || !this.dotEl) {
        const el = document.createElement('div');
        el.className = 'm2d-userloc';
        el.setAttribute('role', 'img');
        const core = document.createElement('div');
        core.className = 'm2d-userloc__dot';
        el.appendChild(core);
        this.dotEl = el;
        this.dot = new Marker({ element: el, anchor: 'center' }).setLngLat([this.loc.lon, this.loc.lat]).addTo(this.map);
      } else {
        this.dot.setLngLat([this.loc.lon, this.loc.lat]);
      }
      const acc = this.loc.accuracyM;
      const accText = Number.isFinite(acc) && acc > 0 ? `（誤差 約 ${acc < 1000 ? `${Math.round(acc)} m` : `${(acc / 1000).toFixed(1)} km`}）` : '';
      const title = `現在地${accText}`;
      this.dotEl.title = title;
      this.dotEl.setAttribute('aria-label', title);
    }
    this.applyCircle();
  }

  /** 精度の円（スタイルの準備ができてから。何度呼んでもよい） */
  applyCircle(): void {
    const src = this.map.getSource(IDS.userLocSource) as GeoJSONSource | undefined;
    if (!src) return;
    const loc = this.loc;
    const r = loc?.accuracyM ?? NaN;
    const key = loc && Number.isFinite(r) && r > 0 ? `${loc.lon},${loc.lat},${r}` : '';
    if (key === this.circleKey) return;
    this.circleKey = key;
    const data: GeoFeatureCollection =
      loc && key
        ? {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleRing(loc.lon, loc.lat, r)] } }],
          }
        : emptyFC();
    src.setData(data).catch((e: unknown) => console.warn('[map2d] userloc', e));
  }

  /** スタイルを読み直した後（ソースが新しくなった）に円を入れ直す */
  resetCircle(): void {
    this.circleKey = '\u0000';
    this.applyCircle();
  }

  destroy(): void {
    this.removePin();
    this.dot?.remove();
    this.dot = null;
    this.dotEl = null;
  }
}
