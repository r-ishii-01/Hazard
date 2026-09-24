/**
 * 入力の種類（マウスか指か）に合わせた操作の説明。
 *
 * タッチ操作の端末（スマートフォン・タブレット）では「クリック」ではなく「タップ」と書き、Esc キーの案内は出さない
 * （2D 地図の配置の案内 map2d/index.ts と同じ判定: CSS の (pointer: coarse)）。
 * 文言を作る関数は純粋関数（coarse を渡せば DOM・matchMedia に依存しない）。
 */

/** 主な入力が指（タッチ）か */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** 主な入力が指（タッチ）か（判定できない環境では false） */
export function isCoarsePointer(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(COARSE_POINTER_QUERY).matches;
  } catch {
    return false;
  }
}

/** 地図を「クリック」するか「タップ」するか */
export function tapVerb(coarse: boolean): 'タップ' | 'クリック' {
  return coarse ? 'タップ' : 'クリック';
}

/** 配置モードの案内（例: 「地図をタップして「大人」を配置」） */
export function placingPrompt(label: string, coarse: boolean): string {
  return `地図を${tapVerb(coarse)}して「${label}」を配置`;
}

/** 配置モードを終えるボタンの文字（キーボードのある端末だけ Esc を添える） */
export function placingDoneLabel(coarse: boolean): string {
  return coarse ? '終了' : '終了（Esc）';
}

/**
 * 入力の種類が変わったとき（タブレットにキーボード・マウスをつないだ等）に fn を呼ぶ。戻り値で解除。
 * matchMedia が無い環境では何もしない。
 */
export function watchPointer(fn: (coarse: boolean) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  try {
    const mq = matchMedia(COARSE_POINTER_QUERY);
    const on = () => fn(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  } catch {
    return () => {};
  }
}
