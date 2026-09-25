/**
 * 避難先の名前（EvacPlan.target.name）を、地図の上の小さな札に出す短い形にする（2D・3D で共用。maplibre-gl に依存しない）。
 *
 * 避難先の名前は、選んだ根拠を括弧の中に書いた長いものになる（src/people/plan.ts）。例:
 *   「最寄りの高台（公式の浸水想定区域の外・計算でも浸水なし・標高 7.8 m）」
 *   「避難場所に到達できないため最寄りの高台（標高 9.1 m・想定津波高 T.P.10.0 m + 1 m 以上。公式の…未確認）」
 *   「安全な高台に到達できないため近くで最も高い地点（標高 3.2 m・安全とは限りません）」
 * 地図の札では、種類と標高と、読み違えると危ない注意（未確認・安全とは限らない）だけを残す。
 * 全文は札の title（ツールチップ）と「人物」タブに出す。
 */

/** 避難場所の名前などを札に出すときの最大の文字数（超えたら「…」で切る） */
export const TARGET_LABEL_MAX_CHARS = 18;

/** 根拠を括弧の中に書く種類（plan.ts が作る名前） */
const KINDS = ['最寄りの高台', '近くで最も高い地点', '現在地'] as const;

/**
 * 地図の札に出す短い避難先の名前。
 * - 最寄りの高台 → 「最寄りの高台（標高 7.8 m）」。公式の浸水想定区域の外か確かめていなければ「…・公式区域外か未確認」を添える
 * - 近くで最も高い地点 → 「近くで最も高い地点（標高 3.2 m・安全とは限らない）」
 * - 現在地 → 「現在地（標高 7.8 m）」
 * - それ以外（避難場所の名前など）はそのまま（長ければ TARGET_LABEL_MAX_CHARS 文字で切る）
 */
export function shortTargetName(name: string): string {
  const full = (name ?? '').trim();
  if (!full) return '';
  for (const kind of KINDS) {
    const at = full.indexOf(`${kind}（`);
    if (at < 0) continue;
    const inside = full.slice(at + kind.length + 1).replace(/）\s*$/, '');
    const parts: string[] = [];
    const elev = /標高\s*(-?\d+(?:\.\d+)?)\s*m/.exec(inside);
    if (elev) parts.push(`標高 ${elev[1]} m`);
    if (kind === '近くで最も高い地点' || /安全とは限りません/.test(inside)) parts.push('安全とは限らない');
    if (/未確認/.test(inside)) parts.push('公式区域外か未確認');
    return parts.length ? `${kind}（${parts.join('・')}）` : kind;
  }
  const chars = [...full];
  return chars.length > TARGET_LABEL_MAX_CHARS ? `${chars.slice(0, TARGET_LABEL_MAX_CHARS - 1).join('')}…` : full;
}
