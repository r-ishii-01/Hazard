/**
 * 避難場所の読み込み。［スタブ: people 担当が実装］
 * 国土地理院「指定緊急避難場所データ（津波）」をブラウザから取得し、失敗時は空配列（または確認済みの静的データ）。
 */
import type { Shelter } from '../core/types';

export async function loadShelters(_opts: { signal?: AbortSignal } = {}): Promise<Shelter[]> {
  return [];
}
