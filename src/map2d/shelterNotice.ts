/**
 * 避難場所データの利用上の注意（2D のポップアップ・3D の説明で共用。maplibre-gl・three.js に依存しない）。
 *
 * 国土地理院の指定緊急避難場所データの「ご利用上の注意」は、データを使った情報を第三者に提供するときに注意事項が
 * 正確に伝わるようにすることを求めている（src/data/shelters.ts の SHELTER_USAGE_NOTICE）。避難場所の説明には、
 * その要点と、藤沢市が独自に指定している津波避難ビルの多くが含まれないこと（市の一覧へのリンク）を添える。
 */
import { FUJISAWA_TSUNAMI_BUILDING_LABEL, FUJISAWA_TSUNAMI_BUILDING_URL, SHELTER_BUILDING_NOTE, SHELTER_USAGE_NOTICE } from '../data/shelters';

/** 文字だけの注意（ツールチップ用。リンクは押せないので、市の一覧の名前を示す） */
export function shelterNoticeText(): string {
  return `${SHELTER_USAGE_NOTICE}${SHELTER_BUILDING_NOTE}`;
}

/**
 * 注意の要素（市の一覧へのリンクつき）。文字は textContent、リンクは固定の URL（新しいタブで開く）。
 * className は呼び出し側のスタイルに合わせて指定する。
 */
export function shelterNoticeElement(className = 'm2d-shelter-note'): HTMLElement {
  const box = document.createElement('div');
  box.className = className;
  const usage = document.createElement('p');
  usage.textContent = SHELTER_USAGE_NOTICE;
  const building = document.createElement('p');
  building.append(SHELTER_BUILDING_NOTE, '（');
  const a = document.createElement('a');
  a.href = FUJISAWA_TSUNAMI_BUILDING_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = FUJISAWA_TSUNAMI_BUILDING_LABEL;
  building.append(a, '）');
  box.append(usage, building);
  return box;
}
