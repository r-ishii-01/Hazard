/**
 * 避難場所・主な地点（POI）・計算範囲ラベルの HTML マーカー。
 * 文字のシンボルレイヤー（グリフが必要）は使わず、すべて DOM で描く。
 */
import { Marker, Popup, type Map as MapLibreMap } from 'maplibre-gl';
import type { Shelter } from '../core/types';
import { SHELTER_STYLE } from './icons';
import type { Poi } from '../data/poi';
import { shelterNoticeElement } from './shelterNotice';

/** 表示対象とするおおよその範囲（計算範囲より少し広く） */
const NEAR = { west: 139.38, east: 139.56, south: 35.26, north: 35.39 };

const near = (lon: number, lat: number) => lon >= NEAR.west && lon <= NEAR.east && lat >= NEAR.south && lat <= NEAR.north;

export class ShelterLayer {
  private markers = new Map<string, { marker: Marker; el: HTMLElement; shelter: Shelter }>();
  private data: Shelter[] = [];
  private visible = true;
  private popup: Popup;
  private highlighted: string | null = null;

  constructor(private map: MapLibreMap) {
    this.popup = new Popup({ closeButton: true, closeOnClick: true, className: 'm2d-popup', offset: 14, maxWidth: '280px', focusAfterOpen: false });
  }

  setData(shelters: Shelter[]): void {
    if (shelters === this.data) return;
    this.data = shelters;
    this.clear();
    if (this.visible) this.build();
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    if (v) this.build();
    else {
      this.clear();
      this.popup.remove();
    }
  }

  /** 選択中の人物の避難先を強調する */
  setHighlight(target: { lon: number; lat: number; name: string } | null): void {
    let id: string | null = null;
    if (target) {
      for (const [sid, m] of this.markers) {
        const s = m.shelter;
        if ((Math.abs(s.lon - target.lon) < 1e-5 && Math.abs(s.lat - target.lat) < 1e-5) || s.name === target.name) {
          id = sid;
          break;
        }
      }
    }
    if (id === this.highlighted) return;
    if (this.highlighted) this.markers.get(this.highlighted)?.el.classList.remove('m2d-shelter--target');
    this.highlighted = id;
    if (id) this.markers.get(id)?.el.classList.add('m2d-shelter--target');
  }

  private build(): void {
    if (this.markers.size) return;
    for (const s of this.data) {
      if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat) || !near(s.lon, s.lat)) continue;
      const st = SHELTER_STYLE[s.kind] ?? SHELTER_STYLE['evac-site'];
      const el = document.createElement('div');
      el.className = 'm2d-shelter';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `${st.label}: ${s.name}`);
      el.title = `${s.name}（${st.label}）`;
      const dot = document.createElement('div');
      dot.className = 'm2d-shelter__dot';
      dot.style.setProperty('--m2d-c', st.color);
      dot.innerHTML = st.icon;
      el.appendChild(dot);
      const marker = new Marker({ element: el, anchor: 'center' }).setLngLat([s.lon, s.lat]).addTo(this.map);
      const open = (ev: Event) => {
        ev.stopPropagation();
        this.openPopup(s);
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open(ev);
        }
      });
      this.markers.set(s.id, { marker, el, shelter: s });
    }
    if (this.highlighted) {
      const id = this.highlighted;
      this.highlighted = null;
      const s = this.markers.get(id)?.shelter;
      if (s) this.setHighlight(s);
    }
  }

  private openPopup(s: Shelter): void {
    const st = SHELTER_STYLE[s.kind] ?? SHELTER_STYLE['evac-site'];
    const box = document.createElement('div');
    const kind = document.createElement('span');
    kind.className = 'm2d-pk';
    kind.style.background = st.color;
    kind.textContent = st.label;
    const h = document.createElement('h4');
    h.textContent = s.name;
    box.append(kind, h);
    if (s.address) {
      const p = document.createElement('p');
      p.textContent = s.address;
      box.appendChild(p);
    }
    if (s.safeHeightTP != null && Number.isFinite(s.safeHeightTP)) {
      const p = document.createElement('p');
      p.textContent = `避難できる高さ: T.P. ${s.safeHeightTP.toFixed(1)} m`;
      box.appendChild(p);
    }
    const src = document.createElement('p');
    src.className = 'm2d-src';
    src.textContent = `出典: ${s.source}`;
    box.append(src, shelterNoticeElement());
    this.popup.setLngLat([s.lon, s.lat]).setDOMContent(box).addTo(this.map);
  }

  private clear(): void {
    for (const m of this.markers.values()) m.marker.remove();
    this.markers.clear();
  }

  destroy(): void {
    this.clear();
    this.popup.remove();
  }
}

/** 主な地点の小さなラベル */
export class PoiLayer {
  private markers: Marker[] = [];

  constructor(private map: MapLibreMap) {}

  setData(pois: Poi[]): void {
    for (const m of this.markers) m.remove();
    this.markers = [];
    for (const p of pois) {
      if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
      const el = document.createElement('div');
      el.className = `m2d-poi m2d-poi--${p.kind}`;
      el.textContent = p.name;
      el.setAttribute('aria-hidden', 'true');
      this.markers.push(new Marker({ element: el, anchor: 'left', offset: [-3, 0] }).setLngLat([p.lon, p.lat]).addTo(this.map));
    }
  }

  destroy(): void {
    for (const m of this.markers) m.remove();
    this.markers = [];
  }
}

/** 計算範囲の左上に置く「計算範囲」ラベル */
export function createDomainLabel(map: MapLibreMap, lonLat: [number, number]): Marker {
  const el = document.createElement('div');
  el.className = 'm2d-domain-label';
  el.textContent = '計算範囲';
  el.title = '津波シミュレーションの計算範囲（破線の枠）';
  return new Marker({ element: el, anchor: 'top-left' }).setLngLat(lonLat).addTo(map);
}
