/** 主な地点（ランドマーク）。［スタブ: 調査結果に基づき data 担当が座標を確定］ */
export interface Poi {
  id: string;
  name: string;
  lon: number;
  lat: number;
  kind: 'station' | 'landmark' | 'river' | 'park';
  source?: string;
}

export const POIS: Poi[] = [];
